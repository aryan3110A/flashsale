export interface EventItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  venue: string;
  city: string;
  eventDate: string;
  imageUrl: string | null;
  ticketPrice: number;
  totalCapacity: number;
  availableCapacity: number;
  status: 'ON_SALE' | 'SOLD_OUT' | 'CANCELLED';
  isFeatured: boolean;
}

export interface CategoryItem { name: string; slug: string; count: number }

export type BookingStatus = 'PROCESSING' | 'CONFIRMED' | 'FAILED';

export interface JobInfo { state: string; attemptsMade: number; maxAttempts: number }

export interface Booking {
  id: string;
  reference: string;
  status: BookingStatus;
  quantity: number;
  totalAmount: number;
  eventId: string;
  eventTitle?: string;
  eventDate?: string;
  venue?: string;
  city?: string;
  customerName?: string;
  customerEmail?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  job?: JobInfo | null;
}

export interface BookingAccepted {
  bookingId: string;
  bookingReference: string;
  status: BookingStatus;
  quantity: number;
  totalAmount: number;
  eventId: string;
  statusUrl: string;
}

export interface WorkerEvent {
  type: string;
  at: string;
  source: 'worker' | 'dispatcher';
  bookingId?: string;
  jobId?: string;
  attempt?: number;
  maxAttempts?: number;
  durationMs?: number;
  error?: string;
  result?: string;
}

export type Unavailable = { available: false; reason: string };
export type MaybeAvailable<T> = (T & { available: true }) | Unavailable;

export interface SeriesPoint {
  t: string; requests: number; success: number; failed: number; clientErrors: number; rateLimited: number; avgMs: number;
}

export interface BreakerSnapshot {
  name: string; state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; failures: number; failureThreshold: number;
  halfOpenSuccesses: number; successThreshold: number; halfOpenMaxCalls: number; resetTimeoutMs: number;
  retryAfterMs: number; openedAt: string | null;
  totals: { calls: number; successes: number; failures: number; rejected: number };
  history: { at: string; from: string; to: string; reason: string }[];
}

export interface Summary {
  generatedAt: string;
  gateway: { uptimeSeconds: number; requests: number; successful: number; failed: number; clientErrors: number; rateLimited: number; avgResponseMs: number; byStatus: Record<string, number> };
  series: SeriesPoint[];
  circuitBreaker: BreakerSnapshot;
  cache: MaybeAvailable<{ hits: number; misses: number; errors: number; hitRatio: number | null }>;
  queue: MaybeAvailable<{ waiting: number; active: number; delayed: number; failed: number; completed?: number }>;
  worker: MaybeAvailable<{ instances: number; completed: number; failed: number; retried: number; avgProcessingMs: number }>;
  database: MaybeAvailable<{ queryFailures: number; pool: { total: number; idle: number; waiting: number } }>;
  outbox: MaybeAvailable<{ pending: number; published: number; failed: number }>;
  rateLimit: { capacity: number; refillRate: number; refillIntervalMs: number };
}

export type ServiceStatus = 'healthy' | 'unhealthy' | 'unknown';
export interface ServicesHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: Record<string, ServiceStatus>;
  details: Record<string, { status: ServiceStatus; latencyMs?: number; message?: string; instances?: number }>;
  circuitBreaker: string;
}
