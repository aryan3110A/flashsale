import { fileURLToPath } from 'node:url';
import { num, str, bool } from '@flashsale/common';

export function loadConfig() {
  return {
    port: num('PORT', 8081),
    databaseUrl: str('DATABASE_URL', 'postgres://flashsale:change_me_local@localhost:5432/flashsale'),
    redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
    dbPoolMax: num('DB_POOL_MAX', 20),
    cache: {
      listTtlSeconds: num('CACHE_TTL_SECONDS', 30),
      detailTtlSeconds: num('CACHE_DETAIL_TTL_SECONDS', 30),
      jitterRatio: 0.1,
      // Benchmark switch: false bypasses Redis entirely so load tests can measure a no-cache baseline.
      enabled: bool('CACHE_ENABLED', true),
    },
    outbox: {
      pollIntervalMs: num('OUTBOX_POLL_INTERVAL_MS', 500),
      batchSize: num('OUTBOX_BATCH_SIZE', 50),
      maxBackoffMs: num('OUTBOX_MAX_BACKOFF_MS', 30_000),
      enabled: bool('OUTBOX_DISPATCHER_ENABLED', true),
    },
    job: {
      attempts: num('JOB_ATTEMPTS', 4),
      backoffMs: num('JOB_BACKOFF_MS', 1000),
    },
    booking: { maxQuantity: num('MAX_TICKETS_PER_BOOKING', 10) },
    auth: { sessionTtlHours: num('AUTH_SESSION_TTL_HOURS', 168) },
    migrationsDir: str('MIGRATIONS_DIR', fileURLToPath(new URL('../../../database/migrations', import.meta.url))),
    runMigrationsOnStart: bool('RUN_MIGRATIONS_ON_START', true),
    seedOnStart: bool('SEED_ON_START', true),
    // Demo / test hooks. Admin endpoints additionally require X-Admin-Token === ADMIN_TOKEN.
    enableChaos: bool('ENABLE_CHAOS', true),
    enableDemoEndpoints: bool('ENABLE_DEMO_ENDPOINTS', true),
    enableTestEndpoints: bool('ENABLE_TEST_ENDPOINTS', false),
    adminToken: str('ADMIN_TOKEN', ''),
    shutdownGraceMs: num('SHUTDOWN_GRACE_MS', 10_000),
  };
}
