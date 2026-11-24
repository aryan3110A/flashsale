import { rawRequest } from './api';

/**
 * Browser-side flash-sale simulator.
 *
 * Every "virtual user" is anonymous (never carries the logged-in user's token), books with its own
 * e-mail and ONE Idempotency-Key, and hammers the Book button `clicks` times in parallel. That models
 * the real flash-sale situation: many people, each clicking impatiently several times.
 *
 * Everything goes through the real gateway, so the numbers the page shows come from the real system:
 * rate limiter (429), atomic inventory (409), idempotency (200 replay), queue and worker (async status).
 */

export type Mode = 'polite' | 'flood';
export type Outcome = 'accepted' | 'replayed' | 'soldOut' | 'rateLimited' | 'error';
export type UserPhase = 'waiting' | 'sending' | 'retrying' | 'rate_limited' | 'error' | 'sold_out' | 'accepted';

export interface SimConfig { eventId: string; runId: string; users: number; quantity: number; clicks: number; mode: Mode }

export interface SimUser {
  n: number; name: string; email: string; phase: UserPhase;
  sent: number; rateLimited: number; reference?: string; note?: string;
}

export interface Counters { sent: number; accepted: number; replayed: number; soldOut: number; rateLimited: number; errors: number }
export const emptyCounters = (): Counters => ({ sent: 0, accepted: 0, replayed: 0, soldOut: 0, rateLimited: 0, errors: 0 });

// A later, more informative outcome never gets overwritten by a less informative one.
const RANK: Record<UserPhase, number> = { waiting: 0, sending: 0, retrying: 1, rate_limited: 2, error: 3, sold_out: 4, accepted: 5 };

interface Body { success?: boolean; error?: string; message?: string; idempotentReplay?: boolean; retryAfterSeconds?: number; data?: { bookingReference?: string } }

export function classify(status: number, body: unknown): Outcome {
  const b = (body && typeof body === 'object' ? body : {}) as Body;
  if (status === 202) return 'accepted';
  if (status === 200 && b.idempotentReplay) return 'replayed';
  if (status === 409 && b.error === 'INSUFFICIENT_INVENTORY') return 'soldOut';
  if (status === 429) return 'rateLimited';
  return 'error';
}

export function makeUsers(count: number): SimUser[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1; const pad = String(n).padStart(2, '0');
    return { n, name: `Sim User ${pad}`, email: `sim-user-${pad}@example.com`, phase: 'waiting', sent: 0, rateLimited: 0 };
  });
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function setPhase(u: SimUser, phase: UserPhase, note?: string) {
  if (RANK[phase] >= RANK[u.phase]) { u.phase = phase; if (note !== undefined) u.note = note; }
}

export interface RunControl { counters: Counters; users: SimUser[]; signal: AbortSignal }

const MAX_POLITE_ATTEMPTS = 8;

async function click(cfg: SimConfig, u: SimUser, key: string, ctl: RunControl) {
  const maxAttempts = cfg.mode === 'polite' ? MAX_POLITE_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (ctl.signal.aborted) return;
    let status = 0; let body: unknown = null; let retryAfter: number | null = null;
    try {
      const res = await rawRequest('/api/bookings', {
        method: 'POST', anonymous: true, signal: ctl.signal, timeoutMs: 20_000,
        body: { eventId: cfg.eventId, quantity: cfg.quantity, name: u.name, email: u.email },
        headers: { 'Idempotency-Key': key },
      });
      status = res.status; body = res.body; retryAfter = res.headers.retryAfter;
    } catch (e) {
      if (ctl.signal.aborted) return;
      ctl.counters.sent++; ctl.counters.errors++; u.sent++;
      setPhase(u, 'error', (e as Error).message);
      return;
    }
    ctl.counters.sent++; u.sent++;
    const b = (body && typeof body === 'object' ? body : {}) as Body;
    const outcome = classify(status, body);
    switch (outcome) {
      case 'accepted':
        ctl.counters.accepted++;
        u.reference = b.data?.bookingReference ?? u.reference;
        setPhase(u, 'accepted', 'tickets reserved');
        return;
      case 'replayed':
        ctl.counters.replayed++;
        u.reference = b.data?.bookingReference ?? u.reference;
        setPhase(u, 'accepted', 'duplicate click absorbed');
        return;
      case 'soldOut':
        ctl.counters.soldOut++;
        setPhase(u, 'sold_out', b.message ?? 'sold out');
        return;
      case 'rateLimited': {
        ctl.counters.rateLimited++; u.rateLimited++;
        if (cfg.mode === 'polite' && attempt < maxAttempts) {
          const wait = Math.max(1, retryAfter ?? b.retryAfterSeconds ?? 1);
          setPhase(u, 'retrying', `rate limited (429) - retrying in ${wait}s`);
          await sleep(wait * 1000 + Math.random() * 400, ctl.signal);
          continue;
        }
        setPhase(u, 'rate_limited', 'rejected by the rate limiter (429)');
        return;
      }
      default:
        ctl.counters.errors++;
        setPhase(u, 'error', b.message ?? `HTTP ${status}`);
        return;
    }
  }
}

/** Run every virtual user in parallel; resolves when all of their requests have finished (or were aborted). */
export async function runSimulation(cfg: SimConfig, ctl: RunControl): Promise<void> {
  await Promise.all(ctl.users.map(async (u) => {
    const key = `sim-${cfg.runId}-${u.n}`; // one purchase attempt per user => one idempotency key
    setPhase(u, 'sending');
    await Promise.all(Array.from({ length: cfg.clicks }, () => click(cfg, u, key, ctl)));
    if (u.phase === 'sending' || u.phase === 'retrying') setPhase(u, 'error', u.note ?? 'no response');
  }));
}
