import Redis from 'ioredis';

/**
 * Create an ioredis client.
 *  - `failFast: true`  -> commands reject quickly while Redis is down (used by request paths: rate limiter, cache).
 *  - `failFast: false` -> commands queue and retry forever (used by BullMQ workers, which must survive outages).
 */
export function createRedis(url, { failFast = false, name = 'redis', logger, commandTimeout = 500 } = {}) {
  const opts = failFast
    ? { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout, connectTimeout: 2000 }
    : { maxRetriesPerRequest: null };
  const client = new Redis(url, {
    ...opts,
    connectionName: name,
    retryStrategy: (times) => Math.min(times * 200, 3000),
    reconnectOnError: () => false,
  });
  let lastLogged = 0;
  client.on('error', (err) => {
    // ioredis emits an error per failed reconnect; throttle to one line every 10s.
    const now = Date.now();
    if (logger && now - lastLogged > 10_000) {
      lastLogged = now;
      logger.warn({ redis: name, err: err.message }, 'redis connection error');
    }
  });
  client.on('ready', () => logger?.info({ redis: name }, 'redis ready'));
  return client;
}
