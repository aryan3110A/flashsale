# Redis caching (cache-aside)

Implementation: [apps/booking-api/src/services/cache.js](../apps/booking-api/src/services/cache.js), [events.js](../apps/booking-api/src/services/events.js).

## Strategy

```
read:  Redis GET key → hit: return    miss: load from PostgreSQL → SET key EX ttl → return
write: booking commit → DEL affected keys (post-commit, best effort)
```

| Key | Content | Invalidated when |
|---|---|---|
| `events:all` | public event list (test events excluded) | any booking/release on any event |
| `events:featured` | featured events | same |
| `events:category:{slug}` | per-category list (slug sanitised, so keys cannot be injected) | same (the booked event's category) |
| `events:{id}` | one event | that event is booked/released |

- **TTL**: `CACHE_TTL_SECONDS` (default 30) with up to +10 % random jitter so keys do not all expire together.
- **Filters** (`q`, city, price, dates, sort) are applied in the API on top of the cached list, so they are still cache hits.
- **Not cached**: "not found" results (prevents cache pollution by random ids); bookings; booking status.
- **Stampede protection**: concurrent misses for one key share a single database load (in-process single-flight).

## PostgreSQL stays the source of truth for inventory

Cached `availableCapacity` can be up to a TTL stale and is only used for display. The booking transaction never reads the cache: it runs the conditional `UPDATE … WHERE available_capacity >= qty` in PostgreSQL. Test: a deliberately poisoned cache entry claiming 9999 tickets could not cause an oversell (the next booking got `409 INSUFFICIENT_INVENTORY`).

## Redis unavailable

Reads fall back to PostgreSQL and are flagged (`meta.cacheError: true`, `source: "database"`); errors are counted (`stats:cache.errors`, `flashsale_cache_operations_total{result="errors"}`) and logged. Verified by the Redis-outage fault test.

## Statistics and visibility

- Counters `hits`, `misses`, `errors` in Redis hash `stats:cache`, plus a Prometheus counter. Hit ratio = hits / (hits + misses).
- Every list/detail response has `X-Cache: HIT|MISS` and `meta.source`, `meta.lookupMs`.
- Dashboard tiles (hits, misses, ratio) and a per-3-second hit/miss chart; Playground → *Redis cache* shows MISS/HIT per call, live counters and a confirm-guarded "Clear event cache" (removes only `events:*`).
- `CACHE_ENABLED=false` bypasses Redis entirely. It exists to benchmark a no-cache baseline.

## Measured

See [load-test-report.md](load-test-report.md) (cache ON vs OFF under the same sustained load). Observed hit ratio during the sustained run was ≈ 99.9 %. The latency benefit is modest because the list query is tiny against a local PostgreSQL; the cache matters more as data grows and for protecting the database during spikes.
