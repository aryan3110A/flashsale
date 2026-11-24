import { Readable } from 'node:stream';
import { withRetry, isRetryable } from './resilience/retry.js';
import { CircuitOpenError } from './resilience/circuit-breaker.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length',
]);
// Never forwarded to upstream services.
// `expect` (100-continue, sent by Windows PowerShell 5.1 and curl for large bodies) is answered by the gateway's own
// HTTP server; forwarding it makes undici reject the request (UND_ERR_NOT_SUPPORTED -> 502).
const REQUEST_STRIP = new Set(['cookie', 'expect']);
// Never copied from upstream back to the client (the gateway owns CORS and does not leak internals).
const RESPONSE_STRIP = new Set(['server', 'x-powered-by', 'content-encoding', 'access-control-allow-origin', 'access-control-allow-credentials']);

export function buildForwardHeaders(req, { forwardAuthorization = false } = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k) || REQUEST_STRIP.has(k)) continue;
    // Credentials are only passed to the service that owns authentication (booking-api), never to others.
    if (k === 'authorization' && !forwardAuthorization) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  const prior = req.headers['x-forwarded-for'];
  const remote = req.socket?.remoteAddress;
  headers['x-forwarded-for'] = [prior, remote].filter(Boolean).join(', ');
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-request-id'] = req.id;
  return headers;
}

function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.name === 'TimeoutError';
}

/**
 * Create an Express handler that forwards the request to `baseUrl`.
 * Responsibilities: header hygiene, request-id propagation, per-attempt timeout, safe retries,
 * optional circuit breaker, consistent error JSON, and status/body propagation.
 */
export function createProxy({ upstream, baseUrl, timeoutMs, retry, breaker, metrics, logger, errorBody, fetchFn = fetch, forwardAuthorization = false }) {
  return async function proxy(req, res) {
    const url = new URL(req.originalUrl, baseUrl);
    const method = req.method;
    const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
    const headers = buildForwardHeaders(req, { forwardAuthorization });
    const hasIdempotencyKey = Boolean(req.headers['idempotency-key']);

    const attemptFn = () => fetchFn(url, {
      method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });

    const run = () => withRetry(attemptFn, {
      ...retry,
      shouldRetry: (o) => isRetryable({ method, hasIdempotencyKey, error: o.error, status: o.result?.status }),
      onRetry: async ({ attempt, delay, outcome }) => {
        metrics.upstreamRetries.inc({ upstream });
        logger.warn({ requestId: req.id, upstream, attempt, delayMs: delay, status: outcome.result?.status, err: outcome.error?.message }, 'retrying upstream request');
        try { await outcome.result?.body?.cancel(); } catch { /* body already consumed */ }
      },
    });

    try {
      const { result: upstreamRes, attempts } = breaker
        ? await breaker.execute(run, (r) => r.result.status >= 500)
        : await run();

      metrics.upstreamRequests.inc({ upstream, outcome: upstreamRes.status >= 500 ? 'error' : 'ok' });
      res.status(upstreamRes.status);
      for (const [k, v] of upstreamRes.headers) {
        if (!HOP_BY_HOP.has(k) && !RESPONSE_STRIP.has(k)) res.setHeader(k, v);
      }
      if (attempts > 1) res.setHeader('X-Retry-Attempts', String(attempts));
      if (breaker) res.setHeader('X-Circuit-State', breaker.getState());
      if (!upstreamRes.body) return res.end();
      const stream = Readable.fromWeb(upstreamRes.body);
      stream.on('error', (err) => {
        logger.warn({ requestId: req.id, upstream, err: err.message }, 'upstream stream aborted');
        res.destroy(err);
      });
      stream.pipe(res);
    } catch (err) {
      res.locals.upstreamError = true;
      if (err instanceof CircuitOpenError) {
        metrics.upstreamRequests.inc({ upstream, outcome: 'circuit_open' });
        const retryAfter = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        res.setHeader('X-Circuit-State', breaker.getState());
        return res.status(503).json({
          ...errorBody('CIRCUIT_OPEN', 'The downstream service is failing; requests are being rejected fast while it recovers.', req.id),
          retryAfterSeconds: retryAfter,
          circuitState: breaker.getState(),
        });
      }
      const timeout = isTimeout(err);
      metrics.upstreamRequests.inc({ upstream, outcome: timeout ? 'timeout' : 'error' });
      logger.error({ requestId: req.id, upstream, err: err.message, cause: err.cause?.code, attempts: err.attempts }, 'upstream request failed');
      if (breaker) res.setHeader('X-Circuit-State', breaker.getState());
      if (err.attempts > 1) res.setHeader('X-Retry-Attempts', String(err.attempts));
      return res.status(timeout ? 504 : 502).json(errorBody(
        timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
        timeout ? 'The service took too long to respond.' : 'The service is currently unavailable.',
        req.id,
      ));
    }
  };
}
