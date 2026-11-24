import { describe, it, expect, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { gw, book, resetTestEvent, waitForStatus, waitFor, newPool, newRedis, REDIS_URL, WORKER_DIRECT, uid, bookingStatus } from '../helpers/env.js';

const pool = newPool(); const redis = newRedis();
const queueConn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('booking-processing', { connection: queueConn, prefix: 'flashsale' });
afterAll(async () => { await queue.close(); queueConn.disconnect(); await pool.end(); redis.disconnect(); });

const events = async (bookingId) => (await gw(`/api/worker/events?bookingId=${bookingId}`)).json.data;

describe('queue and worker', () => {
  it('a booking becomes a BullMQ job that the worker processes: PROCESSING → CONFIRMED', async () => {
    const ev = await resetTestEvent(10);
    const r = await book(ev.eventId);
    const id = r.json.data.bookingId;
    const job = await waitFor(async () => queue.getJob(`booking-${id}`), { timeout: 10_000, desc: 'job in queue' });
    expect(job.name).toBe('process-booking');
    expect(job.data).toMatchObject({ bookingId: id, quantity: 1 });
    await waitForStatus(id, 'CONFIRMED');
    const types = (await events(id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['queue.published', 'job.active', 'job.completed']));
    expect(types.indexOf('queue.published')).toBeLessThan(types.indexOf('job.active'));
  });

  it('the API answers before the worker finishes (async processing)', async () => {
    const ev = await resetTestEvent(10);
    const r = await book(ev.eventId);
    expect(r.json.data.status).toBe('PROCESSING');
    expect(r.ms).toBeLessThan(400);   // the worker simulates 400-1200 ms of work
  });

  it('transient failures are retried with backoff and the booking still ends CONFIRMED', async () => {
    const ev = await resetTestEvent(10);
    const r = await book(ev.eventId, { headers: { 'X-Simulate-Failure': 'transient' } });
    const id = r.json.data.bookingId;
    await waitForStatus(id, 'CONFIRMED', 40_000);
    const types = (await events(id)).map((e) => e.type);
    expect(types.filter((t) => t === 'job.retry').length).toBe(2);
    expect(types.filter((t) => t === 'job.active').length).toBe(3);
    expect(types).toContain('job.completed');
  });

  it('permanent failure: no wasted retries, booking FAILED, tickets released, failure recorded', async () => {
    const ev = await resetTestEvent(10);
    const r = await book(ev.eventId, { quantity: 4, headers: { 'X-Simulate-Failure': 'permanent' } });
    const id = r.json.data.bookingId;
    const failed = await waitForStatus(id, 'FAILED', 30_000);
    expect(failed.failureReason).toMatch(/simulated permanent failure/);
    const { rows } = await pool.query('SELECT available_capacity FROM events WHERE id = $1', [ev.eventId]);
    expect(rows[0].available_capacity).toBe(10);          // 4 tickets returned
    const job = await queue.getJob(`booking-${id}`);
    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(1);
    expect((await events(id)).map((e) => e.type)).toContain('job.failed');
  });

  it('SOLD_OUT is reverted when a failed booking releases its tickets', async () => {
    const ev = await resetTestEvent(2);
    const r = await book(ev.eventId, { quantity: 2, headers: { 'X-Simulate-Failure': 'permanent' } });
    await waitForStatus(r.json.data.bookingId, 'FAILED', 30_000);
    const { rows } = await pool.query('SELECT available_capacity, status FROM events WHERE id = $1', [ev.eventId]);
    expect(rows[0]).toMatchObject({ available_capacity: 2, status: 'ON_SALE' });
  });

  it('duplicate delivery does not cause duplicate business effects', async () => {
    const ev = await resetTestEvent(10);
    const r = await book(ev.eventId, { quantity: 2 });
    const id = r.json.data.bookingId;
    const done = await waitForStatus(id, 'CONFIRMED');
    const payload = { bookingId: id, bookingReference: done.reference, eventId: ev.eventId, quantity: 2 };
    // simulate the at-least-once queue delivering the same business message again under different job ids
    for (let i = 0; i < 3; i++) await queue.add('process-booking', payload, { jobId: `dup-${uid('d')}` });
    await waitFor(async () => { const c = await queue.getJobCounts('waiting', 'active'); return c.waiting + c.active === 0; }, { timeout: 15_000, desc: 'queue drained' });
    await new Promise((res) => setTimeout(res, 2500));
    const after = await bookingStatus(id);
    expect(after.status).toBe('CONFIRMED');
    expect(after.confirmedAt).toBe(done.confirmedAt);      // untouched by the replays
    expect((await pool.query('SELECT available_capacity FROM events WHERE id=$1', [ev.eventId])).rows[0].available_capacity).toBe(8);
  });

  it('adding the same job id twice keeps one job (deterministic ids dedupe the outbox relay)', async () => {
    const id = `test-${uid('dedupe')}`;
    await queue.add('noop', { x: 1 }, { jobId: id, delay: 60_000 });
    await queue.add('noop', { x: 2 }, { jobId: id, delay: 60_000 });
    const job = await queue.getJob(id);
    expect(job.data.x).toBe(1);
    await job.remove();
  });

  it('worker exposes health + Prometheus metrics and publishes a fresh heartbeat', async () => {
    expect((await fetch(`${WORKER_DIRECT}/health/live`)).status).toBe(200);
    expect(await (await fetch(`${WORKER_DIRECT}/metrics`)).text()).toMatch(/flashsale_worker_jobs_total/);
    const keys = await redis.keys('worker:heartbeat:*');
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const hb = JSON.parse(await redis.get(keys[0]));
    expect(Date.now() - hb.ts).toBeLessThan(15_000);
  });

  it('worker statistics are recorded in Redis', async () => {
    const s = await redis.hgetall('stats:worker');
    expect(Number(s.processed)).toBeGreaterThan(0);
    expect(Number(s.totalMs)).toBeGreaterThan(0);
  });
});

describe('outbox dispatcher', () => {
  it('publishes a pending outbox row written without the API (crash-recovery path)', async () => {
    const ev = await resetTestEvent(10);
    const userId = (await pool.query("INSERT INTO users (name,email) VALUES ('Outbox User',$1) RETURNING id", [`${uid('ob')}@example.com`])).rows[0].id;
    // emulate "API committed the booking and crashed before publishing": rows exist, nothing on the queue
    const b = (await pool.query(
      `WITH inv AS (UPDATE events SET available_capacity = available_capacity - 1 WHERE id = $1 RETURNING id)
       INSERT INTO bookings (booking_reference,user_id,event_id,quantity,total_amount,status,idempotency_key,request_fingerprint)
       VALUES ($2,$3,$1,1,100,'PROCESSING',$4,'fp') RETURNING id, booking_reference`,
      [ev.eventId, `FS-T${Math.floor(Math.random() * 9e6 + 1e6)}`, userId, uid('crash') + '-key12345'])).rows[0];
    await pool.query("INSERT INTO outbox_events (event_type, aggregate_id, payload) VALUES ('booking.created', $1, $2)",
      [b.id, JSON.stringify({ bookingId: b.id, bookingReference: b.booking_reference, eventId: ev.eventId, quantity: 1 })]);
    await waitForStatus(b.id, 'CONFIRMED', 20_000);
    expect((await pool.query('SELECT status FROM outbox_events WHERE aggregate_id=$1', [b.id])).rows[0].status).toBe('PUBLISHED');
  });

  it('two competing claimers never take the same outbox row (FOR UPDATE SKIP LOCKED)', async () => {
    const a = await pool.connect(); const b = await pool.connect();
    try {
      const ev = await resetTestEvent(10);
      const userId = (await pool.query("INSERT INTO users (name,email) VALUES ('Skip User',$1) RETURNING id", [`${uid('sk')}@example.com`])).rows[0].id;
      const mk = async () => (await pool.query(
        `INSERT INTO bookings (booking_reference,user_id,event_id,quantity,total_amount,status,idempotency_key,request_fingerprint) VALUES ($1,$2,$3,1,100,'FAILED',$4,'fp') RETURNING id`,
        [`FS-S${Math.floor(Math.random() * 9e6 + 1e6)}`, userId, ev.eventId, uid('sk') + '-key12345'])).rows[0].id;
      const ids = [await mk(), await mk()];
      // parked in the future so the live dispatcher ignores them while two transactions try to claim
      for (const id of ids) await pool.query("INSERT INTO outbox_events (event_type, aggregate_id, payload, next_attempt_at) VALUES ('booking.created', $1, '{}', now() + interval '1 hour')", [id]);
      await a.query('BEGIN'); await b.query('BEGIN');
      const sql = "SELECT aggregate_id FROM outbox_events WHERE aggregate_id = ANY($1) AND status='PENDING' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED";
      const ra = await a.query(sql, [ids]); const rb = await b.query(sql, [ids]);
      expect(ra.rows).toHaveLength(1); expect(rb.rows).toHaveLength(1);
      expect(ra.rows[0].aggregate_id).not.toBe(rb.rows[0].aggregate_id);
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
      await pool.query('DELETE FROM outbox_events WHERE aggregate_id = ANY($1)', [ids]);
    } finally { a.release(); b.release(); }
  });
});
