import { createLogger } from '@flashsale/common';
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

const logger = createLogger('migrate');
const cfg = loadConfig();
const pool = createPool(cfg, logger);
try {
  const r = await migrate(pool, cfg.migrationsDir, logger);
  logger.info(r, 'migrations complete');
  if (process.argv.includes('--seed')) {
    const s = await seed(pool, logger);
    logger.info(s, 'seed complete');
  }
  process.exitCode = 0;
} catch (err) {
  logger.error({ err: err.message }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
