import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import Redis from 'ioredis';

export const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
export const API_DIRECT = process.env.API_DIRECT_URL ?? 'http://127.0.0.1:18081';
export const MOCK_DIRECT = process.env.MOCK_DIRECT_URL ?? 'http://127.0.0.1:18082';
export const WORKER_DIRECT = process.env.WORKER_DIRECT_URL ?? 'http://127.0.0.1:19100';
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token-local-only';
export const PG_URL = process.env.TEST_DATABASE_URL ?? `postgres://${process.env.POSTGRES_USER ?? 'flashsale'}:${process.env.POSTGRES_PASSWORD ?? 'change_me_local'}@127.0.0.1:15432/${process.env.POSTGRES_DB ?? 'flashsale'}`;
export const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:16379';
const COMPOSE = 'docker compose -f docker-compose.yml -f docker-compose.test.yml';

export const uid = (p = 't') => `${p}-${randomUUID().slice(0, 12)}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call the gateway. `client` picks an isolated rate-limit bucket (honoured only by the test overlay). */
export async function gw(path, { method = 'GET', body, headers = {}, client = uid('client'), timeoutMs = 20_000, base = GATEWAY } = {}) {
  const started = Date.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'X-Client-Id': client, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON (e.g. Prometheus text) */ }
  return { status: res.status, headers: res.headers, json, text, ms: Date.now() - started };
}

export const admin = (path, opts = {}) => gw(path, { ...opts, headers: { 'X-Admin-Token': ADMIN_TOKEN, ...(opts.headers ?? {}) } });

export async function resetTestEvent(capacity = 10) {
  const r = await admin('/api/admin/test-event/reset', { method: 'POST', body: { capacity } });
  if (r.status !== 200) throw new Error(`reset failed: ${r.status} ${r.text}`);
  return r.json.data;
}
export async function testEventState() {
  return (await admin('/api/admin/test-event')).json.data;
}

export function book(eventId, { quantity = 1, email = `${uid('u')}@example.com`, name = 'Test User', key = uid('key') + '-idem', headers = {}, client } = {}) {
  return gw('/api/bookings', { method: 'POST', body: { eventId, quantity, name, email }, headers: { 'Idempotency-Key': key, ...headers }, client });
}

export async function waitFor(fn, { timeout = 30_000, interval = 300, desc = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${desc}${last instanceof Error ? `: ${last.message}` : ''}`);
    await sleep(interval);
  }
}

export const newPool = () => {
  const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
  pool.on('error', () => { /* idle clients are dropped when the test deliberately stops PostgreSQL */ });
  return pool;
};
export const newRedis = () => new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });

export function compose(cmd) {
  return execSync(`${COMPOSE} ${cmd}`, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

export async function bookingStatus(id) {
  return (await gw(`/api/bookings/${id}`)).json?.data;
}

export async function waitForStatus(id, status, timeout = 30_000) {
  return waitFor(async () => { const b = await bookingStatus(id); return b?.status === status ? b : false; }, { timeout, desc: `booking ${id} → ${status}` });
}

export async function getFirstPublicEvent() {
  const r = await gw('/api/events');
  return r.json.data[0];
}
