/**
 * Redis-backed Token Bucket.
 *
 * State per key (a Redis hash): `tokens` (float) and `ts` (ms timestamp of last update).
 * The whole read-refill-consume-write cycle runs inside ONE Lua script, which Redis executes
 * atomically, so concurrent requests (even from several gateway instances) can never both spend
 * the same token. Time comes from Redis (`TIME`) so gateways with skewed clocks agree.
 *
 * Refill: tokens += elapsedMs * (refillRate / refillIntervalMs), capped at `capacity`.
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local refill_interval = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local per_ms = refill_rate / refill_interval
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * per_ms)

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / per_ms)
end

local full_ms = math.ceil((capacity - tokens) / per_ms)
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, math.max(1000, full_ms * 2 + 1000))

return { allowed, math.floor(tokens), retry_ms, full_ms }
`;

export class TokenBucketLimiter {
  /**
   * @param {import('ioredis').Redis} redis
   */
  constructor(redis) {
    this.redis = redis;
    if (!redis.tokenBucket) {
      redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
    }
  }

  /**
   * Try to take `cost` tokens.
   * @returns {Promise<{allowed:boolean, remaining:number, retryAfterMs:number, resetMs:number}>}
   */
  async consume(key, { capacity, refillRate, refillIntervalMs }, cost = 1) {
    if (capacity <= 0 || refillRate <= 0 || refillIntervalMs <= 0) {
      throw new Error('Invalid token bucket configuration');
    }
    const [allowed, remaining, retryMs, fullMs] = await this.redis.tokenBucket(
      key, capacity, refillRate, refillIntervalMs, cost,
    );
    return {
      allowed: Number(allowed) === 1,
      remaining: Number(remaining),
      retryAfterMs: Number(retryMs),
      resetMs: Number(fullMs),
    };
  }
}

/**
 * Express middleware factory.
 * @param {object} o
 * @param {TokenBucketLimiter} o.limiter
 * @param {() => object} o.getConfig   returns bucket config for the request's class
 * @param {(req) => string} o.keyFor
 */
export function rateLimitMiddleware({ limiter, config, klass, keyFor, failOpen, metrics, logger, errorBody }) {
  const bucket = config[klass];
  return async function rateLimit(req, res, next) {
    const key = keyFor(req, klass);
    res.setHeader('X-RateLimit-Limit', String(bucket.capacity));
    try {
      const r = await limiter.consume(key, bucket, 1);
      res.setHeader('X-RateLimit-Remaining', String(r.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(r.resetMs / 1000)));
      if (r.allowed) return next();
      const retryAfter = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.locals.rateLimited = true;
      return res.status(429).json({
        ...errorBody('RATE_LIMIT_EXCEEDED', 'Too many requests. Please try again later.', req.id),
        retryAfterSeconds: retryAfter,
      });
    } catch (err) {
      metrics?.rateLimiterErrors.inc();
      logger.error({ requestId: req.id, err: err.message }, 'rate limiter unavailable');
      if (failOpen) {
        res.setHeader('X-RateLimit-Status', 'bypassed');
        return next();
      }
      return res.status(503).json(errorBody('RATE_LIMITER_UNAVAILABLE', 'Request protection is temporarily unavailable.', req.id));
    }
  };
}
