import { describe, it, expect, afterAll } from 'vitest';
import { gw, book, resetTestEvent, waitForStatus, waitFor, newPool, uid, GATEWAY } from '../helpers/env.js';

const pool = newPool();
afterAll(() => pool.end());

describe('booking creation and status', () => {
  it('returns 202 with booking id, reference, PROCESSING status and a status URL', async () => {
    const ev = await resetTestEvent(10);
    const r = await book(ev.eventId, { quantity: 2 });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ success: true, message: 'Booking accepted for processing', idempotentReplay: false });
    expect(r.json.data).toMatchObject({ status: 'PROCESSING', quantity: 2, totalAmount: 200 });
    expect(r.json.data.bookingReference).toMatch(/^FS-[A-Z2-9]{8}$/);
    expect(r.json.data.statusUrl).toBe(`/api/bookings/${r.json.data.bookingId}`);
  });

  it('writes booking + outbox row + inventory decrement together', async () => {
    const ev = await resetTestEvent(10);
    const r = await book(ev.eventId, { quantity: 3 });
    const id = r.json.data.bookingId;
    const { rows: ob } = await pool.query('SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1', [id]);
    expect(ob).toHaveLength(1);
    expect(ob[0].event_type).toBe('booking.created');
    expect(ob[0].payload.bookingId).toBe(id);
    const { rows: e } = await pool.query('SELECT available_capacity FROM events WHERE id = $1', [ev.eventId]);
    expect(e[0].available_capacity).toBe(7);
  });

  it('GET /api/bookings/:id returns the latest status from the database', async () => {
    const ev = await resetTestEvent(10);
    const r = await book(ev.eventId);
    const id = r.json.data.bookingId;
    const first = await gw(`/api/bookings/${id}`);
    expect(first.status).toBe(200);
    expect(['PROCESSING', 'CONFIRMED']).toContain(first.json.data.status);
    const done = await waitForStatus(id, 'CONFIRMED');
    expect(done.confirmedAt).toBeDefined();
    expect(done.eventTitle).toBe('Load Test Event');
  });

  it('the outbox is published to the queue and then marked PUBLISHED', async () => {
    const ev = await resetTestEvent(10);
    const r = await book(ev.eventId);
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status, published_at FROM outbox_events WHERE aggregate_id = $1', [r.json.data.bookingId]);
      return rows[0]?.status === 'PUBLISHED' && rows[0].published_at ? rows[0] : false;
    }, { desc: 'outbox row to be published' });
  });

  it('listing by email returns only that customer’s bookings, with the email masked', async () => {
    const ev = await resetTestEvent(10);
    const email = `${uid('list')}@example.com`;
    await book(ev.eventId, { email }); await book(ev.eventId, { email }); await book(ev.eventId);
    const r = await gw(`/api/bookings?email=${encodeURIComponent(email)}`);
    expect(r.json.data).toHaveLength(2);
    expect(r.json.data[0].customerEmail).toMatch(/^l\*\*\*@example\.com$/);
  });

  it('listing all bookings without an email is refused (no unauthenticated data dump)', async () => {
    expect((await gw('/api/bookings')).status).toBe(400);
  });

  it('returns 404 for an unknown booking and 400 for a malformed id', async () => {
    expect((await gw('/api/bookings/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await gw('/api/bookings/xyz')).status).toBe(400);
  });
});

describe('validation', () => {
  it.each([
    ['quantity 0', { quantity: 0 }], ['quantity 11', { quantity: 11 }], ['quantity -1', { quantity: -1 }],
    ['bad email', { email: 'nope' }], ['short name', { name: 'x' }], ['non-uuid event', { eventId: 'abc' }],
  ])('rejects %s with 400 VALIDATION_ERROR and does not touch inventory', async (_n, patch) => {
    const ev = await resetTestEvent(10);
    const body = { eventId: ev.eventId, quantity: 1, name: 'Valid Name', email: 'v@example.com', ...patch };
    const r = await gw('/api/bookings', { method: 'POST', body, headers: { 'Idempotency-Key': uid('v') + '-12345678' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('VALIDATION_ERROR');
    expect((await pool.query('SELECT available_capacity FROM events WHERE id=$1', [ev.eventId])).rows[0].available_capacity).toBe(10);
  });

  it('requires an Idempotency-Key header', async () => {
    const ev = await resetTestEvent(10);
    const r = await gw('/api/bookings', { method: 'POST', body: { eventId: ev.eventId, quantity: 1, name: 'Valid Name', email: 'v@example.com' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 404 for an unknown event and 409 when quantity exceeds remaining stock', async () => {
    expect((await book('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    const ev = await resetTestEvent(3);
    const r = await book(ev.eventId, { quantity: 4 });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'INSUFFICIENT_INVENTORY', details: { available: 3, requested: 4 } });
  });

  it('rejects malformed JSON with 400', async () => {
    const r = await fetch(`${GATEWAY}/api/bookings`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'abcd-12345678', 'X-Client-Id': uid('c') }, body: '{bad json' });
    expect(r.status).toBe(400);
  });

  it('is safe against SQL injection in filters and ids', async () => {
    const r = await gw(`/api/events?q=${encodeURIComponent("'; DROP TABLE events;--")}&city=${encodeURIComponent("x' OR '1'='1")}`);
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual([]);
    expect((await pool.query('SELECT count(*)::int n FROM events')).rows[0].n).toBeGreaterThan(0);
    expect((await gw(`/api/events/${encodeURIComponent("1' OR '1'='1")}`)).status).toBe(400);
  });
});

describe('idempotency', () => {
  it('replaying the same request returns the original booking (HTTP 200, idempotentReplay) and takes no extra tickets', async () => {
    const ev = await resetTestEvent(10);
    const key = uid('idem') + '-key12345';
    const email = `${uid('i')}@example.com`;
    const a = await book(ev.eventId, { quantity: 2, key, email });
    const b = await book(ev.eventId, { quantity: 2, key, email });
    const c = await book(ev.eventId, { quantity: 2, key, email });
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(b.json.idempotentReplay).toBe(true);
    expect(c.json.data.bookingId).toBe(a.json.data.bookingId);
    expect(b.json.data.bookingReference).toBe(a.json.data.bookingReference);
    const { rows } = await pool.query('SELECT count(*)::int n FROM bookings WHERE idempotency_key = $1', [key]);
    expect(rows[0].n).toBe(1);
    expect((await pool.query('SELECT available_capacity FROM events WHERE id=$1', [ev.eventId])).rows[0].available_capacity).toBe(8);
    expect((await pool.query('SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1', [a.json.data.bookingId])).rows[0].n).toBe(1);
  });

  it('reusing a key with a different payload is rejected with 422', async () => {
    const ev = await resetTestEvent(10);
    const key = uid('idem') + '-key12345'; const email = `${uid('i')}@example.com`;
    await book(ev.eventId, { quantity: 1, key, email });
    const r = await book(ev.eventId, { quantity: 2, key, email });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await pool.query('SELECT available_capacity FROM events WHERE id=$1', [ev.eventId])).rows[0].available_capacity).toBe(9);
  });

  it('a rejected (sold-out) request leaves no booking behind, so its key can be retried later', async () => {
    const ev = await resetTestEvent(1);
    await book(ev.eventId, { quantity: 1 });
    const key = uid('idem') + '-key12345';
    const r = await book(ev.eventId, { quantity: 1, key });
    expect(r.status).toBe(409);
    expect((await pool.query('SELECT count(*)::int n FROM bookings WHERE idempotency_key=$1', [key])).rows[0].n).toBe(0);
  });
});
