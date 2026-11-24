import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createApp } from '../../apps/gateway/src/app.js';
import { loadConfig } from '../../apps/gateway/src/config.js';
import { rateLimitMiddleware, TokenBucketLimiter } from '../../apps/gateway/src/rate-limiter/token-bucket.js';
import { TimeSeries } from '../../apps/gateway/src/metrics.js';
import { errorBody } from '@flashsale/common';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeRedis(tokenBucket) {
  return { defineCommand() {}, tokenBucket, ping: async () => 'PONG', scan: async () => ['0', []], mget: async () => [], hgetall: async () => ({}) };
}

async function boot({ upstream, bucket = async () => [1, 39, 0, 0], cfgPatch = {} }) {
  const cfg = { ...loadConfig(), ...cfgPatch, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 } };
  const { app, breaker } = createApp({ cfg, redis: fakeRedis(bucket), logger, fetchFn: upstream });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, server, breaker };
}

describe('gateway proxy behaviour (fake upstream)', () => {
  let ctx; let calls;
  beforeAll(async () => {
    calls = [];
    const upstream = vi.fn(async (url, init) => {
      const u = new URL(url);
      calls.push({ path: u.pathname + u.search, method: init.method, headers: init.headers, body: init.body });
      if (u.pathname === '/api/teapot') return new Response(JSON.stringify({ success: false, error: 'X' }), { status: 418, headers: { 'content-type': 'application/json', 'x-powered-by': 'secret', server: 'internal' } });
      if (u.pathname === '/api/down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      if (u.pathname === '/api/slow') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      if (u.pathname === '/mock/fail') return new Response('{"ok":false}', { status: 503, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ success: true, path: u.pathname }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    ctx = await boot({ upstream });
  });
  afterAll(() => ctx.server.close());

  it('propagates upstream status codes and strips internal headers', async () => {
    const r = await fetch(`${ctx.base}/api/teapot`);
    expect(r.status).toBe(418);
    expect(r.headers.get('x-powered-by')).toBeNull();
    expect(r.headers.get('server')).toBeNull();
  });

  it('forwards method, query string, body, idempotency key and request id (and drops cookies)', async () => {
    calls.length = 0;
    await fetch(`${ctx.base}/api/bookings?x=1`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'abcd-12345678', 'x-request-id': 'req-from-client-1', cookie: 'a=b' }, body: '{"a":1}' });
    const c = calls[0];
    expect(c.path).toBe('/api/bookings?x=1');
    expect(c.method).toBe('POST');
    expect(c.headers['idempotency-key']).toBe('abcd-12345678');
    expect(c.headers['x-request-id']).toBe('req-from-client-1');
    expect(c.headers.cookie).toBeUndefined();
    expect(Buffer.from(c.body).toString()).toBe('{"a":1}');
  });

  it('replaces an unsafe client request id with a generated one', async () => {
    const r = await fetch(`${ctx.base}/api/ok`, { headers: { 'x-request-id': 'bad id with spaces!' } });
    expect(r.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps a refused connection to 502 UPSTREAM_UNAVAILABLE without leaking addresses', async () => {
    const r = await fetch(`${ctx.base}/api/down`);
    const body = await r.json();
    expect(r.status).toBe(502);
    expect(body).toMatchObject({ success: false, error: 'UPSTREAM_UNAVAILABLE' });
    expect(JSON.stringify(body)).not.toMatch(/booking-api|8081|localhost|ECONNREFUSED/);
  });

  it('maps an upstream timeout to 504 UPSTREAM_TIMEOUT', async () => {
    const r = await fetch(`${ctx.base}/api/slow`);
    expect(r.status).toBe(504);
    expect((await r.json()).error).toBe('UPSTREAM_TIMEOUT');
  });

  it('retries a safe GET on connection failure (2 attempts) but not a POST timeout', async () => {
    calls.length = 0;
    await fetch(`${ctx.base}/api/down`);
    expect(calls.length).toBe(2);
    calls.length = 0;
    await fetch(`${ctx.base}/api/slow`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(calls.length).toBe(1);
  });

  it('returns a consistent 404 JSON for unknown routes', async () => {
    const r = await fetch(`${ctx.base}/nope`);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ success: false, error: 'NOT_FOUND' });
  });

  it('rejects oversized bodies with 413', async () => {
    const r = await fetch(`${ctx.base}/api/bookings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(200_000) });
    expect(r.status).toBe(413);
    expect((await r.json()).error).toBe('PAYLOAD_TOO_LARGE');
  });

  it('opens the circuit after repeated mock failures and then fails fast with Retry-After', async () => {
    for (let i = 0; i < 3; i++) await fetch(`${ctx.base}/mock/fail`);
    expect(ctx.breaker.getState()).toBe('OPEN');
    calls.length = 0;
    const r = await fetch(`${ctx.base}/mock/fail`);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('CIRCUIT_OPEN');
    expect(r.headers.get('retry-after')).not.toBeNull();
    expect(calls.length).toBe(0); // nothing reached the downstream
  });

  it('serves Prometheus metrics', async () => {
    const r = await fetch(`${ctx.base}/metrics`);
    const text = await r.text();
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
    expect(text).toMatch(/flashsale_http_requests_total/);
    expect(text).toMatch(/flashsale_circuit_breaker_state\{[^}]*\} 2/);
  });
});

describe('rate limiter responses', () => {
  it('returns 429 with JSON error, Retry-After and rate-limit headers when the bucket is empty', async () => {
    const ctx = await boot({ upstream: async () => new Response('{}'), bucket: async () => [0, 0, 1500, 2000] });
    const r = await fetch(`${ctx.base}/api/events`);
    const body = await r.json();
    expect(r.status).toBe(429);
    expect(body).toMatchObject({ success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please try again later.' });
    expect(r.headers.get('retry-after')).toBe('2');
    expect(r.headers.get('x-ratelimit-limit')).toBe('40');
    expect(r.headers.get('x-ratelimit-remaining')).toBe('0');
    ctx.server.close();
  });

  it('fails open (and says so) when the limiter backend is down', async () => {
    const ctx = await boot({ upstream: async () => new Response('{"success":true}', { status: 200 }), bucket: async () => { throw new Error('redis down'); } });
    const r = await fetch(`${ctx.base}/api/events`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-ratelimit-status')).toBe('bypassed');
    ctx.server.close();
  });

  it('can be configured to fail closed with 503', async () => {
    const limiter = new TokenBucketLimiter({ defineCommand() {}, tokenBucket: async () => { throw new Error('down'); } });
    const mw = rateLimitMiddleware({ limiter, config: { api: { capacity: 5, refillRate: 1, refillIntervalMs: 1000 } }, klass: 'api', keyFor: () => 'k', failOpen: false, logger, errorBody });
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, locals: {} };
    await mw({ id: 'r' }, res, () => { throw new Error('should not pass'); });
    expect(res.code).toBe(503);
  });

  it('rejects invalid bucket configuration instead of dividing by zero', async () => {
    const limiter = new TokenBucketLimiter({ defineCommand() {}, tokenBucket: async () => [1, 1, 0, 0] });
    await expect(limiter.consume('k', { capacity: 10, refillRate: 0, refillIntervalMs: 1000 })).rejects.toThrow(/Invalid/);
  });
});

describe('TimeSeries (bounded metrics memory)', () => {
  it('never keeps more than maxBuckets buckets', () => {
    let t = 0;
    const ts = new TimeSeries({ bucketMs: 1000, maxBuckets: 5, now: () => t });
    for (let i = 0; i < 100; i++) { t = i * 1000; ts.record(200, 5); }
    expect(ts.toArray().length).toBe(5);
  });
  it('classifies outcomes', () => {
    const ts = new TimeSeries({ bucketMs: 1000, maxBuckets: 5, now: () => 0 });
    [200, 202, 404, 429, 500, 503].forEach((s) => ts.record(s, 10));
    expect(ts.toArray()[0]).toMatchObject({ requests: 6, success: 2, clientErrors: 1, rateLimited: 1, failed: 2, avgMs: 10 });
  });
});

describe('credentials and auth rate limiting (fake upstream)', () => {
  let ctx; let calls;
  beforeAll(async () => {
    calls = [];
    const upstream = vi.fn(async (url, init) => {
      calls.push({ path: new URL(url).pathname, headers: init.headers });
      return new Response('{"success":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    // login/sign-up bucket is empty; every other bucket has tokens
    const bucket = async (key) => (String(key).includes(':rl:auth:') ? [0, 0, 2000, 20000] : [1, 39, 0, 0]);
    ctx = await boot({ upstream, bucket });
  });
  afterAll(() => ctx.server.close());

  it('forwards Authorization to booking-api but never to other upstreams', async () => {
    calls.length = 0;
    await fetch(`${ctx.base}/api/auth/me`, { headers: { authorization: 'Bearer abc' } });
    await fetch(`${ctx.base}/mock/normal`, { headers: { authorization: 'Bearer abc' } });
    expect(calls.find((c) => c.path === '/api/auth/me').headers.authorization).toBe('Bearer abc');
    expect(calls.find((c) => c.path === '/mock/normal').headers.authorization).toBeUndefined();
  });

  it('applies the stricter auth bucket to login and sign-up (429, nothing reaches the API)', async () => {
    calls.length = 0;
    for (const path of ['/api/auth/login', '/api/auth/signup']) {
      const r = await fetch(`${ctx.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(429);
      expect(r.headers.get('retry-after')).toBe('2');
      expect((await r.json()).error).toBe('RATE_LIMIT_EXCEEDED');
    }
    expect(calls).toHaveLength(0);
  });

  it('does not apply the auth bucket to /api/auth/me', async () => {
    const r = await fetch(`${ctx.base}/api/auth/me`);
    expect(r.status).toBe(200);
  });
});
