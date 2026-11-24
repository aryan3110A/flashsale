// Concurrent booking: many users fight for a few tickets on the dedicated, hidden "load-test-event".
// Needs the test overlay (admin endpoints + per-client rate-limit buckets). Verifies there is no overselling.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { BASE_URL, ADMIN_TOKEN, buildSummary, TREND_STATS, rateLimited, serverErrors } from './lib/common.js';

// 202 accepted, 409 sold out and 429 rate limited are all correct answers in a booking rush.
const expectBooking = http.expectedStatuses(202, 409, 429);

const CAPACITY = Number(__ENV.CAPACITY || 10);
const ATTEMPTS = Number(__ENV.ATTEMPTS || 200);
const accepted = new Counter('fs_bookings_accepted');
const soldOut = new Counter('fs_bookings_rejected_sold_out');
const unexpected = new Counter('fs_bookings_unexpected');
const consistent = new Rate('fs_inventory_consistent');

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: { rush: { executor: 'shared-iterations', vus: 50, iterations: ATTEMPTS, maxDuration: '2m' } },
  thresholds: {
    fs_bookings_accepted: [`count==${CAPACITY}`],         // never more, never fewer than the stock
    fs_bookings_unexpected: ['count==0'],
    fs_inventory_consistent: ['rate==1'],
    http_5xx_responses: ['count==0'],
  },
};

const admin = { 'X-Admin-Token': ADMIN_TOKEN, 'X-Client-Id': 'k6-admin', 'Content-Type': 'application/json' };

export function setup() {
  const r = http.post(`${BASE_URL}/api/admin/test-event/reset`, JSON.stringify({ capacity: CAPACITY }), { headers: admin });
  if (r.status !== 200) throw new Error(`cannot reset test event (${r.status}): is the test overlay running? ${r.body}`);
  return { eventId: r.json('data.eventId') };
}

export default function (data) {
  http.setResponseCallback(expectBooking);
  const id = `${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(`${BASE_URL}/api/bookings`,
    JSON.stringify({ eventId: data.eventId, quantity: 1, name: `Load User ${__VU}`, email: `load${id}@example.com` }),
    { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `k6-${id}-key`, 'X-Client-Id': `k6-${__VU}` } });
  if (res.status === 429) rateLimited.add(1);
  if (res.status >= 500) serverErrors.add(1);
  if (res.status === 202) accepted.add(1);
  else if (res.status === 409) soldOut.add(1);
  else unexpected.add(1);
  check(res, { 'accepted or sold out': (r) => r.status === 202 || r.status === 409 });
}

export function teardown(data) {
  // allow the worker to finish processing before reading final state
  const deadline = Date.now() + 40000;
  let state;
  for (;;) {
    const r = http.get(`${BASE_URL}/api/admin/test-event`, { headers: admin, responseCallback: http.expectedStatuses(200) });
    if (r.status !== 200) throw new Error(`state read failed: ${r.status} ${r.body}`);
    state = r.json('data');
    if (state.processing === 0 || Date.now() > deadline) break;
    sleep(1);
  }
  consistent.add(state.consistent && state.availableCapacity === 0 && state.bookings === CAPACITY && state.reservedTickets === CAPACITY);
  console.log(`final state: ${JSON.stringify(state)}`);
}

export function handleSummary(data) {
  const m = data.metrics;
  const v = (k) => (m[k] && m[k].values ? m[k].values.count : 0);
  return buildSummary('concurrent-booking-test', data, [
    `capacity ${CAPACITY}, attempts ${ATTEMPTS}: accepted ${v('fs_bookings_accepted')}, rejected (sold out) ${v('fs_bookings_rejected_sold_out')}, unexpected ${v('fs_bookings_unexpected')}`,
    `inventory consistent after run: ${m.fs_inventory_consistent && m.fs_inventory_consistent.values.rate === 1 ? 'YES' : 'NO'}`,
  ]);
}
