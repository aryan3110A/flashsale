'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Loader2, Play, RotateCcw, Square, XCircle } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError, newId } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { fmtNum } from '@/lib/format';
import { emptyCounters, makeUsers, runSimulation, type Counters, type Mode, type SimUser, type UserPhase } from '@/lib/simulator';
import { useToast } from '@/components/Toast';
import { ErrorState, PageHeader, Skeleton, Stat, StatusPill } from '@/components/ui';
import { LiveServices } from '@/components/simulator/LiveServices';
import type { FlashSaleState } from '@/lib/types';

// Same validated dark-surface categorical colours as the monitoring dashboard.
const C = { blue: '#3987e5', orange: '#d95926', aqua: '#199e70', red: '#e66767', violet: '#9085e9' };
const AXIS = { stroke: '#a1abc9', fontSize: 11 };
const GRID = '#232d57';
const TT = { contentStyle: { background: '#111833', border: '1px solid #232d57', borderRadius: 12, color: '#eef1fb', fontSize: 12 }, labelStyle: { color: '#a1abc9' }, cursor: { stroke: '#a1abc9', strokeOpacity: 0.4 } };

type RunPhase = 'idle' | 'starting' | 'running' | 'settling' | 'done';
interface Sample extends Counters { t: number; processing: number; confirmed: number; failed: number; available: number | null }
interface Ctl {
  counters: Counters; users: SimUser[]; abort: AbortController; startedAt: number;
  requestsDone: boolean; doneAt: number; server: FlashSaleState | null; serverAt: number; polling: boolean;
  zeroTicks: number; deadline: number; capacity: number;
}

const SETTLE_TIMEOUT_S = 30;

