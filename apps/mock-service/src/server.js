import express from 'express';
import { createLogger, requestIdMiddleware, errorBody, num, bool } from '@flashsale/common';

const logger = createLogger('mock-service');
const PORT = num('PORT', 8082);
const CHAOS = bool('ENABLE_CHAOS', true);
const DEFAULT_SLOW_MS = num('MOCK_SLOW_MS', 4000);

/**
 * Stand-in for a flaky downstream dependency (payment provider, notification service...).
 *   /mock/normal   always fast and healthy
 *   /mock/slow     responds after ?ms= (default 4s) - longer than the gateway timeout
 *   /mock/fail     always HTTP 503
 *   /mock/flaky    fails with probability ?rate= (default 0.5)
 *   /mock/service  behaviour follows the mode set via POST /mock/control (normal|failing|slow)
 */
function createMockApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(requestIdMiddleware);

  const state = { mode: 'normal', changedAt: new Date().toISOString(), served: 0, failed: 0 };
  const base = (req) => ({ service: 'mock-service', requestId: req.id, mode: state.mode, timestamp: new Date().toISOString() });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clampMs = (v, fallback) => Math.min(Math.max(Number(v) || fallback, 0), 15_000);

  app.get('/health', (_req, res) => res.json({ status: 'healthy', service: 'mock-service', mode: state.mode }));

  app.get('/mock/normal', (req, res) => { state.served++; res.json({ ok: true, ...base(req), scenario: 'normal' }); });

  app.get('/mock/slow', async (req, res) => {
    const ms = clampMs(req.query.ms, DEFAULT_SLOW_MS);
    await sleep(ms);
    state.served++;
    res.json({ ok: true, ...base(req), scenario: 'slow', simulatedLatencyMs: ms });
  });

  app.get('/mock/fail', (req, res) => {
    state.failed++;
    logger.warn({ requestId: req.id }, 'fault injection: simulated downstream failure');
    res.status(503).json({ ok: false, ...base(req), scenario: 'fail', error: 'SIMULATED_FAILURE' });
  });

  app.get('/mock/flaky', (req, res) => {
    const rate = Math.min(Math.max(Number(req.query.rate ?? 0.5), 0), 1);
    if (Math.random() < rate) { state.failed++; return res.status(503).json({ ok: false, ...base(req), scenario: 'flaky', error: 'SIMULATED_FAILURE' }); }
    state.served++;
    res.json({ ok: true, ...base(req), scenario: 'flaky' });
  });

  app.get('/mock/service', async (req, res) => {
    if (state.mode === 'failing') {
      state.failed++;
      return res.status(503).json({ ok: false, ...base(req), scenario: 'service', error: 'SERVICE_DOWN' });
    }
    if (state.mode === 'slow') await sleep(DEFAULT_SLOW_MS);
    state.served++;
    res.json({ ok: true, ...base(req), scenario: 'service' });
  });

  app.get('/mock/control', (_req, res) => res.json({ ...state, chaosEnabled: CHAOS }));
  app.post('/mock/control', (req, res) => {
    if (!CHAOS) return res.status(403).json(errorBody('CHAOS_DISABLED', 'Fault injection is disabled', req.id));
    const mode = req.body?.mode;
    if (!['normal', 'failing', 'slow'].includes(mode)) {
      return res.status(400).json(errorBody('VALIDATION_ERROR', 'mode must be one of normal | failing | slow', req.id));
    }
    state.mode = mode;
    state.changedAt = new Date().toISOString();
    logger.warn({ requestId: req.id, mode }, 'mock service mode changed');
    res.json({ ok: true, ...state });
  });

  app.use((req, res) => res.status(404).json(errorBody('NOT_FOUND', 'Route not found', req.id)));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    logger.error({ requestId: req.id, err: err.message }, 'mock service error');
    res.status(err.status || 500).json(errorBody('INTERNAL_ERROR', 'Unexpected error', req.id));
  });
  return app;
}

const server = createMockApp().listen(PORT, () => logger.info({ port: PORT }, 'mock service listening'));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
