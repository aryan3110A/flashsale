import { randomUUID } from 'node:crypto';

const VALID = /^[A-Za-z0-9._-]{8,100}$/;

/** Accept a caller supplied request id only if it is safe to log and forward; otherwise mint one. */
export function resolveRequestId(header) {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === 'string' && VALID.test(v) ? v : randomUUID();
}

/** Express middleware: attaches req.id and echoes it as X-Request-Id. */
export function requestIdMiddleware(req, res, next) {
  req.id = resolveRequestId(req.headers['x-request-id']);
  res.setHeader('X-Request-Id', req.id);
  next();
}
