import { z } from 'zod';
import { KEYS, WORKER_EVENTS_MAX } from '@flashsale/common';

export const payloadSchema = z.object({
  bookingId: z.string().uuid(),
  bookingReference: z.string().min(3),
  eventId: z.string().uuid(),
  quantity: z.number().int().min(1).max(10),
  requestId: z.string().optional(),
  outboxId: z.string().optional(),
  simulate: z.enum(['transient', 'permanent']).optional(),
});

/** Marks a failure that retrying cannot fix (bad payload, deliberate permanent failure). */
export class PermanentJobError extends Error {
  constructor(message) { super(message); this.name = 'PermanentJobError'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Business logic for one booking job. Dependencies are injected so it can be unit tested without
 * PostgreSQL, Redis or BullMQ.
 *
 * Idempotency: the only state change is `UPDATE ... WHERE status = 'PROCESSING'`. Delivering the
 * same job twice (at-least-once queue) is therefore a no-op the second time.
 */
export function createProcessor({ pool, logEvent, cfg, logger, sleepFn = sleep, random = Math.random }) {
  async function confirm(bookingId) {
    const r = await pool.query(
      `UPDATE bookings SET status = 'CONFIRMED', confirmed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'PROCESSING' RETURNING id`, [bookingId]);
    if (r.rowCount === 1) return 'confirmed';
    const { rows } = await pool.query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    if (!rows[0]) return 'missing';
    return `already-${rows[0].status.toLowerCase()}`;
  }

  /**
   * Compensating action when a job is permanently failed: mark the booking FAILED and return the
   * reserved tickets, atomically. Safe to call more than once (second call finds nothing to update).
   * Returns the released event (for cache invalidation) or null.
   */
  async function failAndRelease(bookingId, reason) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE bookings SET status = 'FAILED', failure_reason = $2, updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING' RETURNING event_id, quantity`, [bookingId, String(reason).slice(0, 300)]);
      let released = null;
      if (rows[0]) {
        const e = await client.query(
          `UPDATE events SET available_capacity = available_capacity + $2,
                             status = CASE WHEN status = 'SOLD_OUT' THEN 'ON_SALE' ELSE status END,
                             updated_at = now()
            WHERE id = $1 RETURNING id, category`, [rows[0].event_id, rows[0].quantity]);
        released = e.rows[0] ?? null;
      }
      await client.query('COMMIT');
      return released;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection lost */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /** @returns {Promise<{status:string, durationMs:number}>} */
  async function process(job) {
    const started = Date.now();
    const parsed = payloadSchema.safeParse(job.data);
    if (!parsed.success) throw new PermanentJobError(`invalid job payload: ${parsed.error.issues[0]?.message}`);
    const p = parsed.data;
    const attempt = job.attemptsMade + 1;
    const base = { jobId: job.id, bookingId: p.bookingId, requestId: p.requestId, attempt, maxAttempts: job.opts.attempts };

    await logEvent({ type: 'job.active', ...base });
    logger.info({ ...base, queue: job.queueName }, 'job started');

    // Simulated payment capture / ticket issuing latency.
    await sleepFn(cfg.processingMinMs + Math.floor(random() * (cfg.processingMaxMs - cfg.processingMinMs)));

    if (p.simulate === 'permanent') throw new PermanentJobError('simulated permanent failure');
    if (p.simulate === 'transient' && attempt < 3) throw new Error(`simulated transient failure (attempt ${attempt})`);

    const outcome = await confirm(p.bookingId);
    const durationMs = Date.now() - started;
    return { status: outcome, durationMs };
  }

  return { process, confirm, failAndRelease };
}

export function createEventLogger(redis) {
  return async (evt) => {
    try {
      await redis.lpush(KEYS.workerEvents, JSON.stringify({ ...evt, at: new Date().toISOString(), source: 'worker' }));
      await redis.ltrim(KEYS.workerEvents, 0, WORKER_EVENTS_MAX - 1);
    } catch { /* observability must never fail a job */ }
  };
}
