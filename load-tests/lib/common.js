import http from 'k6/http';
import { Counter } from 'k6/metrics';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
export const RESULTS_DIR = __ENV.RESULTS_DIR || 'load-tests/results';
export const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || 'test-admin-token-local-only';
// When true every virtual user sends its own X-Client-Id so it gets its own rate-limit bucket (simulates many
// distinct visitors). Only honoured by the gateway when started with the test overlay.
export const CLIENT_IDS = (__ENV.CLIENT_IDS || 'false') === 'true';
export const TAG = __ENV.RUN_TAG || '';
// k6 only computes p(99) if asked to.
export const TREND_STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];

export const rateLimited = new Counter('http_429_responses');
export const serverErrors = new Counter('http_5xx_responses');

export function headers(extra = {}) {
  const h = { ...extra };
  if (CLIENT_IDS) h['X-Client-Id'] = `k6-${__VU}`;
  return h;
}

/** GET that records 429 / 5xx counters. */
export function get(path, tags = {}) {
  const res = http.get(`${BASE_URL}${path}`, { headers: headers(), tags });
  track(res);
  return res;
}

export function track(res) {
  if (res.status === 429) rateLimited.add(1);
  if (res.status >= 500) serverErrors.add(1);
}

/** 429 is an expected, correct answer under overload, so treat it as "handled" for error-rate purposes. */
export const expect429 = http.expectedStatuses({ min: 200, max: 399 }, 429);

const val = (m, k) => (m && m.values && m.values[k] !== undefined ? m.values[k] : 0);

/** Builds handleSummary output: a machine readable JSON report (also served in the web playground) + console text. */
export function buildSummary(testName, data, notes = []) {
  const m = data.metrics;
  const dur = m.http_req_duration;
  const thresholdsPassed = Object.values(m).every((x) => !x.thresholds || Object.values(x.thresholds).every((t) => t.ok));
  const report = {
    test: testName + (TAG ? `:${TAG}` : ''),
    finishedAt: new Date().toISOString(),
    durationSec: Math.round(data.state.testRunDurationMs / 1000),
    maxVus: val(m.vus_max, 'max'),
    requests: val(m.http_reqs, 'count'),
    throughputRps: val(m.http_reqs, 'rate'),
    avgMs: val(dur, 'avg'),
    medMs: val(dur, 'med'),
    p90Ms: val(dur, 'p(90)'),
    p95Ms: val(dur, 'p(95)'),
    p99Ms: val(dur, 'p(99)'),
    maxMs: val(dur, 'max'),
    errorRate: val(m.http_req_failed, 'rate'),
    rateLimited: val(m.http_429_responses, 'count'),
    serverErrors: val(m.http_5xx_responses, 'count'),
    checksPassRate: val(m.checks, 'rate'),
    thresholdsPassed,
    baseUrl: BASE_URL,
    clientIds: CLIENT_IDS,
    notes,
    custom: Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('fs_')).map(([k, v]) => [k, v.values])),
  };
  const stamp = report.finishedAt.replace(/[:.]/g, '-');
  const file = `${testName}${TAG ? `-${TAG}` : ''}`;
  const text = [
    `\n=== ${report.test} ===`,
    `duration ${report.durationSec}s | max VUs ${report.maxVus} | requests ${report.requests} | ${report.throughputRps.toFixed(1)} req/s`,
    `latency ms: avg ${report.avgMs.toFixed(1)} | med ${report.medMs.toFixed(1)} | p90 ${report.p90Ms.toFixed(1)} | p95 ${report.p95Ms.toFixed(1)} | p99 ${report.p99Ms.toFixed(1)} | max ${report.maxMs.toFixed(0)}`,
    `http_req_failed ${(report.errorRate * 100).toFixed(2)}% | 429s ${report.rateLimited} | 5xx ${report.serverErrors} | checks ${(report.checksPassRate * 100).toFixed(1)}% | thresholds ${thresholdsPassed ? 'PASSED' : 'FAILED'}`,
    ...notes, '',
  ].join('\n');
  return {
    stdout: text,
    [`${RESULTS_DIR}/${file}-latest.json`]: JSON.stringify(report, null, 2),
    [`${RESULTS_DIR}/${file}-${stamp}.json`]: JSON.stringify(report, null, 2),
  };
}
