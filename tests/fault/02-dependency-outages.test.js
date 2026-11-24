import { describe, it, expect, afterAll } from 'vitest';
import { gw, book, resetTestEvent, waitFor, waitForStatus, sleep, compose, uid, bookingStatus, newPool } from '../helpers/env.js';

const client = uid('outage');
const pool = newPool();
afterAll(async () => { await pool.end(); });

const health = async () => gw('/health/services', { client });
const waitHealthy = () => waitFor(async () => { const h = await health(); return h.json?.status === 'healthy' && h.status === 200; }, { timeout: 90_000, interval: 1000, desc: 'system healthy' });
const restarts = (svc) => Number(compose(`ps -q ${svc}`).trim() && compose(`ps -q ${svc}`).trim().split('\n').length >= 0 ? 0 : 0);

describe('Redis unavailable', () => {
  it('the system degrades gracefully, then catches up when Redis returns', async () => {
    await waitHealthy();
    const ev = await resetTestEvent(10);
    compose('stop redis');
    try {
      // 1. rate limiter fails OPEN (documented trade-off) and says so
      const ping = await gw('/api/ping', { client });
      expect(ping.status).toBe(200);
      expect(ping.headers.get('x-ratelimit-status')).toBe('bypassed');

      // 2. reads fall back to PostgreSQL, flagged as a cache error
      const events = await gw('/api/events', { client });
      expect(events.status).toBe(200);
      expect(events.json.meta).toMatchObject({ source: 'database', cacheError: true });

      // 3. bookings still succeed: the outbox row lives in PostgreSQL, publishing is just deferred
      const r = await book(ev.eventId, { quantity: 1, client });
      expect(r.status).toBe(202);
      const id = r.json.data.bookingId;
      const during = await bookingStatus(id);
      expect(during.status).toBe('PROCESSING');

      // 4. health reports the outage: Redis is critical, so the system is unhealthy (503)
      const h = await health();
      expect(h.status).toBe(503);
      expect(h.json.services.redis).toBe('unhealthy');
      expect(h.json.status).toBe('unhealthy');

      // 5. the dashboard summary marks Redis-backed numbers unavailable instead of inventing them
      const s = await gw('/metrics/summary', { client });
      expect(s.status).toBe(200);
      expect(s.json.worker.available).toBe(false);
      expect(s.json.cache.available).toBe(false);
      globalThis.__redisOutageBooking = id;
    } finally { compose('start redis'); }

    // 6. after recovery the dispatcher publishes the pending outbox row and the worker confirms it
    await waitForStatus(globalThis.__redisOutageBooking, 'CONFIRMED', 90_000);
    await waitHealthy();
    const { rows } = await pool.query('SELECT status FROM outbox_events WHERE aggregate_id=$1', [globalThis.__redisOutageBooking]);
    expect(rows[0].status).toBe('PUBLISHED');
  });
});

describe('PostgreSQL unavailable', () => {
  it('writes fail cleanly with 503 (no hang, no crash), health shows unhealthy, and service resumes after restart', async () => {
    await waitHealthy();
    const ev = await resetTestEvent(10);
    await gw('/api/cache/clear', { method: 'POST', client });
    compose('stop postgres');
    try {
      const r = await book(ev.eventId, { client });
      expect(r.status).toBe(503);
      expect(r.json.error).toBe('SERVICE_UNAVAILABLE');
      expect(r.ms).toBeLessThan(10_000);

      const events = await gw('/api/events', { client });      // cache is empty => must hit the dead database
      expect(events.status).toBe(503);

      const h = await health();
      expect(h.status).toBe(503);
      expect(h.json.services.postgres).toBe('unhealthy');
      expect(h.json.services.redis).toBe('healthy');

      // the API process itself must stay up and keep answering cheap routes
      expect((await gw('/api/ping', { client })).status).toBe(200);
    } finally { compose('start postgres'); }

    await waitHealthy();
    const ok = await book(ev.eventId, { client });
    expect(ok.status).toBe(202);
    await waitForStatus(ok.json.data.bookingId, 'CONFIRMED', 40_000);
    // dashboard counted the failures
    const s = await gw('/metrics/summary', { client });
    expect(s.json.database.queryFailures).toBeGreaterThan(0);
  });
});

describe('Booking API unavailable', () => {
  it('gateway returns 502 quickly with a safe error; unrelated routes still work; recovers after restart', async () => {
    await waitHealthy();
    compose('stop booking-api');
    try {
      const events = await gw('/api/events', { client });
      expect(events.status).toBe(502);
      expect(events.json).toMatchObject({ success: false, error: 'UPSTREAM_UNAVAILABLE' });
      expect(JSON.stringify(events.json)).not.toMatch(/booking-api|8081/);
      expect(events.ms).toBeLessThan(5000);

      const ev = { id: '11111111-1111-4111-8111-111111111111' };
      const post = await book(ev.id, { client });
      expect(post.status).toBe(502);

      expect((await gw('/mock/normal', { client })).status).toBe(200);     // other services unaffected
      expect((await gw('/health', { client })).status).toBe(200);
      const h = await health();
      expect(h.status).toBe(503);
      expect(h.json.services['booking-api']).toBe('unhealthy');
      expect(h.json.services.postgres).toBe('unknown');                    // postgres health comes via booking-api
    } finally { compose('start booking-api'); }
    await waitHealthy();
    expect((await gw('/api/events', { client })).status).toBe(200);
  });
});

describe('Worker unavailable / killed', () => {
  it('heartbeat expiry marks the worker unhealthy (degraded system); queued bookings finish after it returns', async () => {
    await waitHealthy();
    const ev = await resetTestEvent(10);
    compose('stop worker');
    let ids = [];
    try {
      await waitFor(async () => (await health()).json.services.worker === 'unhealthy', { timeout: 40_000, interval: 1000, desc: 'worker heartbeat to expire' });
      const h = await health();
      expect(h.status).toBe(200);
      expect(h.json.status).toBe('degraded');

      for (let i = 0; i < 3; i++) { const r = await book(ev.eventId, { client }); expect(r.status).toBe(202); ids.push(r.json.data.bookingId); }
      await sleep(3000);
      for (const id of ids) expect((await bookingStatus(id)).status).toBe('PROCESSING');
      const s = (await gw('/metrics/summary', { client })).json;
      expect(s.queue.waiting).toBeGreaterThanOrEqual(3);
      expect(s.worker.instances).toBe(0);
    } finally { compose('start worker'); }
    for (const id of ids) await waitForStatus(id, 'CONFIRMED', 60_000);
    await waitHealthy();
  });

  it('a worker killed (SIGKILL) mid-processing does not lose committed work: stalled jobs are re-run', async () => {
    await waitHealthy();
    const ev = await resetTestEvent(10);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await book(ev.eventId, { client })).json.data.bookingId);
    await sleep(500);                 // jobs are now active inside the worker (400-1200 ms of simulated work)
    compose('kill worker');
    compose('start worker');
    for (const id of ids) await waitForStatus(id, 'CONFIRMED', 120_000);
    const { rows } = await pool.query("SELECT count(*)::int n FROM bookings WHERE event_id=$1 AND status='CONFIRMED'", [ev.eventId]);
    expect(rows[0].n).toBe(4);
    expect((await pool.query('SELECT available_capacity FROM events WHERE id=$1', [ev.eventId])).rows[0].available_capacity).toBe(6);
    await waitHealthy();
  });
});
