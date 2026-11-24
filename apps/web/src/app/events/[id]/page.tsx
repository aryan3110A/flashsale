'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CalendarDays, Clock, Info, MapPin, Minus, Plus, Ticket } from 'lucide-react';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { EventImage } from '@/components/EventImage';
import { ErrorState, Skeleton, StatusPill } from '@/components/ui';
import { clamp, fmtDate, fmtTime, money } from '@/lib/format';

const MAX_PER_BOOKING = 10;

export default function EventDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, loading, reload } = useAsync(() => api.event(id), [id]);
  const [qty, setQty] = useState(1);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return (
    <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]"><Skeleton className="aspect-[16/10]" /><div className="space-y-4"><Skeleton className="h-10 w-3/4" /><Skeleton className="h-32" /><Skeleton className="h-48" /></div></div>
  );
  const e = data!.data;
  const max = Math.min(MAX_PER_BOOKING, e.availableCapacity);
  const soldOut = max <= 0 || e.status !== 'ON_SALE';
  const q = clamp(qty, 1, Math.max(1, max));

  return (
    <div>
      <Link href="/" className="mb-6 inline-flex items-center gap-2 text-sm text-muted hover:text-white"><ArrowLeft className="h-4 w-4" aria-hidden /> All events</Link>
      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        <div>
          <div className="card overflow-hidden"><EventImage src={e.imageUrl} category={e.category} alt={e.title} className="!aspect-[16/9]" /></div>
          <div className="mt-8">
            <div className="flex flex-wrap items-center gap-3"><span className="chip !cursor-default">{e.category}</span>{soldOut ? <StatusPill status="unhealthy" label="Sold out" /> : e.availableCapacity <= 20 ? <StatusPill status="degraded" label={`Only ${e.availableCapacity} left`} /> : null}</div>
            <h1 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{e.title}</h1>
            <p className="mt-4 text-lg leading-relaxed text-muted">{e.description}</p>
          </div>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <div className="card divide-y divide-line">
            <Fact icon={CalendarDays} label="Date" value={fmtDate(e.eventDate)} />
            <Fact icon={Clock} label="Time" value={fmtTime(e.eventDate)} />
            <Fact icon={MapPin} label="Venue" value={`${e.venue}, ${e.city}`} />
            <Fact icon={Ticket} label="Availability" value={soldOut ? 'Sold out' : `${e.availableCapacity.toLocaleString('en-IN')} of ${e.totalCapacity.toLocaleString('en-IN')} left`} />
          </div>

          <div className="card p-5">
            <div className="flex items-baseline justify-between"><span className="text-sm text-muted">Price per ticket</span><span className="num text-2xl font-bold">{money(e.ticketPrice)}</span></div>
            <div className="mt-5">
              <p id="qty-label" className="label">Tickets</p>
              <div className="flex items-center gap-3" role="group" aria-labelledby="qty-label">
                <button className="btn btn-ghost !p-2.5" onClick={() => setQty(clamp(q - 1, 1, max))} disabled={soldOut || q <= 1} aria-label="Decrease quantity"><Minus className="h-4 w-4" /></button>
                <output className="num w-10 text-center text-xl font-bold" aria-live="polite">{soldOut ? 0 : q}</output>
                <button className="btn btn-ghost !p-2.5" onClick={() => setQty(clamp(q + 1, 1, max))} disabled={soldOut || q >= max} aria-label="Increase quantity"><Plus className="h-4 w-4" /></button>
                <span className="ml-auto text-xs text-muted">max {max > 0 ? max : 0} per order</span>
              </div>
            </div>
            <div className="mt-5 flex items-baseline justify-between border-t border-line pt-4"><span className="text-muted">Total</span><span className="num text-2xl font-extrabold">{money(e.ticketPrice * (soldOut ? 0 : q))}</span></div>
            {soldOut ? <button className="btn btn-ghost mt-5 w-full" disabled>Sold out</button> :
              <Link href={`/events/${e.id}/book?qty=${q}`} className="btn btn-primary mt-5 w-full !py-3 text-base">Book {q} ticket{q > 1 ? 's' : ''}</Link>}
            <p className="mt-3 flex gap-2 text-xs text-muted"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />Availability shown here can lag by a few seconds (it is cached). The real check happens atomically at checkout.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Fact({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string }) {
  return <div className="flex items-start gap-3 p-4"><Icon className="mt-0.5 h-5 w-5 text-accent" aria-hidden /><div><p className="text-xs text-muted">{label}</p><p className="font-semibold">{value}</p></div></div>;
}
