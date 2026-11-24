'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Flame, Heart, Search, SlidersHorizontal, Sparkles, TrendingUp } from 'lucide-react';
import { api, type EventFilters } from '@/lib/api';
import { useAsync, useDebounced } from '@/lib/hooks';
import { getFavorites, toggleFavorite } from '@/lib/storage';
import { EventCard, EventCardSkeleton } from '@/components/EventCard';
import { EmptyState, ErrorState } from '@/components/ui';
import { EventImage } from '@/components/EventImage';
import { fmtDate, money } from '@/lib/format';
import type { EventItem } from '@/lib/types';

const DATE_RANGES = [
  { label: 'Any date', days: 0 }, { label: 'Next 7 days', days: 7 }, { label: 'Next 30 days', days: 30 }, { label: 'Next 60 days', days: 60 },
];
const PRICES = [
  { label: 'Any price', max: 0 }, { label: 'Under ₹500', max: 500 }, { label: 'Under ₹1,000', max: 1000 }, { label: 'Under ₹2,000', max: 2000 },
];
const SORTS = [
  { value: 'date', label: 'Soonest first' }, { value: 'price-asc', label: 'Price: low to high' }, { value: 'price-desc', label: 'Price: high to low' }, { value: 'popularity', label: 'Most popular' },
];

