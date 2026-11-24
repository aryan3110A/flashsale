import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { requestIdMiddleware, AppError, errorBody, KEYS } from '@flashsale/common';
import { createEventService } from './services/events.js';
import { createBookingService } from './services/bookings.js';
import { jobIdFor } from './services/queue.js';
import { bookingSchema, eventQuerySchema, emailQuerySchema, signupSchema, loginSchema, resetSchema, IDEMPOTENCY_KEY_RE } from './validation.js';
import { createAuthService, extractToken } from './services/auth.js';
import { withTransaction } from './db/pool.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export function createApp({ cfg, pool, redis, queue, cache, dispatcher, metrics, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use(requestIdMiddleware);
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
      metrics.httpDuration.observe({ route }, ms / 1000);
      if (route !== '/health/live' && route !== '/internal/stats') {
        logger[res.statusCode >= 500 ? 'error' : 'info']({
          requestId: req.id, method: req.method, route, status: res.statusCode, durationMs: +ms.toFixed(2),
        }, 'request completed');
      }
    });
    next();
  });

  const events = createEventService({ pool, cache, cfg });
  const bookings = createBookingService({ pool, cache, metrics, cfg, dispatcher, logger });
  const schema = bookingSchema(cfg.booking.maxQuantity);
  const auth = createAuthService({ pool, cfg, logger });

  // Authentication is OPTIONAL for booking (guests can still book) but, when a token is presented,
  // it must be valid: a bad token is a 401, never silently treated as a guest.
  const optionalAuth = async (req, _res, next) => {
    try {
      const header = req.get('Authorization');
      if (!header) return next();
      const token = extractToken(header);
      const user = token ? await auth.authenticate(token) : null;
      if (!user) throw new AppError(401, 'INVALID_TOKEN', 'Your session has expired. Please log in again.');
      req.user = user; req.token = token;
      next();
    } catch (err) { next(err); }
  };
  const requireAuth = (req, res, next) => optionalAuth(req, res, (e) => {
    if (e) return next(e);
    return req.user ? next() : next(new AppError(401, 'AUTH_REQUIRED', 'Please log in.'));
  });
  const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  const setCacheHeaders = (res, r) => res.set('X-Cache', r.source === 'cache' ? 'HIT' : 'MISS');

  // ---- health / internal --------------------------------------------------------------------
  app.get('/health/live', (_req, res) => res.json({ status: 'healthy', service: 'booking-api' }));

  app.get('/health/ready', async (_req, res) => {
    const checks = { postgres: 'healthy', redis: 'healthy' };
    await Promise.all([
      withTimeout(pool.query('SELECT 1'), 1200).catch(() => { checks.postgres = 'unhealthy'; }),
      withTimeout(redis.ping(), 1000).catch(() => { checks.redis = 'unhealthy'; }),
    ]);
    // Postgres is mandatory for serving traffic. Redis loss only degrades (cache bypass, queue deferred).
    const ready = checks.postgres === 'healthy';
    res.status(ready ? 200 : 503).json({ status: !ready ? 'unhealthy' : checks.redis === 'healthy' ? 'healthy' : 'degraded', service: 'booking-api', checks });
  });

  app.get('/internal/stats', async (_req, res) => {
    const [cacheStats, counts, outbox] = await Promise.all([
      cache.stats(),
      withTimeout(queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'paused'), 1200).catch(() => null),
      pool.query("SELECT status, count(*)::int AS n FROM outbox_events GROUP BY status").then((r) => Object.fromEntries(r.rows.map((x) => [x.status, x.n]))).catch(() => null),
    ]);
    const dbFailures = (await metrics.dbFailures.get()).values.reduce((a, v) => a + v.value, 0);
    res.json({
      cache: cacheStats,
      queue: counts ? { available: true, waiting: counts.waiting + (counts.paused || 0), active: counts.active, delayed: counts.delayed, failed: counts.failed } : { available: false, reason: 'redis unreachable' },
      database: { available: true, queryFailures: dbFailures, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } },
      outbox: outbox ? { available: true, pending: outbox.PENDING || 0, published: outbox.PUBLISHED || 0, failed: outbox.FAILED || 0 } : { available: false, reason: 'database unreachable' },
    });
  });

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  // ---- public API ---------------------------------------------------------------------------
  app.get('/api/ping', (_req, res) => res.json({ success: true, pong: true, timestamp: new Date().toISOString() }));

  app.get('/api/events', async (req, res) => {
    const parsed = eventQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter parameters.', parsed.error.flatten().fieldErrors);
    const r = await events.list(parsed.data);
    setCacheHeaders(res, r);
    res.json({ success: true, data: r.events, meta: { count: r.events.length, source: r.source, cacheKey: r.cacheKey, cacheError: r.cacheError, lookupMs: +r.lookupMs.toFixed(2) } });
  });

  app.get('/api/events/featured', async (_req, res) => {
    const r = await events.featured();
    setCacheHeaders(res, r);
    res.json({ success: true, data: r.events, meta: { count: r.events.length, source: r.source, cacheKey: r.cacheKey, lookupMs: +r.lookupMs.toFixed(2) } });
  });

  app.get('/api/events/:id', async (req, res) => {
    const r = await events.get(req.params.id);
    setCacheHeaders(res, r);
    // Cached inventory is for display only; the booking transaction re-checks PostgreSQL.
    res.json({ success: true, data: r.event, meta: { source: r.source, cacheKey: r.cacheKey, lookupMs: +r.lookupMs.toFixed(2), inventoryAuthoritative: false } });
  });

  app.get('/api/categories', async (_req, res) => {
    const r = await events.categories();
    res.json({ success: true, data: r.categories });
  });

  // ---- accounts -----------------------------------------------------------------------------
  app.post('/api/auth/signup', noStore, async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Sign-up details are invalid.', parsed.error.flatten().fieldErrors);
    res.status(201).json({ success: true, data: await auth.signup(parsed.data, req.id) });
  });

  app.post('/api/auth/login', noStore, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Enter your email and password.', parsed.error.flatten().fieldErrors);
    res.json({ success: true, data: await auth.login(parsed.data, req.id) });
  });

  app.get('/api/auth/me', noStore, requireAuth, (req, res) => res.json({ success: true, data: { user: req.user } }));

  app.post('/api/auth/logout', noStore, async (req, res) => {
    await auth.logout(extractToken(req.get('Authorization')));
    res.json({ success: true, data: { loggedOut: true } });
  });

  app.post('/api/bookings', optionalAuth, async (req, res) => {
    const key = req.get('Idempotency-Key');
    if (!key) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header is required for bookings.');
    if (!IDEMPOTENCY_KEY_RE.test(key)) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 characters of letters, digits, . _ : -');
    // A logged-in user always books as themselves: name/email come from the account, not the body.
    const body = req.user && req.body && typeof req.body === 'object' ? { ...req.body, name: req.user.name, email: req.user.email } : req.body;
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Booking request is invalid.', parsed.error.flatten().fieldErrors);

    const sim = req.get('X-Simulate-Failure');
    const simulate = cfg.enableChaos && ['transient', 'permanent'].includes(sim) ? sim : undefined;

    const { booking, replayed } = await bookings.create({ input: parsed.data, idempotencyKey: key, requestId: req.id, simulate });
    const statusUrl = `/api/bookings/${booking.id}`;
    res.status(replayed ? 200 : 202).json({
      success: true,
      message: replayed ? 'Duplicate request: returning the original booking' : 'Booking accepted for processing',
      idempotentReplay: replayed,
      data: { bookingId: booking.id, bookingReference: booking.reference, status: booking.status, quantity: booking.quantity, totalAmount: booking.totalAmount, eventId: booking.eventId, statusUrl },
    });
  });

  // Must be registered before /api/bookings/:id (otherwise "mine" would be treated as an id).
  app.get('/api/bookings/mine', noStore, requireAuth, async (req, res) => {
    res.json({ success: true, data: await bookings.listByEmail(req.user.email) });
  });

  app.get('/api/bookings/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new AppError(400, 'INVALID_BOOKING_ID', 'Booking id must be a UUID.');
    const booking = await bookings.getById(req.params.id);
    let job = null;
    try {
      const j = await withTimeout(queue.getJob(jobIdFor(booking.id)), 600);
      if (j) job = { state: await withTimeout(j.getState(), 600), attemptsMade: j.attemptsMade, maxAttempts: j.opts.attempts };
    } catch { /* queue info is best-effort; the database row is the source of truth */ }
    res.json({ success: true, data: { ...booking, job } });
  });

  app.get('/api/bookings', async (req, res) => {
    const parsed = emailQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Provide the email used for the booking: ?email=you@example.com');
    res.json({ success: true, data: await bookings.listByEmail(parsed.data.email) });
  });

  // ---- demo / playground helpers ------------------------------------------------------------
  if (cfg.enableDemoEndpoints) {
    app.get('/api/cache/stats', async (_req, res) => res.json({ success: true, data: await cache.stats() }));

    app.post('/api/cache/clear', async (req, res) => {
      let removed;
      try { removed = await cache.clearEvents(); } catch { throw new AppError(503, 'CACHE_UNAVAILABLE', 'Redis is unavailable.'); }
      logger.warn({ requestId: req.id, removed }, 'event cache cleared by request');
      res.json({ success: true, data: { removedKeys: removed } });
    });

    app.get('/api/demo/event', async (_req, res) => {
      const { rows } = await pool.query("SELECT id, available_capacity FROM events WHERE slug = 'demo-playground-event'");
      if (!rows[0]) throw new AppError(404, 'EVENT_NOT_FOUND', 'Demo event is not seeded.');
      res.json({ success: true, data: { eventId: rows[0].id, availableCapacity: rows[0].available_capacity, chaosEnabled: cfg.enableChaos } });
    });

    // ---- live flash-sale simulator (hidden 'flash-sale-demo' event only) ----
    const FLASH_SLUG = 'flash-sale-demo';
    const flashState = async (db = pool) => {
      const { rows } = await db.query(
        `SELECT e.id, e.title, e.total_capacity, e.available_capacity, e.status,
                COALESCE(SUM(b.quantity) FILTER (WHERE b.status IN ('PROCESSING','CONFIRMED')), 0)::int AS reserved,
                COUNT(b.id)::int AS bookings,
                COUNT(b.id) FILTER (WHERE b.status = 'CONFIRMED')::int AS confirmed,
                COUNT(b.id) FILTER (WHERE b.status = 'PROCESSING')::int AS processing,
                COUNT(b.id) FILTER (WHERE b.status = 'FAILED')::int AS failed
           FROM events e LEFT JOIN bookings b ON b.event_id = e.id
          WHERE e.slug = $1 GROUP BY e.id`, [FLASH_SLUG]);
      const r = rows[0];
      if (!r) throw new AppError(404, 'EVENT_NOT_FOUND', 'Flash-sale demo event is not seeded.');
      const list = await db.query(
        `SELECT b.booking_reference AS reference, b.status, b.quantity, b.failure_reason AS "failureReason",
                u.name AS "customerName", b.created_at AS "createdAt"
           FROM bookings b JOIN users u ON u.id = b.user_id
          WHERE b.event_id = $1 ORDER BY b.created_at LIMIT 300`, [r.id]);
      return {
        eventId: r.id, title: r.title, totalCapacity: r.total_capacity, availableCapacity: r.available_capacity, status: r.status,
        bookings: r.bookings, confirmed: r.confirmed, processing: r.processing, failed: r.failed, reservedTickets: r.reserved,
        // total - available must equal the tickets held by live bookings, and stock can never be negative
        consistent: r.total_capacity - r.available_capacity === r.reserved && r.available_capacity >= 0,
        list: list.rows.map((x) => ({ ...x, createdAt: new Date(x.createdAt).toISOString() })),
      };
    };
    app.get('/api/demo/flash-sale', noStore, async (_req, res) => res.json({ success: true, data: await flashState() }));

    // Resets ONLY the hidden demo event: removes its own bookings/outbox rows and restores stock.
    app.post('/api/demo/flash-sale/reset', noStore, async (req, res) => {
      const parsed = resetSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'capacity must be a whole number between 1 and 1000.');
      const capacity = parsed.data.capacity ?? 50;
      const state = await withTransaction(pool, async (db) => {
        const { rows } = await db.query('SELECT id FROM events WHERE slug = $1 FOR UPDATE', [FLASH_SLUG]);
        if (!rows[0]) throw new AppError(404, 'EVENT_NOT_FOUND', 'Flash-sale demo event is not seeded.');
        const id = rows[0].id;
        await db.query('DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM bookings WHERE event_id = $1)', [id]);
        await db.query('DELETE FROM bookings WHERE event_id = $1', [id]);
        await db.query("UPDATE events SET total_capacity = $2, available_capacity = $2, status = 'ON_SALE', event_date = now() + interval '30 days', updated_at = now() WHERE id = $1", [id, capacity]);
        return flashState(db);
      }, metrics);
      await cache.invalidate([KEYS.event(state.eventId)]);
      logger.warn({ requestId: req.id, capacity }, 'flash-sale demo event reset');
      res.json({ success: true, data: state });
    });

    app.get('/api/worker/events', async (req, res) => {
      const bookingId = typeof req.query.bookingId === 'string' ? req.query.bookingId : null;
      let lines;
      try { lines = await redis.lrange(KEYS.workerEvents, 0, 299); } catch { throw new AppError(503, 'REDIS_UNAVAILABLE', 'Worker event log unavailable.'); }
      let items = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (bookingId) items = items.filter((e) => e.bookingId === bookingId);
      res.json({ success: true, data: items.slice(0, 60).reverse() });
    });
  }

  // ---- test-only admin (disabled unless ENABLE_TEST_ENDPOINTS=true AND token matches) --------
  if (cfg.enableTestEndpoints && cfg.adminToken) {
    const requireAdmin = (req, _res, next) => {
      const given = Buffer.from(String(req.get('X-Admin-Token') || ''));
      const want = Buffer.from(cfg.adminToken);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return next(new AppError(403, 'FORBIDDEN', 'Admin token required.'));
      next();
    };
    const testEventState = async (db = pool) => {
      const { rows } = await db.query(`
        SELECT e.id, e.total_capacity, e.available_capacity, e.status,
               COALESCE(SUM(b.quantity) FILTER (WHERE b.status IN ('PROCESSING','CONFIRMED')), 0)::int AS reserved,
               COUNT(b.id)::int AS bookings,
               COUNT(b.id) FILTER (WHERE b.status = 'CONFIRMED')::int AS confirmed,
               COUNT(b.id) FILTER (WHERE b.status = 'PROCESSING')::int AS processing,
               COUNT(b.id) FILTER (WHERE b.status = 'FAILED')::int AS failed
          FROM events e LEFT JOIN bookings b ON b.event_id = e.id
         WHERE e.slug = 'load-test-event' GROUP BY e.id`);
      const r = rows[0];
      return { eventId: r.id, totalCapacity: r.total_capacity, availableCapacity: r.available_capacity, status: r.status,
        bookings: r.bookings, confirmed: r.confirmed, processing: r.processing, failed: r.failed, reservedTickets: r.reserved,
        consistent: r.total_capacity - r.available_capacity === r.reserved && r.available_capacity >= 0 };
    };
    app.get('/api/admin/test-event', requireAdmin, async (_req, res) => res.json({ success: true, data: await testEventState() }));
    app.post('/api/admin/test-event/reset', requireAdmin, async (req, res) => {
      const capacity = Math.min(Math.max(parseInt(req.body?.capacity ?? 10, 10) || 10, 1), 100_000);
      const state = await withTransaction(pool, async (db) => {
        const { rows } = await db.query("SELECT id FROM events WHERE slug = 'load-test-event' FOR UPDATE");
        const id = rows[0].id;
        await db.query('DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM bookings WHERE event_id = $1)', [id]);
        await db.query('DELETE FROM bookings WHERE event_id = $1', [id]);
        await db.query("UPDATE events SET total_capacity = $2, available_capacity = $2, status = 'ON_SALE', event_date = now() + interval '30 days', updated_at = now() WHERE id = $1", [id, capacity]);
        return testEventState(db);
      }, metrics);
      await cache.invalidate([KEYS.event(state.eventId)]);
      res.json({ success: true, data: state });
    });
  }

  // ---- fallthrough --------------------------------------------------------------------------
  app.use((req, res) => res.status(404).json(errorBody('NOT_FOUND', 'Route not found', req.id)));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json(errorBody(err.code, err.message, req.id, err.details));
    if (err.type === 'entity.too.large') return res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', 'Request body too large', req.id));
    if (err.type === 'entity.parse.failed') return res.status(400).json(errorBody('INVALID_JSON', 'Request body is not valid JSON', req.id));
    // Anything else is unexpected: log the detail server-side, return a generic message.
    const infra = !err.code || /^(08|53|57|58)/.test(String(err.code)) || ['ECONNREFUSED', 'ETIMEDOUT'].includes(err.code);
    logger.error({ requestId: req.id, err: err.message, code: err.code, stack: err.stack }, 'unhandled request error');
    if (infra) return res.status(503).json(errorBody('SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Please retry.', req.id));
    res.status(500).json(errorBody('INTERNAL_ERROR', 'Unexpected error', req.id));
  });

  return app;
}
