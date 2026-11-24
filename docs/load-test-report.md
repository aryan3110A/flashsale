# Load-test report

All numbers below were produced by real k6 runs against the running Docker stack and copied from the run output (`load-tests/results/*.json`, also shown in the Playground). Nothing is estimated. Where a result could not be explained from measurements, it is flagged as such.

Run date: 2026-11-24. Raw JSON summaries are written to `load-tests/results/` on every run.

## Test environment

| Item | Value |
|---|---|
| Host | Windows 11 Home, Docker Desktop (Linux VM), Docker Engine 29.7.2, Compose v5.4.0 |
| Resources visible to Docker | 12 CPUs, ~8 GB RAM (shared with the host) |
| Load generator | k6 v2.4.0 (`grafana/k6` image) on the **same machine**, attached to the stack's Docker network, targeting `http://gateway:8080` |
| Stack | the 7 compose services, 1 instance each, test overlay (`docker-compose.test.yml`): only difference from the default stack is that it publishes internal ports, enables admin endpoints and (for the runs marked *per-user buckets*) honours `X-Client-Id` |
| App config | rate limit capacity 40 / refill 20 per s per client; cache TTL 30 s; worker concurrency 5; PostgreSQL pool 20; gateway/booking-api/worker = one Node.js 22 process each |
| Data | 12 public seeded events (+2 hidden test events); read endpoints are tiny |

**Caveat that applies to every number:** generator and system under test share one laptop and one Docker VM, so absolute throughput is conservative and CPU contention with k6 itself is included (k6 used ≈ 67 % of a core during the CPU probe). The tests are closed-loop (fixed virtual users with `sleep`), so throughput depends on user count and think time as much as on server capacity.

## Results

| Test | Duration | Max VUs | Requests | Req/s | avg | median | p90 | p95 | p99 | max | HTTP failed | 429s | 5xx |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Smoke (`smoke-test.js`) | 24 s | 3 | 300 | 12.5 | 5.3 ms | 4.8 | 8.6 | 12.0 | 14.1 | 15 | 0 % | 0 | 0 |
| Spike, **limiter active** (1 shared IP) | 72 s | 200 | 73 277 | 1 021.7 | 4.8 ms | 2.2 | 8.3 | 18.1 | 39.1 | 2 854 | 0 % | **71 865** | 0 |
| Spike, per-user buckets | 72 s | 200 | 49 325 | 687.9 | 60.2 ms | 51.7 | 88.1 | 128.4 | 216.9 | 2 903 | 0 % | 0 | 0 |
| Sustained, **cache ON** (150 VUs, 60 s) | 67 s | 150 | 42 535 | 636.2 | 12.4 ms | 5.1 | 24.2 | 49.8 | 83.5 | 2 901 | 0 % | 0 | 0 |
| Sustained, **cache OFF** (`CACHE_ENABLED=false`) | 67 s | 150 | 42 571 | 636.4 | 11.4 ms | 5.1 | 23.6 | 45.0 | 81.8 | 2 876 | 0 % | 0 | 0 |
| Concurrent booking (200 attempts, 10 tickets, 50 VUs) | 3 s | 50 | 204 | 71.3 | 191.3 ms | 192.4 | 290.4 | 342.3 | 499.9 | 571 | 0 % | 0 | 0 |

"HTTP failed" counts statuses outside the test's expected set (200/429 for read tests; 202/409/429 for the booking test). All thresholds passed in every run.

Spike shape: 10 s → 10 VUs, 5 s → 200, 30 s hold, 10 s → 10, 10 s → 0. Sustained mix: 55 % list, 25 % detail, 10 % featured, 10 % categories.

## Rate limiting: baseline vs comparison

| | Limiter binding (1 shared IP) | Per-user buckets |
|---|---|---|
| Requests attempted | 73 277 | 49 325 |
| Served with 200 | 1 412 (≈ 19.6 /s: the refill rate) | 49 325 |
| Rejected with 429 | 71 865 (98.1 %) | 0 |
| p95 latency (all responses) | 18.1 ms | 128.4 ms |
| 5xx | 0 | 0 |

Reading: with one shared bucket the gateway admitted only the configured 20 req/s plus the initial burst of 40 to the backend and answered the rest in ~2 ms with `429 + Retry-After`. The system never returned a 5xx. With independent buckets (≈ unlimited per user) the same 200 VUs reached the backend, latency rose ~7×, still with no errors. This demonstrates load shedding at the edge; it also shows that **a limiter keyed on IP treats everyone behind one NAT as one client**.

## Cache: baseline vs comparison

| | Cache ON | Cache OFF |
|---|---|---|
| Requests | 42 535 | 42 571 |
| avg / p95 / p99 | 12.4 / 49.8 / 83.5 ms | 11.4 / 45.0 / 81.8 ms |
| Cache hit ratio (delta during run) | 99.88 % (42 483 hits, 52 misses) | n/a (Redis bypassed) |