export default function DiscoverPage() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [city, setCity] = useState('');
  const [days, setDays] = useState(0);
  const [maxPrice, setMaxPrice] = useState(0);
  const [sort, setSort] = useState('date');
  const [savedOnly, setSavedOnly] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  // Favourites live in localStorage, which only exists in the browser, so they are read after mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setFavorites(getFavorites()), []);
  const q = useDebounced(search, 300);

  const filters: EventFilters = useMemo(() => ({
    q: q || undefined, category: category || undefined, city: city || undefined, sort,
    maxPrice: maxPrice || undefined,
  }), [q, category, city, maxPrice, sort]);
  const toDate = () => (days ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined);

  // Unfiltered list feeds the facets (cities) and the trending rail; the filtered query drives the grid.
  const all = useAsync(() => api.events({ sort: 'popularity' }), []);
  const cats = useAsync(() => api.categories(), []);
  const featured = useAsync(() => api.featured(), []);
  const results = useAsync(() => api.events({ ...filters, to: toDate() }), [JSON.stringify(filters), days]);

  const cities = useMemo(() => [...new Set((all.data?.data ?? []).map((e) => e.city))].sort(), [all.data]);
  const trending = (all.data?.data ?? []).filter((e) => e.availableCapacity > 0).slice(0, 4);
  const grid = (results.data?.data ?? []).filter((e) => !savedOnly || favorites.includes(e.id));
  const filtersActive = Boolean(q || category || city || days || maxPrice || savedOnly);
  const onFav = (id: string) => setFavorites(toggleFavorite(id));

  return (
    <div className="space-y-14">
      <section className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-surface-2 via-surface to-bg p-6 sm:p-12">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/30 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-24 left-1/3 h-64 w-64 rounded-full bg-cyan/20 blur-3xl" aria-hidden />
        <div className="relative max-w-3xl">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-white/5 px-3 py-1 text-xs font-semibold text-flash"><Flame className="h-3.5 w-3.5" aria-hidden /> Tickets go fast. Booking is built to hold up under the rush.</p>
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-6xl">Live events.<br /><span className="bg-gradient-to-r from-accent to-cyan bg-clip-text text-transparent">Zero oversells.</span></h1>
          <p className="mt-4 max-w-xl text-lg text-muted">Concerts, summits, runs and more. Every ticket is reserved atomically in PostgreSQL, so when you get a confirmation, the seat is really yours.</p>
          <form role="search" onSubmit={(e) => e.preventDefault()} className="mt-8 flex max-w-xl items-center gap-2 rounded-2xl border border-line bg-bg/70 p-2 backdrop-blur">
            <Search className="ml-2 h-5 w-5 shrink-0 text-muted" aria-hidden />
            <label htmlFor="search" className="sr-only">Search events</label>
            <input id="search" className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none placeholder:text-muted" placeholder="Search events, venues or cities…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {search && <button type="button" className="btn btn-ghost !py-1.5" onClick={() => setSearch('')}>Clear</button>}
          </form>
        </div>
      </section>

      {(featured.loading || (featured.data?.data.length ?? 0) > 0) && (
        <section aria-labelledby="featured-h">
          <h2 id="featured-h" className="mb-4 flex items-center gap-2 text-2xl font-bold"><Sparkles className="h-6 w-6 text-flash" aria-hidden /> Featured</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {featured.loading && !featured.data ? [0, 1, 2].map((i) => <div key={i} className="skeleton aspect-[16/10]" />) :
              featured.data?.data.slice(0, 3).map((e) => <FeaturedTile key={e.id} e={e} />)}
          </div>
        </section>
      )}

      {trending.length > 0 && (
        <section aria-labelledby="trending-h">
          <h2 id="trending-h" className="mb-4 flex flex-wrap items-center gap-2 text-2xl font-bold"><TrendingUp className="h-6 w-6 text-cyan" aria-hidden /> Trending now <span className="text-sm font-normal text-muted">ranked by share of tickets sold</span></h2>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {trending.map((e, i) => (
              <li key={e.id}>
                <Link href={`/events/${e.id}`} className="card flex items-center gap-4 p-3 transition-colors hover:border-accent">
                  <span className="num text-3xl font-black text-white/20">{i + 1}</span>
                  <span className="min-w-0"><span className="block truncate font-semibold">{e.title}</span><span className="num text-xs text-muted">{Math.round((1 - e.availableCapacity / e.totalCapacity) * 100)}% sold · {e.city}</span></span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="browse-h">
        <h2 id="browse-h" className="mb-4 text-2xl font-bold">Browse events</h2>
        <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Categories">
          <button className="chip" aria-pressed={category === ''} onClick={() => setCategory('')}>All</button>
          {cats.data?.data.map((c) => (
            <button key={c.slug} className="chip" aria-pressed={category === c.name} onClick={() => setCategory(category === c.name ? '' : c.name)}>{c.name} <span className="num opacity-60">{c.count}</span></button>
          ))}
        </div>
        <div className="card mb-6 grid grid-cols-2 gap-3 p-4 lg:grid-cols-6">
          <div className="col-span-2 flex items-center gap-2 text-sm font-semibold text-muted lg:col-span-1"><SlidersHorizontal className="h-4 w-4" aria-hidden /> Filters</div>
          <Select id="f-city" label="Location" value={city} onChange={setCity} options={[{ value: '', label: 'All cities' }, ...cities.map((c) => ({ value: c, label: c }))]} />
          <Select id="f-date" label="Date" value={String(days)} onChange={(v) => setDays(Number(v))} options={DATE_RANGES.map((d) => ({ value: String(d.days), label: d.label }))} />
          <Select id="f-price" label="Price" value={String(maxPrice)} onChange={(v) => setMaxPrice(Number(v))} options={PRICES.map((p) => ({ value: String(p.max), label: p.label }))} />
          <Select id="f-sort" label="Sort by" value={sort} onChange={setSort} options={SORTS} />
          <div className="flex items-end">
            <button className="chip w-full justify-center !py-2.5" aria-pressed={savedOnly} onClick={() => setSavedOnly((s) => !s)}><Heart className={`h-4 w-4 ${savedOnly ? 'fill-bad text-bad' : ''}`} aria-hidden /> Saved{favorites.length ? ` (${favorites.length})` : ''}</button>
          </div>
        </div>

        <div aria-live="polite">
          {results.error ? <ErrorState error={results.error} onRetry={results.reload} /> :
            results.loading && !results.data ? <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <EventCardSkeleton key={i} />)}</div> :
              grid.length === 0 ? (
                <EmptyState title={savedOnly && favorites.length === 0 ? 'No saved events yet' : 'No events match your filters'} body={savedOnly && favorites.length === 0 ? 'Tap the heart on any event to save it here.' : 'Try widening the date range, price or location.'}
                  action={filtersActive ? <button className="btn btn-ghost" onClick={() => { setSearch(''); setCategory(''); setCity(''); setDays(0); setMaxPrice(0); setSavedOnly(false); }}>Reset filters</button> : undefined} />
              ) : (
                <>
                  <p className="mb-3 text-sm text-muted">{grid.length} event{grid.length === 1 ? '' : 's'}
                    {results.data?.raw.headers.cache && <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-xs">served from {results.data.raw.headers.cache === 'HIT' ? 'Redis cache' : 'PostgreSQL'}</span>}
                  </p>
                  <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {grid.map((e) => <EventCard key={e.id} event={e} favorite={favorites.includes(e.id)} onToggleFavorite={onFav} />)}
                  </div>
                </>
              )}
        </div>
      </section>
    </div>
  );
}

function FeaturedTile({ e }: { e: EventItem }) {
  return (
    <Link href={`/events/${e.id}`} className="card group relative block overflow-hidden">
      <EventImage src={e.imageUrl} category={e.category} alt={e.title} />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg via-bg/80 to-transparent p-4 pt-12">
        <p className="text-xs font-semibold uppercase tracking-wider text-flash">{e.category} · {fmtDate(e.eventDate)}</p>
        <h3 className="mt-1 text-xl font-bold">{e.title}</h3>
        <p className="num text-sm text-muted">from {money(e.ticketPrice)} · {e.city}</p>
      </div>
    </Link>
  );
}

function Select({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
