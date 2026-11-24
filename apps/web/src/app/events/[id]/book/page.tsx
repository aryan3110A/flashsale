'use client';
import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, CheckCircle2, CircleDashed, Loader2, Minus, Plus, TicketCheck, XCircle } from 'lucide-react';
import { api, ApiError, newId } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { getContact, saveContact } from '@/lib/storage';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/components/AuthProvider';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ErrorState, Skeleton, StatusPill } from '@/components/ui';
import { EMAIL_RE, clamp, fmtDateTime, money } from '@/lib/format';
import type { Booking, BookingAccepted } from '@/lib/types';

export default function BookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense fallback={<Skeleton className="h-96" />}><BookFlow id={id} /></Suspense>;
}

function BookFlow({ id }: { id: string }) {
  const toast = useToast();
  const { user } = useAuth();
  const sp = useSearchParams();
  const { data, error, loading, reload } = useAsync(() => api.event(id), [id]);
  const [qty, setQty] = useState(clamp(Number(sp.get('qty')) || 1, 1, 10));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState<BookingAccepted | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  // One idempotency key per distinct payload: retrying the SAME payload after a network blip can never double-book.
  const keyRef = useRef<{ payload: string; key: string } | null>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { const c = getContact(); setName(c.name ?? ''); setEmail(c.email ?? ''); }, []);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Skeleton className="h-96" />;
  const ev = data!.data;
  // A logged-in user always books as their account (the server enforces this too).
  const cName = user ? user.name : name;
  const cEmail = user ? user.email : email;
  const max = Math.min(10, ev.availableCapacity);
  const errors = {
    name: cName.trim().length < 2 ? 'Enter your full name (at least 2 characters).' : '',
    email: !EMAIL_RE.test(cEmail.trim()) ? 'Enter a valid email address.' : '',
    qty: qty < 1 || qty > max ? `Choose between 1 and ${max} tickets.` : '',
  };
  const valid = !errors.name && !errors.email && !errors.qty;
  const total = ev.ticketPrice * qty;

  const submit = async () => {
    if (submitting) return; // guard against double submit
    setSubmitting(true);
    setFailure(null);
    const payload = { eventId: ev.id, quantity: qty, name: cName.trim(), email: cEmail.trim().toLowerCase() };
    const sig = JSON.stringify(payload);
    if (keyRef.current?.payload !== sig) keyRef.current = { payload: sig, key: `web-${newId()}` };
    try {
      const r = await api.createBooking(payload, keyRef.current.key);
      saveContact({ name: payload.name, email: payload.email });
      setAccepted(r.data);
      setConfirmOpen(false);
      toast.push('success', 'Booking accepted', `Reference ${r.data.bookingReference} is being processed.`);
    } catch (e) {
      setConfirmOpen(false);
      const err = e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', (e as Error).message);
      setFailure(err);
      // A definitive 4xx rejection means the next attempt is a brand-new request; network/5xx errors keep the key so a retry is safe.
      if (err.status >= 400 && err.status < 500 && err.status !== 429) keyRef.current = null;
      toast.error(e, 'Booking failed');
      if (err.code === 'INSUFFICIENT_INVENTORY') void reload();
    } finally { setSubmitting(false); }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <Link href={`/events/${id}`} className="mb-6 inline-flex items-center gap-2 text-sm text-muted hover:text-white"><ArrowLeft className="h-4 w-4" aria-hidden /> Back to event</Link>
      <h1 className="mb-8 text-3xl font-extrabold tracking-tight">{accepted ? 'Your booking' : 'Complete your booking'}</h1>

      <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
        {!accepted ? (
          <form noValidate className="card space-y-5 p-6" onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) setConfirmOpen(true); }}>
            {failure && (
              <div role="alert" className="rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm">
                <p className="flex items-center gap-2 font-semibold text-bad"><XCircle className="h-4 w-4" aria-hidden /> Booking not completed</p>
                <p className="mt-1 text-ink/90">{failure.message}</p>
                {failure.code === 'INSUFFICIENT_INVENTORY' && <p className="mt-1 text-muted">Availability has been refreshed. Lower the quantity or pick another event.</p>}
                {(failure.status === 0 || failure.status >= 500) && <p className="mt-1 text-muted">Safe to retry: the same request key is reused, so you cannot be booked twice.</p>}
                {failure.requestId && <p className="num mt-2 text-xs text-muted">Request ID: {failure.requestId}</p>}
              </div>
            )}
            {user ? (
              <p className="rounded-xl border border-accent/30 bg-accent/10 p-3 text-sm" data-testid="booking-as">Booking as <strong>{user.name}</strong> ({user.email}). Your tickets will appear under <Link href="/bookings" className="underline">My bookings</Link>.</p>
            ) : (
              <p className="rounded-xl border border-line bg-white/5 p-3 text-sm text-muted">Booking as a guest. <Link href={`/login?next=${encodeURIComponent(`/events/${id}/book`)}`} className="font-semibold text-accent hover:underline">Log in</Link> or <Link href={`/signup?next=${encodeURIComponent(`/events/${id}/book`)}`} className="font-semibold text-accent hover:underline">sign up</Link> to book faster.</p>
            )}
            <div>
              <label htmlFor="name" className="label">Full name</label>
              <input id="name" className="input" autoComplete="name" value={cName} readOnly={!!user} onChange={(e) => setName(e.target.value)} aria-invalid={touched && !!errors.name} aria-describedby="name-err" maxLength={100} />
              <p id="name-err" className="mt-1 min-h-4 text-xs text-bad">{touched ? errors.name : ''}</p>
            </div>
            <div>
              <label htmlFor="email" className="label">Email (your bookings are looked up by this)</label>
              <input id="email" type="email" className="input" autoComplete="email" value={cEmail} readOnly={!!user} onChange={(e) => setEmail(e.target.value)} aria-invalid={touched && !!errors.email} aria-describedby="email-err" maxLength={200} />
              <p id="email-err" className="mt-1 min-h-4 text-xs text-bad">{touched ? errors.email : ''}</p>
            </div>
            <div>
              <p id="q-label" className="label">Tickets</p>
              <div className="flex items-center gap-3" role="group" aria-labelledby="q-label">
                <button type="button" className="btn btn-ghost !p-2.5" onClick={() => setQty(clamp(qty - 1, 1, max))} disabled={qty <= 1} aria-label="Decrease quantity"><Minus className="h-4 w-4" /></button>
                <output className="num w-10 text-center text-xl font-bold">{qty}</output>
                <button type="button" className="btn btn-ghost !p-2.5" onClick={() => setQty(clamp(qty + 1, 1, max))} disabled={qty >= max} aria-label="Increase quantity"><Plus className="h-4 w-4" /></button>
              </div>
              <p className="mt-1 min-h-4 text-xs text-bad">{touched ? errors.qty : ''}</p>
            </div>
            <button type="submit" className="btn btn-primary w-full !py-3 text-base" disabled={submitting || max < 1}>
              {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Submitting…</> : 'Review booking'}
            </button>
          </form>
        ) : <Tracker accepted={accepted} />}

        <aside className="card h-fit space-y-4 p-6 lg:sticky lg:top-24">
          <h2 className="text-lg font-bold">Booking summary</h2>
          <div><p className="font-semibold">{ev.title}</p><p className="text-sm text-muted">{fmtDateTime(ev.eventDate)}</p><p className="text-sm text-muted">{ev.venue}, {ev.city}</p></div>
          <dl className="space-y-2 border-t border-line pt-4 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Ticket price</dt><dd className="num">{money(ev.ticketPrice)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Quantity</dt><dd className="num">× {accepted?.quantity ?? qty}</dd></div>
            <div className="flex justify-between border-t border-line pt-3 text-lg font-bold"><dt>Total</dt><dd className="num">{money(accepted?.totalAmount ?? total)}</dd></div>
          </dl>
          <p className="text-xs text-muted">No payment is taken in this demo; the worker simulates payment capture and ticket issuing.</p>
        </aside>
      </div>

      <ConfirmDialog open={confirmOpen} title="Confirm your booking" confirmLabel={`Book ${qty} ticket${qty > 1 ? 's' : ''}`} busy={submitting} onConfirm={submit} onCancel={() => setConfirmOpen(false)}>
        <p>You are booking <strong className="text-ink">{qty} × {ev.title}</strong> for <strong className="text-ink">{money(total)}</strong>. Confirmation is processed asynchronously and usually takes a couple of seconds.</p>
      </ConfirmDialog>
    </div>
  );
}

