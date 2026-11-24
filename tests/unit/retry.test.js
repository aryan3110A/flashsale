import { describe, it, expect } from 'vitest';
import { withRetry, backoffDelay, isRetryable, isConnectError } from '../../apps/gateway/src/resilience/retry.js';

const noSleep = async () => {};

describe('backoffDelay', () => {
  it('grows exponentially up to the cap (full jitter upper bound)', () => {
    const max = (attempt) => backoffDelay(attempt, { baseDelayMs: 100, maxDelayMs: 1000 }, () => 0.999999);
    expect(max(0)).toBeLessThanOrEqual(110);
    expect(max(1)).toBeLessThanOrEqual(210);
    expect(max(2)).toBeLessThanOrEqual(410);
    expect(max(10)).toBeLessThanOrEqual(1010);
    expect(max(3)).toBeGreaterThan(max(1));
  });
});

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const r = await withRetry(async () => 'x', { maxAttempts: 3, shouldRetry: (o) => Boolean(o.error), sleepFn: noSleep });
    expect(r).toEqual({ result: 'x', attempts: 1 });
  });
  it('retries transient failures then succeeds', async () => {
    let n = 0;
    const r = await withRetry(async () => { if (++n < 3) throw new Error('t'); return 'ok'; }, { maxAttempts: 3, shouldRetry: (o) => Boolean(o.error), sleepFn: noSleep });
    expect(r.attempts).toBe(3);
  });
  it('stops at maxAttempts and rethrows the last error with attempts', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error('always'); }, { maxAttempts: 2, shouldRetry: () => true, sleepFn: noSleep })).rejects.toMatchObject({ message: 'always', attempts: 2 });
    expect(n).toBe(2);
  });
  it('does not retry when shouldRetry says no', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error('fatal'); }, { maxAttempts: 5, shouldRetry: () => false, sleepFn: noSleep })).rejects.toThrow();
    expect(n).toBe(1);
  });
  it('uses the backoff delay between attempts', async () => {
    const delays = [];
    await withRetry(async (a) => { if (a < 3) throw new Error('x'); return 1; }, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, shouldRetry: (o) => Boolean(o.error), sleepFn: async (ms) => delays.push(ms), random: () => 0.5 });
    expect(delays.length).toBe(2);
    expect(delays[1]).toBeGreaterThan(delays[0]);
  });
});

describe('isRetryable (what is safe to repeat)', () => {
  it('retries GET on 502/503/504 but not on 500 or 4xx', () => {
    for (const status of [502, 503, 504]) expect(isRetryable({ method: 'GET', status })).toBe(true);
    for (const status of [400, 404, 409, 422, 429, 500]) expect(isRetryable({ method: 'GET', status })).toBe(false);
  });
  it('never retries a POST on a response status without an idempotency key', () => {
    expect(isRetryable({ method: 'POST', status: 503 })).toBe(false);
    expect(isRetryable({ method: 'POST', status: 503, hasIdempotencyKey: true })).toBe(true);
  });
  it('retries connection-level errors for any method (request was never delivered)', () => {
    const err = Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } });
    expect(isConnectError(err)).toBe(true);
    expect(isRetryable({ method: 'POST', error: err })).toBe(true);
  });
  it('does not retry timeouts on non-idempotent writes', () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    expect(isRetryable({ method: 'POST', error: timeout })).toBe(false);
    expect(isRetryable({ method: 'GET', error: timeout })).toBe(true);
    expect(isRetryable({ method: 'POST', error: timeout, hasIdempotencyKey: true })).toBe(true);
  });
  it('never retries when the circuit is open', () => {
    expect(isRetryable({ method: 'GET', error: Object.assign(new Error('o'), { code: 'CIRCUIT_OPEN' }) })).toBe(false);
  });
});
