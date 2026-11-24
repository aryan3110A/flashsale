// Spike test: low traffic -> sudden surge -> sustained surge -> recovery.
// Default run exercises the gateway as shipped (all VUs share one client IP, so the Token Bucket protects the system).
// CLIENT_IDS=true gives each VU its own bucket (needs the test overlay) to show raw capacity without limiting.
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { get, buildSummary, TREND_STATS, expect429 } from './lib/common.js';
import http from 'k6/http';

const unexpected = new Rate('fs_unexpected_status');

export const options = {
  summaryTrendStats: TREND_STATS,
  stages: [
    { duration: '10s', target: 10 },    // warm-up
    { duration: '5s', target: 200 },    // spike
    { duration: '30s', target: 200 },   // sustain the spike
    { duration: '10s', target: 10 },    // drop
    { duration: '10s', target: 0 },     // cool-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<1500'],
    fs_unexpected_status: ['rate<0.01'],   // only 200 / 429 are acceptable answers
    http_5xx_responses: ['count==0'],
  },
};

export default function () {
  http.setResponseCallback(expect429);
  const r = get('/api/events');
  unexpected.add(r.status !== 200 && r.status !== 429);
  check(r, { 'status is 200 or 429': (x) => x.status === 200 || x.status === 429 });
  check(r, { '429 carries Retry-After': (x) => x.status !== 429 || !!x.headers['Retry-After'] });
  sleep(0.1);
}

export function handleSummary(data) { return buildSummary('spike-test', data); }
