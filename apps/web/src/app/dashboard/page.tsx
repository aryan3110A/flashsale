'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { rawRequest } from '@/lib/api';
import { usePolling, useNow } from '@/lib/hooks';
import { fmtNum, pct } from '@/lib/format';
import { PageHeader, Stat, StatusPill } from '@/components/ui';
import type { MaybeAvailable, ServicesHealth, Summary } from '@/lib/types';

// Categorical colours (dark-surface steps of the validated reference palette).
const C = { blue: '#3987e5', orange: '#d95926', aqua: '#199e70', red: '#e66767', violet: '#9085e9' };
const AXIS = { stroke: '#a1abc9', fontSize: 11 };
const GRID = '#232d57';
const TT = { contentStyle: { background: '#111833', border: '1px solid #232d57', borderRadius: 12, color: '#eef1fb', fontSize: 12 }, labelStyle: { color: '#a1abc9' }, cursor: { stroke: '#a1abc9', strokeOpacity: 0.4 } };

interface Sample { t: number; waiting: number | null; active: number | null; failedJobs: number | null; hits: number | null; misses: number | null }

const timeLabel = (iso: string | number) => new Date(iso).toLocaleTimeString('en-IN', { hour12: false });
const val = <T extends object>(m: MaybeAvailable<T> | undefined): (T & { available: true }) | null => (m && m.available ? m : null);

