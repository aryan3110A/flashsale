'use client';
import { rawRequest } from '@/lib/api';
import { usePolling } from '@/lib/hooks';
import { fmtNum, pct } from '@/lib/format';
import { Stat, StatusPill } from '@/components/ui';
import type { MaybeAvailable, ServicesHealth, Summary } from '@/lib/types';

const SERVICES: { name: string; role: string }[] = [
  { name: 'gateway', role: 'rate limiter, routing, retries' },
  { name: 'booking-api', role: 'inventory + booking transaction' },
  { name: 'postgres', role: 'source of truth' },
  { name: 'redis', role: 'queue, cache, limiter buckets' },
  { name: 'worker', role: 'confirms bookings in background' },
  { name: 'mock-service', role: 'downstream dependency' },
];

const val = <T extends object>(m: MaybeAvailable<T> | undefined): (T & { available: true }) | null => (m && m.available ? m : null);

/** Live service status + pipeline numbers. Polls the monitoring endpoints (their own, generous rate-limit bucket). */
export function LiveServices({ busy }: { busy: boolean }) {
  const health = usePolling(async () => (await rawRequest<ServicesHealth>('/health/services', { timeoutMs: 5000, anonymous: true })).body, 2000);
  const summary = usePolling(async () => (await rawRequest<Summary>('/metrics/summary', { timeoutMs: 5000, anonymous: true })).body, 2000);
  const h = health.data; const s = summary.data;
  const q = val(s?.queue); const w = val(s?.worker); const c = val(s?.cache); const o = val(s?.outbox); const d = val(s?.database);

  return (
    <section aria-labelledby="live-svc-h" className="mt-10">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id="live-svc-h" className="text-xl font-bold">What is running right now</h2>
        {h ? <StatusPill status={h.status} label={`System ${h.status}`} /> : <span className="text-sm text-muted">{health.error ? 'gateway unreachable' : 'checking…'}</span>}
        <span className="flex items-center gap-2 text-xs text-muted" role="status"><span className={`h-2 w-2 rounded-full ${busy ? 'bg-flash pulse-dot' : health.error ? 'bg-bad' : 'bg-good'}`} aria-hidden />{busy ? 'under load - refreshing every 2 s' : 'refreshing every 2 s'}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {SERVICES.map(({ name, role }) => {
          const x = h?.details[name];
          return (
            <div key={name} className="card p-4" data-testid={`svc-${name}`}>
              <p className="text-xs font-medium text-muted">{name}</p>
              <div className="mt-2">{x ? <StatusPill status={x.status} /> : <StatusPill status="unknown" label={health.error ? 'unreachable' : '…'} />}</div>
              <p className="num mt-2 min-h-4 text-xs text-muted">{x?.latencyMs !== undefined ? `${x.latencyMs} ms` : ''}{name === 'worker' && x?.instances ? ` · ${x.instances} instance${x.instances > 1 ? 's' : ''}` : ''}</p>
              <p className="mt-1 text-xs text-muted">{role}</p>
              {x?.message && x.status !== 'healthy' && <p className="mt-1 text-xs text-bad">{x.message}</p>}
            </div>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Queue waiting" value={q ? fmtNum(q.waiting) : 'n/a'} hint="jobs not yet picked up" />
        <Stat label="Active jobs" value={q ? fmtNum(q.active) : 'n/a'} hint="being processed now" />
        <Stat label="Retry backoff" value={q ? fmtNum(q.delayed) : 'n/a'} hint="delayed jobs" tone={q && q.delayed > 0 ? 'warn' : undefined} />
        <Stat label="Outbox pending" value={o ? fmtNum(o.pending) : 'n/a'} hint="committed, not queued" />
        <Stat label="Worker done" value={w ? fmtNum(w.completed) : 'n/a'} tone="good" hint={w ? `avg ${w.avgProcessingMs} ms` : undefined} />
        <Stat label="Job failures" value={w ? fmtNum(w.failed) : 'n/a'} tone={w && w.failed > 0 ? 'bad' : undefined} hint={w ? `${w.retried} retries` : undefined} />
        <Stat label="Cache hit ratio" value={c ? pct(c.hitRatio) : 'n/a'} />
        <Stat label="DB pool in use" value={d ? `${d.pool.total - d.pool.idle}/${d.pool.total}` : 'n/a'} hint={d ? `${d.pool.waiting} waiting` : undefined} />
      </div>
      {s && <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">Circuit breaker (mock service): <StatusPill status={s.circuitBreaker.state} /> · gateway has answered {fmtNum(s.gateway.requests)} requests, {fmtNum(s.gateway.rateLimited)} of them with 429.</p>}
    </section>
  );
}