const STEPS = ['Accepted', 'Queued', 'Processing', 'Confirmed'] as const;

function stepIndex(b: Booking | null): number {
  if (!b) return 0;
  if (b.status === 'CONFIRMED') return 4;
  const s = b.job?.state;
  if (s === 'active') return 2;
  if (s === 'waiting' || s === 'delayed' || s === 'prioritized' || s === 'waiting-children') return 1;
  return b.status === 'FAILED' ? 3 : 1;
}

function Tracker({ accepted }: { accepted: BookingAccepted }) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const poll = useCallback(async () => {
    try { const r = await api.booking(accepted.bookingId); setBooking(r.data); setPollError(null); return r.data; }
    catch (e) { setPollError((e as Error).message); return null; }
  }, [accepted.bookingId]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const b = await poll();
      if (stop || (b && b.status !== 'PROCESSING')) return;
      timer = setTimeout(loop, 1000);
    };
    void loop();
    return () => { stop = true; clearTimeout(timer); };
  }, [poll]);

  const status = booking?.status ?? accepted.status;
  const idx = stepIndex(booking);
  const failed = status === 'FAILED';
  return (
    <div className="card p-6" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-xs uppercase tracking-widest text-muted">Booking reference</p><p className="num text-3xl font-extrabold tracking-wider">{accepted.bookingReference}</p></div>
        <StatusPill status={status} />
      </div>

      <ol className="mt-8 space-y-4">
        {STEPS.map((label, i) => {
          const done = i < idx;
          const current = i === idx && status === 'PROCESSING';
          const isFailStep = failed && i === 3;
          return (
            <li key={label} className="flex items-center gap-3">
              {isFailStep ? <XCircle className="h-6 w-6 text-bad" aria-hidden /> : done ? <CheckCircle2 className="h-6 w-6 text-good" aria-hidden /> : current ? <Loader2 className="h-6 w-6 animate-spin text-flash" aria-hidden /> : <CircleDashed className="h-6 w-6 text-muted" aria-hidden />}
              <span className={done || current || isFailStep ? 'font-semibold' : 'text-muted'}>{isFailStep ? 'Failed' : label}</span>
              {current && <span className="text-xs text-muted">{label === 'Queued' ? 'waiting for a worker' : label === 'Accepted' ? 'recorded in PostgreSQL' : 'worker is processing'}</span>}
            </li>
          );
        })}
      </ol>

      {status === 'CONFIRMED' && <div className="mt-6 rounded-xl border border-good/30 bg-good/10 p-4 text-sm"><p className="flex items-center gap-2 font-semibold text-good"><TicketCheck className="h-5 w-5" aria-hidden /> You&apos;re going!</p><p className="mt-1 text-muted">Your tickets are confirmed. Find them any time under <Link href="/bookings" className="underline">My bookings</Link>.</p></div>}
      {failed && <div role="alert" className="mt-6 rounded-xl border border-bad/30 bg-bad/10 p-4 text-sm"><p className="font-semibold text-bad">We could not complete this booking.</p><p className="mt-1 text-muted">{booking?.failureReason ?? 'Processing failed'}. Your reserved tickets were released.</p></div>}
      {pollError && <p className="mt-4 text-xs text-warn">Status check failed ({pollError}); retrying…</p>}
      {booking?.job && <p className="num mt-4 text-xs text-muted">Queue job: {booking.job.state} · attempt {booking.job.attemptsMade}/{booking.job.maxAttempts}</p>}
      <div className="mt-6 flex flex-wrap gap-3"><Link href="/bookings" className="btn btn-ghost">My bookings</Link><Link href="/" className="btn btn-ghost">Keep browsing</Link></div>
    </div>
  );
}
