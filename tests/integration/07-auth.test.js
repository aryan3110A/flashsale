import { createHash } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { gw, book, resetTestEvent, waitForStatus, newPool, uid } from '../helpers/env.js';

const pool = newPool();
afterAll(() => pool.end());

const PASSWORD = 'correct-horse-9';
const signup = (over = {}, opts = {}) => gw('/api/auth/signup', { method: 'POST', body: { name: 'Asha Rao', email: `${uid('acct')}@example.com`, password: PASSWORD, ...over }, ...opts });
const login = (email, password = PASSWORD, opts = {}) => gw('/api/auth/login', { method: 'POST', body: { email, password }, ...opts });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function newAccount(over = {}) {
  const email = over.email ?? `${uid('acct')}@example.com`;
  const r = await signup({ ...over, email });
  expect(r.status).toBe(201);
  return { email, token: r.json.data.token, user: r.json.data.user };
}

describe('sign-up', () => {
  it('creates an account and returns a session, never the password or its hash', async () => {
    const email = `${uid('acct')}@example.com`;
    const r = await signup({ email, name: 'Asha Rao' });
    expect(r.status).toBe(201);
    expect(r.json.data.user).toMatchObject({ name: 'Asha Rao', email });
    expect(r.json.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(r.json.data.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    expect(r.text).not.toContain(PASSWORD);
    expect(r.text).not.toMatch(/password_hash|scrypt\$/);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('stores only a salted scrypt hash and only the SHA-256 of the session token', async () => {
    const { email, token } = await newAccount();
    const { rows } = await pool.query('SELECT password_hash, id FROM users WHERE email = $1', [email]);
    expect(rows[0].password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
    const { rows: s } = await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [rows[0].id]);
    expect(s).toHaveLength(1);
    expect(s[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(s[0].token_hash).not.toBe(token);
  });

  it('rejects a duplicate e-mail with 409 and does NOT overwrite the original password', async () => {
    const { email } = await newAccount();
    const dup = await signup({ email, password: 'attacker-pass-1', name: 'Mallory' });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe('EMAIL_TAKEN');
    expect((await login(email)).status).toBe(200);                       // original password still works
    expect((await login(email, 'attacker-pass-1')).status).toBe(401);    // attacker's does not
  });

  it('treats e-mail case-insensitively', async () => {
    const email = `${uid('Case')}@Example.com`;
    expect((await signup({ email })).status).toBe(201);
    expect((await signup({ email: email.toUpperCase() })).status).toBe(409);
  });

  it.each([
    ['too short', { password: 'a1' }],
    ['no digit', { password: 'onlyletters' }],
    ['no letter', { password: '12345678' }],
    ['bad e-mail', { email: 'not-an-email' }],
    ['one-letter name', { name: 'A' }],
    ['extra field', { isAdmin: true }],
    ['SQL in e-mail', { email: "x'; DROP TABLE users;--@example.com" }],
  ])('validates input: %s -> 400', async (_l, patch) => {
    const r = await signup(patch);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('VALIDATION_ERROR');
  });
});

describe('login, sessions and logout', () => {
  it('logs in with the right password and gives a working token', async () => {
    const { email } = await newAccount();
    const r = await login(email);
    expect(r.status).toBe(200);
    const me = await gw('/api/auth/me', { headers: bearer(r.json.data.token) });
    expect(me.status).toBe(200);
    expect(me.json.data.user.email).toBe(email);
  });

  it('gives the SAME error for a wrong password and an unknown e-mail (no account enumeration)', async () => {
    const { email } = await newAccount();
    const wrong = await login(email, 'wrong-pass-1');
    const unknown = await login(`${uid('nobody')}@example.com`, 'wrong-pass-1');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.error).toBe('INVALID_CREDENTIALS');
    expect(unknown.json.message).toBe(wrong.json.message);
  });

  it('refuses /me without a token, with a garbage token, and after logout', async () => {
    const { token } = await newAccount();
    expect((await gw('/api/auth/me')).json.error).toBe('AUTH_REQUIRED');
    const garbage = await gw('/api/auth/me', { headers: bearer('A'.repeat(43)) });
    expect(garbage.status).toBe(401);
    expect(garbage.json.error).toBe('INVALID_TOKEN');
    expect((await gw('/api/auth/me', { headers: bearer(token) })).status).toBe(200);
    expect((await gw('/api/auth/logout', { method: 'POST', headers: bearer(token) })).status).toBe(200);
    expect((await gw('/api/auth/me', { headers: bearer(token) })).status).toBe(401);
  });

  it('rejects an expired session', async () => {
    const { token } = await newAccount();
    const hash = createHash('sha256').update(token).digest('hex');
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE token_hash = $1", [hash]);
    const r = await gw('/api/auth/me', { headers: bearer(token) });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('INVALID_TOKEN');
  });

  it('the Authorization header never reaches the mock service', async () => {
    const { token } = await newAccount();
    const r = await gw('/mock/normal', { headers: bearer(token) });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(token);
  });
});

describe('bookings with an account', () => {
  it('a logged-in user always books as their account (a spoofed name/e-mail in the body is ignored)', async () => {
    const ev = await resetTestEvent(10);
    const { token, email } = await newAccount({ name: 'Real Owner' });
    const spoof = `${uid('spoof')}@example.com`;
    const r = await book(ev.eventId, { quantity: 2, name: 'Spoofed Name', email: spoof, headers: bearer(token) });
    expect(r.status).toBe(202);
    await waitForStatus(r.json.data.bookingId, 'CONFIRMED');
    const mine = await gw('/api/bookings/mine', { headers: bearer(token) });
    expect(mine.status).toBe(200);
    expect(mine.json.data.map((b) => b.id)).toContain(r.json.data.bookingId);
    expect(mine.json.data[0].customerName).toBe('Real Owner');
    const { rows } = await pool.query('SELECT u.email FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.id = $1', [r.json.data.bookingId]);
    expect(rows[0].email).toBe(email);
    expect((await gw(`/api/bookings?email=${encodeURIComponent(spoof)}`)).json.data).toHaveLength(0);
  });

  it('an invalid token on /api/bookings is a 401 and changes nothing (no silent guest booking)', async () => {
    const ev = await resetTestEvent(10);
    const r = await book(ev.eventId, { quantity: 3, headers: bearer('B'.repeat(43)) });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('INVALID_TOKEN');
    const { rows } = await pool.query('SELECT available_capacity FROM events WHERE id = $1', [ev.eventId]);
    expect(rows[0].available_capacity).toBe(10);
  });

  it('guests can still book without any token', async () => {
    const ev = await resetTestEvent(10);
    expect((await book(ev.eventId)).status).toBe(202);
  });

  it('/api/bookings/mine needs a login and lists only that account\'s bookings', async () => {
    const ev = await resetTestEvent(10);
    expect((await gw('/api/bookings/mine')).status).toBe(401);
    const a = await newAccount(); const b = await newAccount();
    const ra = await book(ev.eventId, { headers: bearer(a.token) });
    await book(ev.eventId, { headers: bearer(b.token) });
    const mineA = (await gw('/api/bookings/mine', { headers: bearer(a.token) })).json.data;
    expect(mineA.map((x) => x.id)).toEqual([ra.json.data.bookingId]);
  });

  it('idempotent replay works for an authenticated booking', async () => {
    const ev = await resetTestEvent(10);
    const { token } = await newAccount();
    const key = `${uid('auth')}-idem`;
    const first = await book(ev.eventId, { quantity: 2, key, headers: bearer(token) });
    const again = await book(ev.eventId, { quantity: 2, key, headers: bearer(token) });
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect(again.json.idempotentReplay).toBe(true);
    expect(again.json.data.bookingId).toBe(first.json.data.bookingId);
  });

  it('signing up with an e-mail that already has guest bookings links that history to the new account', async () => {
    const ev = await resetTestEvent(10);
    const email = `${uid('guest')}@example.com`;
    const guest = await book(ev.eventId, { quantity: 1, email, name: 'Guest Name' });
    expect(guest.status).toBe(202);
    const r = await signup({ email, name: 'Now Registered' });
    expect(r.status).toBe(201);
    const mine = await gw('/api/bookings/mine', { headers: bearer(r.json.data.token) });
    expect(mine.json.data.map((x) => x.id)).toContain(guest.json.data.bookingId);
    expect(mine.json.data[0].customerName).toBe('Now Registered');
  });
});

describe('brute-force protection', () => {
  it('limits login attempts per client with 429 + Retry-After, without affecting other clients', async () => {
    const { email } = await newAccount();
    const attacker = uid('attacker');
    const statuses = [];
    for (let i = 0; i < 14; i++) statuses.push((await login(email, `wrong-guess-${i}`, { client: attacker })).status);
    expect(statuses.slice(0, 8).every((s) => s === 401)).toBe(true);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    const blocked = await login(email, PASSWORD, { client: attacker });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // a different client is unaffected and the real owner can log in
    expect((await login(email, PASSWORD, { client: uid('other') })).status).toBe(200);
  });
});
