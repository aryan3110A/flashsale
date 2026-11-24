import { describe, it, expect, afterAll } from 'vitest';
import { gw, waitFor, newPool, uid } from '../helpers/env.js';

const pool = newPool();
afterAll(() => pool.end());

const state = async () => (await gw('/api/demo/flash-sale')).json.data;
const reset = (capacity) => gw('/api/demo/flash-sale/reset', { method: 'POST', body: capacity === undefined ? {} : { capacity } });
const bookAs = (eventId, n, quantity, key = `${uid('sim')}-idem`, email = `sim-${uid('u')}-${n}@example.com`) =>
  gw('/api/bookings', { method: 'POST', body: { eventId, quantity, name: `Sim User ${n}`, email }, headers: { 'Idempotency-Key': key } });

describe('flash-sale simulator endpoints', () => {
  it('reports the hidden demo event with aggregate counts, a consistency flag and a bookings list', async () => {
    const r = await reset(50);
    expect(r.status).toBe(200);
    const s = await state();
    expect(s).toMatchObject({ totalCapacity: 50, availableCapacity: 50, status: 'ON_SALE', bookings: 0, processing: 0, confirmed: 0, failed: 0, consistent: true });
    expect(s.list).toEqual([]);
  });

  it('the demo event is hidden from the public event list', async () => {
    const events = (await gw('/api/events')).json.data;
    expect(events.find((e) => e.slug === 'flash-sale-demo')).toBeUndefined();
  });

  it('reset validates capacity (1..1000)', async () => {
    for (const bad of [0, -5, 1001, 'abc', 2.5]) expect((await reset(bad)).status).toBe(400);
    expect((await reset(7)).json.data.totalCapacity).toBe(7);
    await reset(50);
  });

  it('10 users x 10 tickets, 8 impatient clicks each, for 50 tickets: exactly 5 winners, no oversell, one booking per winner', async () => {
    const s0 = (await reset(50)).json.data;
    const users = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, key: `${uid('sim')}-idem`, email: `sim-${uid('u')}-${i + 1}@example.com` }));
    // every user fires 8 parallel clicks with ONE idempotency key; all 80 requests race together
    const results = await Promise.all(users.flatMap((u) => Array.from({ length: 8 }, () => bookAs(s0.eventId, u.n, 10, u.key, u.email).then((r) => ({ u: u.n, r })))));
    const by = (pred) => results.filter(({ r }) => pred(r));
    const accepted = by((r) => r.status === 202);
    const replays = by((r) => r.status === 200 && r.json.idempotentReplay);
    const soldOut = by((r) => r.status === 409 && r.json.error === 'INSUFFICIENT_INVENTORY');
    const unexpected = by((r) => ![202, 200, 409].includes(r.status));
    expect(unexpected, JSON.stringify(unexpected.map(({ r }) => [r.status, r.json?.error]))).toHaveLength(0);
    expect(accepted).toHaveLength(5);                              // 50 tickets / 10 each
    expect(new Set(accepted.map((a) => a.u)).size).toBe(5);        // 5 different winners
    expect(replays.length + accepted.length + soldOut.length).toBe(80);
    expect(soldOut.length).toBeGreaterThan(0);

    const final = await waitFor(async () => { const s = await state(); return s.processing === 0 && s.confirmed === 5 ? s : false; }, { timeout: 40_000, desc: 'worker to confirm 5 bookings' });
    expect(final).toMatchObject({ availableCapacity: 0, status: 'SOLD_OUT', bookings: 5, reservedTickets: 50, failed: 0, consistent: true });
    expect(final.list).toHaveLength(5);
    await reset(50);
  });

  it('reset removes only the demo event\'s bookings (other events keep theirs)', async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM bookings b JOIN events e ON e.id = b.event_id WHERE e.slug <> 'flash-sale-demo'")).rows[0].n;
    const s0 = (await reset(20)).json.data;
    expect((await bookAs(s0.eventId, 1, 2)).status).toBe(202);
    expect((await state()).bookings).toBe(1);
    await reset(20);
    expect((await state()).bookings).toBe(0);
    const after = (await pool.query("SELECT count(*)::int AS n FROM bookings b JOIN events e ON e.id = b.event_id WHERE e.slug <> 'flash-sale-demo'")).rows[0].n;
    expect(after).toBe(before);
    await reset(50);
  });
});
