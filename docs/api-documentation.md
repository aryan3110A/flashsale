# API documentation

Base URL: `http://localhost:8080` (the gateway). Every response carries `X-Request-Id`; send your own (`[A-Za-z0-9._-]{8,100}`) to correlate logs, otherwise one is generated. All JSON errors share one shape:

```json
{ "success": false, "error": "MACHINE_CODE", "message": "Human readable", "requestId": "…", "details": { } }
```

Rate-limit headers on every proxied response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds until full). On `429`: `Retry-After` (seconds). CORS exposes these headers plus `X-Cache`, `X-Circuit-State`, `X-Retry-Attempts`.

## Events

### `GET /api/events`
Query (all optional): `category`, `city`, `q` (title/venue/city/category substring), `minPrice`, `maxPrice`, `from`, `to` (ISO dates), `sort` = `date | price-asc | price-desc | popularity`, `availableOnly=true`.

```json
{ "success": true,
  "data": [{ "id":"…","slug":"neon-nights-festival","title":"Neon Nights Festival","description":"…","category":"Music","venue":"Riverfront Grounds","city":"Ahmedabad","eventDate":"2026-12-12T18:00:00.000Z","imageUrl":"https://…","ticketPrice":2499,"totalCapacity":1200,"availableCapacity":1198,"status":"ON_SALE","isFeatured":true }],
  "meta": { "count": 12, "source": "cache", "cacheKey": "events:all", "cacheError": false, "lookupMs": 0.4 } }
```
Header `X-Cache: HIT|MISS`. `source` is `cache` or `database`. Cached `availableCapacity` is for display only (≤ 30 s stale, invalidated after bookings); the booking itself checks PostgreSQL.

### `GET /api/events/featured` · `GET /api/events/:id` · `GET /api/categories`
`:id` must be a UUID (`400 INVALID_EVENT_ID`), unknown ids give `404 EVENT_NOT_FOUND`. Categories: `[{name, slug, count}]`.

## Bookings

### `POST /api/bookings`
Headers: `Content-Type: application/json`, **`Idempotency-Key`** (required, 8–128 chars `A-Za-z0-9._:-`).
Body (unknown keys rejected):
```json
{ "eventId": "uuid", "quantity": 2, "name": "Asha Rao", "email": "asha@example.com" }
```

| Status | When | `error` |
|---|---|---|
| **202** | accepted for async processing | |
| 200 | same key + same payload (replay) | `idempotentReplay: true` |
| 400 | validation, missing/invalid key, bad JSON | `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_JSON` |
| 404 | unknown event | `EVENT_NOT_FOUND` |
| 409 | not enough tickets / event not on sale | `INSUFFICIENT_INVENTORY` (`details.available`), `EVENT_NOT_ON_SALE` |
| 413 | body > 100 kB | `PAYLOAD_TOO_LARGE` |
| 422 | key reused with a different payload | `IDEMPOTENCY_KEY_REUSED` |
| 429 | rate limited | `RATE_LIMIT_EXCEEDED` (+ `Retry-After`) |
| 502/504 | gateway could not reach / timed out waiting for the API | `UPSTREAM_UNAVAILABLE`, `UPSTREAM_TIMEOUT` |
| 503 | database temporarily unavailable | `SERVICE_UNAVAILABLE` |

```json
{ "success": true, "message": "Booking accepted for processing", "idempotentReplay": false,
  "data": { "bookingId":"…","bookingReference":"FS-7MPA5U3Q","status":"PROCESSING","quantity":2,"totalAmount":4998,"eventId":"…","statusUrl":"/api/bookings/…" } }
```

Optional demo header (only if `ENABLE_CHAOS=true`): `X-Simulate-Failure: transient | permanent`.

### `GET /api/bookings/:id`
Latest status from PostgreSQL plus queue state.
```json
{ "success": true, "data": { "id":"…","reference":"FS-…","status":"CONFIRMED","quantity":2,"totalAmount":4998,"eventTitle":"…","eventDate":"…","venue":"…","city":"…","customerName":"Asha Rao","customerEmail":"a***@example.com","createdAt":"…","confirmedAt":"…","job":{"state":"completed","attemptsMade":1,"maxAttempts":4} } }
```
`status` ∈ `PROCESSING | CONFIRMED | FAILED` (`failureReason` set when failed). `job` may be `null` if the job has been trimmed or Redis is unavailable.

### `GET /api/bookings?email=you@example.com`
Up to 50 most recent bookings for that e-mail (masked e-mail in the response). `email` is required; there is deliberately no "list everything" call. URL-encode `+` as `%2B`.

## Health, metrics, gateway

| Endpoint | Description |
|---|---|
| `GET /health` | Gateway liveness: `{status:"healthy", service:"gateway", uptimeSeconds}` |
| `GET /health/live` | Used by Docker health checks |
| `GET /health/services` | `{status, services:{gateway,booking-api,postgres,redis,worker,mock-service}, details:{…latencyMs…}, circuitBreaker}`; **200** healthy/degraded, **503** unhealthy |
| `GET /metrics` | Prometheus exposition format |
| `GET /metrics/summary` | JSON for the dashboard: gateway totals, 5 s time series, cache, queue, worker, database, outbox, circuit breaker. Unmeasurable values are `{available:false, reason}` |
| `GET /gateway/circuit-breaker` | Breaker snapshot (state, counters, last 25 transitions) |

Health and metrics endpoints use a separate, larger token bucket (300 / 150 per second).

## Mock downstream (`/mock/*`, behind the circuit breaker)

| Endpoint | Behaviour |
|---|---|
| `GET /mock/normal` | 200 immediately |
| `GET /mock/slow?ms=4000` | responds after `ms` (> gateway timeout 2.5 s ⇒ 504) |
| `GET /mock/fail` | always 503 |
| `GET /mock/flaky?rate=0.5` | fails with that probability |
| `GET /mock/service` | follows the mode below |
| `GET/POST /mock/control` `{mode:"normal"\|"failing"\|"slow"}` | switch an outage on/off (`ENABLE_CHAOS`) |

Responses include `X-Circuit-State` (`CLOSED|HALF_OPEN|OPEN`) and, when retried, `X-Retry-Attempts`. While `OPEN`: `503 CIRCUIT_OPEN` with `Retry-After`.

## Demo helpers (`ENABLE_DEMO_ENDPOINTS=true`, default in compose)

`GET /api/cache/stats` · `POST /api/cache/clear` (removes only `events:*`) · `GET /api/demo/event` · `GET /api/worker/events?bookingId=` · `GET /api/ping`.

## Test-only admin (disabled unless `ENABLE_TEST_ENDPOINTS=true` **and** `ADMIN_TOKEN` set; send `X-Admin-Token`)

`GET /api/admin/test-event` (inventory + consistency check) · `POST /api/admin/test-event/reset` `{capacity}`. They touch only the hidden `load-test-event`. Only the test overlay turns them on.
