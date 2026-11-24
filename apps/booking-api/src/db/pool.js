import pg from 'pg';

// NUMERIC -> JS number for money fields (2 decimal places, far below float precision limits).
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

export function createPool(cfg, logger, metrics) {
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10_000,
  });
  pool.on('error', (err) => {
    // Idle client errors (e.g. PostgreSQL restarted). The pool discards the client; nothing else to do.
    metrics?.dbFailures.inc({ kind: 'pool' });
    logger.error({ err: err.message }, 'idle postgres client error');
  });
  return pool;
}

/** Run `fn(client)` inside BEGIN/COMMIT; ROLLBACK on any error. */
export async function withTransaction(pool, fn, metrics) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    if (isInfrastructureError(err)) metrics?.dbFailures.inc({ kind: 'transaction' });
    throw err;
  } finally {
    client.release();
  }
}

/** Connection / server problems (as opposed to business errors like constraint violations). */
export function isInfrastructureError(err) {
  const code = err?.code;
  if (!code) return true;                       // network level errors without a SQLSTATE
  return /^(08|53|57|58|XX)/.test(String(code)) || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code);
}
