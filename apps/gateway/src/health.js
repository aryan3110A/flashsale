const HEALTHY = 'healthy';
const UNHEALTHY = 'unhealthy';

async function timed(fn) {
  const t = Date.now();
  try {
    const out = await fn();
    return { ...out, latencyMs: Date.now() - t };
  } catch (err) {
    return { status: UNHEALTHY, message: err.name === 'TimeoutError' ? 'timeout' : (err.message || 'error').slice(0, 120), latencyMs: Date.now() - t };
  }
}

async function getJson(url, timeoutMs, fetchFn = fetch) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, body };
}

export async function checkRedis(redis) {
  return timed(async () => {
    const pong = await redis.ping();
    return pong === 'PONG' ? { status: HEALTHY } : { status: UNHEALTHY, message: 'unexpected PING reply' };
  });
}

/** Worker liveness is judged by heartbeat freshness, not by whether a container exists. */
export async function readWorkerHeartbeats(redis, prefix, staleMs, now = Date.now()) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < 200);
  if (keys.length === 0) return [];
  const values = await redis.mget(keys);
  return values.filter(Boolean).map((v) => {
    try {
      const hb = JSON.parse(v);
      return { ...hb, ageMs: now - hb.ts, fresh: now - hb.ts <= staleMs };
    } catch { return null; }
  }).filter(Boolean);
}

export async function checkWorker(redis, prefix, staleMs) {
  return timed(async () => {
    const beats = await readWorkerHeartbeats(redis, prefix, staleMs);
    const fresh = beats.filter((b) => b.fresh);
    if (fresh.length === 0) {
      return { status: UNHEALTHY, message: beats.length ? `last heartbeat ${Math.round(Math.min(...beats.map((b) => b.ageMs)) / 1000)}s ago` : 'no heartbeat found', instances: 0 };
    }
    return { status: HEALTHY, instances: fresh.length, lastHeartbeatAgeMs: Math.min(...fresh.map((b) => b.ageMs)) };
  });
}

export async function checkServices({ redis, cfg, workerPrefix, breaker, fetchFn = fetch }) {
  const t = cfg.upstream.healthTimeoutMs;
  const [redisR, apiR, mockR, workerR] = await Promise.all([
    checkRedis(redis),
    timed(async () => {
      const r = await getJson(`${cfg.apiUrl}/health/ready`, t, fetchFn);
      return { status: r.ok ? HEALTHY : UNHEALTHY, dependencies: r.body?.checks ?? null, message: r.ok ? undefined : `HTTP ${r.status}` };
    }),
    timed(async () => {
      const r = await getJson(`${cfg.mockUrl}/health`, t, fetchFn);
      return { status: r.ok ? HEALTHY : UNHEALTHY, message: r.ok ? undefined : `HTTP ${r.status}` };
    }),
    checkWorker(redis, workerPrefix, cfg.workerHeartbeatStaleMs).catch((e) => ({ status: UNHEALTHY, message: e.message })),
  ]);

  // PostgreSQL health is reported by the Booking API (the gateway never talks to the database).
  const pg = apiR.dependencies?.postgres;
  const postgresR = pg
    ? { status: pg === HEALTHY ? HEALTHY : UNHEALTHY, message: pg === HEALTHY ? undefined : 'reported by booking-api' }
    : { status: 'unknown', message: 'booking-api unreachable' };

  const details = {
    gateway: { status: HEALTHY },
    'booking-api': apiR,
    postgres: postgresR,
    redis: redisR,
    worker: workerR,
    'mock-service': mockR,
  };
  const services = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, v.status]));
  const critical = ['gateway', 'booking-api', 'postgres', 'redis'];
  const status = critical.some((k) => services[k] !== HEALTHY)
    ? 'unhealthy'
    : Object.values(services).every((s) => s === HEALTHY) ? 'healthy' : 'degraded';

  return {
    status,
    httpStatus: status === 'unhealthy' ? 503 : 200,
    body: {
      status,
      timestamp: new Date().toISOString(),
      services,
      details,
      circuitBreaker: breaker.snapshot().state,
    },
  };
}
