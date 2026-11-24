import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { requestIdMiddleware, errorBody, KEYS } from '@flashsale/common';
import { TokenBucketLimiter, rateLimitMiddleware } from './rate-limiter/token-bucket.js';
import { CircuitBreaker } from './resilience/circuit-breaker.js';
import { createProxy } from './proxy.js';
import { createMetrics } from './metrics.js';
import { checkServices } from './health.js';
import { buildSummary } from './summary.js';

const BREAKER_STATE_VALUE = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };
const EXPOSED_HEADERS = [
  'X-Request-Id', 'X-Cache', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset',
  'X-RateLimit-Status', 'Retry-After', 'X-Circuit-State', 'X-Retry-Attempts',
];

/**
 * Build the gateway Express app. Dependencies are injected so tests can substitute fakes.
 */
export function createApp({ cfg, redis, logger, fetchFn = fetch }) {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', true);

  const metrics = createMetrics(cfg);
  const breaker = new CircuitBreaker({
    name: 'mock-service',
    ...cfg.circuitBreaker,
    onTransition: (t) => {
      metrics.breakerState.set({ breaker: 'mock-service' }, BREAKER_STATE_VALUE[t.to]);
      metrics.breakerTransitions.inc({ breaker: 'mock-service', from: t.from, to: t.to });
      logger.warn({ breaker: 'mock-service', from: t.from, to: t.to, reason: t.reason }, 'circuit breaker transition');
    },
  });
  metrics.breakerState.set({ breaker: 'mock-service' }, 0);

  // ---- cross-cutting middleware -------------------------------------------------------------
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || cfg.corsOrigins.includes(origin)),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'X-Client-Id', 'X-Admin-Token', 'X-Simulate-Failure'],
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: 600,
  }));
  app.use(requestIdMiddleware);
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const path = req.originalUrl.split('?')[0]; // never log query strings (may contain emails)
      metrics.observe({ method: req.method, path, status: res.statusCode, durationMs });
      const level = res.statusCode >= 500 ? 'error' : res.statusCode === 429 ? 'warn' : 'info';
      logger[level]({
        requestId: req.id, method: req.method, route: path, status: res.statusCode,
        durationMs: +durationMs.toFixed(2), rateLimited: res.locals.rateLimited || undefined,
      }, 'request completed');
    });
    next();
  });

  // ---- rate limiting ------------------------------------------------------------------------
  const limiter = new TokenBucketLimiter(redis);
  const keyFor = (req, klass) => {
    const clientId = req.headers['x-client-id'];
    const id = cfg.rateLimit.trustClientId && typeof clientId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(clientId)
      ? `client:${clientId}` : `ip:${req.ip}`;
    return KEYS.rateLimit(klass, id);
  };
  const limiterOpts = { limiter, config: cfg.rateLimit, keyFor, failOpen: cfg.rateLimit.failOpen, metrics, logger, errorBody };
  const apiLimiter = rateLimitMiddleware({ ...limiterOpts, klass: 'api' });
  const monitoringLimiter = rateLimitMiddleware({ ...limiterOpts, klass: 'monitoring' });
  const authLimiter = rateLimitMiddleware({ ...limiterOpts, klass: 'auth' });

  // ---- gateway's own endpoints --------------------------------------------------------------
  app.get('/health/live', monitoringLimiter, (_req, res) => res.json({ status: 'healthy', service: 'gateway', timestamp: new Date().toISOString() }));
  app.get('/health', monitoringLimiter, (_req, res) => res.json({
    status: 'healthy', service: 'gateway', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString(),
  }));
  app.get('/health/services', monitoringLimiter, async (_req, res, next) => {
    try {
      const r = await checkServices({ redis, cfg, workerPrefix: KEYS.workerHeartbeatPrefix, breaker, fetchFn });
      res.status(r.httpStatus).json(r.body);
    } catch (err) { next(err); }
  });
  app.get('/metrics', monitoringLimiter, async (_req, res, next) => {
    try {
      res.set('Content-Type', metrics.registry.contentType);
      res.send(await metrics.registry.metrics());
    } catch (err) { next(err); }
  });
  app.get('/metrics/summary', monitoringLimiter, async (_req, res, next) => {
    try { res.json(await buildSummary({ cfg, redis, metrics, breaker, fetchFn })); } catch (err) { next(err); }
  });
  app.get('/gateway/circuit-breaker', monitoringLimiter, (_req, res) => res.json(breaker.snapshot()));

  // ---- proxied routes -----------------------------------------------------------------------
  const rawBody = express.raw({ type: () => true, limit: cfg.bodyLimit });
  const apiProxy = createProxy({
    upstream: 'booking-api', baseUrl: cfg.apiUrl, timeoutMs: cfg.upstream.apiTimeoutMs, retry: cfg.retry, metrics, logger, errorBody, fetchFn, forwardAuthorization: true,
  });
  const mockProxy = createProxy({
    upstream: 'mock-service', baseUrl: cfg.mockUrl, timeoutMs: cfg.upstream.mockTimeoutMs, retry: cfg.retry, breaker, metrics, logger, errorBody, fetchFn,
  });
  // Stricter bucket for credential endpoints; the request then also counts against the general API bucket.
  app.post(['/api/auth/login', '/api/auth/signup'], authLimiter);
  app.use('/api', apiLimiter, rawBody, apiProxy);
  app.use('/mock', apiLimiter, rawBody, mockProxy);

  // ---- fallthrough --------------------------------------------------------------------------
  app.use((req, res) => res.status(404).json(errorBody('NOT_FOUND', 'Route not found', req.id)));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', `Request body exceeds ${cfg.bodyLimit}`, req.id));
    if (err.status && err.status < 500) return res.status(err.status).json(errorBody('BAD_REQUEST', 'Malformed request', req.id));
    logger.error({ requestId: req.id, err: err.message, stack: err.stack }, 'unhandled gateway error');
    res.status(500).json(errorBody('INTERNAL_ERROR', 'Unexpected gateway error', req.id));
  });

  return { app, metrics, breaker };
}
