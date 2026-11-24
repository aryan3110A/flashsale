import { num, str, bool, list } from '@flashsale/common';

export function loadConfig() {
  return {
    port: num('PORT', 8080),
    redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
    apiUrl: str('API_URL', 'http://localhost:8081'),
    mockUrl: str('MOCK_URL', 'http://localhost:8082'),
    corsOrigins: list('CORS_ORIGINS', ['http://localhost:3000']),
    bodyLimit: str('BODY_LIMIT', '100kb'),
    shutdownGraceMs: num('SHUTDOWN_GRACE_MS', 10_000),

    // Token Bucket: `refillRate` tokens are added every `refillIntervalMs`, up to `capacity`.
    rateLimit: {
      api: {
        capacity: num('RATE_LIMIT_CAPACITY', 40),
        refillRate: num('RATE_LIMIT_REFILL_RATE', 20),
        refillIntervalMs: num('RATE_LIMIT_REFILL_INTERVAL', 1000),
      },
      // Health / monitoring endpoints get their own, far more generous bucket so dashboards and
      // Docker health checks are never starved by (or counted against) user traffic.
      monitoring: {
        capacity: num('RATE_LIMIT_HEALTH_CAPACITY', 300),
        refillRate: num('RATE_LIMIT_HEALTH_REFILL_RATE', 150),
        refillIntervalMs: num('RATE_LIMIT_HEALTH_REFILL_INTERVAL', 1000),
      },
      // Login / sign-up are the targets of password guessing, so they get a much smaller bucket
      // (default: burst of 10, then one attempt every 2 s per client) on top of the general limit.
      auth: {
        capacity: num('RATE_LIMIT_AUTH_CAPACITY', 10),
        refillRate: num('RATE_LIMIT_AUTH_REFILL_RATE', 1),
        refillIntervalMs: num('RATE_LIMIT_AUTH_REFILL_INTERVAL', 2000),
      },
      // DEMO/TEST ONLY: lets a client choose its own bucket via X-Client-Id so load tests can
      // simulate many distinct users from one machine. Must stay false in any real deployment.
      trustClientId: bool('RATE_LIMIT_TRUST_CLIENT_ID', false),
      failOpen: bool('RATE_LIMIT_FAIL_OPEN', true),
    },

    upstream: {
      apiTimeoutMs: num('API_TIMEOUT_MS', 8000),
      mockTimeoutMs: num('MOCK_TIMEOUT_MS', 2500),
      healthTimeoutMs: num('HEALTH_TIMEOUT_MS', 2500),
      connectTimeoutMs: num('UPSTREAM_CONNECT_TIMEOUT_MS', 1000),
    },

    retry: {
      maxAttempts: num('RETRY_MAX_ATTEMPTS', 2),
      baseDelayMs: num('RETRY_BASE_DELAY_MS', 100),
      maxDelayMs: num('RETRY_MAX_DELAY_MS', 1000),
    },

    circuitBreaker: {
      failureThreshold: num('CIRCUIT_FAILURE_THRESHOLD', 3),
      resetTimeoutMs: num('CIRCUIT_RESET_TIMEOUT_MS', 10_000),
      halfOpenMaxCalls: num('CIRCUIT_HALF_OPEN_MAX_CALLS', 1),
      successThreshold: num('CIRCUIT_SUCCESS_THRESHOLD', 2),
    },

    workerHeartbeatStaleMs: num('WORKER_HEARTBEAT_STALE_MS', 15_000),
    metricsBucketMs: num('METRICS_BUCKET_MS', 5000),
    metricsBuckets: num('METRICS_BUCKETS', 120),
    trustProxy: bool('TRUST_PROXY', false),
  };
}
