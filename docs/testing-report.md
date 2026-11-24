# Testing report

Everything below was executed on 2026-11-24 against the Docker stack built from this repository (host: Windows 11, Docker Desktop, Node 24 on the host, Node 22 in containers). Counts are copied from the runner output of one final, consecutive run on a freshly rebuilt stack. Load-test numbers are in [load-test-report.md](load-test-report.md).

## Summary

| Suite | Command | Result | Needs |
|---|---|---|---|
| Lint (ESLint, Next/TS rules) | `npm run lint` | clean (0 problems) | |
| Type check (`tsc --noEmit`, strict) | `npm run typecheck` | clean | |
| **Unit** (6 files) | `npm run test:unit` | **66 / 66 passed** | nothing |
| **Integration** (6 files) | `npm run test:integration` | **65 / 65 passed** | test stack |
| **Fault tolerance** (2 files) | `npm run test:fault` | **12 / 12 passed** (≈ 2.7 min; stops/starts real containers) | test stack |
| **End-to-end** (Playwright, Chromium) | `npm run test:e2e` | **15 / 15 passed** | test stack |
| Clean-room E2E subset (journey, search, mobile) on a stack built with `--no-cache` from a pristine copy, own ports/volumes | `WEB_URL=… GATEWAY_URL=… npx playwright test -g "browse\|search\|phone"` | 3 / 3 passed | |
| **k6** (smoke, spike ×2, sustained ×2, concurrent booking) | `npm run load:*` | all thresholds passed | test stack |
| `npm audit --omit=dev` | | 0 vulnerabilities | |
| `docker compose config` (base + test overlay) | | valid | |

## What each suite covers

**Unit (no infrastructure):** circuit-breaker state machine with a fake clock (open, fail-fast, half-open limit, close, re-open, bounded history); retry/backoff and the "what is safe to retry" rules; booking validation (quantity bounds, strict keys, email normalisation), idempotency key format and fingerprint; cache-aside logic with a fake Redis (miss/hit, counters, Redis failure fallback, single-flight, no caching of nulls, invalidation errors swallowed); worker processor with fakes (confirm, idempotent duplicate, missing booking, invalid payload, simulated transient/permanent failures, `failAndRelease` transaction shape and rollback); gateway app with a fake upstream (status propagation, header hygiene, request-id handling, 502/504 mapping with no leakage of internal names, retry only where safe, 413, 404 JSON, circuit open → 503 with nothing reaching the downstream, Prometheus output); rate-limit middleware (429 body and headers, fail-open, fail-closed, invalid config); bounded time-series memory.

**Integration (real PostgreSQL, Redis, BullMQ, worker via the gateway):** connectivity and migrations; DB `CHECK` rejects negative stock; routing to booking-api and mock; `/health/services`; request-id echo; Prometheus text; `/metrics/summary`; internal endpoints not reachable via the gateway; CORS allow/deny; security headers; cache MISS→HIT with TTL and documented keys, filters on cached data, counters, invalidation on booking, **poisoned-cache cannot oversell**; booking 202 shape, atomic booking+outbox+inventory, status API, listing by e-mail (masked, no unauthenticated dump), validation matrix, SQL-injection attempts, idempotency (replay, key reuse 422, no leftover row on rejection); **concurrency** (below); rate limiting (below); queue/worker lifecycle, retries, permanent failure + compensation, duplicate delivery, job-id dedupe, heartbeat, outbox recovery path and `SKIP LOCKED` exclusivity.

**Concurrency (the critical ones):**
- 50 concurrent single-ticket requests for 10 tickets → exactly 10 × `202`, 40 × `409 INSUFFICIENT_INVENTORY`, unique references, available = 0, `SOLD_OUT`, all 10 later `CONFIRMED`.
- 20 concurrent mixed quantities (1–5) against capacity 20 → tickets taken ≤ 20 and equal to the inventory decrement.
- Same idempotency key sent 25× concurrently → one booking, one ticket, one outbox row, identical `bookingId` everywhere.
- 12 users × 3 duplicate submits for 5 tickets → exactly 5 bookings.
- After each: `available ≥ 0`, `total − available = Σ active quantities`, one outbox row per booking.

**Rate limiting:** below-limit success + headers; 100-request burst → ≥ 40 accepted, the rest `429` with JSON, `Retry-After`; per-client isolation; refill after 1.5 s; health bucket independent; 429 counted in metrics; **Lua atomicity: 300 concurrent consumers over 3 Redis connections on a 50-token bucket → exactly 50 allowed**; capacity cap, retry delay, key TTL.

**Fault tolerance** (executed, see the expected-vs-actual table in [fault-tolerance.md](fault-tolerance.md)): breaker CLOSED→OPEN→HALF_OPEN→CLOSED, failed-trial re-open, outage/recovery via mock mode, mock container stopped, isolation from bookings; **Redis**, **PostgreSQL**, **Booking API** and **worker** unavailable (and a worker SIGKILL mid-job).

