'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { getContact, saveContact } from '@/lib/storage';
import { useToast } from '@/components/Toast';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusPill } from '@/components/ui';
import { EMAIL_RE, fmtDate, fmtDateTime, money } from '@/lib/format';
import type { Booking } from '@/lib/types';

export default function BookingsPage() {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const [rows, setRows] = useState<Booking[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [emailErr, setEmailErr] = useState('');

  const load = async (addr: string, silent = false) => {
    if (!silent) setLoading(true);
    try { setRows((await api.bookingsByEmail(addr)).data); setError(null); }
    catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', (e as Error).message)); if (silent) toast.error(e, 'Refresh failed'); }
    finally { setLoading(false); }
  };

  // Contact details come from localStorage (browser only), so they are read after mount.
  useEffect(() => {
    const c = getContact();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (c.email) { setEmail(c.email); setSearched(c.email); void load(c.email); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh while anything is still processing.
  const pending = rows?.some((b) => b.status === 'PROCESSING');
  useEffect(() => {
    if (!pending || !searched) return;
    const t = setInterval(() => void load(searched, true), 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, searched]);

  return (
    <div>
      <PageHeader eyebrow="Your tickets" title="My bookings" subtitle="Bookings are looked up by the email you booked with. Status updates live as the background worker confirms each one."
        actions={searched ? <button className="btn btn-ghost" onClick={() => void load(searched)} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden /> Refresh</button> : undefined} />
      <form noValidate className="card mb-8 flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => {
        e.preventDefault();
        const v = email.trim().toLowerCase();
        if (!EMAIL_RE.test(v)) { setEmailErr('Enter a valid email address.'); return; }
        setEmailErr(''); setSearched(v); saveContact({ name: getContact().name ?? '', email: v }); void load(v);
      }}>
        <div className="min-w-60 flex-1">
          <label htmlFor="b-email" className="label">Email used for booking</label>
          <input id="b-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!emailErr} aria-describedby="b-email-err" placeholder="you@example.com" />
          <p id="b-email-err" className="mt-1 min-h-4 text-xs text-bad">{emailErr}</p>
        </div>
        <button className="btn btn-primary mb-5" type="submit" disabled={loading}><Search className="h-4 w-4" aria-hidden /> Find bookings</button>
      </form>

      {error ? <ErrorState error={error} onRetry={searched ? () => void load(searched) : undefined} /> :
        loading && !rows ? <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div> :
          !searched ? <EmptyState title="Enter your email" body="Use the email address you gave when booking to see your tickets." /> :
            rows && rows.length === 0 ? <EmptyState title="No bookings found" body={`Nothing booked with ${searched} yet.`} action={<Link href="/" className="btn btn-primary">Browse events</Link>} /> : (
              <ul className="space-y-3" aria-live="polite">
                {rows?.map((b) => (
                  <li key={b.id} className="card flex flex-wrap items-center justify-between gap-4 p-5">
                    <div className="min-w-0">
                      <p className="num text-sm font-bold tracking-wider text-accent">{b.reference}</p>
                      <Link href={`/events/${b.eventId}`} className="mt-0.5 block truncate text-lg font-semibold hover:underline">{b.eventTitle}</Link>
                      <p className="text-sm text-muted">{b.eventDate ? fmtDate(b.eventDate) : ''} · {b.venue}, {b.city}</p>
                      <p className="mt-1 text-xs text-muted">Booked {fmtDateTime(b.createdAt)}</p>
                    </div>
                    <div className="text-right">
                      <StatusPill status={b.status} />
                      {b.status === 'PROCESSING' && <p className="mt-1 flex items-center justify-end gap-1 text-xs text-muted"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> awaiting worker</p>}
                      {b.status === 'FAILED' && <p className="mt-1 max-w-48 text-xs text-bad">{b.failureReason ?? 'Failed'}; tickets released</p>}
                      <p className="num mt-2 text-xl font-bold">{money(b.totalAmount)}</p>
                      <p className="num text-xs text-muted">{b.quantity} ticket{b.quantity > 1 ? 's' : ''}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
    </div>
  );
}
