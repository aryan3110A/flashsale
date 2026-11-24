import { Queue } from 'bullmq';
import { QUEUE_NAME, QUEUE_PREFIX } from '@flashsale/common';

export function createBookingQueue(connection) {
  return new Queue(QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });
}

export const jobIdFor = (bookingId) => `booking-${bookingId}`;

export function jobOptions(cfg) {
  return {
    attempts: cfg.job.attempts,
    backoff: { type: 'exponential', delay: cfg.job.backoffMs },
    removeOnComplete: { age: 3600, count: 1000 },   // bounded retention: queue memory cannot grow without limit
    removeOnFail: { age: 86_400, count: 5000 },
  };
}
