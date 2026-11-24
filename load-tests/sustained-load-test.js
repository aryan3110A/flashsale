// Sustained load: steady number of users browsing for a configurable duration (VUS, DURATION env vars).
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { get, buildSummary, TREND_STATS, expect429 } from './lib/common.js';
import http from 'k6/http';

const unexpected = new Rate('fs_unexpected_status');

export const options = {
  summaryTrendStats: TREND_STATS,
  vus: Number(__ENV.VUS || 40),
  duration: __ENV.DURATION || '60s',
  thresholds: {
    http_req_duration: ['p(95)<800'],
    fs_unexpected_status: ['rate<0.01'],
    http_5xx_responses: ['count==0'],
  },
};

export function setup() {
  http.setResponseCallback(expect429);
  const r = get('/api/events');
  return { ids: r.json('data').map((e) => e.id) };
}

export default function (data) {
  http.setResponseCallback(expect429);
  const roll = Math.random();
  let res;
  if (roll < 0.55) res = get('/api/events');
  else if (roll < 0.8) res = get(`/api/events/${data.ids[Math.floor(Math.random() * data.ids.length)]}`);
  else if (roll < 0.9) res = get('/api/events/featured');
  else res = get('/api/categories');
  unexpected.add(res.status !== 200 && res.status !== 429);
  check(res, { 'status is 200 or 429': (x) => x.status === 200 || x.status === 429 });
  sleep(0.2);
}

export function handleSummary(data) { return buildSummary('sustained-load-test', data); }
