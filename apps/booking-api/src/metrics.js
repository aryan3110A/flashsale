import client from 'prom-client';

export function createMetrics() {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: 'booking-api' });
  client.collectDefaultMetrics({ register: registry });
  const reg = [registry];
  return {
    registry,
    httpRequests: new client.Counter({ name: 'flashsale_http_requests_total', help: 'Booking API HTTP requests', labelNames: ['method', 'route', 'status'], registers: reg }),
    httpDuration: new client.Histogram({ name: 'flashsale_http_request_duration_seconds', help: 'Booking API request duration', labelNames: ['route'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: reg }),
    cacheOps: new client.Counter({ name: 'flashsale_cache_operations_total', help: 'Cache lookups by result', labelNames: ['result'], registers: reg }),
    bookings: new client.Counter({ name: 'flashsale_bookings_total', help: 'Booking attempts by outcome', labelNames: ['outcome'], registers: reg }),
    dbFailures: new client.Counter({ name: 'flashsale_db_failures_total', help: 'PostgreSQL infrastructure failures', labelNames: ['kind'], registers: reg }),
    outboxPublished: new client.Counter({ name: 'flashsale_outbox_published_total', help: 'Outbox rows published to BullMQ', registers: reg }),
    outboxErrors: new client.Counter({ name: 'flashsale_outbox_publish_errors_total', help: 'Outbox publish failures', registers: reg }),
  };
}
