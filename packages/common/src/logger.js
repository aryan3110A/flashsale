import pino from 'pino';

/**
 * Structured JSON logger. Every line carries `service`, an ISO timestamp and a level label.
 * Secrets are redacted by path so they cannot leak into logs even if a caller logs a whole object.
 */
export function createLogger(service, extra = {}) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service, ...extra },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: [
        'password', '*.password', 'token', '*.token', 'authorization', '*.authorization',
        'headers.authorization', 'headers.cookie', 'req.headers.authorization', 'req.headers.cookie',
        'headers["x-admin-token"]', '*.adminToken', 'DATABASE_URL', 'REDIS_URL',
      ],
      censor: '[REDACTED]',
    },
  });
}
