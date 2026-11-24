import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitOpenError, STATES } from '../../apps/gateway/src/resilience/circuit-breaker.js';

const make = (over = {}) => {
  const clock = { t: 1_000_000 };
  const transitions = [];
  const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10_000, halfOpenMaxCalls: 1, successThreshold: 2, now: () => clock.t, onTransition: (t) => transitions.push(`${t.from}->${t.to}`), ...over });
  return { cb, clock, transitions };
};
const ok = () => Promise.resolve('ok');
const bad = () => Promise.reject(new Error('boom'));

describe('CircuitBreaker', () => {
  it('starts CLOSED and passes calls through', async () => {
    const { cb } = make();
    expect(cb.getState()).toBe(STATES.CLOSED);
    await expect(cb.execute(ok)).resolves.toBe('ok');
  });

  it('opens after the failure threshold of consecutive failures', async () => {
    const { cb, transitions } = make();
    for (let i = 0; i < 2; i++) await expect(cb.execute(bad)).rejects.toThrow('boom');
    expect(cb.getState()).toBe(STATES.CLOSED);
    await expect(cb.execute(bad)).rejects.toThrow('boom');
    expect(cb.getState()).toBe(STATES.OPEN);
    expect(transitions).toEqual(['CLOSED->OPEN']);
  });

  it('a success resets the consecutive failure count', async () => {
    const { cb } = make();
    await cb.execute(bad).catch(() => {}); await cb.execute(bad).catch(() => {});
    await cb.execute(ok);
    await cb.execute(bad).catch(() => {}); await cb.execute(bad).catch(() => {});
    expect(cb.getState()).toBe(STATES.CLOSED);
  });

  it('fails fast without calling the downstream while OPEN', async () => {
    const { cb } = make();
    for (let i = 0; i < 3; i++) await cb.execute(bad).catch(() => {});
    let called = false;
    await expect(cb.execute(async () => { called = true; })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
    expect(cb.snapshot().totals.rejected).toBe(1);
  });

  it('moves to HALF_OPEN after the reset timeout and closes after enough trial successes', async () => {
    const { cb, clock, transitions } = make();
    for (let i = 0; i < 3; i++) await cb.execute(bad).catch(() => {});
    clock.t += 9_999;
    expect(cb.getState()).toBe(STATES.OPEN);
    clock.t += 1;
    expect(cb.getState()).toBe(STATES.HALF_OPEN);
    await cb.execute(ok);
    expect(cb.getState()).toBe(STATES.HALF_OPEN); // needs successThreshold=2
    await cb.execute(ok);
    expect(cb.getState()).toBe(STATES.CLOSED);
    expect(transitions).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
  });

  it('re-opens immediately if a HALF_OPEN trial fails', async () => {
    const { cb, clock } = make();
    for (let i = 0; i < 3; i++) await cb.execute(bad).catch(() => {});
    clock.t += 10_000;
    await cb.execute(bad).catch(() => {});
    expect(cb.getState()).toBe(STATES.OPEN);
    expect(cb.retryAfterMs()).toBe(10_000);
  });

  it('limits concurrent HALF_OPEN trial calls', async () => {
    const { cb, clock } = make();
    for (let i = 0; i < 3; i++) await cb.execute(bad).catch(() => {});
    clock.t += 10_000;
    let release;
    const slow = cb.execute(() => new Promise((r) => { release = r; }));
    await expect(cb.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError); // second trial rejected
    release('x');
    await slow;
  });

  it('treats failure responses (isFailure predicate) as failures', async () => {
    const { cb } = make();
    for (let i = 0; i < 3; i++) await cb.execute(async () => ({ status: 503 }), (r) => r.status >= 500);
    expect(cb.getState()).toBe(STATES.OPEN);
  });

  it('keeps a bounded transition history', async () => {
    const { cb, clock } = make({ failureThreshold: 1, successThreshold: 1 });
    for (let i = 0; i < 40; i++) { await cb.execute(bad).catch(() => {}); clock.t += 10_000; await cb.execute(ok); }
    expect(cb.snapshot().history.length).toBeLessThanOrEqual(25);
  });
});
