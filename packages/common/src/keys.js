// Redis key names shared between services. Centralised so producers and consumers cannot drift apart.

export const QUEUE_NAME = 'booking-processing';
export const QUEUE_PREFIX = 'flashsale';

export const KEYS = {
  rateLimit: (klass, id) => `flashsale:rl:${klass}:${id}`,
  eventsAll: 'events:all',
  eventsFeatured: 'events:featured',
  eventsCategory: (c) => `events:category:${c}`,
  event: (id) => `events:${id}`,
  eventsPattern: 'events:*',
  cacheStats: 'stats:cache',
  workerStats: 'stats:worker',
  workerHeartbeatPrefix: 'worker:heartbeat:',
  workerEvents: 'worker:events',
  bookingStats: 'stats:booking',
};

export const WORKER_EVENTS_MAX = 300;
