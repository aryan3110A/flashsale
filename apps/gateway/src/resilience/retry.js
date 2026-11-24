const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter: random(0, min(maxDelay, base * 2^attempt)). */
export function backoffDelay(attempt, { baseDelayMs, maxDelayMs }, random = Math.random) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling) + Math.min(10, ceiling);
}

/**
 * Run `fn(attempt)` up to `maxAttempts` times.
 * `shouldRetry(outcome)` receives `{error}` or `{result}` and decides whether another attempt is
 * justified - callers use it to retry only transient, safe-to-repeat failures.
 * Returns `{ result, attempts }`; rethrows the last error (decorated with `.attempts`).
 */
export async function withRetry(fn, { maxAttempts = 2, baseDelayMs = 100, maxDelayMs = 1000, shouldRetry, onRetry, sleepFn = sleep, random = Math.random } = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    let outcome;
    try {
      outcome = { result: await fn(attempt) };
    } catch (error) {
      outcome = { error };
    }
    const retry = attempt < maxAttempts && shouldRetry(outcome);
    if (!retry) {
      if (outcome.error) {
        outcome.error.attempts = attempt;
        throw outcome.error;
      }
      return { result: outcome.result, attempts: attempt };
    }
    const delay = backoffDelay(attempt - 1, { baseDelayMs, maxDelayMs }, random);
    onRetry?.({ attempt, delay, outcome });
    await sleepFn(delay);
  }
}

/**
 * Which failures are safe to retry?
 *  - Idempotent methods (GET/HEAD/OPTIONS) on network errors, timeouts and 502/503/504.
 *  - Non-idempotent methods ONLY if the request was never delivered (connection refused/reset
 *    before a response) or the client supplied an Idempotency-Key, which makes replays harmless.
 *  - Never 4xx, never 500 on writes, never when the circuit is open.
 */
export function isRetryable({ method, hasIdempotencyKey, error, status }) {
  if (error?.code === 'CIRCUIT_OPEN') return false;
  const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(method) || Boolean(hasIdempotencyKey);
  if (error) {
    if (isConnectError(error)) return true;
    return idempotent; // timeouts / aborted responses
  }
  return idempotent && [502, 503, 504].includes(status);
}

export function isConnectError(error) {
  const code = error?.cause?.code || error?.code;
  return ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH'].includes(code);
}
