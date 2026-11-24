import { describe, it, expect, vi } from 'vitest';
import { EventCache, categorySlug } from '../../apps/booking-api/src/services/cache.js';

function fakeRedis({ failReads = false } = {}) {
  const store = new Map();
  const counters = {};
  return {
    store, counters,
    get: vi.fn(async (k) => { if (failReads) throw new Error('redis down'); return store.get(k) ?? null; }),
    set: vi.fn(async (k, v) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (...ks) => { ks.forEach((k) => store.delete(k)); return ks.length; }),
    hincrby: vi.fn(async (_h, f, n) => { counters[f] = (counters[f] || 0) + n; return counters[f]; }),
    hgetall: vi.fn(async () => ({ ...counters })),
  };
}
const logger = { warn: vi.fn(), info: vi.fn() };
const cfg = { cache: { jitterRatio: 0 } };
const mk = (redis) => new EventCache({ redis, cfg, metrics: null, logger });

describe('EventCache (cache-aside)', () => {
  it('MISS loads from the loader and stores; second call is a HIT without calling the loader', async () => {
    const redis = fakeRedis(); const cache = mk(redis);
    const loader = vi.fn(async () => [{ id: 1 }]);
    const a = await cache.getOrLoad('events:all', 30, loader);
    const b = await cache.getOrLoad('events:all', 30, loader);
    expect(a).toMatchObject({ source: 'database', value: [{ id: 1 }] });
    expect(b).toMatchObject({ source: 'cache', value: [{ id: 1 }] });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith('events:all', JSON.stringify([{ id: 1 }]), 'EX', 30);
  });

  it('records hit/miss counters used by the dashboard', async () => {
    const redis = fakeRedis(); const cache = mk(redis);
    await cache.getOrLoad('k', 30, async () => 1);
    await cache.getOrLoad('k', 30, async () => 1);
    await cache.getOrLoad('k', 30, async () => 1);
    await new Promise((r) => setImmediate(r));
    const s = await cache.stats();
    expect(s).toMatchObject({ available: true, hits: 2, misses: 1, errors: 0 });
    expect(s.hitRatio).toBeCloseTo(0.6667, 3);
  });

  it('falls back to the loader when Redis reads fail, and does not throw', async () => {
    const cache = mk(fakeRedis({ failReads: true }));
    const r = await cache.getOrLoad('k', 30, async () => 'from-db');
    expect(r).toMatchObject({ value: 'from-db', source: 'database', cacheError: true });
  });

  it('shares one loader call between concurrent misses (stampede protection)', async () => {
    const cache = mk(fakeRedis());
    const loader = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); return 'v'; });
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.getOrLoad('k', 30, loader)));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.value === 'v')).toBe(true);
  });

  it('never caches a null (not found) result', async () => {
    const redis = fakeRedis(); const cache = mk(redis);
    await cache.getOrLoad('events:missing', 30, async () => null);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('invalidate deletes keys and swallows Redis errors', async () => {
    const redis = fakeRedis(); const cache = mk(redis);
    redis.store.set('a', '1');
    await cache.invalidate(['a', 'b']);
    expect(redis.store.has('a')).toBe(false);
    redis.del.mockRejectedValueOnce(new Error('down'));
    await expect(cache.invalidate(['a'])).resolves.toBeUndefined();
  });

  it('builds safe category slugs for cache keys', () => {
    expect(categorySlug('Food & Drink')).toBe('food-drink');
    expect(categorySlug('../../etc')).toBe('etc');
  });
});
