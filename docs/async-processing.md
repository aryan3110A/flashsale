# Asynchronous processing: outbox → BullMQ → worker

## Why

Confirmation (payment capture, ticket issuing) is slow and fallible. The API only needs to *record* the booking durably and answer. The worker finishes the slow part later and can retry without the user waiting. The API answers `202` in roughly 10 ms while the worker simulates 400–1200 ms of work.

## The dual-write problem and the outbox

"Commit to PostgreSQL, then publish to Redis" can lose work if the process dies between the two. Instead the booking transaction also inserts an `outbox_events` row, atomically. A relay publishes it afterwards:

1. Dispatcher polls (500 ms; woken immediately after each booking commit).
2. `SELECT … WHERE status='PENDING' AND next_attempt_at <= now() ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED`. Several dispatchers can run safely: each skips rows another has locked.
3. `queue.add('process-booking', payload, { jobId: 'booking-<id>', attempts: 4, backoff: exponential 1 s })`.
4. Mark the row `PUBLISHED`; commit.
5. On failure: `attempts+1`, `last_error`, `next_attempt_at = now() + min(30 s, 500 ms·2^n)`; stop the batch (the queue is probably down). Transport failures never mark a row `FAILED`.

If the API crashes after `queue.add` but before the commit, the row is re-published later. That is harmless (see below).

## Delivery guarantee: at-least-once, not exactly-once

- The pipeline is **at-least-once**: a job may be delivered more than once (outbox retry, BullMQ stalled-job recovery, a worker killed mid-job).
- It is **not exactly-once delivery** and we do not claim that. We achieve **effectively-once processing** by making the effect idempotent:
  - deterministic job id `booking-<id>` makes a duplicate `add` a no-op while the job exists;
  - the only state change is `UPDATE bookings SET status='CONFIRMED' … WHERE id=$1 AND status='PROCESSING'`; a second delivery matches 0 rows and returns `already-confirmed`;
  - compensation uses the same conditional pattern (below).
- Test: three duplicate deliveries of a confirmed booking left its `confirmed_at` unchanged and inventory untouched.

## Worker

[apps/worker/src/processor.js](../apps/worker/src/processor.js) (logic, unit-tested with fakes) and [worker.js](../apps/worker/src/worker.js) (BullMQ wiring).

- Validates the payload with Zod; an invalid payload is a **permanent** error (`UnrecoverableError`, no retries).
- Concurrency `WORKER_CONCURRENCY` (default 5); scale with `docker compose up -d --scale worker=3`.
- **Retries**: `JOB_ATTEMPTS=4`, exponential backoff starting at `JOB_BACKOFF_MS=1000` (1 s, 2 s, 4 s). Only transient errors are retried.
- **Permanent failure / retries exhausted** → `failAndRelease`: in one transaction `bookings: PROCESSING → FAILED` (with reason) and `events.available_capacity += quantity` (SOLD_OUT reverts to ON_SALE). Idempotent: the second call finds nothing in `PROCESSING`.
- **Retention is bounded**: completed jobs kept 1 h / 1000, failed 24 h / 5000.
- **Graceful shutdown**: `worker.close()` stops taking jobs and waits for in-flight ones (compose `stop_grace_period: 30s`).
- **Heartbeat**: every 5 s the worker writes `worker:heartbeat:<instance>` with a 15 s TTL. The gateway judges health by heartbeat freshness, not by container state.
- Logs per job: `jobId`, `bookingId`, `requestId`, `queue`, `attempt`, `durationMs`, `finalStatus`. Events also go to a bounded Redis list for the playground.

## Demonstrating failures

`X-Simulate-Failure: transient` (fails attempts 1–2, succeeds on 3) and `permanent` on `POST /api/bookings` (only when `ENABLE_CHAOS=true`). The playground exposes both.

## Verified

| Scenario | Test |
|---|---|
| booking → job in queue → worker → `CONFIRMED`; events ordered `queue.published < job.active < job.completed` | integration |
| API responds before worker finishes | integration |
| transient failure: 2 retries, 3 active events, ends `CONFIRMED` | integration + e2e |
| permanent failure: no wasted retries (`attemptsMade = 1`), `FAILED`, tickets released, SOLD_OUT reverted | integration |
| duplicate delivery has no extra effect | integration |
| outbox row with no queue job (crash-recovery path) is published and confirmed | integration |
| two claimers never take the same outbox row | integration |
| Redis down: booking accepted, outbox waits, confirmed after recovery | fault |
| worker stopped: bookings wait, health `degraded`, complete after start | fault |
| worker SIGKILLed mid-job: stalled jobs re-run, all 4 bookings confirmed | fault (≈ 70 s: BullMQ's 30 s stall detection) |

Limitation: a SIGKILLed worker's jobs are only re-run after BullMQ's stall interval (default 30 s), so confirmation can be delayed that long.
