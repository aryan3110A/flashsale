// Smoke test: a handful of users, proves the system is up, responses have the right shape and latency is sane.
import { check, sleep } from 'k6';
import { get, buildSummary, TREND_STATS, expect429 } from './lib/common.js';
import http from 'k6/http';

export const options = {
  summaryTrendStats: TREND_STATS,
  vus: 3,
  duration: '20s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  http.setResponseCallback(expect429);
  const health = get('/health');
  check(health, { 'health 200': (r) => r.status === 200, 'health body': (r) => r.json('status') === 'healthy' });

  const services = get('/health/services');
  check(services, { 'services 200': (r) => r.status === 200, 'all services listed': (r) => Object.keys(r.json('services')).length === 6 });

  const events = get('/api/events');
  check(events, {
    'events 200': (r) => r.status === 200,
    'events shape': (r) => Array.isArray(r.json('data')) && r.json('data').length > 0 && r.json('data.0.id') !== undefined,
    'x-cache header present': (r) => ['HIT', 'MISS'].includes(r.headers['X-Cache']),
    'request id echoed': (r) => !!r.headers['X-Request-Id'],
  });

  const first = events.json('data.0.id');
  const detail = get(`/api/events/${first}`);
  check(detail, { 'detail 200': (r) => r.status === 200, 'detail has capacity': (r) => typeof r.json('data.availableCapacity') === 'number' });

  const mock = get('/mock/normal');
  check(mock, { 'mock 200': (r) => r.status === 200 });
  sleep(1);
}

export function handleSummary(data) { return buildSummary('smoke-test', data); }
