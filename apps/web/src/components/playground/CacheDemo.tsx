'use client';
import { useState } from 'react';
import { Database, Eraser, Search } from 'lucide-react';
import { rawRequest, api } from '@/lib/api';
import { usePolling } from '@/lib/hooks';
import { pct } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Section, ResultRow, MiniStat } from './shared';

interface Fetch { n: number; status: number; source: string | null; ms: number; lookupMs: number | null; count: number }
interface Stats { available: boolean; hits?: number; misses?: number; errors?: number; hitRatio?: number | null }

export function CacheDemo() {
  const toast = useToast();
  const [log, setLog] = useState<Fetch[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const stats = usePolling(async () => (await rawRequest<{ data: Stats }>('/api/cache/stats')).body.data, 2000);

  const fetchEvents = async () => {
    setBusy(true);
    try {
      const r = await rawRequest<{ data?: unknown[]; meta?: { lookupMs?: number } }>('/api/events');
      setLog((l) => [{ n: (l[0]?.n ?? 0) + 1, status: r.status, source: r.headers.cache, ms: r.durationMs, lookupMs: r.body?.meta?.lookupMs ?? null, count: r.body?.data?.length ?? 0 }, ...l].slice(0, 12));
      void stats.refresh();
    } catch (e) { toast.error(e, 'Fetch failed'); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true);
    try { const r = await api.cacheClear(); toast.push('success', 'Cache cleared', `${r.data.removedKeys} event cache key(s) removed. The next fetch will be a MISS.`); setConfirm(false); void stats.refresh(); }
    catch (e) { toast.error(e, 'Could not clear cache'); setConfirm(false); }
    finally { setBusy(false); }
  };
  const s = stats.data;

  return (
    <Section icon={Database} title="2 · Redis cache (cache-aside)" blurb="The Booking API checks Redis first. On a miss it reads PostgreSQL, stores the result with a TTL and returns it. Bookings invalidate the affected keys, and the booking transaction always re-checks real inventory in PostgreSQL, never the cached copy.">
      <div className="flex flex-wrap gap-3">
        <button className="btn btn-primary" onClick={fetchEvents} disabled={busy}><Search className="h-4 w-4" aria-hidden /> Fetch events</button>
        <button className="btn btn-danger" onClick={() => setConfirm(true)} disabled={busy}><Eraser className="h-4 w-4" aria-hidden /> Clear event cache</button>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label="Cache hits" value={s?.available ? s.hits ?? 0 : 'n/a'} tone="good" />
        <MiniStat label="Cache misses" value={s?.available ? s.misses ?? 0 : 'n/a'} tone="warn" />
        <MiniStat label="Hit ratio" value={s?.available ? pct(s.hitRatio ?? null) : 'n/a'} />
        <MiniStat label="Redis errors" value={s?.available ? s.errors ?? 0 : 'n/a'} tone={s?.errors ? 'bad' : undefined} />
      </div>
      {log.length > 0 ? (
        <div className="mt-4 rounded-xl border border-line">
          {log.map((f) => (
            <ResultRow key={f.n} left={`#${f.n}`} status={f.status}
              badge={<span className={`w-24 shrink-0 rounded px-2 py-0.5 text-center text-[11px] font-bold ${f.source === 'HIT' ? 'bg-good/20 text-good' : 'bg-warn/20 text-warn'}`}>{f.source === 'HIT' ? 'CACHE HIT' : f.source === 'MISS' ? 'CACHE MISS' : 'UNKNOWN'}</span>}
              detail={`${f.source === 'HIT' ? 'from Redis' : 'from PostgreSQL'} · ${f.count} events · server lookup ${f.lookupMs ?? 'n/a'} ms · round trip ${f.ms} ms`} />
          ))}
        </div>
      ) : <p className="mt-4 text-sm text-muted">Click “Fetch events” twice: the first call after a clear is a MISS (PostgreSQL), the next is a HIT (Redis).</p>}
      <ConfirmDialog open={confirm} title="Clear the event cache?" confirmLabel="Clear cache" busy={busy} onConfirm={clear} onCancel={() => setConfirm(false)}>
        Only <code>events:*</code> keys are removed (never queue or rate-limit data). The next requests will hit PostgreSQL until the cache warms up again.
      </ConfirmDialog>
    </Section>
  );
}
