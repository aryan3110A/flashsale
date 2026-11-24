# Implementation audit

Statuses: **PASS** implemented and verified · **PARTIAL** implemented but incomplete · **FAIL** implemented but failing · **NOT IMPLEMENTED** missing · **NOT TESTED** cannot yet be verified.

## 0. Provenance of the audited code

The workspace folder (`SD ASSIGNMENT`) was empty. A previous FlashSale project was found at `Downloads\FlashSale_Distributed_Ticketing_Platform\flashsale` (also referenced by 7 stopped Docker containers and the volume `flashsale_pgdata`, created 2026-10-19). It was **copied** into the workspace; the original folder, those containers and that volume were not modified. The `.env` in the copy contained only local placeholder values and was replaced from `.env.example`.

The baseline was audited by reading every file **and by running it unchanged** (a throw-away compose project `flashsale-baseline`, removed afterwards together with its own volume). Baseline = a ~75 KB skeleton: a single-file Express gateway, a single-file booking API, a worker that also ran the outbox poller, a 3-route mock service, `init.sql`, one 17 KB React page (JSX) with hard-coded fallback events, 2 k6 scripts, one source-regex "test", template docs.

## 1. Baseline architecture

```
Next.js (JSX, rewrites) → Express gateway (single file) → Booking API (single file) → Postgres / Redis / BullMQ
                                                     └→ mock-service                       worker(+outbox poller)
```

## 2. Baseline findings (verified by running it)

| # | Area | Baseline | Evidence |
|---|---|---|---|
| 1 | Gateway routing + 429 | PARTIAL: worked; Redis token bucket via Lua (HMSET with caller clock), 429 + Retry-After | burst of 60 → 25×200, 35×429 |
| 2 | `GET /health/services` | NOT IMPLEMENTED | 404 |
| 3 | Worker health | NOT IMPLEMENTED (no heartbeat) | |
| 4 | Idempotency | **FAIL**: same `Idempotency-Key` created two bookings | two different booking ids, 2 tickets taken |
| 5 | PII | **FAIL**: `GET /api/bookings` returned every customer's name/e-mail, unauthenticated | curl |
| 6 | Network exposure | **FAIL**: PostgreSQL `5432` and Redis `6379` published to all interfaces | `docker compose ps` |
| 7 | Forwarded headers | `Idempotency-Key`, etc. dropped by the proxy (re-created JSON body, only 2 headers copied) | source |
| 8 | Rate limiter failure mode | fail-**closed** (503) with no option | source |
| 9 | Circuit breaker | PARTIAL: process-local, no half-open trial limit/success threshold, state on a custom `/mock/circuit` route | source + run |
| 10 | Retries | NOT IMPLEMENTED in gateway | |
| 11 | Outbox | PARTIAL: dispatcher inside the worker, `SELECT` without claim/`SKIP LOCKED` (duplicate publish on 2 workers) | source |
| 12 | Migrations | NOT IMPLEMENTED (single `init.sql` at first container start) | |
| 13 | Booking refs / statuses | no reference; statuses lowercase; no failure compensation (tickets never released on a failed job) | source |
| 14 | Cache | PARTIAL: list + detail keys, no category/featured, no stats, no invalidation of lists beyond one key | source |
| 15 | Metrics | PARTIAL: in-memory JSON, no Prometheus, no time series | |
| 16 | UI | PARTIAL: one JSX page; **hard-coded fallback events shown when the API failed**; decorative metrics; no routing, dashboard or playground | source |
| 17 | Tests | NOT TESTED: the only "test" was a regex over the gateway source file; nothing executed any behaviour | `server.test.js` |
| 18 | k6 | PARTIAL: 2 scripts; no booking/concurrency test; no report | |
| 19 | Docker | PARTIAL: containers ran as root, a single flat network (no isolation of data stores), no Redis persistence volume, no restart/stop-grace tuning, web image shipped the full source tree and dev toolchain | Dockerfiles, compose |
| 20 | Request-id propagation to worker | NOT IMPLEMENTED | |

## 3. What was built (all verified; see testing report)

| Area | Final | Notes |
|---|---|---|
| Gateway: routing, errors, timeouts, request id, CORS, Helmet, body limit, graceful shutdown | **PASS** | unit + integration + fault |
| Redis Token Bucket (Lua), per-class buckets, headers, 429 JSON, fail-open/closed | **PASS** | multi-**container** gateway not run (PARTIAL for that sub-claim; see below) |
| `/health`, `/health/services` (6 services, heartbeat for worker, 200/503 semantics) | **PASS** | |
| Docker: 7 services, health checks, internal network, volumes, restart policies, non-root, multi-stage web | **PASS** | clean `--no-cache` build verified |
| PostgreSQL schema + versioned migrations (checksum, advisory lock) | **PASS** | only one migration exists so far |
| Booking transaction, atomic inventory, CHECK constraint | **PASS** | concurrency tests + k6 |
| Idempotency | **PASS** | |
| Cache-aside + stats + clear + Redis-down fallback | **PASS** | |
| BullMQ + worker + retries + backoff + compensation + heartbeat | **PASS** | |
| Transactional outbox + `SKIP LOCKED` dispatcher | **PASS** | |
| Circuit breaker (3 states, thresholds, half-open limit) | **PASS** | per-gateway-instance state |
| Retry with backoff (gateway safe-retry rules; BullMQ) | **PASS** | |
| Structured logs + request-id propagation + Prometheus metrics + dashboard feed | **PASS** | gateway `/metrics` does not federate other services |
| Premium responsive UI (discover, details, booking, my bookings) | **PASS** | Chromium only |
| Monitoring dashboard with real metrics and charts | **PASS** | |
| Playground (5 sections) | **PASS** | load tests are run from a terminal by design |
| Unit / integration / fault / E2E tests, k6 | **PASS** | counts in the testing report |

