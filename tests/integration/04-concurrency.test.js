import { describe, it, expect, afterAll } from 'vitest';
import { book, resetTestEvent, testEventState, waitFor, newPool, uid } from '../helpers/env.js';

const pool = newPool();
afterAll(() => pool.end());

/** Database-level invariants that must hold after any amount of concurrency. */
async function assertConsistent(eventId) {
  const { rows } = await pool.query(`
    SELECT e.total_capacity, e.available_capacity,
           COALESCE((SELECT SUM(quantity) FROM bookings b WHERE b.event_id = e.id AND b.status IN ('PROCESSING','CONFIRMED')), 0)::int AS reserved,
           (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id) AS bookings,
           (SELECT count(*)::int FROM outbox_events o JOIN bookings b ON b.id = o.aggregate_id WHERE b.event_id = e.id) AS outbox
      FROM events e WHERE e.id = $1`, [eventId]);
  const r = rows[0];
  expect(r.available_capacity).toBeGreaterThanOrEqual(0);
  expect(r.total_capacity - r.available_capacity).toBe(r.reserved);     // inventory == sum of active bookings
  expect(r.outbox).toBe(r.bookings);                                    // every booking has exactly one outbox row
  return r;
}

describe('concurrent booking (no overselling)', () => {
  it('50 concurrent single-ticket requests against 10 tickets: exactly 10 succeed, 40 get 409', async () => {
    const ev = await resetTestEvent(10);
    const results = await Promise.all(Array.from({ length: 50 }, () => book(ev.eventId, { quantity: 1 })));
    const accepted = results.filter((r) => r.status === 202);
    const rejected = results.filter((r) => r.status === 409);
    expect(accepted).toHaveLength(10);
    expect(rejected).toHaveLength(40);
    expect(rejected.every((r) => r.json.error === 'INSUFFICIENT_INVENTORY')).toBe(true);
    expect(results.filter((r) => ![202, 409].includes(r.status))).toHaveLength(0);
    expect(new Set(accepted.map((r) => r.json.data.bookingReference)).size).toBe(10);
    const row = await assertConsistent(ev.eventId);
    expect(row.available_capacity).toBe(0);
    expect(row.bookings).toBe(10);
    expect((await testEventState()).status).toBe('SOLD_OUT');
    await waitFor(async () => (await testEventState()).confirmed === 10, { timeout: 40_000, desc: '10 bookings confirmed' });
  });

  it('mixed quantities never exceed capacity', async () => {
    const ev = await resetTestEvent(20);
    const qty = [3, 5, 2, 4, 1, 5, 3, 2, 4, 5, 1, 2, 3, 4, 5, 2, 1, 3, 4, 2];
    const results = await Promise.all(qty.map((q) => book(ev.eventId, { quantity: q })));
    const taken = results.filter((r) => r.status === 202).reduce((s, r) => s + r.json.data.quantity, 0);
    expect(taken).toBeLessThanOrEqual(20);
    const row = await assertConsistent(ev.eventId);
    expect(row.total_capacity - row.available_capacity).toBe(taken);
    expect(results.every((r) => [202, 409].includes(r.status))).toBe(true);
  });

  it('the SAME idempotency key sent 25 times concurrently creates exactly one booking and takes one ticket', async () => {
    const ev = await resetTestEvent(10);
    const key = uid('same') + '-key12345'; const email = `${uid('s')}@example.com`;
    const results = await Promise.all(Array.from({ length: 25 }, () => book(ev.eventId, { quantity: 1, key, email })));
    expect(results.every((r) => [200, 202].includes(r.status))).toBe(true);
    expect(new Set(results.map((r) => r.json.data.bookingId)).size).toBe(1);
    const { rows } = await pool.query('SELECT count(*)::int n FROM bookings WHERE idempotency_key = $1', [key]);
    expect(rows[0].n).toBe(1);
    const row = await assertConsistent(ev.eventId);
    expect(row.available_capacity).toBe(9);
    expect(row.bookings).toBe(1);
  });

  it('a double-submit storm from several users still obeys capacity', async () => {
    const ev = await resetTestEvent(5);
    const users = Array.from({ length: 12 }, () => ({ key: uid('k') + '-key12345', email: `${uid('m')}@example.com` }));
    const all = await Promise.all(users.flatMap((u) => Array.from({ length: 3 }, () => book(ev.eventId, { quantity: 1, key: u.key, email: u.email }))));
    const bookingIds = new Set(all.filter((r) => [200, 202].includes(r.status)).map((r) => r.json.data.bookingId));
    expect(bookingIds.size).toBe(5);
    const row = await assertConsistent(ev.eventId);
    expect(row.available_capacity).toBe(0);
    expect(row.bookings).toBe(5);
  });
});