**Honest conclusion: no latency benefit was measurable in this setup.** In an earlier run on the previous build (not kept as a final result) cache-on was ~20 % faster (p95 62.9 vs 78.3 ms); in this final run it is slightly slower (49.8 vs 45.0 ms). Run-to-run variance is larger than the effect. Reasons: the dataset is 12 rows on a local PostgreSQL (a primary-key/small scan costs about the same as a Redis round trip), PostgreSQL CPU was ≈ 3 % during load, and the gateway is the limiting component. What the cache demonstrably does here is serve 99.9 % of lookups without touching PostgreSQL; its value grows with larger/more expensive queries and with spikes against a remote database, which this test does not exercise.

## Concurrent booking test

204 requests (200 attempts + setup/teardown reads) for **10** tickets from 50 VUs, each with a unique idempotency key and e-mail:

- accepted (202): **10**; rejected (409 sold out): **190**; unexpected: **0**
- final state read through the admin endpoint after the worker finished: `bookings = 10, confirmed = 10, processing = 0, failed = 0, available = 0, status = SOLD_OUT, consistent = true`
- p95 342 ms for the booking POSTs under contention (includes transaction waits on the single hot event row).

## Queue, worker and database observations

- Worker: simulated 400–1200 ms per job, average recorded ≈ 0.8–0.9 s; with concurrency 5 and 10 jobs the booking test drained in a few seconds. Queue depth stayed ≈ 0 in read-only tests (no jobs).
- Booking acceptance latency (API only) ≈ 10 ms unloaded; p95 342 ms in the 50-way contention test.
- PostgreSQL: ≈ 3 % CPU, 44 MiB at ≈ 976 req/s of cached reads; 0 DB failures recorded; outbox pending 0 at end.
- Redis: ≈ 18 % CPU at the same load (token-bucket Lua call per request + cache reads).

## Bottleneck analysis (measured)

CPU probe during a 300-VU, 25 s sustained run (976 req/s, p95 184.7 ms, 0 errors) via `docker stats`:

| Container | CPU | Memory |
|---|---|---|
| gateway | **115 %** | 167 MiB |
| booking-api | 68 % | 128 MiB |
| redis | 18 % | 9 MiB |
| postgres | 3 % | 44 MiB |
| worker / mock | < 1 % | |
| k6 (load generator) | 67 % | 121 MiB |

The gateway (one Node process doing proxying, a Redis Lua call, metrics and logging per request) is the first component to saturate, followed by the Booking API. PostgreSQL has ample headroom for this read-heavy mix. Not measured: write-heavy PostgreSQL limits (the booking path serialises on one hot row per event; the 200-attempt test is too short to establish a sustained write ceiling).

Unexplained observation: every run with ≥ 150 VUs shows a max latency of ≈ 2.9 s while p99 is ≤ 220 ms, both with and without the limiter. It looks like connection-setup stalls during the VU ramp (a single slow connection each time) but this was **not investigated** and is not proven.

## Conclusions

1. Under a 200-user spike with one client IP the gateway shed 98 % of requests as correct 429s with sub-20 ms p95 and zero 5xx; the backend only saw the configured rate.
2. With per-user limits the stack sustained ≈ 690 req/s at 200 VUs with p95 128 ms and 0 errors on one laptop.
3. The overselling protection held under contention: exactly 10 of 200 attempts won 10 tickets and the database was consistent.
4. The cache removes 99.9 % of read queries but gave no measurable latency gain at this data size.

## Recommendations

- Scale the gateway horizontally (the Redis-backed limiter is already instance-safe) and consider clustering Node (or an L7 proxy for pure pass-through) since it saturates first.
- Key rate limits on authenticated user / API key, not only IP, to avoid NAT collateral damage.
- For one extremely hot event, split inventory into N sub-counters or pre-allocate ticket blocks to remove the single-row serialisation point.
- Repeat the cache comparison with a larger catalogue or a remote/slow database to see its real value; use a separate load-generator host.
- Add `pg_stat_statements` and per-service CPU/GC metrics to Prometheus for a proper capacity model.

## Reproduce

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d
npm run load:smoke
node scripts/run-k6.mjs spike-test.js RUN_TAG=limiter-on
node scripts/run-k6.mjs spike-test.js CLIENT_IDS=true RUN_TAG=per-user-buckets
node scripts/run-k6.mjs sustained-load-test.js CLIENT_IDS=true VUS=150 DURATION=60s RUN_TAG=cache-on
CACHE_ENABLED=false docker compose -f docker-compose.yml -f docker-compose.test.yml up -d booking-api
node scripts/run-k6.mjs sustained-load-test.js CLIENT_IDS=true VUS=150 DURATION=60s RUN_TAG=cache-off
npm run load:booking
```
