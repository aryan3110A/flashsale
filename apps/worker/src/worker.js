import { hostname } from 'node:os';
import http from 'node:http';
import { Worker, UnrecoverableError } from 'bullmq';
import client from 'prom-client';
import pg from 'pg';
import { createLogger, createRedis, num, str, bool, KEYS, QUEUE_NAME, QUEUE_PREFIX } from '@flashsale/common';
import { createProcessor, createEventLogger, PermanentJobError } from './processor.js';

const logger = createLogger('worker');
const cfg = {
  databaseUrl: str('DATABASE_URL', 'postgres://flashsale:change_me_local@localhost:5432/flashsale'),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  concurrency: num('WORKER_CONCURRENCY', 5),
  processingMinMs: num('WORKER_PROCESSING_MIN_MS', 400),
  processingMaxMs: num('WORKER_PROCESSING_MAX_MS', 1200),
  healthPort: num('PORT', 9100),
  heartbeatMs: num('WORKER_HEARTBEAT_MS', 5000),
  shutdownGraceMs: num('SHUTDOWN_GRACE_MS', 20_000),
  enabled: bool('WORKER_ENABLED', true),
};
const instance = `${hostname()}-${process.pid}`;
const startedAt = Date.now();

pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: Math.max(5, cfg.concurrency * 2), connectionTimeoutMillis: 3000 });
pool.on('error', (err) => logger.error({ err: err.message }, 'idle postgres client error'));

// BullMQ needs a connection that retries forever (blocking commands). Stats/heartbeat use fail-fast ones.
const bullRedis = createRedis(cfg.redisUrl, { failFast: false, name: 'worker-bullmq', logger });
const redis = createRedis(cfg.redisUrl, { failFast: true, name: 'worker-aux', logger });

const registry = new client.Registry();
registry.setDefaultLabels({ service: 'worker' });
client.collectDefaultMetrics({ register: registry });
const jobsTotal = new client.Counter({ name: 'flashsale_worker_jobs_total', help: 'Jobs processed by outcome', labelNames: ['outcome'], registers: [registry] });
const jobDuration = new client.Histogram({ name: 'flashsale_worker_job_duration_seconds', help: 'Job processing time', buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10], registers: [registry] });

const logEvent = createEventLogger(redis);
const processor = createProcessor({ pool, logEvent, cfg, logger });

async function invalidateEventCache(released) {
  if (!released) return;
  const slug = String(released.category).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try { await redis.del(KEYS.eventsAll, KEYS.eventsFeatured, KEYS.event(released.id), KEYS.eventsCategory(slug)); } catch { /* best effort */ }
}

const stat = (field, n = 1) => redis.hincrby(KEYS.workerStats, field, n).catch(() => {});

