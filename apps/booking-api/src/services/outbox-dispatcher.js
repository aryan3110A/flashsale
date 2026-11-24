import { KEYS, WORKER_EVENTS_MAX } from '@flashsale/common';
import { withTransaction } from '../db/pool.js';
import { jobIdFor, jobOptions } from './queue.js';

/**
 * Transactional-outbox relay: PostgreSQL outbox_events  ->  BullMQ.
 *
 * Delivery guarantee: AT-LEAST-ONCE. A crash after queue.add() but before COMMIT re-publishes the row
 * on the next poll. That is harmless because (a) the BullMQ jobId is deterministic, so a duplicate add
 * is ignored while the job exists, and (b) the worker's state transition is conditional
 * (`WHERE status='PROCESSING'`), so a re-run cannot double-apply. "Exactly-once" is achieved at the
 * business level by idempotent processing - not by the transport.
 *
 * Multiple dispatchers may run concurrently: rows are claimed with FOR UPDATE SKIP LOCKED.
 */
export class OutboxDispatcher {
  constructor({ pool, queue, redis, cfg, logger, metrics }) {
    Object.assign(this, { pool, queue, redis, cfg, logger, metrics });
    this.running = false;
    this.wake = null;
    this.loopPromise = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this._loop();
    this.logger.info({ pollIntervalMs: this.cfg.outbox.pollIntervalMs, batchSize: this.cfg.outbox.batchSize }, 'outbox dispatcher started');
  }

  async stop() {
    this.running = false;
    this.wake?.();
    await this.loopPromise;
  }

  /** Skip the remaining poll delay (called right after a booking commits). */
  kick() { this.wake?.(); }

  async _loop() {
    let errorStreak = 0;
    while (this.running) {
      let delay = this.cfg.outbox.pollIntervalMs;
      try {
        const n = await this.runOnce();
        errorStreak = 0;
        if (n >= this.cfg.outbox.batchSize) delay = 0; // backlog: keep draining
      } catch (err) {
        errorStreak++;
        delay = Math.min(this.cfg.outbox.maxBackoffMs, this.cfg.outbox.pollIntervalMs * 2 ** Math.min(errorStreak, 6));
        this.logger.error({ err: err.message, errorStreak, retryInMs: delay }, 'outbox dispatch cycle failed');
      }
      if (delay > 0 && this.running) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, delay);
          this.wake = () => { clearTimeout(t); resolve(); };
        });
        this.wake = null;
      }
    }
  }

  /** One claim-publish-commit cycle. Returns the number of rows published. */
  async runOnce() {
    return withTransaction(this.pool, async (db) => {
      const { rows } = await db.query(
        `SELECT id, aggregate_id, payload, attempts FROM outbox_events
          WHERE status = 'PENDING' AND next_attempt_at <= now()
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`, [this.cfg.outbox.batchSize]);

      let published = 0;
      for (const row of rows) {
        try {
          await this.queue.add('process-booking', { ...row.payload, outboxId: row.id }, { ...jobOptions(this.cfg), jobId: jobIdFor(row.aggregate_id) });
          await db.query("UPDATE outbox_events SET status = 'PUBLISHED', published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1", [row.id]);
          this.metrics.outboxPublished.inc();
          published++;
          this._logEvent({ type: 'queue.published', bookingId: row.aggregate_id, outboxId: row.id, requestId: row.payload.requestId });
        } catch (err) {
          this.metrics.outboxErrors.inc();
          const attempts = row.attempts + 1;
          const backoff = Math.min(this.cfg.outbox.maxBackoffMs, 500 * 2 ** Math.min(attempts, 8));
          await db.query(
            `UPDATE outbox_events SET attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval WHERE id = $1`,
            [row.id, attempts, String(err.message).slice(0, 300), String(backoff)]);
          this.logger.warn({ outboxId: row.id, bookingId: row.aggregate_id, attempts, backoffMs: backoff, err: err.message }, 'outbox publish failed; will retry');
          break; // queue is probably down; do not hammer it with the rest of the batch
        }
      }
      return published;
    }, this.metrics);
  }

  _logEvent(evt) {
    const line = JSON.stringify({ ...evt, at: new Date().toISOString(), source: 'dispatcher' });
    this.redis.lpush(KEYS.workerEvents, line).then(() => this.redis.ltrim(KEYS.workerEvents, 0, WORKER_EVENTS_MAX - 1)).catch(() => {});
  }
}
