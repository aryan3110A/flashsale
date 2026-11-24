export const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

export class CircuitOpenError extends Error {
  constructor(retryAfterMs) {
    super('Circuit breaker is open');
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Circuit breaker with three states.
 *
 *   CLOSED     calls flow normally; `failureThreshold` consecutive failures trip it to OPEN.
 *   OPEN       calls fail fast (no downstream traffic) until `resetTimeoutMs` has elapsed.
 *   HALF_OPEN  at most `halfOpenMaxCalls` trial calls are in flight at once; `successThreshold`
 *              successes close the breaker, a single failure re-opens it.
 *
 * Per-call timeouts are the caller's job (the gateway aborts the fetch); a timeout simply
 * surfaces here as a rejected promise and counts as a failure.
 */
export class CircuitBreaker {
  constructor({
    name = 'breaker',
    failureThreshold = 3,
    resetTimeoutMs = 10_000,
    halfOpenMaxCalls = 1,
    successThreshold = 2,
    now = () => Date.now(),
    onTransition = () => {},
  } = {}) {
    Object.assign(this, { name, failureThreshold, resetTimeoutMs, halfOpenMaxCalls, successThreshold, now, onTransition });
    this.state = STATES.CLOSED;
    this.failures = 0;            // consecutive failures while CLOSED
    this.halfOpenSuccesses = 0;
    this.halfOpenInFlight = 0;
    this.openedAt = null;
    this.totals = { calls: 0, successes: 0, failures: 0, rejected: 0 };
    this.history = [];            // bounded: last 25 transitions
  }

  _transition(to, reason) {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    if (to === STATES.OPEN) this.openedAt = this.now();
    if (to === STATES.CLOSED) { this.failures = 0; this.openedAt = null; }
    if (to === STATES.HALF_OPEN) { this.halfOpenSuccesses = 0; this.halfOpenInFlight = 0; }
    const entry = { at: new Date(this.now()).toISOString(), from, to, reason };
    this.history.push(entry);
    if (this.history.length > 25) this.history.shift();
    this.onTransition(entry);
  }

  /** Lazily move OPEN -> HALF_OPEN once the reset timeout has elapsed. */
  _refresh() {
    if (this.state === STATES.OPEN && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this._transition(STATES.HALF_OPEN, 'reset timeout elapsed');
    }
  }

  getState() {
    this._refresh();
    return this.state;
  }

  retryAfterMs() {
    if (this.state !== STATES.OPEN) return 0;
    return Math.max(0, this.resetTimeoutMs - (this.now() - this.openedAt));
  }

  /**
   * @param {() => Promise<T>} fn
   * @param {(result:T)=>boolean} [isFailure] decides whether a *resolved* result counts as failure
   */
  async execute(fn, isFailure = () => false) {
    this._refresh();
    if (this.state === STATES.OPEN) {
      this.totals.rejected++;
      throw new CircuitOpenError(this.retryAfterMs());
    }
    const trial = this.state === STATES.HALF_OPEN;
    if (trial) {
      if (this.halfOpenInFlight >= this.halfOpenMaxCalls) {
        this.totals.rejected++;
        throw new CircuitOpenError(1000);
      }
      this.halfOpenInFlight++;
    }
    this.totals.calls++;
    let result;
    try {
      result = await fn();
    } catch (err) {
      this._onFailure(trial, err.message);
      throw err;
    }
    if (isFailure(result)) this._onFailure(trial, 'failure response');
    else this._onSuccess(trial);
    return result;
  }

  _onSuccess(trial) {
    this.totals.successes++;
    if (trial) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      if (this.state !== STATES.HALF_OPEN) return;
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) this._transition(STATES.CLOSED, 'trial calls succeeded');
    } else if (this.state === STATES.CLOSED) {
      this.failures = 0;
    }
  }

  _onFailure(trial, reason) {
    this.totals.failures++;
    if (trial) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      if (this.state === STATES.HALF_OPEN) this._transition(STATES.OPEN, `trial call failed: ${reason}`);
    } else if (this.state === STATES.CLOSED) {
      this.failures++;
      if (this.failures >= this.failureThreshold) {
        this._transition(STATES.OPEN, `${this.failures} consecutive failures: ${reason}`);
      }
    }
  }

  snapshot() {
    this._refresh();
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      failureThreshold: this.failureThreshold,
      halfOpenSuccesses: this.halfOpenSuccesses,
      successThreshold: this.successThreshold,
      halfOpenMaxCalls: this.halfOpenMaxCalls,
      resetTimeoutMs: this.resetTimeoutMs,
      retryAfterMs: this.retryAfterMs(),
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      totals: { ...this.totals },
      history: [...this.history],
    };
  }
}