**E2E (browser):** open → browse (≥ 10 DB events) → details → quantity → form → confirm dialog → reference → live tracker → "You're going!" → My bookings CONFIRMED → reload still there → API agrees; form validation + `aria-invalid`; quantity capped by availability and sold-out state; a stale page booking more than what remains gets a clear failure and a usable form; search/category/sort/saved-events (persisted across reload); phone viewport (no horizontal overflow, mobile menu); dashboard shows real healthy services and shows "Gateway unreachable / Disconnected" instead of fake data when the backend calls are blocked; playground burst → accepted + 429 results; cache MISS then HIT; worker normal / transient (retry events) / permanent (FAILED); breaker opens then closes; load-test panel.

**Docker/ops checks performed:** `docker compose config`; `up --build`; `ps` (all healthy); only `web:3000` and `gateway:8080` published; restart of **all** containers → system healthy again in ≈ 8 s, a confirmed booking and inventory survived (volumes untouched); clean-room: copy of the repo without `node_modules`/`.env`/cache, `build --no-cache`, new `.env` from `.env.example`, different ports → healthy in seconds, 12 events seeded, booking confirmed, test-admin endpoints return 404 (disabled outside the test overlay); `npm run migrate` against the running DB → 0 applied / 1 total (idempotent).

## Problems found by testing and fixed

| Found | Fix |
|---|---|
| Baseline gateway accepted the same `Idempotency-Key` twice → two bookings (baseline probe) | Idempotency implemented (unique key + fingerprint) |
| Baseline `GET /api/bookings` returned every customer's e-mail unauthenticated | e-mail-scoped lookup, masked response |
| `isRetryable` returned `undefined` instead of `false` for non-idempotent requests (unit test) | coerced to boolean |
| PostgreSQL outage reported `postgres: unknown` instead of `unhealthy` because the gateway's health probe (1.5 s) timed out before the API's own DB check | probe 2.5 s, DB check 1.2 s |
| A stopped container's address dropped packets; each attempt stalled ≈ 4 s, GETs took 8.4 s to fail | 1 s TCP connect timeout (undici agent) → fast 502; error maps to "never delivered", so retry-safe |
| `npm audit`: zod < 4.6.6 (memory exhaustion) | upgraded to zod 4 (code adapted, tests re-run) |
| Seed times were UTC but rendered as IST (6 pm showed 11:30 pm) | seed stores local time correctly (applies to new databases) |
| Found afterwards while checking demo commands by hand (not by the automated suites): any POST sent with `Expect: 100-continue` (Windows PowerShell 5.1 `Invoke-RestMethod`, curl for big bodies) got `502` because the header was forwarded and undici rejects it (`UND_ERR_NOT_SUPPORTED`) | gateway no longer forwards `Expect`; verified by hand (breaker demo and a booking + idempotent replay from PowerShell); unit suite re-run 66/66; **integration/E2E/fault suites were not re-run after this one-line change and there is no dedicated regression test for it** |
| Test-side: fixed `sleep` before a HALF_OPEN trial failed intermittently; vacuous assertion on always-rendered text; ambiguous Playwright locators; unhandled pg `error` from the test's own pool during DB stop | polling instead of sleeping; real state test-ids; exact locators; error handler on test pool |

Honest note on the intermittent failure: with a fixed `sleep(3300)` the "failed trial re-opens the circuit" test failed repeatedly in the full file but passed in isolation and in a manual replay; the gateway history showed the call had been rejected as still OPEN. I could not conclusively explain the timing difference (clock skew host↔container was measured and is small). The suite now waits for the breaker to report HALF_OPEN before the trial, which tests the same behaviour deterministically and has passed in every run since. The breaker logic itself is covered by deterministic unit tests with an injected clock.

## Not tested / limitations (stated plainly)

- **Multiple gateway containers**: the compose file runs one. Atomic limiter behaviour is shown with 3 concurrent Redis connections running the same Lua script, not 3 gateway processes. Marked PARTIAL.
- **Browsers**: Chromium only (desktop + 390 px viewport). No Firefox/Safari, no real devices.
- **Accessibility**: semantic roles, labels, focus states, `aria-live`, `aria-invalid`, skip link and keyboard-operable dialog are implemented and partly exercised by role-based locators, but no automated axe/WCAG audit or screen-reader pass was run.
- **No React component unit tests**; UI is covered by E2E and type/lint checks. Code coverage was not measured.
- **Frontend performance review** (unnecessary re-renders) was by reading, not profiling.
- Secrets/log redaction is configured (pino `redact`) and query strings are never logged, but there is no dedicated test asserting redaction.
- Prometheus scraping was not run; `/metrics` output format was only checked as text.
- The load tests run on one machine shared with the system under test (see report caveats). No soak test (hours) or spike above 300 VUs.
- Dev-dependency advisories remain in the **vitest** tool chain (`@vitest/mocker`, `tinypool`, plus zod's earlier advisory now fixed): test runner only, never in any container; not upgraded to avoid a major test-runner migration.
- The fault suite is destructive to *running containers* (not volumes) and must only be run against the local test stack.
- Image hosting: event photos load from Unsplash at runtime (needs internet); the UI falls back to category gradients if they fail (implemented, not tested offline).

## How to reproduce

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d
npm install && npx playwright install chromium
npm run lint && npm run typecheck
npm run test:unit && npm run test:integration && npm run test:e2e && npm run test:fault
```
