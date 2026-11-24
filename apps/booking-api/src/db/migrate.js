import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_ID = 727_274_001; // arbitrary constant: serialises concurrent migrators (e.g. scaled booking-api)

export function parseMigrationName(file) {
  const m = /^(\d{3,})_([a-z0-9_]+)\.sql$/.exec(file);
  return m ? { version: m[1], name: m[2] } : null;
}

/**
 * Apply every not-yet-applied `NNN_name.sql` file in order, each inside its own transaction.
 * Applied files are recorded with a checksum; editing an applied migration is detected and refused.
 */
export async function migrate(pool, dir, logger) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        name        TEXT        NOT NULL,
        checksum    TEXT        NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Map((await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]));
    const files = (await readdir(dir)).filter((f) => parseMigrationName(f)).sort();

    for (const file of files) {
      const { version, name } = parseMigrationName(file);
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (done.has(version)) {
        if (done.get(version) !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      logger?.info({ migration: file }, 'applying migration');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [version, name, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    return { applied, total: files.length };
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } catch { /* connection gone */ }
    client.release();
  }
}
