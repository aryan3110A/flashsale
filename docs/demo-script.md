# 10-minute demo script

**Before you start (5 min earlier):** `docker compose up --build -d`, wait until `docker compose ps` shows 7 × healthy. Open three tabs: `http://localhost:3000`, `http://localhost:3000/dashboard`, `http://localhost:3000/playground`. Have a terminal in the repo root. Optional: run `npm run load:smoke` once so the dashboard has history.

Tip: do the rate-limiter burst *before* long browsing, then wait 3 s, because the burst empties your IP's bucket.

| Time | Do | Say |
|---|---|---|
| **0:00–1:00 Intro** | Show the home page. | "FlashSale sells tickets. The hard part is a flash sale: thousands of people, a few hundred seats, and dependencies that sometimes fail. This project shows the patterns that keep that correct: gateway, rate limiter, cache, transactional booking, outbox + queue + worker, circuit breaker, and observability." |
| **1:00–2:00 Architecture** | Open `docs/architecture.md` (Mermaid diagram) or README §5. | "Browser → gateway → booking-api → PostgreSQL / Redis / BullMQ → worker. The gateway is the single public entry. PostgreSQL, Redis and all services sit on an internal Docker network with no published ports; only web :3000 and gateway :8080 are exposed." |
| **2:00–3:00 Docker** | Terminal: `docker compose ps`, then `curl localhost:8080/health/services`. Show `docker compose config` ports (only 2). | "Seven services, each with a health check. The worker is not 'healthy' because its container runs: it must have a fresh heartbeat in Redis." |
| **3:00–4:00 Booking flow** | UI: open an event → quantity 2 → Book → fill form → confirm dialog. Watch the tracker go Accepted → Queued → Processing → Confirmed. Then `docker compose exec postgres psql -U flashsale -d flashsale -c "select booking_reference,status,quantity from bookings order by created_at desc limit 3"`. | "The API answered 202 immediately; confirmation happened in the background. The row is in PostgreSQL. Retrying the same request with the same Idempotency-Key cannot double-book." |
| **4:00–5:00 Async worker** | Playground → *Async worker* → Transient failures → Submit. Point at the job event log: `queue.published`, `job.active`, `job.retry` ×2, `job.completed`. Then run Permanent failure: booking FAILED, tickets released. | "The booking and an outbox row are written in one transaction, so a committed booking can't lose its job even if the API crashes. A dispatcher relays the outbox to BullMQ; the worker retries with exponential backoff. Delivery is at-least-once, so processing is idempotent." |
| **5:00–6:00 Rate limiter** | Playground → *Rate limiter* → burst 200. Show accepted vs rejected, `Retry-After`. | "Token bucket in Redis, one atomic Lua script: capacity 40, refill 20/s per client. The excess gets HTTP 429 with Retry-After. Because it's atomic in Redis, it's correct across several gateway instances (we tested 300 concurrent consumers over 3 connections: exactly 50 tokens granted)." |
| **6:00–7:00 Cache** | Playground → *Redis cache* → Clear → Fetch (MISS) → Fetch (HIT); watch hit ratio. | "Cache-aside with a 30 s TTL. Bookings invalidate the keys. But booking never trusts the cache for inventory: PostgreSQL decides." |
| **7:00–8:00 Fault tolerance** | Playground → *Circuit breaker* → *Start outage* → *Call dependent service* ×3 → OPEN → *Recover* → keep calling → HALF_OPEN → CLOSED. Mention the dashboard transition list. | "After three consecutive failures the breaker opens and calls fail in milliseconds instead of waiting for timeouts. After 10 s it lets one trial through; two successes close it. Browsing and booking never depended on it." |
| **8:00–9:00 Load test** | Terminal: `node scripts/run-k6.mjs spike-test.js`. Meanwhile show the dashboard charts moving. Then show the Playground *Load testing* table. | "k6 ramps to 200 virtual users in 5 seconds. With one shared IP the gateway admitted only the refill rate to the backend and returned 429 to the rest; no 5xx. The numbers in the report are from real runs." (Quote from `docs/load-test-report.md`.) |
| **9:00–10:00 Wrap-up** | Show `docs/testing-report.md` summary line, then say challenges & future work. | "Key decisions: inventory correctness in the database, not in cache; outbox instead of dual writes; at-least-once + idempotency instead of claiming exactly-once; fail-open limiter as a conscious trade-off. Future: auth, HA PostgreSQL/Redis, shared breaker state, real payments, OpenTelemetry tracing." |

**Backup plan if something breaks live:** `docker compose ps` / `docker compose logs <svc> --tail 30`; the playground is independent of bookings; screenshots of the dashboard are in the report.

**Optional kill-switch moment (30 s):** `docker compose stop worker`, book a ticket (stays PROCESSING; dashboard "Queue waiting" rises, worker tile turns unhealthy after ~15 s), `docker compose start worker` (booking completes).

## Added: live "many people at once" demo (about 2 minutes)

1. Open **/simulator**. Leave the defaults: 10 users x 10 tickets, 8 clicks each, 50 tickets, "Polite" clients. Say: "100 tickets are wanted, 50 exist, and every person clicks 8 times."
2. Press **Start flash sale**. Point at the charts filling: green = accepted, blue = duplicate clicks absorbed by the idempotency key, orange = sold out, violet = rate limited by the gateway.
3. Point at the pipeline chart: bookings go PROCESSING then CONFIRMED as the worker drains the queue, and at the stock chart which stops at 0, never below.
4. Read the **"What the system proved"** box (no overselling, database consistent, no extra bookings from duplicate clicks, worker finished) and the **"What is running right now"** panel (all services healthy, queue/outbox/worker numbers).
5. Switch to **Raw flood (no retry)**, 20 users x 20 clicks, and run again to show the gateway shedding hundreds of requests with 429 while the data stays consistent.
6. Optional: sign up on **/signup**, book as that account and open **My bookings** (no e-mail needed).
