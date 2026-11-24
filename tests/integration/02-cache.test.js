import { describe, it, expect, afterAll } from 'vitest';
import { gw, book, resetTestEvent, newRedis, waitFor, getFirstPublicEvent } from '../helpers/env.js';

const redis = newRedis();
afterAll(() => redis.disconnect());

describe('Redis cache-aside', () => {
  it('first read after a clear is a MISS from PostgreSQL, next reads are HITs from Redis', async () => {
    const cleared = await gw('/api/cache/clear', { method: 'POST' });
    expect(cleared.status).toBe(200);
    const a = await gw('/api/events');
    const b = await gw('/api/events');
    expect(a.headers.get('x-cache')).toBe('MISS');
    expect(a.json.meta.source).toBe('database');
    expect(b.headers.get('x-cache')).toBe('HIT');
    expect(b.json.meta.source).toBe('cache');
    expect(b.json.data).toEqual(a.json.data);
    expect(await redis.exists('events:all')).toBe(1);
    expect(await redis.ttl('events:all')).toBeGreaterThan(0);
  });

  it('caches per category, featured and per event under the documented keys', async () => {
    await gw('/api/cache/clear', { method: 'POST' });
    const ev = await getFirstPublicEvent();
    await gw(`/api/events?category=${encodeURIComponent(ev.category)}`);
    await gw('/api/events/featured');
    await gw(`/api/events/${ev.id}`);
    const keys = (await redis.keys('events:*')).sort();
    expect(keys).toEqual(expect.arrayContaining(['events:featured', `events:${ev.id}`, `events:category:${ev.category.toLowerCase()}`]));
  });

  it('filters are applied on top of the cached list (still a HIT)', async () => {
    await gw('/api/events');
    const r = await gw('/api/events?maxPrice=300&sort=price-asc');
    expect(r.headers.get('x-cache')).toBe('HIT');
    expect(r.json.data.length).toBeGreaterThan(0);
    expect(r.json.data.every((e) => e.ticketPrice <= 300)).toBe(true);
    const prices = r.json.data.map((e) => e.ticketPrice);
    expect(prices).toEqual([...prices].sort((x, y) => x - y));
  });

  it('hit/miss counters are exposed and consistent', async () => {
    const before = (await gw('/api/cache/stats')).json.data;
    await gw('/api/events'); await gw('/api/events');
    await new Promise((r) => setTimeout(r, 200));
    const after = (await gw('/api/cache/stats')).json.data;
    expect(after.hits + after.misses).toBeGreaterThanOrEqual(before.hits + before.misses + 2);
    expect(after.hitRatio).toBeGreaterThan(0);
  });

  it('a booking invalidates the cached event, so listings do not show stale availability', async () => {
    const ev = await resetTestEvent(5);
    // test events are not in the public list but are readable by id and cached
    const first = await gw(`/api/events/${ev.eventId}`);
    expect(first.json.data.availableCapacity).toBe(5);
    await gw(`/api/events/${ev.eventId}`);
    const r = await book(ev.eventId, { quantity: 2 });
    expect(r.status).toBe(202);
    const after = await waitFor(async () => { const x = await gw(`/api/events/${ev.eventId}`); return x.json.data.availableCapacity === 3 ? x : false; }, { timeout: 5000, desc: 'cache invalidation' });
    expect(after.json.data.availableCapacity).toBe(3);
  });

  it('booking never trusts cached inventory: a poisoned cache entry cannot cause overselling', async () => {
    const ev = await resetTestEvent(2);
    await redis.set(`events:${ev.eventId}`, JSON.stringify({ id: ev.eventId, availableCapacity: 9999, status: 'ON_SALE', category: 'Demo' }), 'EX', 60);
    const ok = await book(ev.eventId, { quantity: 2 });
    const over = await book(ev.eventId, { quantity: 1 });
    expect(ok.status).toBe(202);
    expect(over.status).toBe(409);
    expect(over.json.error).toBe('INSUFFICIENT_INVENTORY');
  });
});