let worker = null;
if (cfg.enabled) {
  worker = new Worker(QUEUE_NAME, async (job) => {
    try {
      const result = await processor.process(job);
      return result;
    } catch (err) {
      const attempt = job.attemptsMade + 1;
      const final = err instanceof PermanentJobError || attempt >= (job.opts.attempts ?? 1);
      if (final && job.data?.bookingId) {
        // Out of retries: fail the booking and give the tickets back before BullMQ marks the job failed.
        const released = await processor.failAndRelease(job.data.bookingId, err.message);
        await invalidateEventCache(released);
      }
      if (err instanceof PermanentJobError) throw new UnrecoverableError(err.message); // skip remaining retries
      throw err;
    }
  }, { connection: bullRedis, prefix: QUEUE_PREFIX, concurrency: cfg.concurrency });

  worker.on('completed', async (job, result) => {
    jobsTotal.inc({ outcome: 'completed' });
    jobDuration.observe(result.durationMs / 1000);
    await Promise.all([stat('processed'), stat('totalMs', result.durationMs)]);
    await logEvent({ type: 'job.completed', jobId: job.id, bookingId: job.data.bookingId, requestId: job.data.requestId, attempt: job.attemptsMade, durationMs: result.durationMs, result: result.status });
    logger.info({ jobId: job.id, bookingId: job.data.bookingId, requestId: job.data.requestId, queue: QUEUE_NAME, durationMs: result.durationMs, attempt: job.attemptsMade, finalStatus: result.status }, 'job completed');
  });

  worker.on('failed', async (job, err) => {
    if (!job) { logger.error({ err: err.message }, 'job failed (unknown job)'); return; }
    const willRetry = job.attemptsMade < (job.opts.attempts ?? 1) && !(err instanceof UnrecoverableError) && err.name !== 'UnrecoverableError';
    jobsTotal.inc({ outcome: willRetry ? 'retry' : 'failed' });
    if (willRetry) await stat('retried'); else await stat('failed');
    await logEvent({ type: willRetry ? 'job.retry' : 'job.failed', jobId: job.id, bookingId: job.data?.bookingId, requestId: job.data?.requestId, attempt: job.attemptsMade, maxAttempts: job.opts.attempts, error: err.message });
    logger[willRetry ? 'warn' : 'error']({ jobId: job.id, bookingId: job.data?.bookingId, requestId: job.data?.requestId, queue: QUEUE_NAME, attempt: job.attemptsMade, willRetry, err: err.message, finalStatus: willRetry ? 'retrying' : 'FAILED' }, 'job failed');
    if (!willRetry && job.data?.bookingId) {
      // Covers stalled-job failures, which never pass through the processor's catch block. Idempotent.
      try { await invalidateEventCache(await processor.failAndRelease(job.data.bookingId, err.message)); }
      catch (e) { logger.error({ err: e.message, bookingId: job.data.bookingId }, 'compensation failed'); }
    }
  });
  worker.on('error', (err) => logger.warn({ err: err.message }, 'worker error'));
}

// ---- heartbeat: the gateway judges worker health by this key, not by container state -------------
async function beat() {
  const s = await redis.hgetall(KEYS.workerStats).catch(() => ({}));
  const hb = { instance, pid: process.pid, ts: Date.now(), startedAt, concurrency: cfg.concurrency, running: worker ? worker.isRunning() : false, processed: Number(s.processed || 0), failed: Number(s.failed || 0) };
  await redis.set(`${KEYS.workerHeartbeatPrefix}${instance}`, JSON.stringify(hb), 'PX', cfg.heartbeatMs * 3).catch((err) => logger.warn({ err: err.message }, 'heartbeat write failed'));
}
const heartbeatTimer = setInterval(beat, cfg.heartbeatMs);
beat();

// ---- tiny internal HTTP server for Docker health checks and Prometheus ---------------------------
const server = http.createServer(async (req, res) => {
  if (req.url === '/health/live') {
    const ok = worker ? worker.isRunning() : true;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: ok ? 'healthy' : 'unhealthy', service: 'worker', instance, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));
  }
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': registry.contentType });
    return res.end(await registry.metrics());
  }
  res.writeHead(404).end();
});
server.listen(cfg.healthPort, () => logger.info({ instance, concurrency: cfg.concurrency, queue: QUEUE_NAME, port: cfg.healthPort }, 'worker started'));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down worker (waiting for active jobs)');
  const force = setTimeout(() => { logger.error('forced exit after grace period'); process.exit(1); }, cfg.shutdownGraceMs);
  force.unref();
  clearInterval(heartbeatTimer);
  try {
    await worker?.close();            // stops taking jobs, waits for in-flight ones
    await redis.del(`${KEYS.workerHeartbeatPrefix}${instance}`).catch(() => {});
    server.close();
    await redis.quit().catch(() => redis.disconnect());
    bullRedis.disconnect();
    await pool.end();
  } catch (err) { logger.error({ err: err.message }, 'error during shutdown'); }
  logger.info('worker stopped');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'unhandled promise rejection'));
process.on('uncaughtException', (err) => { logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception'); process.exit(1); });
