import { describe, it, expect, afterAll } from 'vitest';
import Redis from 'ioredis';
import { gw, newRedis, REDIS_URL, uid, sleep } from '../helpers/env.js';
import { TokenBucketLimiter } from '../../apps/gateway/src/rate-limiter/token-bucket.js';

const redis = newRedis();
afterAll(() => redis.disconnect());

describe('gateway rate limiting (default: capacity 40, refill 20/s)', () => {
  it('requests below the limit succeed and expose rate-limit headers', async () => {
    const r = await gw('/api/ping', { client: uid('rl') });
    expect(r.status).toBe(200);
    expect(Number(r.headers.get('x-ratelimit-limit'))).toBe(40);
    expect(Number(r.headers.get('x-ratelimit-remaining'))).toBe(39);
  });

  it('a burst above capacity is partially rejected with HTTP 429, JSON body and Retry-After', async () => {
    const client = uid('burst');
    const results = await Promise.all(Array.from({ length: 100 }, () => gw('/api/ping', { client })));
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429);
    expect(ok).toBeGreaterThanOrEqual(40);
    expect(ok).toBeLessThan(100);
    expect(limited.length).toBe(100 - ok);
    expect(limited.length).toBeGreaterThan(0);
    const l = limited[0];
    expect(l.json).toMatchObject({ success: false, error: 'RATE_LIMIT_EXCEEDED' });
    expect(l.json.message).toMatch(/too many requests/i);
    expect(Number(l.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(l.headers.get('x-ratelimit-remaining')).toBe('0');
  });

  it('buckets are per client: one client being limited does not affect another', async () => {
    const noisy = uid('noisy');
    const burst = await Promise.all(Array.from({ length: 120 }, () => gw('/api/ping', { client: noisy })));
    expect(burst.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    const quiet = await gw('/api/ping', { client: uid('quiet') });
    expect(quiet.status).toBe(200);
    expect(quiet.headers.get('x-ratelimit-remaining')).toBe('39');   // untouched full bucket
  });

  it('tokens refill over time so the client recovers', async () => {
    const client = uid('refill');
    const burst = await Promise.all(Array.from({ length: 120 }, () => gw('/api/ping', { client })));
    expect(burst.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    await sleep(1500);   // ~30 tokens at 20/s
    const after = await gw('/api/ping', { client });
    expect(after.status).toBe(200);
    expect(Number(after.headers.get('x-ratelimit-remaining'))).toBeGreaterThan(10);
  });

  it('health endpoints use a separate bucket and stay available while the API bucket is exhausted', async () => {
    const client = uid('health');
    const burst = await Promise.all(Array.from({ length: 120 }, () => gw('/api/ping', { client })));
    expect(burst.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    const h = await gw('/health', { client });
    expect(h.status).toBe(200);
    expect(Number(h.headers.get('x-ratelimit-limit'))).toBe(300);
  });

  it('429 responses are counted in the metrics', async () => {
    const read = async () => Number(/flashsale_rate_limited_total\{[^}]*\} (\d+)/.exec((await gw('/metrics')).text)?.[1] ?? 0);
    const before = await read();
    const client = uid('metric');
    await Promise.all(Array.from({ length: 80 }, () => gw('/api/ping', { client })));
    expect(await read()).toBeGreaterThan(before);
  });
});

describe('Token Bucket Lua script atomicity (direct Redis)', () => {
  const cfg = { capacity: 50, refillRate: 1, refillIntervalMs: 600_000 }; // effectively no refill during the test

  it('300 concurrent consumers over 3 separate connections (simulating 3 gateway instances) get exactly 50 tokens', async () => {
    const conns = [0, 1, 2].map(() => new Redis(REDIS_URL));
    const limiters = conns.map((c) => new TokenBucketLimiter(c));
    const key = `test:tb:${uid('atomic')}`;
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => limiters[i % 3].consume(key, cfg)));
    expect(results.filter((r) => r.allowed)).toHaveLength(50);
    expect(results.filter((r) => !r.allowed)).toHaveLength(250);
    await redis.del(key);
    conns.forEach((c) => c.disconnect());
  });

  it('never exceeds capacity after idle time and reports a sensible retry delay', async () => {
    const conn = new Redis(REDIS_URL);
    const limiter = new TokenBucketLimiter(conn);
    const key = `test:tb:${uid('cap')}`;
    const fast = { capacity: 5, refillRate: 5, refillIntervalMs: 1000 };
    for (let i = 0; i < 5; i++) expect((await limiter.consume(key, fast)).allowed).toBe(true);
    const denied = await limiter.consume(key, fast);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(200);
    await sleep(1500);
    const ok = await limiter.consume(key, fast);
    expect(ok.allowed).toBe(true);
    expect(ok.remaining).toBeLessThanOrEqual(4);   // refill capped at capacity (5) minus the one consumed
    await redis.del(key);
    conn.disconnect();
  });

  it('keys expire so idle clients do not accumulate in Redis', async () => {
    const conn = new Redis(REDIS_URL);
    const limiter = new TokenBucketLimiter(conn);
    const key = `test:tb:${uid('ttl')}`;
    await limiter.consume(key, { capacity: 5, refillRate: 5, refillIntervalMs: 1000 });
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThan(10_000);
    await redis.del(key);
    conn.disconnect();
  });
});
