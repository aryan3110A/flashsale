import { describe, it, expect, afterAll } from 'vitest';
import { gw, newPool, newRedis, API_DIRECT, MOCK_DIRECT } from '../helpers/env.js';

const pool = newPool(); const redis = newRedis();
afterAll(async () => { await pool.end(); redis.disconnect(); });

describe('infrastructure connectivity', () => {
  it('PostgreSQL is reachable, migrated and seeded', async () => {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM events WHERE is_test = FALSE");
    expect(rows[0].n).toBeGreaterThanOrEqual(10);
    const m = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    expect(m.rows.map((r) => r.version)).toContain('001');
  });
  it('Redis is reachable', async () => { expect(await redis.ping()).toBe('PONG'); });
  it('database constraints reject negative inventory directly', async () => {
    await expect(pool.query("UPDATE events SET available_capacity = -1 WHERE slug = 'load-test-event'")).rejects.toThrow(/events_capacity_range/);
  });
});

describe('gateway routing', () => {
  it('GET /health reports the gateway', async () => {
    const r = await gw('/health');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'healthy', service: 'gateway' });
  });

  it('GET /health/services reports every service individually', async () => {
    const r = await gw('/health/services');
    expect(r.status).toBe(200);
    expect(r.json.services).toEqual({ gateway: 'healthy', 'booking-api': 'healthy', postgres: 'healthy', redis: 'healthy', worker: 'healthy', 'mock-service': 'healthy' });
    expect(r.json.status).toBe('healthy');
  });

  it('/api/* is routed to the Booking API', async () => {
    const r = await gw('/api/ping');
    expect(r.status).toBe(200);
    expect(r.json.pong).toBe(true);
  });

  it('/mock/* is routed to the Mock service', async () => {
    const r = await gw('/mock/normal');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, service: 'mock-service' });
    expect(r.headers.get('x-circuit-state')).toBe('CLOSED');
  });

  it('propagates upstream status codes (404 for unknown event, 400 for bad id)', async () => {
    expect((await gw('/api/events/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await gw('/api/events/not-a-uuid')).status).toBe(400);
  });

  it('echoes a valid X-Request-Id and generates one otherwise', async () => {
    const a = await gw('/api/ping', { headers: { 'X-Request-Id': 'integration-req-0001' } });
    expect(a.headers.get('x-request-id')).toBe('integration-req-0001');
    const b = await gw('/api/ping');
    expect(b.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves Prometheus-format metrics', async () => {
    const r = await gw('/metrics');
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/# TYPE flashsale_http_requests_total counter/);
    expect(r.text).toMatch(/flashsale_rate_limited_total/);
  });

  it('/metrics/summary aggregates real gateway, cache, queue and worker data', async () => {
    const r = await gw('/metrics/summary');
    expect(r.status).toBe(200);
    expect(r.json.cache.available).toBe(true);
    expect(r.json.queue.available).toBe(true);
    expect(r.json.worker.available).toBe(true);
    expect(r.json.circuitBreaker.state).toBeDefined();
    expect(Array.isArray(r.json.series)).toBe(true);
  });

  it('internal services are not reachable through the gateway', async () => {
    expect((await gw('/internal/stats')).status).toBe(404);
    expect((await gw('/metrics/../internal/stats')).status).toBeGreaterThanOrEqual(400);
  });

  it('CORS allows the web origin and rejects others', async () => {
    const ok = await gw('/api/ping', { headers: { Origin: 'http://localhost:3000' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    const bad = await gw('/api/ping', { headers: { Origin: 'http://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sets security headers', async () => {
    const r = await gw('/api/ping');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-powered-by')).toBeNull();
  });

  it('direct internal endpoints exist only on the test overlay ports', async () => {
    expect((await fetch(`${API_DIRECT}/health/ready`)).status).toBe(200);
    expect((await fetch(`${MOCK_DIRECT}/health`)).status).toBe(200);
  });
});
