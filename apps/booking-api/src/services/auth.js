import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from '@flashsale/common';

const scryptAsync = promisify(scrypt);

// scrypt parameters (memory-hard KDF from node:crypto, so no native dependency is needed).
// N=16384, r=8, p=1 uses ~16 MiB and ~50 ms per hash: slow enough to hurt brute force, fast enough for login.
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const dk = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const dk = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

// Hash compared against when the e-mail is unknown, so "no such user" and "wrong password"
// take about the same time (no account enumeration through response timing).
let dummyHash;
const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password-for-timing-only'));

export const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{20,100})$/;
export const extractToken = (header) => BEARER_RE.exec(header ?? '')?.[1] ?? null;

export function createAuthService({ pool, cfg, logger }) {
  const ttlHours = cfg.auth.sessionTtlHours;

  async function createSession(userId, db = pool) {
    const token = randomBytes(32).toString('base64url');
    const { rows } = await db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(hours => $3)) RETURNING expires_at`,
      [userId, sha256(token), ttlHours]);
    // housekeeping: drop expired sessions and keep at most 10 live sessions per user
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    await db.query(
      `DELETE FROM sessions WHERE user_id = $1 AND id NOT IN
         (SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10)`, [userId]);
    return { token, expiresAt: new Date(rows[0].expires_at).toISOString() };
  }

  /**
   * Create an account. If a guest row already exists for the e-mail (from a previous booking) it is
   * claimed instead. One atomic statement: the conflict branch only fires while password_hash IS NULL,
   * so an existing account can never be overwritten.
   *
   * NOTE: there is no e-mail verification in this demo, so whoever signs up first with a guest
   * e-mail claims that e-mail's booking history.
   */
  async function signup({ name, email, password }, requestId) {
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, last_login_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, last_login_at = now()
         WHERE users.password_hash IS NULL
       RETURNING id, name, email, (xmax <> 0) AS claimed`, [name, email, hash]);
    if (!rows[0]) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Try logging in.');
    const session = await createSession(rows[0].id);
    logger.info({ requestId, userId: rows[0].id, claimedGuest: rows[0].claimed }, 'account created');
    return { user: publicUser(rows[0]), ...session };
  }

  async function login({ email, password }, requestId) {
    const { rows } = await pool.query('SELECT id, name, email, password_hash FROM users WHERE email = $1', [email]);
    const u = rows[0];
    const ok = u?.password_hash ? await verifyPassword(password, u.password_hash) : (await verifyPassword(password, await getDummyHash()), false);
    if (!ok) {
      logger.warn({ requestId }, 'login failed');
      // identical message for unknown e-mail and wrong password
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
    }
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
    const session = await createSession(u.id);
    logger.info({ requestId, userId: u.id }, 'login succeeded');
    return { user: publicUser(u), ...session };
  }

  async function authenticate(token) {
    if (!token) return null;
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
    return rows[0] ? publicUser(rows[0]) : null;
  }

  async function logout(token) {
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  }

  return { signup, login, authenticate, logout };
}