## 4. Security review

| Item | Status | Note |
|---|---|---|
| Secrets via env, none hard-coded in code | PASS | compose has dev defaults (`change_me_local`) for convenience: **change before any non-local use** |
| Input validation, body limits | PASS | Zod strict; 50 kB API / 100 kB gateway |
| CORS allow-list, security headers | PASS | gateway Helmet; Next headers |
| SQL injection | PASS | parameterised queries; injection attempts tested |
| Safe errors / no internal addresses | PASS | tested |
| Network isolation, no DB/Redis ports | PASS | verified on base compose file |
| Containers non-root | PASS | `USER node` |
| Rate limiting | PASS | per-IP; NAT limitation documented |
| Test/demo endpoints | PARTIAL | admin endpoints off unless test overlay + token; **demo endpoints (cache clear, chaos headers) are ON in compose by default** for the demo; set `ENABLE_DEMO_ENDPOINTS=false` / `ENABLE_CHAOS=false` for anything public |
| Authentication / authorisation | NOT IMPLEMENTED | out of scope; bookings are looked up by e-mail (masked). Anyone knowing an e-mail can list its bookings |
| TLS | NOT IMPLEMENTED | plain HTTP on localhost |
| Dependency audit | PASS (prod) / PARTIAL (dev) | prod 0 vulnerabilities; dev vitest chain advisories remain |

## 5. Code-quality review (spec §10)

| Concern | Finding |
|---|---|
| N+1 queries | none: booking list/detail use one JOIN; events lists one query |
| Unbounded memory/logs/queues | time series 120 buckets; transition history 25; Redis worker-event list capped at 300; BullMQ retention bounded; cache keys have TTL; rate-limit keys expire |
| Unhandled rejections | handlers installed in every service; Express 5 forwards async errors |
| Unsafe retries / duplicate processing | restricted retry rules; idempotent worker (tested) |
| Transaction handling | single transaction per booking; rollback on any error; savepoint for reference collision |
| Missing indexes | partial indexes for every query path (database-design.md) |
| Re-renders | polling hooks isolate state per page; not profiled |
| Dead code | removed baseline `init.sql`, JSX page, regex test, old docs; no unused dependencies known (not machine-checked) |

## 6. Remaining issues and risks

1. Single instance of PostgreSQL/Redis/each service: no high availability.
2. Hot-row contention on one event's inventory is a throughput ceiling (not measured at saturation).
3. Circuit-breaker state is per gateway process.
4. Limiter fails open when Redis is down (deliberate, configurable).
5. A SIGKILLed worker's jobs wait for BullMQ's ~30 s stall detection.
6. No authentication; demo endpoints on by default in compose.
7. Event photos come from Unsplash at runtime.
8. Cache gave no measurable latency gain at this data size (measured; see load report).
9. Multi-container gateway limiter behaviour, non-Chromium browsers, automated accessibility audit: NOT TESTED.

## 7. Final acceptance checklist

| Requirement | Status | Evidence |
|---|---|---|
| Architecture documented | PASS | architecture.md, data-flow.md (Mermaid) |
| Docker (all services via compose) | PASS | `up --build -d`, clean `--no-cache` build, 7 × healthy |
| Gateway routing | PASS | integration + unit |
| Rate limiter (Redis Token Bucket, 429) | PASS | atomicity test (300 → 50); multi-container: NOT RUN |
| Health checks (per service) | PASS | integration + fault |
| PostgreSQL (persistent) | PASS | volume; restart-persistence check |
| Migrations | PASS | applied on start; `npm run migrate` idempotent |
| Redis cache-aside | PASS | |
| BullMQ queue | PASS | |
| Worker | PASS | |
| Outbox | PASS | |
| Idempotency | PASS | |
| Concurrency / no overbooking | PASS | 50→10 test, k6 200→10 |
| Circuit breaker | PASS | |
| Logging | PASS | request-id verified across 3 services; redaction untested |
| Metrics | PASS | with documented limits |
| UI/UX premium & responsive | PASS | screenshots reviewed (desktop + 390 px); Chromium only |
| Dashboard | PASS | |
| Playground | PASS | |
| Unit tests executed | PASS | 66 / 66 |
| Integration tests executed | PASS | 65 / 65 |
| E2E tests executed | PASS | 15 / 15 (+3 clean-room) |
| Fault-tolerance tests executed | PASS | 12 / 12 |
| Load testing (k6 actually run) | PASS | 6 runs |
| Load report with real numbers | PASS | load-test-report.md |
| Documentation | PASS | README + 13 docs |
| 10-minute demo | PASS (prepared, not rehearsed live) | demo-script.md |

Overall: no critical requirement is untested; the items above marked NOT RUN / NOT TESTED are called out as limitations rather than hidden.