export default function SimulatorPage() {
  const toast = useToast();
  const initial = useAsync(() => api.flashSale(), []);
  const [live, setLive] = useState<FlashSaleState | null>(null);
  const server = live ?? initial.data?.data ?? null;

  const [cfg, setCfg] = useState({ users: 10, quantity: 10, clicks: 8, capacity: 50, mode: 'polite' as Mode, autoReset: true });
  const [phase, setPhase] = useState<RunPhase>('idle');
  const [counts, setCounts] = useState<Counters>(emptyCounters());
  const [users, setUsers] = useState<SimUser[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [startError, setStartError] = useState<ApiError | null>(null);
  const ctlRef = useRef<Ctl | null>(null);

  const running = phase === 'starting' || phase === 'running' || phase === 'settling';

  // Sample the counters and the real server state twice a second while a run is active.
  useEffect(() => {
    if (phase !== 'running' && phase !== 'settling') return;
    const tick = () => {
      const c = ctlRef.current;
      if (!c) return;
      const now = performance.now();
      const el = (now - c.startedAt) / 1000;
      setElapsed(el);
      setCounts({ ...c.counters });
      setUsers(c.users.map((u) => ({ ...u })));
      if (!c.polling) {
        c.polling = true;
        api.flashSale()
          .then((r) => { c.server = r.data; c.serverAt = performance.now(); setLive(r.data); })
          .catch(() => { /* a 429 or blip during the flood: keep the last known state */ })
          .finally(() => { c.polling = false; });
      }
      const s = c.server;
      setSamples((prev) => [...prev, {
        ...c.counters, t: Math.round(el * 10) / 10,
        processing: s?.processing ?? 0, confirmed: s?.confirmed ?? 0, failed: s?.failed ?? 0, available: s ? s.availableCapacity : c.capacity,
      }].slice(-300));
      if (c.requestsDone) {
        // Done only when the worker has drained everything: two consecutive fresh reads with nothing PROCESSING.
        if (s && c.serverAt > c.doneAt && s.processing === 0) c.zeroTicks++; else c.zeroTicks = 0;
        if (c.zeroTicks >= 2 || now > c.deadline) { setPhase('done'); }
      }
    };
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [phase]);

  // Leaving the page cancels an in-flight run.
  useEffect(() => () => { ctlRef.current?.abort.abort(); }, []);

  const start = async () => {
    if (running) return;
    setPhase('starting'); setStartError(null); setSamples([]); setCounts(emptyCounters()); setUsers([]); setElapsed(0);
    let st: FlashSaleState;
    try {
      st = (cfg.autoReset ? await api.flashSaleReset(cfg.capacity) : await api.flashSale()).data;
    } catch (e) {
      setStartError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', (e as Error).message));
      setPhase('idle');
      return;
    }
    setLive(st);
    const abort = new AbortController();
    const ctl: Ctl = {
      counters: emptyCounters(), users: makeUsers(cfg.users), abort, startedAt: performance.now(),
      requestsDone: false, doneAt: 0, server: st, serverAt: performance.now(), polling: false, zeroTicks: 0, deadline: Infinity, capacity: st.totalCapacity,
    };
    ctlRef.current = ctl;
    setUsers(ctl.users.map((u) => ({ ...u })));
    setPhase('running');
    void runSimulation(
      { eventId: st.eventId, runId: newId().slice(0, 8), users: cfg.users, quantity: cfg.quantity, clicks: cfg.clicks, mode: cfg.mode },
      { counters: ctl.counters, users: ctl.users, signal: abort.signal },
    ).then(() => {
      ctl.requestsDone = true;
      ctl.doneAt = performance.now();
      ctl.deadline = ctl.doneAt + SETTLE_TIMEOUT_S * 1000;
      setCounts({ ...ctl.counters });
      setUsers(ctl.users.map((u) => ({ ...u })));
      setPhase((p) => (p === 'running' ? 'settling' : p));
    });
  };

  const stop = () => { ctlRef.current?.abort.abort(); toast.push('info', 'Stopping', 'Remaining requests were cancelled; already accepted bookings keep processing.'); };

  const reset = async () => {
    try { const r = await api.flashSaleReset(cfg.capacity); setLive(r.data); setSamples([]); setUsers([]); setCounts(emptyCounters()); setPhase('idle'); toast.push('success', 'Stock reset', `${cfg.capacity} tickets available, old demo bookings removed.`); }
    catch (e) { toast.error(e, 'Could not reset the demo event'); }
  };

  if (initial.error && !server) return <ErrorState error={initial.error} onRetry={initial.reload} />;
  if (!server) return <Skeleton className="h-96" />;

  const total = server.totalCapacity;
  const pctLeft = total > 0 ? Math.round((server.availableCapacity / total) * 100) : 0;
  const byRef = new Map(server.list.map((b) => [b.reference, b]));
  const winners = users.filter((u) => u.phase === 'accepted').length;
  const demand = cfg.users * cfg.quantity;

  return (
    <div>
      <PageHeader eyebrow="Live demo" title="Flash-sale simulator"
        subtitle="Many people hit Book at the same moment. Watch the real gateway, rate limiter, database, queue and worker handle it - every number below comes from the running system." />

      {/* ---- controls ---- */}
      <section aria-labelledby="ctl-h" className="card mb-6 p-5">
        <h2 id="ctl-h" className="mb-4 text-lg font-bold">Scenario</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <NumberField id="sim-users" label="Virtual users" hint="people buying" value={cfg.users} min={1} max={50} disabled={running} onChange={(v) => setCfg((c) => ({ ...c, users: v }))} />
          <NumberField id="sim-qty" label="Tickets per user" hint="max 10 per booking" value={cfg.quantity} min={1} max={10} disabled={running} onChange={(v) => setCfg((c) => ({ ...c, quantity: v }))} />
          <NumberField id="sim-clicks" label="Clicks per user" hint="impatient double-clicks" value={cfg.clicks} min={1} max={20} disabled={running} onChange={(v) => setCfg((c) => ({ ...c, clicks: v }))} />
          <NumberField id="sim-stock" label="Tickets on sale" hint="stock to start with" value={cfg.capacity} min={1} max={1000} disabled={running} onChange={(v) => setCfg((c) => ({ ...c, capacity: v }))} />
          <div>
            <p id="mode-l" className="label">Client behaviour</p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="mode-l">
              {([['polite', 'Polite (retry after 429)'], ['flood', 'Raw flood (no retry)']] as [Mode, string][]).map(([m, label]) => (
                <button key={m} type="button" role="radio" aria-checked={cfg.mode === m} disabled={running} onClick={() => setCfg((c) => ({ ...c, mode: m }))}
                  className={`chip`}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        <p className="mt-4 text-sm text-muted">
          Demand: <strong className="text-ink">{cfg.users} users × {cfg.quantity} tickets = {demand} tickets</strong> for <strong className="text-ink">{cfg.capacity}</strong> on sale
          ({cfg.users * cfg.clicks} booking requests in a burst). {demand > cfg.capacity ? 'There are more buyers than tickets, so some users must be turned away.' : 'There is enough stock for everyone.'}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" onClick={() => void start()} disabled={running} data-testid="sim-start">
            {phase === 'starting' ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Preparing…</> : <><Play className="h-4 w-4" aria-hidden /> Start flash sale</>}
          </button>
          {running && phase !== 'starting' && <button className="btn btn-ghost" onClick={stop}><Square className="h-4 w-4" aria-hidden /> Stop</button>}
          <button className="btn btn-ghost" onClick={() => void reset()} disabled={running}><RotateCcw className="h-4 w-4" aria-hidden /> Reset stock</button>
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={cfg.autoReset} disabled={running} onChange={(e) => setCfg((c) => ({ ...c, autoReset: e.target.checked }))} /> Reset stock before each run</label>
        </div>
        {startError && <p role="alert" className="mt-3 text-sm text-bad">Could not start: {startError.message}</p>}
        <p className="mt-3 text-xs text-muted">Uses a dedicated hidden demo event, so your real events are never touched. Resetting only removes that event&apos;s own demo bookings.</p>
      </section>

      {/* ---- live numbers ---- */}
      <section aria-labelledby="live-h" className="mb-6">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 id="live-h" className="text-xl font-bold">Live results</h2>
          <span role="status" aria-live="polite" className="text-sm text-muted" data-testid="sim-phase">
            {phase === 'idle' ? 'Ready' : phase === 'starting' ? 'Preparing…' : phase === 'running' ? `Sending requests… ${elapsed.toFixed(1)} s` : phase === 'settling' ? 'All requests answered - waiting for the background worker…' : `Finished in ${elapsed.toFixed(1)} s`}
          </span>
        </div>
        <div className="grid gap-3 lg:grid-cols-[1.2fr_2fr]">
          <div className="card p-4" data-testid="stock-card">
            <p className="text-xs font-medium text-muted">Tickets left ({server.title})</p>
            <p className="num mt-1 text-4xl font-extrabold" data-testid="stock-left">{server.availableCapacity}<span className="text-lg font-semibold text-muted"> / {total}</span></p>
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={server.availableCapacity} aria-valuemin={0} aria-valuemax={total} aria-label="Tickets remaining"><div className="h-full rounded-full bg-gradient-to-r from-accent-strong to-cyan transition-all" style={{ width: `${pctLeft}%` }} /></div>
            <p className="num mt-2 text-xs text-muted">{server.reservedTickets} reserved · status {server.status}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Stat label="Requests sent" value={fmtNum(counts.sent)} hint="incl. duplicate clicks + retries" />
            <Stat label="Accepted (202)" value={fmtNum(counts.accepted)} tone="good" hint="booking created" />
            <Stat label="Duplicate clicks" value={fmtNum(counts.replayed)} hint="200 replay: no 2nd booking" />
            <Stat label="Sold out (409)" value={fmtNum(counts.soldOut)} tone={counts.soldOut > 0 ? 'warn' : undefined} hint="stock check said no" />
            <Stat label="Rate limited (429)" value={fmtNum(counts.rateLimited)} tone={counts.rateLimited > 0 ? 'warn' : undefined} hint="gateway shed the load" />
            <Stat label="Errors" value={fmtNum(counts.errors)} tone={counts.errors > 0 ? 'bad' : undefined} hint="5xx / network" />
          </div>
        </div>
      </section>

      {/* ---- charts ---- */}
      <section aria-labelledby="sim-charts-h" className="grid gap-5 lg:grid-cols-2">
        <h2 id="sim-charts-h" className="sr-only">Charts</h2>
        <ChartCard title="Requests by outcome" sub="cumulative, since the button was pressed" empty={samples.length < 2}>
          <LineChart data={samples} margin={{ left: -16, right: 8, top: 8 }}>
            <CartesianGrid stroke={GRID} vertical={false} /><XAxis dataKey="t" {...AXIS} tickLine={false} unit=" s" minTickGap={24} /><YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip {...TT} labelFormatter={(l) => `${l} s`} /><Legend wrapperStyle={{ fontSize: 12, color: '#a1abc9' }} />
            <Line type="monotone" dataKey="accepted" name="Accepted (202)" stroke={C.aqua} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="replayed" name="Duplicate click (200)" stroke={C.blue} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="soldOut" name="Sold out (409)" stroke={C.orange} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="rateLimited" name="Rate limited (429)" stroke={C.violet} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="errors" name="Errors" stroke={C.red} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ChartCard>

        <ChartCard title="Booking pipeline" sub="bookings by stage, read from PostgreSQL" empty={samples.length < 2}>
          <LineChart data={samples} margin={{ left: -16, right: 8, top: 8 }}>
            <CartesianGrid stroke={GRID} vertical={false} /><XAxis dataKey="t" {...AXIS} tickLine={false} unit=" s" minTickGap={24} /><YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip {...TT} labelFormatter={(l) => `${l} s`} /><Legend wrapperStyle={{ fontSize: 12, color: '#a1abc9' }} />
            <Line type="stepAfter" dataKey="processing" name="Processing (queued / in worker)" stroke={C.orange} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="confirmed" name="Confirmed" stroke={C.aqua} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="failed" name="Failed" stroke={C.red} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ChartCard>

        <ChartCard title="Tickets remaining" sub="live stock in PostgreSQL (never goes below 0)" empty={samples.length < 2}>
          <AreaChart data={samples} margin={{ left: -16, right: 8, top: 8 }}>
            <CartesianGrid stroke={GRID} vertical={false} /><XAxis dataKey="t" {...AXIS} tickLine={false} unit=" s" minTickGap={24} /><YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} domain={[0, total]} />
            <Tooltip {...TT} labelFormatter={(l) => `${l} s`} />
            <Area type="stepAfter" dataKey="available" name="Tickets left" stroke={C.blue} fill={C.blue} fillOpacity={0.2} strokeWidth={2} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ChartCard>

        <div className="card p-5">
          <h3 className="font-semibold">Virtual users</h3>
          <p className="mb-3 text-xs text-muted">{users.length ? `${winners} of ${users.length} got tickets` : 'Press “Start flash sale”.'}</p>
          <div className="max-h-60 overflow-auto">
            <table className="w-full text-left text-xs" data-testid="sim-users">
              <thead className="sticky top-0 bg-surface text-muted"><tr><th className="py-1 pr-3">User</th><th className="pr-3">Result</th><th className="pr-3">Booking</th><th className="num text-right">Sent / 429</th></tr></thead>
              <tbody>
                {users.map((u) => {
                  const b = u.reference ? byRef.get(u.reference) : undefined;
                  return (
                    <tr key={u.n} className="border-t border-line align-top">
                      <td className="py-1.5 pr-3">{u.name}</td>
                      <td className="pr-3"><PhaseBadge phase={u.phase} /><span className="sr-only"> {u.note}</span></td>
                      <td className="pr-3">{b ? <StatusPill status={b.status} /> : <span className="text-muted">-</span>}{u.reference && <span className="num ml-1 text-muted">{u.reference}</span>}</td>
                      <td className="num text-right text-muted">{u.sent} / {u.rateLimited}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {phase === 'done' && <Verdict server={server} counts={counts} demand={demand} />}

      <LiveServices busy={running} />

      {samples.length > 0 && (
        <details className="card mt-6 p-4">
          <summary className="cursor-pointer text-sm font-semibold">View chart data as a table</summary>
          <div className="mt-3 max-h-72 overflow-auto">
            <table className="num w-full text-left text-xs"><thead className="sticky top-0 bg-surface text-muted"><tr><th className="py-1 pr-3">Time (s)</th><th className="pr-3">202</th><th className="pr-3">Dup 200</th><th className="pr-3">409</th><th className="pr-3">429</th><th className="pr-3">Err</th><th className="pr-3">Processing</th><th className="pr-3">Confirmed</th><th className="pr-3">Failed</th><th>Left</th></tr></thead>
              <tbody>{[...samples].reverse().map((p, i) => <tr key={i} className="border-t border-line"><td className="py-1 pr-3">{p.t}</td><td className="pr-3">{p.accepted}</td><td className="pr-3">{p.replayed}</td><td className="pr-3">{p.soldOut}</td><td className="pr-3">{p.rateLimited}</td><td className="pr-3">{p.errors}</td><td className="pr-3">{p.processing}</td><td className="pr-3">{p.confirmed}</td><td className="pr-3">{p.failed}</td><td>{p.available ?? '-'}</td></tr>)}</tbody></table>
          </div>
        </details>
      )}
      <p className="mt-6 text-xs text-muted">Honest limits: this runs in your browser, which opens at most about 6 connections to the gateway at a time, so it demonstrates behaviour (not maximum throughput) and every virtual user shares your IP address, hence one rate-limit bucket. For heavy load (hundreds of users) use the k6 scripts in <code>load-tests/</code>; their results are in the load-test report.</p>
    </div>
  );
}

function NumberField({ id, label, hint, value, min, max, disabled, onChange }: { id: string; label: string; hint: string; value: number; min: number; max: number; disabled: boolean; onChange: (v: number) => void }) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <input id={id} type="number" inputMode="numeric" className="input" min={min} max={max} value={value} disabled={disabled}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value)) || min)))} />
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

const PHASE: Record<UserPhase, { label: string; cls: string }> = {
  waiting: { label: 'waiting', cls: 'bg-white/10 text-muted border-line' },
  sending: { label: 'sending…', cls: 'bg-flash/15 text-flash border-flash/30' },
  retrying: { label: 'retrying after 429', cls: 'bg-accent/15 text-accent border-accent/30' },
  rate_limited: { label: 'rate limited', cls: 'bg-accent/15 text-accent border-accent/30' },
  error: { label: 'error', cls: 'bg-bad/15 text-bad border-bad/30' },
  sold_out: { label: 'sold out', cls: 'bg-flash/15 text-flash border-flash/30' },
  accepted: { label: 'got tickets', cls: 'bg-good/15 text-good border-good/30' },
};
function PhaseBadge({ phase }: { phase: UserPhase }) {
  const p = PHASE[phase];
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${p.cls}`}><span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />{p.label}</span>;
}

function Verdict({ server, counts, demand }: { server: FlashSaleState; counts: Counters; demand: number }) {
  const notOversold = server.reservedTickets <= server.totalCapacity && server.availableCapacity >= 0;
  const oneBookingEach = server.bookings === counts.accepted;
  const drained = server.processing === 0;
  const rows: { ok: boolean; label: string; detail: ReactNode }[] = [
    { ok: notOversold, label: 'No overselling', detail: <>{server.reservedTickets} tickets reserved of {server.totalCapacity}; {demand} were requested; {server.availableCapacity} left (never below 0).</> },
    { ok: server.consistent, label: 'Database is consistent', detail: <>total − left ({server.totalCapacity - server.availableCapacity}) equals tickets held by live bookings ({server.reservedTickets}).</> },
    { ok: oneBookingEach, label: 'Duplicate clicks created no extra bookings', detail: <>{counts.accepted} accepted requests = {server.bookings} bookings in the database ({fmtNum(counts.replayed)} duplicate clicks were absorbed by the idempotency key).</> },
    { ok: drained, label: 'Background worker finished everything', detail: <>{server.confirmed} confirmed, {server.failed} failed, {server.processing} still processing.</> },
  ];
  return (
    <section aria-labelledby="verdict-h" className="card mt-6 p-5" data-testid="sim-verdict">
      <h2 id="verdict-h" className="mb-3 text-lg font-bold">What the system proved</h2>
      <ul className="space-y-2.5 text-sm">
        {rows.map((r) => (
          <li key={r.label} className="flex items-start gap-3">
            {r.ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-good" aria-label="passed" /> : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-bad" aria-label="failed" />}
            <span><strong>{r.label}.</strong> <span className="text-muted">{r.detail}</span></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChartCard({ title, sub, children, empty }: { title: string; sub: string; children: ReactNode; empty?: boolean }) {
  return (
    <div className="card p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mb-3 text-xs text-muted">{sub}</p>
      <div className="h-60">
        {empty ? <div className="grid h-full place-items-center text-sm text-muted">Waiting for data… press “Start flash sale”.</div> :
          <ResponsiveContainer width="100%" height="100%">{children as React.ReactElement}</ResponsiveContainer>}
      </div>
    </div>
  );
}
