import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, extractToken } from '../../apps/booking-api/src/services/auth.js';
import { signupSchema, loginSchema } from '../../apps/booking-api/src/validation.js';

describe('password hashing (scrypt)', () => {
  it('produces a self-describing hash that verifies the right password only', async () => {
    const h = await hashPassword('correct horse 9');
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(h).not.toContain('correct horse');
    expect(await verifyPassword('correct horse 9', h)).toBe(true);
    expect(await verifyPassword('correct horse 8', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  it('uses a fresh random salt each time', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password-1'), hashPassword('same-password-1')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-1', a)).toBe(true);
    expect(await verifyPassword('same-password-1', b)).toBe(true);
  });

  it('rejects malformed or foreign stored hashes instead of throwing', async () => {
    for (const bad of [null, undefined, '', 'plaintext', 'bcrypt$10$abc', 'scrypt$1$2$3']) {
      expect(await verifyPassword('whatever1', bad)).toBe(false);
    }
  });
});

describe('bearer token parsing', () => {
  const token = 'A'.repeat(43);
  it('extracts a well-formed bearer token', () => expect(extractToken(`Bearer ${token}`)).toBe(token));
  it('ignores anything else', () => {
    for (const h of [undefined, '', 'Basic abc', `bearer ${token}`, 'Bearer short', `Bearer ${token} extra`, `Bearer ${'x'.repeat(200)}`, 'Bearer a b']) {
      expect(extractToken(h)).toBeNull();
    }
  });
});

describe('sign-up / login validation', () => {
  const ok = { name: 'Asha Rao', email: ' Asha@Example.com ', password: 'passw0rd!' };
  it('normalises the e-mail and accepts a valid sign-up', () => {
    const r = signupSchema.safeParse(ok);
    expect(r.success).toBe(true);
    expect(r.data.email).toBe('asha@example.com');
  });
  it.each([
    ['short password', { password: 'a1' }],
    ['no digit', { password: 'onlyletters' }],
    ['no letter', { password: '123456789' }],
    ['too long', { password: 'a1'.repeat(70) }],
    ['bad e-mail', { email: 'nope' }],
    ['short name', { name: 'A' }],
    ['unknown field', { role: 'admin' }],
  ])('rejects %s', (_label, patch) => {
    expect(signupSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
  it('login needs e-mail and a non-empty password, and no extra fields', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(loginSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x', admin: true }).success).toBe(false);
  });
});
