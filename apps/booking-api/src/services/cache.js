import { KEYS } from '@flashsale/common';

/**
 * Cache-aside over Redis.
 *
 *   read:  Redis hit -> return it.  miss -> run loader (PostgreSQL), SET with TTL, return it.
 *   write: the booking path invalidates the affected keys after COMMIT.
 *
 * Redis is an optimisation, never a dependency: any Redis error is counted, logged and the
 * loader result is returned instead. Concurrent misses for one key share a single loader call
 * (in-process single-flight) to damp cache stampedes.
 */
export class EventCache {
  constructor({ redis, cfg, metrics, logger }) {
    this.redis = redis;
    this.cfg = cfg;
    this.metrics = metrics;
    this.logger = logger;
    this.inflight = new Map();
  }

  _ttl(seconds) {
    const jitter = Math.round(seconds * this.cfg.cache.jitterRatio * Math.random());
    return seconds + jitter; // jitter spreads expiry so keys do not all miss at once
  }

  _count(field) {
    this.metrics?.cacheOps.inc({ result: field });
    this.redis.hincrby(KEYS.cacheStats, field, 1).catch(() => {});
  }

  /** @returns {Promise<{value:any, source:'cache'|'database', cacheError:boolean}>} */
  async getOrLoad(key, ttlSeconds, loader) {
    if (this.cfg.cache.enabled === false) return { value: await loader(), source: 'database', cacheError: false };
    let cacheError = false;
    try {
      const raw = await this.redis.get(key);
      if (raw !== null) {
        this._count('hits');
        return { value: JSON.parse(raw), source: 'cache', cacheError: false };
      }
      this._count('misses');
    } catch (err) {
      cacheError = true;
      this.metrics?.cacheOps.inc({ result: 'errors' });
      this.logger.warn({ key, err: err.message }, 'cache read failed; falling back to database');
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const value = await loader();
        if (!cacheError && value !== null) { // never cache "not found" (avoids cache pollution by random ids)
          try { await this.redis.set(key, JSON.stringify(value), 'EX', this._ttl(ttlSeconds)); }
          catch (err) {
            this.metrics?.cacheOps.inc({ result: 'errors' });
            this.logger.warn({ key, err: err.message }, 'cache write failed');
          }
        }
        return value;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return { value: await pending, source: 'database', cacheError };
  }

  async invalidate(keys) {
    try {
      if (keys.length) await this.redis.del(...keys);
    } catch (err) {
      this.metrics?.cacheOps.inc({ result: 'errors' });
      this.logger.warn({ keys, err: err.message }, 'cache invalidation failed');
    }
  }

  /** Remove only event cache entries (never queue / rate-limit keys). Returns number removed. */
  async clearEvents() {
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', KEYS.eventsPattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) removed += await this.redis.unlink(...keys);
    } while (cursor !== '0');
    return removed;
  }

  async stats() {
    try {
      const h = await this.redis.hgetall(KEYS.cacheStats);
      const hits = Number(h.hits || 0);
      const misses = Number(h.misses || 0);
      const errors = Number(h.errors || 0);
      const total = hits + misses;
      return { available: true, hits, misses, errors, hitRatio: total ? +(hits / total).toFixed(4) : null };
    } catch (err) {
      return { available: false, reason: 'redis unreachable' };
    }
  }

  async resetStats() {
    await this.redis.del(KEYS.cacheStats);
  }
}

export const categorySlug = (c) => String(c).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
