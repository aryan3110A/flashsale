'use client';
import Link from 'next/link';
import { CalendarDays, Heart, MapPin } from 'lucide-react';
import type { EventItem } from '@/lib/types';
import { fmtDate, money } from '@/lib/format';
import { EventImage } from './EventImage';

export function EventCard({ event: e, favorite, onToggleFavorite }: { event: EventItem; favorite: boolean; onToggleFavorite: (id: string) => void }) {
  const soldOut = e.availableCapacity === 0 || e.status === 'SOLD_OUT';
  const pctLeft = e.availableCapacity / e.totalCapacity;
  const low = !soldOut && (e.availableCapacity <= 20 || pctLeft < 0.15);
  return (
    <article className="card group relative flex flex-col overflow-hidden transition-transform hover:-translate-y-1">
      <Link href={`/events/${e.id}`} className="block" aria-label={`${e.title} - view details`}>
        <EventImage src={e.imageUrl} category={e.category} alt={e.title} />
      </Link>
      <span className="absolute left-3 top-3 rounded-full bg-bg/80 px-2.5 py-1 text-xs font-semibold backdrop-blur">{e.category}</span>
      <button
        onClick={() => onToggleFavorite(e.id)}
        aria-pressed={favorite}
        aria-label={favorite ? `Remove ${e.title} from saved events` : `Save ${e.title}`}
        className="absolute right-3 top-3 rounded-full bg-bg/80 p-2 backdrop-blur transition-colors hover:bg-bg"
      >
        <Heart className={`h-4 w-4 ${favorite ? 'fill-bad text-bad' : 'text-ink'}`} />
      </button>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <h3 className="line-clamp-2 text-lg font-semibold leading-snug">{e.title}</h3>
        <ul className="space-y-1 text-sm text-muted">
          <li className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0" aria-hidden /><span className="truncate">{e.venue}, {e.city}</span></li>
          <li className="flex items-center gap-2"><CalendarDays className="h-4 w-4 shrink-0" aria-hidden />{fmtDate(e.eventDate)}</li>
        </ul>
        <div className="mt-auto">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className={soldOut ? 'font-semibold text-bad' : low ? 'font-semibold text-warn' : 'text-muted'}>
              {soldOut ? 'Sold out' : low ? `Only ${e.availableCapacity} left` : `${e.availableCapacity.toLocaleString('en-IN')} available`}
            </span>
            <span className="num text-muted">{Math.round((1 - pctLeft) * 100)}% sold</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="Tickets sold" aria-valuenow={Math.round((1 - pctLeft) * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full rounded-full ${soldOut ? 'bg-bad' : low ? 'bg-warn' : 'bg-gradient-to-r from-accent to-cyan'}`} style={{ width: `${(1 - pctLeft) * 100}%` }} />
          </div>
          <div className="mt-4 flex items-center justify-between">
            <p className="num text-xl font-bold">{money(e.ticketPrice)}<span className="text-xs font-normal text-muted"> / ticket</span></p>
            <Link href={`/events/${e.id}`} className="btn btn-ghost !py-1.5">Details</Link>
          </div>
        </div>
      </div>
    </article>
  );
}

export function EventCardSkeleton() {
  return (
    <div className="card overflow-hidden" aria-hidden>
      <div className="skeleton aspect-[16/10] !rounded-none" />
      <div className="space-y-3 p-4"><div className="skeleton h-5 w-4/5" /><div className="skeleton h-4 w-3/5" /><div className="skeleton h-4 w-2/5" /><div className="skeleton mt-6 h-8 w-full" /></div>
    </div>
  );
}
