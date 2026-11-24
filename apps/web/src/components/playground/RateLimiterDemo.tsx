'use client';
import { useState } from 'react';
import { Gauge, Send, Zap } from 'lucide-react';
import { rawRequest, type RawResponse } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Section, ResultRow, MiniStat } from './shared';

interface Row { n: number; status: number; ms: number; remaining: number | null; retryAfter: number | null }

export function RateLimiterDemo() {
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [burst, setBurst] = useState(60);

  const toRow = (n: number, r: RawResponse): Row => ({ n, status: r.status, ms: r.durationMs, remaining: r.headers.rateLimitRemaining, retryAfter: r.headers.retryAfter });

  const single = async () => {
    setBusy(true);
    try { const r = await rawRequest('/api/ping'); setRows([toRow(1, r)]); }
    catch (e) { toast.error(e, 'Request failed'); }
    finally { setBusy(false); }
  };
  const fire = async () => {
    setBusy(true);
    try {
      // All requests leave the browser at once, so they hit the token bucket together.
      const results = await Promise.all(Array.from({ length: burst }, (_, i) => rawRequest('/api/ping').then((r) => toRow(i + 1, r)).catch(() => ({ n: i + 1, status: 0, ms: 0, remaining: null, retryAfter: null }) as Row)));
      setRows(results);
    } finally { setBusy(false); }
  };

  const ok = rows.filter((r) => r.status === 200).length;
  const limited = rows.filter((r) => r.status === 429).length;
  const failed = rows.length - ok - limited;
  const minRemaining = rows.reduce<number | null>((m, r) => (r.remaining !== null && (m === null || r.remaining < m) ? r.remaining : m), null);
  const retry = rows.find((r) => r.retryAfter !== null)?.retryAfter ?? null;

  return (
    <Section icon={Gauge} title="1 · Rate limiter (Token Bucket in Redis)" blurb="Each client IP owns a bucket of tokens in Redis. Every request spends one; tokens refill continuously. When the bucket is empty the gateway answers HTTP 429 with Retry-After. The check runs as one atomic Lua script, so concurrent requests cannot overspend.">
      <div className="flex flex-wrap items-end gap-3">
        <button className="btn btn-ghost" onClick={single} disabled={busy}><Send className="h-4 w-4" aria-hidden /> Send 1 request</button>
        <div>
          <label htmlFor="burst" className="label">Burst size</label>
          <select id="burst" className="input !w-28" value={burst} onChange={(e) => setBurst(Number(e.target.value))}>{[20, 40, 60, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </div>
        <button className="btn btn-primary" onClick={fire} disabled={busy}><Zap className="h-4 w-4" aria-hidden /> Fire burst</button>
      </div>
      {rows.length > 0 && (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <MiniStat label="Sent" value={rows.length} />
            <MiniStat label="Accepted (200)" value={ok} tone="good" />
            <MiniStat label="Rejected (429)" value={limited} tone={limited ? 'warn' : undefined} />
            <MiniStat label="Other / network" value={failed} tone={failed ? 'bad' : undefined} />
            <MiniStat label="Lowest tokens left" value={minRemaining ?? 'n/a'} />
          </div>
          {retry !== null && <p className="mt-3 text-sm text-muted">Rejected responses carried <code className="rounded bg-white/10 px-1">Retry-After: {retry}s</code>.</p>}
          <div className="mt-4 max-h-64 overflow-auto rounded-xl border border-line">
            {rows.slice(0, 200).map((r) => <ResultRow key={r.n} left={`#${r.n}`} status={r.status} detail={`${r.ms} ms · tokens left ${r.remaining ?? 'n/a'}${r.retryAfter !== null ? ` · retry-after ${r.retryAfter}s` : ''}`} />)}
          </div>
        </>
      )}
    </Section>
  );
}
