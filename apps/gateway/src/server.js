import { createLogger, createRedis } from '@flashsale/common';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createFetch } from './http.js';

const logger = createLogger('gateway');
const cfg = loadConfig();
const redis = createRedis(cfg.redisUrl, { failFast: true, name: 'gateway', logger });

const { app } = createApp({ cfg, redis, logger, fetchFn: createFetch({ connectTimeoutMs: cfg.upstream.connectTimeoutMs }) });
const server = app.listen(cfg.port, () => logger.info({ port: cfg.port, rateLimit: cfg.rateLimit.api }, 'gateway listening'));
server.keepAliveTimeout = 65_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down gateway');
  const force = setTimeout(() => { logger.error('forced exit after grace period'); process.exit(1); }, cfg.shutdownGraceMs);
  force.unref();
  server.close(async () => {
    try { await redis.quit(); } catch { redis.disconnect(); }
    logger.info('gateway stopped');
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'unhandled promise rejection'));
process.on('uncaughtException', (err) => { logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception'); process.exit(1); });
