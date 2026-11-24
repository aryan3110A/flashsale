import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { gw, waitFor, sleep, compose, uid } from '../helpers/env.js';

const breaker = async () => (await gw('/gateway/circuit-breaker')).json;
const client = uid('cb');

async function settleClosed() {
  await gw('/mock/control', { method: 'POST', body: { mode: 'normal' }, client });
  await waitFor(async () => {
    const r = await gw('/mock/normal', { client });
    return r.status === 200 && (await breaker()).state === 'CLOSED';
  }, { timeout: 30_000, interval: 500, desc: 'breaker CLOSED' });
}

// The breaker leaves OPEN lazily once its reset timeout has elapsed, so poll its state instead of guessing a sleep.
const waitHalfOpen = () => waitFor(async () => (await breaker()).state === 'HALF_OPEN', { timeout: 15_000, interval: 200, desc: 'breaker HALF_OPEN' });

beforeAll(settleClosed);
afterAll(async () => { try { compose('start mock-service'); } catch { /* already running */ } await settleClosed(); });

describe('circuit breaker: CLOSED → OPEN → HALF_OPEN → CLOSED (reset timeout 3s in test overlay)', () => {
  it('a slow downstream is cut off by the gateway timeout (504) and counted as a failure', async () => {
    const r = await gw('/mock/slow?ms=4000', { client, timeoutMs: 30_000 });
    expect(r.status).toBe(504);
    expect(r.json.error).toBe('UPSTREAM_TIMEOUT');
    expect(r.ms).toBeGreaterThanOrEqual(2400);      // timeout is 2.5 s, retried once => ~5 s
    expect(r.ms).toBeLessThan(10_000);
    expect(Number(r.headers.get('x-retry-attempts'))).toBe(2);
    await settleClosed();
  });

  it('repeated failures open the circuit; calls then fail fast without reaching the service', async () => {
    await settleClosed();
    const states = [];
    for (let i = 0; i < 3; i++) {
      const r = await gw('/mock/fail', { client });
      expect(r.status).toBe(503);
      expect(Number(r.headers.get('x-retry-attempts'))).toBe(2);   // GET retried with backoff before counting one failure
      states.push(r.headers.get('x-circuit-state'));
    }
    expect(states).toEqual(['CLOSED', 'CLOSED', 'OPEN']);
    const fast = await gw('/mock/normal', { client });                 // even a healthy endpoint is rejected while OPEN
    expect(fast.status).toBe(503);
    expect(fast.json).toMatchObject({ error: 'CIRCUIT_OPEN', circuitState: 'OPEN' });
    expect(Number(fast.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(fast.ms).toBeLessThan(100);
    const snap = await breaker();
    expect(snap.state).toBe('OPEN');
    expect(snap.totals.rejected).toBeGreaterThanOrEqual(1);
  });

  it('after the reset timeout it goes HALF_OPEN, and enough successful trials CLOSE it again', async () => {
    await waitFor(async () => (await breaker()).state === 'OPEN' || (await breaker()).retryAfterMs === 0, { timeout: 10_000, desc: 'open' });
    await waitHalfOpen();
    const first = await gw('/mock/normal', { client });                 // trial #1
    expect(first.status).toBe(200);
    expect(first.headers.get('x-circuit-state')).toBe('HALF_OPEN');
    const second = await gw('/mock/normal', { client });                // trial #2 reaches successThreshold
    expect(second.status).toBe(200);
    expect(second.headers.get('x-circuit-state')).toBe('CLOSED');
    const history = (await breaker()).history.map((h) => `${h.from}->${h.to}`);
    expect(history.slice(-3)).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
  });

  it('a failed trial in HALF_OPEN re-opens the circuit immediately', async () => {
    await settleClosed();
    for (let i = 0; i < 3; i++) await gw('/mock/fail', { client });
    expect((await breaker()).state).toBe('OPEN');
    await waitHalfOpen();
    const trial = await gw('/mock/fail', { client });                   // trial fails
    expect(trial.status).toBe(503);
    expect((await breaker()).state).toBe('OPEN');
    await settleClosed();
  });

  it('outage and recovery scenario driven through the mock service mode', async () => {
    await settleClosed();
    expect((await gw('/mock/control', { method: 'POST', body: { mode: 'failing' }, client })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await gw('/mock/service', { client })).status).toBe(503);
    expect((await breaker()).state).toBe('OPEN');
    await gw('/mock/control', { method: 'POST', body: { mode: 'normal' }, client }).catch(() => {});
    // control endpoint is itself behind the breaker while OPEN - wait out the reset, then recover
    await waitHalfOpen();
    const ctl = await gw('/mock/control', { method: 'POST', body: { mode: 'normal' }, client });
    expect([200]).toContain(ctl.status);
    const a = await gw('/mock/service', { client });
    const b = await gw('/mock/service', { client });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await breaker()).state).toBe('CLOSED');
  });

  it('mock service container stopped: bounded 502/504 from the gateway (no hang), breaker opens, and it recovers after restart', async () => {
    await settleClosed();
    compose('stop mock-service');
    try {
      const r = await gw('/mock/normal', { client });
      // A stopped container's address either refuses (502) or silently drops packets until the gateway timeout (504).
      expect([502, 504]).toContain(r.status);
      expect(['UPSTREAM_UNAVAILABLE', 'UPSTREAM_TIMEOUT']).toContain(r.json.error);
      expect(r.ms).toBeLessThan(8000);
      expect(JSON.stringify(r.json)).not.toMatch(/mock-service:8082/);
      for (let i = 0; i < 3; i++) await gw('/mock/normal', { client });
      expect((await breaker()).state).toBe('OPEN');
      const health = await gw('/health/services');
      expect(health.json.services['mock-service']).toBe('unhealthy');
      expect(health.json.status).toBe('degraded');       // non-critical dependency: degraded, not unhealthy
      expect(health.status).toBe(200);
    } finally { compose('start mock-service'); }
    await settleClosed();
    expect((await gw('/mock/normal', { client })).status).toBe(200);
  });

  it('booking and browsing keep working while the mock dependency is down (isolation)', async () => {
    await settleClosed();
    for (let i = 0; i < 3; i++) await gw('/mock/fail', { client });
    expect((await breaker()).state).toBe('OPEN');
    expect((await gw('/api/events', { client })).status).toBe(200);
    expect((await gw('/api/ping', { client })).status).toBe(200);
    await settleClosed();
  });
});
