import { describe, it, expect, vi } from 'vitest';
import { createProcessor, payloadSchema, PermanentJobError } from '../../apps/worker/src/processor.js';

const BOOKING = '22222222-2222-4222-8222-222222222222';
const EVENT = '11111111-1111-4111-8111-111111111111';
const payload = (over = {}) => ({ bookingId: BOOKING, bookingReference: 'FS-ABCDEFGH', eventId: EVENT, quantity: 2, requestId: 'req-12345678', ...over });
const job = (data, attemptsMade = 0) => ({ id: `booking-${BOOKING}`, data, attemptsMade, opts: { attempts: 4 }, queueName: 'booking-processing' });
const cfg = { processingMinMs: 0, processingMaxMs: 1 };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function mk(rows) {
  // rows: queue of results for successive pool.query calls
  const query = vi.fn(async () => rows.shift() ?? { rowCount: 0, rows: [] });
  const events = [];
  const proc = createProcessor({ pool: { query }, logEvent: async (e) => events.push(e), cfg, logger, sleepFn: async () => {} });
  return { proc, query, events };
}

describe('payload validation', () => {
  it('accepts a well-formed payload and rejects malformed ones', () => {
    expect(payloadSchema.safeParse(payload()).success).toBe(true);
    expect(payloadSchema.safeParse(payload({ bookingId: 'x' })).success).toBe(false);
    expect(payloadSchema.safeParse(payload({ quantity: 0 })).success).toBe(false);
    expect(payloadSchema.safeParse(payload({ simulate: 'weird' })).success).toBe(false);
  });
});

describe('worker processor', () => {
  it('confirms a PROCESSING booking', async () => {
    const { proc, query, events } = mk([{ rowCount: 1, rows: [{ id: BOOKING }] }]);
    const r = await proc.process(job(payload()));
    expect(r.status).toBe('confirmed');
    expect(query.mock.calls[0][0]).toMatch(/WHERE id = \$1 AND status = 'PROCESSING'/);
    expect(events.map((e) => e.type)).toEqual(['job.active']);
  });

  it('is idempotent: a duplicate delivery for an already CONFIRMED booking changes nothing', async () => {
    const { proc } = mk([{ rowCount: 0, rows: [] }, { rows: [{ status: 'CONFIRMED' }] }]);
    const r = await proc.process(job(payload()));
    expect(r.status).toBe('already-confirmed');
  });

  it('reports a missing booking without throwing (e.g. test data was reset)', async () => {
    const { proc } = mk([{ rowCount: 0, rows: [] }, { rows: [] }]);
    expect((await proc.process(job(payload()))).status).toBe('missing');
  });

  it('rejects an invalid payload as a permanent (non-retryable) error', async () => {
    const { proc } = mk([]);
    await expect(proc.process(job({ bookingId: 'bad' }))).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('simulated permanent failure throws PermanentJobError and never touches the booking', async () => {
    const { proc, query } = mk([]);
    await expect(proc.process(job(payload({ simulate: 'permanent' })))).rejects.toBeInstanceOf(PermanentJobError);
    expect(query).not.toHaveBeenCalled();
  });

  it('simulated transient failure fails on early attempts and succeeds on the 3rd', async () => {
    const { proc } = mk([{ rowCount: 1, rows: [{ id: BOOKING }] }]);
    await expect(proc.process(job(payload({ simulate: 'transient' }), 0))).rejects.toThrow(/transient/);
    await expect(proc.process(job(payload({ simulate: 'transient' }), 1))).rejects.toThrow(/transient/);
    expect((await proc.process(job(payload({ simulate: 'transient' }), 2))).status).toBe('confirmed');
  });

  it('failAndRelease marks FAILED and returns the tickets in one transaction', async () => {
    const calls = [];
    const client = {
      query: vi.fn(async (sql) => {
        calls.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
        if (/UPDATE bookings/.test(sql)) return { rows: [{ event_id: EVENT, quantity: 2 }] };
        if (/UPDATE events/.test(sql)) return { rows: [{ id: EVENT, category: 'Music' }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const proc = createProcessor({ pool: { connect: async () => client }, logEvent: async () => {}, cfg, logger });
    const released = await proc.failAndRelease(BOOKING, 'boom');
    expect(released).toEqual({ id: EVENT, category: 'Music' });
    expect(calls).toEqual(['BEGIN', 'UPDATE bookings', 'UPDATE events', 'COMMIT']);
    expect(client.release).toHaveBeenCalled();
  });

  it('failAndRelease does not release tickets twice (nothing left in PROCESSING)', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
    const proc = createProcessor({ pool: { connect: async () => client }, logEvent: async () => {}, cfg, logger });
    expect(await proc.failAndRelease(BOOKING, 'again')).toBeNull();
    expect(client.query.mock.calls.some(([s]) => /UPDATE events/.test(s))).toBe(false);
  });

  it('failAndRelease rolls back if the release step throws', async () => {
    const seen = [];
    const client = { query: vi.fn(async (sql) => { seen.push(sql.trim().split(/\s+/)[0]); if (/UPDATE bookings/.test(sql)) return { rows: [{ event_id: EVENT, quantity: 1 }] }; if (/UPDATE events/.test(sql)) throw new Error('db down'); return { rows: [] }; }), release: vi.fn() };
    const proc = createProcessor({ pool: { connect: async () => client }, logEvent: async () => {}, cfg, logger });
    await expect(proc.failAndRelease(BOOKING, 'x')).rejects.toThrow('db down');
    expect(seen).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});
