import client from 'prom-client';

/** Fixed-size ring of time buckets: memory is bounded no matter how long the process runs. */
export class TimeSeries {
  constructor({ bucketMs = 5000, maxBuckets = 120, now = () => Date.now() } = {}) {
    this.bucketMs = bucketMs;
    this.maxBuckets = maxBuckets;
    this.now = now;
    this.buckets = new Map(); // bucketStart -> counters
  }

  _bucket() {
    const start = Math.floor(this.now() / this.bucketMs) * this.bucketMs;
    let b = this.buckets.get(start);
    if (!b) {
      b = { t: start, requests: 0, success: 0, failed: 0, clientErrors: 0, rateLimited: 0, durationMs: 0 };
      this.buckets.set(start, b);
      while (this.buckets.size > this.maxBuckets) this.buckets.delete(this.buckets.keys().next().value);
    }
    return b;
  }

  record(status, durationMs) {
    const b = this._bucket();
    b.requests++;
    b.durationMs += durationMs;
    if (status === 429) b.rateLimited++;
    else if (status >= 500) b.failed++;
    else if (status >= 400) b.clientErrors++;
    else b.success++;
  }

  toArray(limit = this.maxBuckets) {
    return [...this.buckets.values()].slice(-limit).map((b) => ({
      t: new Date(b.t).toISOString(),
      requests: b.requests,
      success: b.success,
      failed: b.failed,
      clientErrors: b.clientErrors,
      rateLimited: b.rateLimited,
      avgMs: b.requests ? +(b.durationMs / b.requests).toFixed(2) : 0,
    }));
  }
}

export function classifyRoute(path) {
  if (path === '/health' || path.startsWith('/health/') || path === '/metrics' || path.startsWith('/metrics/') || path.startsWith('/gateway/')) return 'monitoring';
  if (path.startsWith('/api/') || path === '/api') return 'api';
  if (path.startsWith('/mock/') || path === '/mock') return 'mock';
  return 'other';
}

export function createMetrics(cfg) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: 'gateway' });
  client.collectDefaultMetrics({ register: registry });

  const httpRequests = new client.Counter({
    name: 'flashsale_http_requests_total', help: 'HTTP requests handled by the gateway', labelNames: ['method', 'route_class', 'status'], registers: [registry],
  });
  const httpDuration = new client.Histogram({
    name: 'flashsale_http_request_duration_seconds', help: 'Gateway request duration', labelNames: ['route_class'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry],
  });
  const rateLimited = new client.Counter({ name: 'flashsale_rate_limited_total', help: 'Requests rejected with 429', registers: [registry] });
  const rateLimiterErrors = new client.Counter({ name: 'flashsale_rate_limiter_errors_total', help: 'Rate limiter backend failures (request let through when fail-open)', registers: [registry] });
  const upstreamRequests = new client.Counter({
    name: 'flashsale_upstream_requests_total', help: 'Calls from the gateway to upstream services', labelNames: ['upstream', 'outcome'], registers: [registry],
  });
  const upstreamRetries = new client.Counter({ name: 'flashsale_upstream_retries_total', help: 'Upstream retry attempts', labelNames: ['upstream'], registers: [registry] });
  const breakerState = new client.Gauge({ name: 'flashsale_circuit_breaker_state', help: 'Circuit breaker state: 0=CLOSED 1=HALF_OPEN 2=OPEN', labelNames: ['breaker'], registers: [registry] });
  const breakerTransitions = new client.Counter({
    name: 'flashsale_circuit_breaker_transitions_total', help: 'Circuit breaker state transitions', labelNames: ['breaker', 'from', 'to'], registers: [registry],
  });

  const series = new TimeSeries({ bucketMs: cfg.metricsBucketMs, maxBuckets: cfg.metricsBuckets });
  // Lifetime totals for user-facing traffic (health/metrics polling is excluded so the dashboard
  // does not inflate its own numbers).
  const totals = { requests: 0, success: 0, failed: 0, clientErrors: 0, rateLimited: 0, durationMs: 0, byStatus: {} };
  const startedAt = Date.now();

  function observe({ method, path, status, durationMs }) {
    const klass = classifyRoute(path);
    httpRequests.inc({ method, route_class: klass, status: String(status) });
    httpDuration.observe({ route_class: klass }, durationMs / 1000);
    if (status === 429) rateLimited.inc();
    if (klass === 'monitoring') return;
    totals.requests++;
    totals.durationMs += durationMs;
    totals.byStatus[status] = (totals.byStatus[status] || 0) + 1;
    if (status === 429) totals.rateLimited++;
    else if (status >= 500) totals.failed++;
    else if (status >= 400) totals.clientErrors++;
    else totals.success++;
    series.record(status, durationMs);
  }

  function summary() {
    return {
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      requests: totals.requests,
      successful: totals.success,
      failed: totals.failed,
      clientErrors: totals.clientErrors,
      rateLimited: totals.rateLimited,
      avgResponseMs: totals.requests ? +(totals.durationMs / totals.requests).toFixed(2) : 0,
      byStatus: { ...totals.byStatus },
    };
  }

  return { registry, observe, summary, series, rateLimited, rateLimiterErrors, upstreamRequests, upstreamRetries, breakerState, breakerTransitions, startedAt };
}
