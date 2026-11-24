import { createLogger, createRedis } from '@flashsale/common';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { createMetrics } from './metrics.js';
import { createBookingQueue } from './services/queue.js';
import { EventCache } from './services/cache.js';
import { OutboxDispatcher } from './services/outbox-dispatcher.js';
import { createApp } from './app.js';

const logger = createLogger('booking-api');
const cfg = loadConfig();
const metrics = createMetrics();

const pool = createPool(cfg, logger, metrics);
// Two fail-fast Redis connections: one for cache/stats, one for the BullMQ producer.
const redis = createRedis(cfg.redisUrl, { failFast: true, name: 'booking-api-cache', logger });
const queueRedis = createRedis(cfg.redisUrl, { failFast: true, name: 'booking-api-queue', logger, commandTimeout: 2500 });

async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      logger.warn({ attempt, err: err.message }, 'waiting for PostgreSQL');
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

await connectWithRetry();
if (cfg.runMigrationsOnStart) {
  const r = await migrate(pool, cfg.migrationsDir, logger);
  logger.info(r, 'migrations up to date');
}
if (cfg.seedOnStart) await seed(pool, logger);

const queue = createBookingQueue(queueRedis);
queue.on('error', (err) => logger.warn({ err: err.message }, 'queue error'));
const cache = new EventCache({ redis, cfg, metrics, logger });
const dispatcher = new OutboxDispatcher({ pool, queue, redis, cfg, logger, metrics });

const app = createApp({ cfg, pool, redis, queue, cache, dispatcher, metrics, logger });
const server = app.listen(cfg.port, () => logger.info({ port: cfg.port }, 'booking api listening'));
server.keepAliveTimeout = 65_000;
if (cfg.outbox.enabled) dispatcher.start();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down booking api');
  const force = setTimeout(() => { logger.error('forced exit after grace period'); process.exit(1); }, cfg.shutdownGraceMs);
  force.unref();
  server.close();
  server.closeIdleConnections();
  try {
    await dispatcher.stop();
    await queue.close();
    await redis.quit().catch(() => redis.disconnect());
    queueRedis.disconnect();
    await pool.end();
  } catch (err) { logger.error({ err: err.message }, 'error during shutdown'); }
  logger.info('booking api stopped');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'unhandled promise rejection'));
process.on('uncaughtException', (err) => { logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception'); process.exit(1); });
