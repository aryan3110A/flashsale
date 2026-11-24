# Rate limiting: Redis Token Bucket

Implementation: [apps/gateway/src/rate-limiter/token-bucket.js](../apps/gateway/src/rate-limiter/token-bucket.js).

## Algorithm

Each client owns a bucket holding up to `capacity` tokens. Tokens refill continuously at `refillRate` tokens per `refillIntervalMs`. A request spends one token; with none left it is rejected with HTTP 429.

```
tokens = min(capacity, tokens + elapsedMs * refillRate / refillIntervalMs)
if tokens >= 1: tokens -= 1; allow   else: reject, retryAfter = (1 - tokens) / ratePerMs
```

Burst tolerance (a real user opening a page fires several requests at once) comes from `capacity`; sustained rate is capped by the refill.

## Why Redis + Lua

State has to be shared between gateway instances, and the read-refill-spend-write sequence must be atomic. The whole sequence runs inside one Lua script, which Redis executes atomically, so concurrent requests can never both spend the same token. Time comes from Redis `TIME`, so gateways with skewed clocks agree. Bucket keys carry a TTL (≈ 2× time-to-full) so idle clients disappear.

Not used: `setTimeout` timers or in-process counters (they are per-process, lost on restart and not shared).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_CAPACITY` | 40 | burst size for API/mock routes |
| `RATE_LIMIT_REFILL_RATE` | 20 | tokens added per interval |
| `RATE_LIMIT_REFILL_INTERVAL` | 1000 | interval in ms |
| `RATE_LIMIT_HEALTH_CAPACITY / _REFILL_RATE / _REFILL_INTERVAL` | 300 / 150 / 1000 | separate bucket for `/health*`, `/metrics*`, `/gateway/*` so monitoring and Docker health checks are never starved by user traffic |
| `RATE_LIMIT_FAIL_OPEN` | true | behaviour when Redis is unreachable |
| `RATE_LIMIT_TRUST_CLIENT_ID` | **false** | demo/test only: honour `X-Client-Id` as the bucket key. Enabled only by `docker-compose.test.yml` so load tests can simulate many users from one machine. Never enable in a real deployment: clients could pick fresh buckets at will. |

Bucket key: `flashsale:rl:{api|monitoring}:ip:{client ip}` (set `TRUST_PROXY=true` only behind a trusted proxy).

## Response

```
HTTP/1.1 429 Too Many Requests
Retry-After: 1
X-RateLimit-Limit: 40
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 2
{"success":false,"error":"RATE_LIMIT_EXCEEDED","message":"Too many requests. Please try again later.","retryAfterSeconds":1,"requestId":"…"}
```

CORS preflight (`OPTIONS`) is answered before the limiter and costs no tokens.

## Failure mode: fail open

If Redis is down the limiter cannot decide. The gateway **lets the request through**, sets `X-RateLimit-Status: bypassed`, and counts `flashsale_rate_limiter_errors_total`. Rationale: the limiter protects capacity, but an outage of a protective component should not take the whole site down. Set `RATE_LIMIT_FAIL_OPEN=false` to fail closed with 503 instead. Trade-off: while Redis is down there is no rate limiting.

## Verified behaviour

From `tests/integration/05-rate-limiting.test.js` (all passing, see [testing-report.md](testing-report.md)):

- below the limit succeeds and returns `X-RateLimit-Remaining: 39`;
- a 100-request burst from one client: ≥ 40 accepted, the rest `429` with JSON body, `Retry-After ≥ 1`, `X-RateLimit-Remaining: 0`;
- buckets are per client; a limited client does not affect another;
- tokens refill (after 1.5 s a limited client gets through again);
- health endpoints stay available while the API bucket is exhausted;
- **atomicity**: 300 concurrent consumers over 3 separate Redis connections (standing in for 3 gateway instances) on a 50-token bucket received **exactly 50** tokens;
- capacity cap after idle time, sensible `retryAfterMs`, key TTL set;
- fail-open and fail-closed behaviour (unit tests + Redis-outage fault test).

Not tested: multiple real gateway containers (the compose file runs one; the 3-connection test above exercises the same Lua script from several clients).

## Measured effect

See the spike test comparison in [load-test-report.md](load-test-report.md): with one shared IP the gateway admitted only the refill rate (~20 req/s) to the backend while absorbing 1000+ req/s of attempts.
