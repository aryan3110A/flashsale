'use client';
import { useState } from 'react';
import { ShieldAlert, Power, PowerOff } from 'lucide-react';
import { rawRequest } from '@/lib/api';
import { usePolling, useNow } from '@/lib/hooks';
import { useToast } from '@/components/Toast';
import { StatusPill } from '@/components/ui';
import type { BreakerSnapshot } from '@/lib/types';
import { Section, ResultRow, MiniStat } from './shared';

interface Call { n: number; label: string; status: number; ms: number; circuit: string | null; attempts: number | null }

export function BreakerDemo() {
  const toast = useToast();
  const [log, setLog] = useState<Call[]>([]);
  const [busy, setBusy] = useState(false);
  const breaker = usePolling(async () => (await rawRequest<BreakerSnapshot>('/gateway/circuit-breaker')).body, 1000);
  const mode = usePolling(async () => (await rawRequest<{ mode: string }>('/mock/control')).body, 2000);
  const now = useNow(250);
  const b = breaker.data;
  const retryIn = b && b.state === 'OPEN' && b.openedAt ? Math.max(0, Math.ceil((Date.parse(b.openedAt) + b.resetTimeoutMs - now) / 1000)) : 0;

  const call = async (label: string, path: string, times = 1) => {
    setBusy(true);
    try {
      for (let i = 0; i < times; i++) {
        const r = await rawRequest(path, { timeoutMs: 8000 });
        setLog((l) => [{ n: (l[0]?.n ?? 0) + 1, label, status: r.status, ms: r.durationMs, circuit: r.headers.circuit, attempts: r.headers.retryAttempts }, ...l].slice(0, 25));
        await breaker.refresh();
      }
    } catch (e) { toast.error(e, 'Request failed'); }
    finally { setBusy(false); }
  };
  const setMode = async (m: 'normal' | 'failing') => {
    setBusy(true);
    try {
      const r = await rawRequest('/mock/control', { method: 'POST', body: { mode: m } });
      if (!r.ok) throw new Error('Fault injection is disabled on this server.');
      toast.push('info', m === 'failing' ? 'Outage started' : 'Service recovered', m === 'failing' ? 'The mock service now fails every /mock/service call.' : 'The mock service is healthy again. Wait for the breaker to probe it.');
      await mode.refresh();
    } catch (e) { toast.error(e, 'Could not change mock mode'); }
    finally { setBusy(false); }
  };

  return (
    <Section icon={ShieldAlert} title="4 · Circuit breaker" blurb="Calls to the downstream mock service go through a circuit breaker. After repeated failures it OPENS and rejects calls instantly (no waiting, no load on the sick service). After a cool-down it goes HALF_OPEN, lets a trial call through, and CLOSES again once the service has recovered. Safe GET requests are also retried with exponential backoff before a failure is counted.">
      <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
        <div className="space-y-4">
          <div className="rounded-2xl border border-line bg-white/[0.03] p-4">
            <div className="flex items-center justify-between"><span className="text-sm text-muted">Breaker state</span><span data-testid="breaker-state">{b ? <StatusPill status={b.state} /> : <span className="text-sm text-muted">{breaker.error ? 'unreachable' : '…'}</span>}</span></div>
            {b && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <MiniStat label="Consecutive failures" value={`${b.failures} / ${b.failureThreshold}`} tone={b.failures > 0 ? 'warn' : undefined} />
                <MiniStat label={b.state === 'OPEN' ? 'Probe in' : 'Trial successes'} value={b.state === 'OPEN' ? `${retryIn}s` : `${b.halfOpenSuccesses} / ${b.successThreshold}`} />
                <MiniStat label="Calls passed" value={b.totals.calls} />
                <MiniStat label="Rejected fast" value={b.totals.rejected} tone={b.totals.rejected ? 'bad' : undefined} />
              </div>
            )}
            <p className="mt-3 text-xs text-muted">Mock service mode: <strong className="text-ink">{mode.data?.mode ?? 'n/a'}</strong></p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" disabled={busy} onClick={() => call('normal', '/mock/normal')}>Normal request</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => call('slow (times out)', '/mock/slow')}>Slow request</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => call('fail', '/mock/fail')}>Failing request</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => call('fail', '/mock/fail', 5)}>5 failing requests</button>
          </div>
          <div className="rounded-2xl border border-line bg-white/[0.03] p-4">
            <p className="label">Outage &amp; recovery scenario</p>
            <p className="mb-3 text-xs text-muted">1. Start outage → 2. call the dependent service until the breaker opens → 3. recover the service → 4. keep calling after the cool-down and watch HALF_OPEN → CLOSED.</p>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-danger" disabled={busy} onClick={() => setMode('failing')}><PowerOff className="h-4 w-4" aria-hidden /> Start outage</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => call('service', '/mock/service')}>Call dependent service</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => setMode('normal')}><Power className="h-4 w-4" aria-hidden /> Recover service</button>
            </div>
          </div>
        </div>
        <div>
          <p className="label">Request log (newest first)</p>
          <div className="max-h-96 overflow-auto rounded-xl border border-line">
            {log.length === 0 ? <p className="p-4 text-sm text-muted">No calls yet.</p> : log.map((c) => (
              <ResultRow key={c.n} left={`#${c.n}`} status={c.status}
                badge={c.circuit ? <span className="shrink-0"><StatusPill status={c.circuit} /></span> : undefined}
                detail={`${c.label} · ${c.ms} ms${c.attempts ? ` · ${c.attempts} attempts (retried)` : ''}${c.status === 503 && c.ms < 20 ? ' · failed fast' : ''}`} />
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
