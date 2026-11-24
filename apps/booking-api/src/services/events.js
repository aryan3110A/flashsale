import { KEYS, AppError } from '@flashsale/common';
import { categorySlug } from './cache.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = `id, slug, title, description, category, venue, city, event_date, image_url, ticket_price,
                 total_capacity, available_capacity, status, is_featured, updated_at`;

export function toEvent(r) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    category: r.category,
    venue: r.venue,
    city: r.city,
    eventDate: new Date(r.event_date).toISOString(),
    imageUrl: r.image_url,
    ticketPrice: r.ticket_price,
    totalCapacity: r.total_capacity,
    availableCapacity: r.available_capacity,
    status: r.status,
    isFeatured: r.is_featured,
  };
}

/** Keys that hold data derived from one event; invalidated after the event's inventory changes. */
export function keysForEvent({ id, category }) {
  return [KEYS.eventsAll, KEYS.eventsFeatured, KEYS.event(id), KEYS.eventsCategory(categorySlug(category))];
}

export function createEventService({ pool, cache, cfg }) {
  const loadList = (extraWhere = '', params = []) => async () => {
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM events WHERE is_test = FALSE ${extraWhere} ORDER BY event_date ASC`, params);
    return rows.map(toEvent);
  };

  function applyFilters(list, f) {
    let out = list;
    if (f.q) { const q = f.q.toLowerCase(); out = out.filter((e) => `${e.title} ${e.venue} ${e.city} ${e.category}`.toLowerCase().includes(q)); }
    if (f.city) out = out.filter((e) => e.city.toLowerCase() === f.city.toLowerCase());
    if (f.minPrice !== undefined) out = out.filter((e) => e.ticketPrice >= f.minPrice);
    if (f.maxPrice !== undefined) out = out.filter((e) => e.ticketPrice <= f.maxPrice);
    if (f.from) out = out.filter((e) => e.eventDate >= f.from.toISOString());
    if (f.to) out = out.filter((e) => e.eventDate <= f.to.toISOString());
    if (f.availableOnly) out = out.filter((e) => e.availableCapacity > 0);
    const sorters = {
      date: (a, b) => a.eventDate.localeCompare(b.eventDate),
      'price-asc': (a, b) => a.ticketPrice - b.ticketPrice,
      'price-desc': (a, b) => b.ticketPrice - a.ticketPrice,
      popularity: (a, b) => (b.totalCapacity - b.availableCapacity) / b.totalCapacity - (a.totalCapacity - a.availableCapacity) / a.totalCapacity,
    };
    return [...out].sort(sorters[f.sort] ?? sorters.date);
  }

  return {
    async list(filters) {
      const t = process.hrtime.bigint();
      const slug = filters.category ? categorySlug(filters.category) : null;
      const key = slug ? KEYS.eventsCategory(slug) : KEYS.eventsAll;
      const loader = slug ? loadList('AND lower(regexp_replace(category, \'[^a-zA-Z0-9]+\', \'-\', \'g\')) = $1', [slug]) : loadList();
      const r = await cache.getOrLoad(key, cfg.cache.listTtlSeconds, loader);
      return { events: applyFilters(r.value, filters), source: r.source, cacheKey: key, cacheError: r.cacheError, lookupMs: Number(process.hrtime.bigint() - t) / 1e6 };
    },

    async featured() {
      const t = process.hrtime.bigint();
      const r = await cache.getOrLoad(KEYS.eventsFeatured, cfg.cache.listTtlSeconds, loadList('AND is_featured = TRUE'));
      return { events: r.value, source: r.source, cacheKey: KEYS.eventsFeatured, cacheError: r.cacheError, lookupMs: Number(process.hrtime.bigint() - t) / 1e6 };
    },

    async categories() {
      const r = await cache.getOrLoad(KEYS.eventsAll, cfg.cache.listTtlSeconds, loadList());
      const counts = new Map();
      for (const e of r.value) counts.set(e.category, (counts.get(e.category) || 0) + 1);
      return { categories: [...counts].map(([name, count]) => ({ name, slug: categorySlug(name), count })).sort((a, b) => a.name.localeCompare(b.name)), source: r.source };
    },

    async get(id) {
      if (!UUID_RE.test(id)) throw new AppError(400, 'INVALID_EVENT_ID', 'Event id must be a UUID');
      const t = process.hrtime.bigint();
      const r = await cache.getOrLoad(KEYS.event(id), cfg.cache.detailTtlSeconds, async () => {
        const { rows } = await pool.query(`SELECT ${COLUMNS} FROM events WHERE id = $1`, [id]);
        return rows[0] ? toEvent(rows[0]) : null;
      });
      if (!r.value) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');
      return { event: r.value, source: r.source, cacheKey: KEYS.event(id), cacheError: r.cacheError, lookupMs: Number(process.hrtime.bigint() - t) / 1e6 };
    },

    /** Authoritative inventory read straight from PostgreSQL (never cached). */
    async liveAvailability(id) {
      const { rows } = await pool.query('SELECT available_capacity, status FROM events WHERE id = $1', [id]);
      return rows[0] ?? null;
    },
  };
}
