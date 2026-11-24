'use client';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleDashed, Cog, Loader2, Play, XCircle } from 'lucide-react';
import { api, newId, ApiError } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useToast } from '@/components/Toast';
import type { Booking, WorkerEvent } from '@/lib/types';
import { Section } from './shared';

type Mode = 'normal' | 'transient' | 'permanent';
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'normal', label: 'Normal', hint: 'Completes on the first attempt.' },
  { id: 'transient', label: 'Transient failures', hint: 'Fails twice, then succeeds: shows retries with exponential backoff.' },
  { id: 'permanent', label: 'Permanent failure', hint: 'Always fails: booking is marked FAILED and the tickets are released.' },
];

const EVENT_LABEL: Record<string, string> = {
  'queue.published': 'Outbox dispatcher published job to BullMQ',
  'job.active': 'Worker picked up the job',
  'job.completed': 'Job completed',
  'job.retry': 'Job failed - scheduled for retry (backoff)',
  'job.failed': 'Job failed permanently',
};

export function WorkerDemo() {
  const toast = useToast();
  const demo = useAsync(() => api.demoEvent(), []);
  const [mode, setMode] = useState<Mode>('normal');
  const [running, setRunning] = useState(false);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [events, setEvents] = useState<WorkerEvent[]>([]);
  const [ref, setRef] = useState<string | null>(null);
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);

  const chaos = demo.data?.data.chaosEnabled ?? false;

  const run = async () => {
    if (!demo.data) return;
    setRunning(true); setBooking(null); setEvents([]); setRef(null); stop.current = false;
    try {
      const headers: Record<string, string> = mode === 'normal' ? {} : { 'X-Simulate-Failure': mode };
      const r = await api.createBooking({ eventId: demo.data.data.eventId, quantity: 1, name: 'Playground User', email: `playground+${Date.now()}@example.com` }, `pg-${newId()}`, headers);
      setRef(r.data.bookingReference);
      const id = r.data.bookingId;
      for (let i = 0; i < 90 && !stop.current; i++) {
        const [b, ev] = await Promise.all([api.booking(id), api.workerEvents(id).catch(() => null)]);
        setBooking(b.data);
        if (ev) setEvents(ev.data);
        if (b.data.status !== 'PROCESSING') break;
        await new Promise((res) => setTimeout(res, 600));
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e : e, 'Test booking failed');
    } finally { setRunning(false); }
  };

  const published = events.some((e) => e.type === 'queue.published');
  const active = events.some((e) => e.type === 'job.active');
  const done = booking?.status === 'CONFIRMED';
  const failed = booking?.status === 'FAILED';
  const steps = [
    { label: 'Accepted (HTTP 202) - row + outbox record committed in PostgreSQL', on: Boolean(ref) },
    { label: 'Queued - dispatcher published to BullMQ', on: published || active || done || failed },
    { label: 'Active - worker processing', on: active || done || failed },
    { label: failed ? 'Failed - retries exhausted, inventory released' : 'Completed - booking CONFIRMED in PostgreSQL', on: done || failed },
  ];

  return (
    <Section icon={Cog} title="3 · Async worker (outbox → BullMQ → worker)" blurb="The API answers 202 as soon as the booking and an outbox record are committed. A dispatcher relays the outbox to BullMQ and a separate worker confirms the booking later. Nothing waits on the slow work.">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Failure simulation">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={mode === m.id} className="chip" disabled={running || (m.id !== 'normal' && !chaos)} onClick={() => setMode(m.id)} title={m.hint}>{m.label}</button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">{MODES.find((m) => m.id === mode)?.hint}{!chaos && demo.data ? ' (Failure simulation is disabled on this server.)' : ''}</p>
      <button className="btn btn-primary mt-4" onClick={run} disabled={running || !demo.data}>{running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Submit test booking</button>
      {demo.error && <p className="mt-3 text-sm text-bad">Demo event unavailable: {demo.error.message}</p>}

      {ref && (
        <div className="mt-5 grid gap-5 lg:grid-cols-2" aria-live="polite">
          <div>
            <p className="num mb-3 text-sm text-muted">Reference <strong className="text-ink">{ref}</strong> · status <strong data-testid="worker-demo-status" className={done ? 'text-good' : failed ? 'text-bad' : 'text-flash'}>{booking?.status ?? 'PROCESSING'}</strong>{booking?.job ? ` · job ${booking.job.state} (attempt ${booking.job.attemptsMade}/${booking.job.maxAttempts})` : ''}</p>
            <ol className="space-y-3">
              {steps.map((s, i) => {
                const isLastFail = i === 3 && failed;
                const current = !s.on && steps[i - 1]?.on && running;
                return <li key={s.label} className="flex items-start gap-3 text-sm">
                  {isLastFail ? <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-bad" aria-hidden /> : s.on ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-good" aria-hidden /> : current ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-flash" aria-hidden /> : <CircleDashed className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />}
                  <span className={s.on ? '' : 'text-muted'}>{s.label}</span></li>;
              })}
            </ol>
          </div>
          <div>
            <p className="label">Job events (from worker &amp; dispatcher)</p>
            <div className="max-h-56 overflow-auto rounded-xl border border-line bg-black/20 p-3 font-mono text-xs">
              {events.length === 0 ? <span className="text-muted">waiting for events…</span> : events.map((e, i) => (
                <div key={i} className="mb-1"><span className="text-muted">{new Date(e.at).toLocaleTimeString('en-IN', { hour12: false })}</span>{' '}
                  <span className={e.type.includes('fail') ? 'text-bad' : e.type.includes('retry') ? 'text-warn' : e.type === 'job.completed' ? 'text-good' : 'text-cyan'}>{e.type}</span>
                  <span className="text-muted"> {EVENT_LABEL[e.type] ?? ''}{e.attempt ? ` · attempt ${e.attempt}${e.maxAttempts ? `/${e.maxAttempts}` : ''}` : ''}{e.durationMs ? ` · ${e.durationMs} ms` : ''}{e.error ? ` · ${e.error}` : ''}</span></div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