export default function DashboardPage() {
  const summary = usePolling(async () => (await rawRequest<Summary>('/metrics/summary', { timeoutMs: 6000 })).body, 3000);
  const health = usePolling(async () => (await rawRequest<ServicesHealth>('/health/services', { timeoutMs: 6000 })).body, 5000);
  const now = useNow(1000);
  const [samples, setSamples] = useState<Sample[]>([]);
  const lastGen = useRef<string>('');

  // Accumulate real polled values for queue/cache trend charts (bounded to 60 points).
  useEffect(() => {
    const s = summary.data;
    if (!s || s.generatedAt === lastGen.current) return;
    lastGen.current = s.generatedAt;
    const q = val(s.queue); const c = val(s.cache);
    setSamples((prev) => [...prev, { t: Date.parse(s.generatedAt), waiting: q ? q.waiting : null, active: q ? q.active : null, failedJobs: q ? q.failed : null, hits: c ? c.hits : null, misses: c ? c.misses : null }].slice(-60));
  }, [summary.data]);

  const s = summary.data;
  const h = health.data;
  const q = val(s?.queue); const c = val(s?.cache); const w = val(s?.worker);
  const ageS = summary.updatedAt ? Math.max(0, Math.round((now - summary.updatedAt) / 1000)) : null;
  const down = Boolean(summary.error) && !s;

  const cacheDeltas = samples.map((p, i) => {
    const prev = samples[i - 1];
    return { t: p.t, hits: prev && p.hits !== null && prev.hits !== null ? Math.max(0, p.hits - prev.hits) : 0, misses: prev && p.misses !== null && prev.misses !== null ? Math.max(0, p.misses - prev.misses) : 0 };
  });
  const series = (s?.series ?? []).map((p) => ({ ...p, label: timeLabel(p.t) }));

  return (
    <div>
      <PageHeader eyebrow="Observability" title="System monitor" subtitle="Live numbers from the gateway, Redis, PostgreSQL, BullMQ and the worker. Anything that cannot be measured is shown as n/a, never guessed."
        actions={
          <div className="flex items-center gap-3 text-sm text-muted" role="status" aria-live="polite">
            <span className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${summary.error ? 'bg-bad' : 'bg-good pulse-dot'}`} aria-hidden />
              {summary.error ? 'Disconnected' : ageS === null ? 'Connecting…' : `Updated ${ageS}s ago · every 3s`}
            </span>
            <button className="btn btn-ghost !py-1.5" onClick={() => { void summary.refresh(); void health.refresh(); }} disabled={summary.refreshing}><RefreshCw className={`h-4 w-4 ${summary.refreshing ? 'animate-spin' : ''}`} aria-hidden /> Refresh</button>
          </div>
        } />

      {summary.error && (
        <div role="alert" className="card mb-6 flex items-start gap-3 border-bad/40 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-bad" aria-hidden />
          <div><p className="font-semibold text-bad">{down ? 'Gateway unreachable' : 'Latest refresh failed'}</p><p className="text-muted">{summary.error.message} {s ? 'Showing the last successful data.' : ''}</p></div>
        </div>
      )}

      {/* overall + services */}
      <section aria-labelledby="svc-h" className="mb-8">
        <div className="mb-3 flex items-center gap-3"><h2 id="svc-h" className="text-xl font-bold">Services</h2>{h ? <StatusPill status={h.status} label={`System ${h.status}`} /> : <span className="text-sm text-muted">checking…</span>}</div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {['gateway', 'booking-api', 'postgres', 'redis', 'worker', 'mock-service'].map((name) => {
            const d = h?.details[name];
            return (
              <div key={name} className="card p-4">
                <p className="text-xs font-medium text-muted">{name}</p>
                <div className="mt-2">{d ? <StatusPill status={d.status} /> : <StatusPill status="unknown" label={health.error ? 'unreachable' : '…'} />}</div>
                <p className="num mt-2 min-h-4 text-xs text-muted">{d?.latencyMs !== undefined ? `${d.latencyMs} ms` : ''}{name === 'worker' && d?.instances ? ` · ${d.instances} instance${d.instances > 1 ? 's' : ''}` : ''}</p>
                {d?.message && d.status !== 'healthy' && <p className="mt-1 text-xs text-bad">{d.message}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {/* headline numbers */}
      <section aria-labelledby="num-h" className="mb-8">
        <h2 id="num-h" className="mb-3 text-xl font-bold">Traffic</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Requests" value={s ? fmtNum(s.gateway.requests) : 'n/a'} hint="user traffic since gateway start" />
          <Stat label="Successful" value={s ? fmtNum(s.gateway.successful) : 'n/a'} tone="good" hint="status < 400" />
          <Stat label="Failed" value={s ? fmtNum(s.gateway.failed) : 'n/a'} tone={s && s.gateway.failed > 0 ? 'bad' : undefined} hint="status ≥ 500" />
          <Stat label="Rate limited" value={s ? fmtNum(s.gateway.rateLimited) : 'n/a'} tone={s && s.gateway.rateLimited > 0 ? 'warn' : undefined} hint="HTTP 429" />
          <Stat label="Avg response" value={s ? `${s.gateway.avgResponseMs} ms` : 'n/a'} hint="gateway, incl. upstream" />
          <Stat label="Client errors" value={s ? fmtNum(s.gateway.clientErrors) : 'n/a'} hint="4xx except 429" />
        </div>
      </section>

      <section aria-labelledby="cache-h" className="mb-8">
        <h2 id="cache-h" className="mb-3 text-xl font-bold">Cache, queue &amp; worker</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Cache hits" value={c ? fmtNum(c.hits) : 'n/a'} tone="good" hint={c ? undefined : unavailableReason(s?.cache)} />
          <Stat label="Cache misses" value={c ? fmtNum(c.misses) : 'n/a'} hint={c ? `${c.errors} Redis errors` : undefined} />
          <Stat label="Hit ratio" value={c ? pct(c.hitRatio) : 'n/a'} />
          <Stat label="Queue waiting" value={q ? fmtNum(q.waiting) : 'n/a'} hint={q ? `${q.delayed} delayed (retry backoff)` : unavailableReason(s?.queue)} />
          <Stat label="Active jobs" value={q ? fmtNum(q.active) : 'n/a'} />
          <Stat label="Failed jobs" value={q ? fmtNum(q.failed) : 'n/a'} tone={q && q.failed > 0 ? 'bad' : undefined} hint={w ? `${w.retried} retries` : undefined} />
          <Stat label="Completed jobs" value={w ? fmtNum(w.completed) : 'n/a'} tone="good" hint={w ? `avg ${w.avgProcessingMs} ms` : unavailableReason(s?.worker)} />
          <Stat label="Outbox pending" value={val(s?.outbox) ? fmtNum(val(s?.outbox)!.pending) : 'n/a'} hint="committed, not yet queued" />
          <Stat label="DB failures" value={val(s?.database) ? fmtNum(val(s?.database)!.queryFailures) : 'n/a'} tone={(val(s?.database)?.queryFailures ?? 0) > 0 ? 'bad' : undefined} />
          <div className="card col-span-2 p-4 md:col-span-3 xl:col-span-3">
            <p className="text-xs font-medium text-muted">Circuit breaker (mock service)</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">{s ? <StatusPill status={s.circuitBreaker.state} /> : <span className="text-muted">n/a</span>}
              {s && <span className="num text-xs text-muted">failures {s.circuitBreaker.failures}/{s.circuitBreaker.failureThreshold} · rejected {s.circuitBreaker.totals.rejected}{s.circuitBreaker.state === 'OPEN' ? ` · retry in ${Math.ceil(s.circuitBreaker.retryAfterMs / 1000)}s` : ''}</span>}
            </div>
          </div>
        </div>
      </section>

      {/* charts */}
      <section aria-labelledby="chart-h" className="grid gap-5 lg:grid-cols-2">
        <h2 id="chart-h" className="sr-only">Charts</h2>
        <ChartCard title="Request volume" sub="requests per 5 s" empty={series.length === 0}>
          <AreaChart data={series} margin={{ left: -16, right: 8, top: 8 }}>
            <CartesianGrid stroke={GRID} vertical={false} /><XAxis dataKey="label" {...AXIS} tickLine={false} minTickGap={30} /><YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip {...TT} /><Area type="monotone" dataKey="requests" name="Requests" stroke={C.blue} fill={C.blue} fillOpacity={0.2} strokeWidth={2} dot={false} />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Successful vs failed" sub="outcome per 5 s" empty={series.length === 0} legend>
          <BarChart data={series} margin={{ left: -16, right: 8, top: 8 }}>
            <CartesianGrid stroke={GRID} vertical={false} /><XAxis dataKey="label" {...AXIS} tickLine={false} minTickGap={30} /><YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip {...TT} cursor={{ fill: '#ffffff10' }} /><Legend wrapperStyle={{ fontSize: 12, color: '#a1abc9' }} />
            <Bar dataKey="success" name="Successful" stackId="a" fill={C.blue} stroke="#111833" strokeWidth={2} />
            <Bar dataKey="rateLimited" name="Rate limited (429)" stackId="a" fill={C.orange} stroke="#111833" strokeWidth={2} />
            <Bar dataKey="failed" name="Failed (5xx)" stackId="a" fill={C.red} stroke="#111833" strokeWidth={2} />
          </BarChart>
        </ChartCard>

        <ChartCard title="Response-time trend" sub="mean gateway latency (ms) per 5 s" empty={series.length === 0}>
          <LineChart data={series} margin={{ left: -16, right: 8, top: 8 }}>
            <CartesianGrid stroke={GRID} vertical={false} /><XAxis dataKey="label" {...AXIS} tickLine={false} minTickGap={30} /><YAxis {...AXIS} tickLine={false} axisLine={false} unit=" ms" />
            <Tooltip {...TT} /><Line type="monotone" dataKey="avgMs" name="Avg latency (ms)" stroke={C.violet} strokeWidth={2} dot={false} />
          </LineChart>
        </ChartCard>

        <ChartCard title="Queue activity" sub="BullMQ depth, sampled every 3 s" empty={samples.filter((p) => p.waiting !== null).length < 2} legend>
          <LineChart data={samples.map((p) => ({ ...p, label: timeLabel(p.t) }))} margin={{ left: -16, right: 8, top: 8 }}>
            <CartesianGrid stroke={GRID} vertical={false} /><XAxis dataKey="label" {...AXIS} tickLine={false} minTickGap={30} /><YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip {...TT} /><Legend wrapperStyle={{ fontSize: 12, color: '#a1abc9' }} />
            <Line type="stepAfter" dataKey="waiting" name="Waiting" stroke={C.orange} strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="stepAfter" dataKey="active" name="Active" stroke={C.blue} strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="stepAfter" dataKey="failedJobs" name="Failed" stroke={C.red} strokeWidth={2} dot={false} connectNulls={false} />
          </LineChart>
        </ChartCard>

        <ChartCard title="Cache performance" sub="lookups per 3 s: hit vs miss" empty={cacheDeltas.length < 2} legend>
          <BarChart data={cacheDeltas.map((p) => ({ ...p, label: timeLabel(p.t) }))} margin={{ left: -16, right: 8, top: 8 }}>
            <CartesianGrid stroke={GRID} vertical={false} /><XAxis dataKey="label" {...AXIS} tickLine={false} minTickGap={30} /><YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip {...TT} cursor={{ fill: '#ffffff10' }} /><Legend wrapperStyle={{ fontSize: 12, color: '#a1abc9' }} />
            <Bar dataKey="hits" name="Hits" stackId="c" fill={C.aqua} stroke="#111833" strokeWidth={2} />
            <Bar dataKey="misses" name="Misses" stackId="c" fill={C.orange} stroke="#111833" strokeWidth={2} />
          </BarChart>
        </ChartCard>

        <div className="card p-5">
          <h3 className="flex items-center gap-2 font-semibold"><Activity className="h-4 w-4 text-accent" aria-hidden /> Circuit breaker transitions</h3>
          {s && s.circuitBreaker.history.length > 0 ? (
            <ol className="mt-3 space-y-2 text-sm">
              {[...s.circuitBreaker.history].reverse().slice(0, 6).map((t, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2"><span className="num text-xs text-muted">{timeLabel(t.at)}</span><StatusPill status={t.from} /><span aria-hidden>→</span><StatusPill status={t.to} /><span className="text-xs text-muted">{t.reason}</span></li>
              ))}
            </ol>
          ) : <p className="mt-3 text-sm text-muted">No transitions yet. Trigger failures in the <a className="underline" href="/playground">playground</a>.</p>}
        </div>
      </section>

      {series.length > 0 && (
        <details className="card mt-6 p-4">
          <summary className="cursor-pointer text-sm font-semibold">View request data as a table</summary>
          <div className="mt-3 max-h-72 overflow-auto">
            <table className="num w-full text-left text-xs"><thead className="sticky top-0 bg-surface text-muted"><tr><th className="py-1 pr-4">Time</th><th className="pr-4">Requests</th><th className="pr-4">Successful</th><th className="pr-4">429</th><th className="pr-4">5xx</th><th>Avg ms</th></tr></thead>
              <tbody>{[...series].reverse().map((p) => <tr key={p.t} className="border-t border-line"><td className="py-1 pr-4">{p.label}</td><td className="pr-4">{p.requests}</td><td className="pr-4">{p.success}</td><td className="pr-4">{p.rateLimited}</td><td className="pr-4">{p.failed}</td><td>{p.avgMs}</td></tr>)}</tbody></table>
          </div>
        </details>
      )}
      <p className="mt-6 text-xs text-muted">Metric notes: gateway counters and time-series live in gateway memory and reset when it restarts (the series keeps a bounded 10-minute window). Cache and worker counters are stored in Redis. Health/metrics polling is excluded from request counts.</p>
    </div>
  );
}

function unavailableReason(m: MaybeAvailable<object> | undefined) { return m && !m.available ? `unavailable: ${m.reason}` : undefined; }

function ChartCard({ title, sub, children, empty, legend }: { title: string; sub: string; children: ReactNode; empty?: boolean; legend?: boolean }) {
  void legend;
  return (
    <div className="card p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mb-3 text-xs text-muted">{sub}</p>
      <div className="h-60">
        {empty ? <div className="grid h-full place-items-center text-sm text-muted">Waiting for data… generate some traffic.</div> :
          <ResponsiveContainer width="100%" height="100%">{children as React.ReactElement}</ResponsiveContainer>}
      </div>
    </div>
  );
}
