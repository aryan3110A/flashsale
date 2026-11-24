import { KEYS } from '@flashsale/common';
import { readWorkerHeartbeats } from './health.js';

const unavailable = (reason) => ({ available: false, reason });

/** Fetch internal stats from the Booking API (cache counters, queue depth, DB failures, outbox). */
async function fetchApiStats(cfg, fetchFn = fetch) {
  try {
    const res = await fetchFn(`${cfg.apiUrl}/internal/stats`, { signal: AbortSignal.timeout(cfg.upstream.healthTimeoutMs) });
    if (!res.ok) return { error: `booking-api HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (err) {
    return { error: err.name === 'TimeoutError' ? 'booking-api timeout' : 'booking-api unreachable' };
  }
}

/**
 * Everything the monitoring dashboard needs, in one call. A value that cannot be measured right
 * now is reported as `{available:false, reason}` rather than invented.
 */
export async function buildSummary({ cfg, redis, metrics, breaker, fetchFn = fetch }) {
  const [api, workerStatsRaw, beats] = await Promise.all([
    fetchApiStats(cfg, fetchFn),
    redis.hgetall(KEYS.workerStats).catch(() => null),
    readWorkerHeartbeats(redis, KEYS.workerHeartbeatPrefix, cfg.workerHeartbeatStaleMs).catch(() => null),
  ]);

  const stats = api.data;
  const cache = stats?.cache ?? unavailable(api.error ?? 'no data');
  const queue = stats?.queue ?? unavailable(api.error ?? 'no data');

  let worker;
  if (workerStatsRaw === null || beats === null) {
    worker = unavailable('redis unreachable');
  } else {
    const processed = Number(workerStatsRaw.processed || 0);
    const failed = Number(workerStatsRaw.failed || 0);
    const retried = Number(workerStatsRaw.retried || 0);
    const totalMs = Number(workerStatsRaw.totalMs || 0);
    const fresh = beats.filter((b) => b.fresh);
    worker = {
      available: true,
      instances: fresh.length,
      completed: processed,
      failed,
      retried,
      avgProcessingMs: processed ? +(totalMs / processed).toFixed(1) : 0,
    };
  }

  if (queue.available !== false && worker.available) {
    queue.completed = worker.completed;
    queue.completedNote = 'lifetime counter maintained by the worker (BullMQ trims finished jobs)';
  }

  return {
    generatedAt: new Date().toISOString(),
    gateway: metrics.summary(),
    series: metrics.series.toArray(),
    circuitBreaker: breaker.snapshot(),
    cache,
    queue,
    worker,
    database: stats?.database ?? unavailable(api.error ?? 'no data'),
    outbox: stats?.outbox ?? unavailable(api.error ?? 'no data'),
    rateLimit: {
      capacity: cfg.rateLimit.api.capacity,
      refillRate: cfg.rateLimit.api.refillRate,
      refillIntervalMs: cfg.rateLimit.api.refillIntervalMs,
    },
  };
}
