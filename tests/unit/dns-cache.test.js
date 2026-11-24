import { describe, it, expect, vi } from 'vitest';
import { createCachingLookup } from '../../apps/gateway/src/http.js';

// fake dns.lookup: records calls, answers from a table (with optional delay / failure)
function fakeResolver(table, { delayMs = 0 } = {}) {
  const calls = [];
  const lookup = (host, opts, cb) => {
    calls.push(host);
    setTimeout(() => {
      const addr = table[host];
      if (!addr) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
      cb(null, opts.all ? [{ address: addr, family: 4 }] : addr, opts.all ? undefined : 4);
    }, typeof delayMs === 'function' ? delayMs(host) : delayMs);
  };
  return { lookup, calls };
}
const resolve = (fn, host, opts = {}) => new Promise((res) => fn(host, opts, (err, address, family) => res({ err, address, family })));

describe('caching DNS lookup', () => {
  it('resolves once, then answers from memory while the entry is fresh', async () => {
    const r = fakeResolver({ 'mock-service': '10.0.0.3' });
    let t = 1000;
    const fn = createCachingLookup({ ttlMs: 2000, lookup: r.lookup, now: () => t });
    expect((await resolve(fn, 'mock-service')).address).toBe('10.0.0.3');
    t += 1500;
    expect((await resolve(fn, 'mock-service')).address).toBe('10.0.0.3');
    expect(r.calls).toHaveLength(1);
  });

  it('single-flights concurrent first lookups', async () => {
    const r = fakeResolver({ a: '10.0.0.1' }, { delayMs: 20 });
    const fn = createCachingLookup({ lookup: r.lookup });
    await Promise.all([resolve(fn, 'a'), resolve(fn, 'a'), resolve(fn, 'a')]);
    expect(r.calls).toHaveLength(1);
  });

  it('serves a stale entry immediately and refreshes in the background (a slow resolver cannot delay requests)', async () => {
    const table = { svc: '10.0.0.1' };
    const r = fakeResolver(table, { delayMs: 30 });
    let t = 0;
    const fn = createCachingLookup({ ttlMs: 1000, lookup: r.lookup, now: () => t });
    await resolve(fn, 'svc');
    t += 5000;                                   // expired
    table.svc = '10.0.0.9';                      // the container got a new address
    const started = Date.now();
    expect((await resolve(fn, 'svc')).address).toBe('10.0.0.1');   // stale answer, no waiting
    expect(Date.now() - started).toBeLessThan(25);
    await new Promise((res) => setTimeout(res, 60));               // background refresh lands
    expect((await resolve(fn, 'svc')).address).toBe('10.0.0.9');
    expect(r.calls).toHaveLength(2);
  });

  it('keeps the last known address when a refresh fails (e.g. container stopped => NXDOMAIN)', async () => {
    const table = { svc: '10.0.0.1' };
    const r = fakeResolver(table);
    let t = 0;
    const fn = createCachingLookup({ ttlMs: 1000, lookup: r.lookup, now: () => t });
    await resolve(fn, 'svc');
    delete table.svc;
    t += 5000;
    expect((await resolve(fn, 'svc')).address).toBe('10.0.0.1');
    await new Promise((res) => setTimeout(res, 10));
    const again = await resolve(fn, 'svc');
    expect(again.err).toBeNull();
    expect(again.address).toBe('10.0.0.1');
  });

  it('a slow failing lookup for a dead host does not delay a cached healthy host', async () => {
    const r = fakeResolver({ healthy: '10.0.0.3' }, { delayMs: (h) => (h === 'dead' ? 300 : 0) });
    const fn = createCachingLookup({ lookup: r.lookup });
    await resolve(fn, 'healthy');                                   // warm
    const dead = resolve(fn, 'dead');                               // takes ~300 ms and fails
    const started = Date.now();
    expect((await resolve(fn, 'healthy')).address).toBe('10.0.0.3');
    expect(Date.now() - started).toBeLessThan(50);
    expect((await dead).err.code).toBe('ENOTFOUND');
  });

  it('reports a lookup error when nothing has ever been resolved', async () => {
    const r = fakeResolver({});
    const fn = createCachingLookup({ lookup: r.lookup });
    expect((await resolve(fn, 'nope')).err.code).toBe('ENOTFOUND');
  });

  it('supports the all:true form used by happy-eyeballs connects', async () => {
    const r = fakeResolver({ svc: '10.0.0.1' });
    const fn = createCachingLookup({ lookup: r.lookup });
    const first = await resolve(fn, 'svc', { all: true });
    expect(first.address).toEqual([{ address: '10.0.0.1', family: 4 }]);
    const second = await resolve(fn, 'svc', { all: true });
    expect(second.address).toEqual(first.address);
    expect(r.calls).toHaveLength(1);
  });

  it('supports the (host, callback) call form', async () => {
    const r = fakeResolver({ svc: '10.0.0.1' });
    const fn = createCachingLookup({ lookup: r.lookup });
    const got = await new Promise((res) => fn('svc', (err, address) => res(address)));
    expect(got).toBe('10.0.0.1');
    void vi;
  });
});
