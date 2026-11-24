# Likely viva questions

**1. How do you prevent overselling?**
The reservation is one atomic statement inside a transaction: `UPDATE events SET available_capacity = available_capacity - q WHERE id=$1 AND available_capacity >= q`. The row lock serialises concurrent buyers; each waiter re-evaluates the condition on the latest committed row. A `CHECK (available_capacity BETWEEN 0 AND total_capacity)` is a second, independent guard. Verified with 50 concurrent requests for 10 tickets (exactly 10 accepted) and a k6 run of 200 attempts.

**2. Why not use the Redis cache for stock?**
Cache values can be stale and are not part of the transaction. Cached availability is display-only. We even tested a poisoned cache entry (9999 tickets) and the booking still got 409.

**3. What is idempotency and how is it implemented?**
Doing the same request twice has the effect of doing it once. The client sends an `Idempotency-Key`; it is stored on the booking with a UNIQUE constraint and a fingerprint of the payload. Same key + same payload → return the original; different payload → 422. If two identical requests race, one insert fails the UNIQUE constraint and its whole transaction (including the inventory decrement) rolls back.

**4. What problem does the outbox pattern solve?**
The dual-write problem: you cannot atomically write to PostgreSQL and publish to Redis. We insert an outbox row in the same transaction as the booking; a dispatcher publishes it afterwards. A crash can delay publishing but not lose it.

**5. Is delivery exactly-once?**
No. It is at-least-once. Duplicates are possible (outbox retry, stalled job re-run). We make processing idempotent (deterministic job id, `UPDATE … WHERE status='PROCESSING'`), which gives effectively-once *effects*, not exactly-once delivery.

**6. How do multiple dispatchers avoid publishing the same row?**
`SELECT … FOR UPDATE SKIP LOCKED`: a row locked by one transaction is skipped by the others. Even if a duplicate slipped through, the deterministic BullMQ job id and idempotent worker absorb it.

**7. Explain the Token Bucket and why it's in Redis with Lua.**
A bucket holds up to `capacity` tokens and refills at a constant rate; a request needs one token. It allows bursts but caps the sustained rate. State must be shared and updated atomically across gateway instances, so refill-and-spend runs as a single Lua script in Redis (Redis runs scripts atomically). Tested: 300 concurrent consumers → exactly 50 tokens.

**8. What happens if Redis is down?**
The limiter fails open (request allowed, header `X-RateLimit-Status: bypassed`), reads fall back to PostgreSQL, bookings still succeed because the outbox lives in PostgreSQL, and queued work resumes after Redis returns. Trade-off: no rate limiting during the outage; it's configurable (`RATE_LIMIT_FAIL_OPEN`).

**9. What if PostgreSQL is down?**
Writes and uncached reads fail fast with 503, health reports `postgres: unhealthy`, services stay up and recover when it returns.

**10. Describe the circuit breaker states.**
CLOSED (normal), OPEN (after 3 consecutive failures: reject instantly for 10 s), HALF_OPEN (let one trial call at a time; 2 successes close it, one failure re-opens). It stops a failing dependency from consuming threads/time and gives it room to recover.

**11. Retries: where and why not everywhere?**
Gateway retries GETs on network errors/timeouts/502-504, and POSTs only if never delivered or carrying an idempotency key. Blind retries on non-idempotent writes could duplicate side effects. Retries use exponential backoff with jitter to avoid synchronised retry storms. Worker jobs retry 4× with exponential backoff.

**12. Why a gateway?**
One public entry point for cross-cutting concerns: rate limiting, request IDs, timeouts, CORS, security headers, routing, health aggregation, metrics, and hiding internal addresses.

**13. Why asynchronous confirmation?**
The user shouldn't wait for slow, failure-prone work; the API stays fast (≈10 ms to accept) under load, and retries happen off the request path.

**14. How do you know the worker is really alive?**
It writes a heartbeat key (TTL 15 s) every 5 s; the gateway checks freshness. Container "running" doesn't prove the process is consuming jobs.

**15. What if a worker dies mid-job?**
BullMQ detects the stalled job after its lock expires (≈30 s) and re-queues it; processing is idempotent. We tested SIGKILL: all bookings confirmed.

**16. How does request tracing work?**
`X-Request-Id` is created (or validated) at the gateway, forwarded to the API, stored in the outbox payload and BullMQ job, and logged by the worker. One ID shows up in all three services' JSON logs.

**17. What isolation level and why does the booking work?**
READ COMMITTED. The conditional `UPDATE` locks the row and re-checks its predicate after the lock is acquired, so no SERIALIZABLE retry loop is needed. The cost: the hot event row is a serialisation point.

**18. What are the bottlenecks?**
Per-event row contention (one hot row); single PostgreSQL and Redis instances; gateway breaker state is per instance; in the load test with one shared IP the limiter, not the backend, bounds throughput. Mitigations: sharded inventory counters or pre-allocated ticket blocks, read replicas, Redis Sentinel/Cluster, shared breaker state.

**19. Security measures? Known weaknesses?**
Env-based secrets, body size limits, CORS allow-list, Helmet headers, parameterised SQL, strict validation, internal-only network, log redaction. Weaknesses: no authentication ("My bookings" is by e-mail), demo endpoints enabled by default in compose, single-node infra.

**20. What would you do next?**
Authentication/authorisation, payments via a real provider with its own idempotency, OpenTelemetry tracing, HA data stores, shared circuit-breaker state, cancellation/refund flow, per-event inventory sharding for extreme hot spots.
