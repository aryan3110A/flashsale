import { describe, it, expect } from 'vitest';
import { bookingSchema, eventQuerySchema, IDEMPOTENCY_KEY_RE } from '../../apps/booking-api/src/validation.js';
import { fingerprint } from '../../apps/booking-api/src/services/bookings.js';

const schema = bookingSchema(10);
const valid = { eventId: '11111111-1111-4111-8111-111111111111', quantity: 2, name: 'Asha Rao', email: 'ASHA@Example.com ' };

describe('booking validation', () => {
  it('accepts a valid request and normalises the email', () => {
    const r = schema.safeParse(valid);
    expect(r.success).toBe(true);
    expect(r.data.email).toBe('asha@example.com');
  });
  it.each([
    ['zero quantity', { quantity: 0 }], ['negative quantity', { quantity: -1 }], ['fractional quantity', { quantity: 1.5 }],
    ['quantity above the per-order max', { quantity: 11 }], ['string quantity', { quantity: '2' }],
    ['bad event id', { eventId: 'not-a-uuid' }], ['short name', { name: 'A' }], ['bad email', { email: 'nope' }],
  ])('rejects %s', (_label, patch) => {
    expect(schema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
  it('rejects unknown fields (strict) so clients cannot smuggle extra data', () => {
    expect(schema.safeParse({ ...valid, isAdmin: true }).success).toBe(false);
  });
  it('validates the idempotency key format', () => {
    expect(IDEMPOTENCY_KEY_RE.test('abcd1234')).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test('short')).toBe(false);
    expect(IDEMPOTENCY_KEY_RE.test('has spaces in it')).toBe(false);
    expect(IDEMPOTENCY_KEY_RE.test('x'.repeat(129))).toBe(false);
  });
});

describe('event query validation', () => {
  it('coerces numbers/dates and rejects bad sort', () => {
    expect(eventQuerySchema.safeParse({ minPrice: '100', maxPrice: '900', to: '2030-01-01', sort: 'price-asc' }).success).toBe(true);
    expect(eventQuerySchema.safeParse({ sort: 'DROP TABLE' }).success).toBe(false);
    expect(eventQuerySchema.safeParse({ minPrice: '-5' }).success).toBe(false);
  });
});

describe('idempotency fingerprint', () => {
  it('is stable for the same request and differs when any field changes', () => {
    const a = fingerprint({ eventId: 'e', quantity: 1, email: 'a@x.com' });
    expect(fingerprint({ eventId: 'e', quantity: 1, email: 'a@x.com' })).toBe(a);
    expect(fingerprint({ eventId: 'e', quantity: 2, email: 'a@x.com' })).not.toBe(a);
    expect(fingerprint({ eventId: 'f', quantity: 1, email: 'a@x.com' })).not.toBe(a);
    expect(fingerprint({ eventId: 'e', quantity: 1, email: 'b@x.com' })).not.toBe(a);
  });
});
