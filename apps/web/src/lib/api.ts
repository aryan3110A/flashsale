import type { AuthResult, AuthUser, Booking, BookingAccepted, CategoryItem, EventItem, FlashSaleState, WorkerEvent } from './types';
import { getToken } from './auth-token';

export const GATEWAY_URL = (process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:8080').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public requestId?: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RawResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
  durationMs: number;
  requestId: string;
  headers: {
    cache: string | null;
    rateLimitLimit: number | null;
    rateLimitRemaining: number | null;
    retryAfter: number | null;
    circuit: string | null;
    retryAttempts: number | null;
  };
}

export const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

const numHeader = (h: Headers, k: string) => { const v = h.get(k); return v === null || v === '' ? null : Number(v); };

/** Low level call. Never throws on HTTP status (callers like the playground want to *see* 429/503). Throws ApiError only for network failure. */
export async function rawRequest<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; anonymous?: boolean } = {},
): Promise<RawResponse<T>> {
  const requestId = newId();
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  // `anonymous` calls (the load simulator) must never carry the logged-in user's identity.
  const token = opts.anonymous ? null : getToken();
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers: { 'X-Request-Id': requestId, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    let body: unknown = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return {
      status: res.status, ok: res.ok, body: body as T, durationMs: Math.round(performance.now() - started),
      requestId: res.headers.get('x-request-id') ?? requestId,
      headers: {
        cache: res.headers.get('x-cache'),
        rateLimitLimit: numHeader(res.headers, 'x-ratelimit-limit'),
        rateLimitRemaining: numHeader(res.headers, 'x-ratelimit-remaining'),
        retryAfter: numHeader(res.headers, 'retry-after'),
        circuit: res.headers.get('x-circuit-state'),
        retryAttempts: numHeader(res.headers, 'x-retry-attempts'),
      },
    };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    throw new ApiError(0, aborted ? 'TIMEOUT' : 'NETWORK_ERROR', aborted ? 'The request timed out.' : 'Cannot reach the FlashSale gateway. Is the stack running?', undefined, requestId);
  } finally {
    clearTimeout(timer);
  }
}

interface Envelope<T> { success: boolean; data: T; meta?: Record<string, unknown>; message?: string; idempotentReplay?: boolean; error?: string; details?: unknown; retryAfterSeconds?: number; requestId?: string }

/** Standard call: returns parsed data, throws ApiError for any non-2xx. Centralised error normalisation. */
export async function request<T>(path: string, opts?: Parameters<typeof rawRequest>[1]) {
  const r = await rawRequest<Envelope<T>>(path, opts);
  if (!r.ok || !r.body || typeof r.body !== 'object' || (r.body as Envelope<T>).success === false) {
    const b = (r.body ?? {}) as Envelope<T>;
    throw new ApiError(
      r.status,
      b.error ?? `HTTP_${r.status}`,
      b.message ?? (r.status === 429 ? 'Too many requests. Please slow down.' : `Request failed (${r.status}).`),
      b.details,
      b.requestId ?? r.requestId,
      b.retryAfterSeconds ?? r.headers.retryAfter ?? undefined,
    );
  }
  return { ...(r.body as Envelope<T>), raw: r };
}

export interface EventFilters {
  q?: string; category?: string; city?: string; minPrice?: number; maxPrice?: number; to?: string; sort?: string; availableOnly?: boolean;
}

const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== '' && v !== false) p.set(k, String(v)); });
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  events: (f: EventFilters = {}) => request<EventItem[]>(`/api/events${qs({ ...f })}`),
  featured: () => request<EventItem[]>('/api/events/featured'),
  categories: () => request<CategoryItem[]>('/api/categories'),
  event: (id: string) => request<EventItem>(`/api/events/${id}`),
  createBooking: (input: { eventId: string; quantity: number; name: string; email: string }, idempotencyKey: string, extraHeaders: Record<string, string> = {}) =>
    request<BookingAccepted>('/api/bookings', { method: 'POST', body: input, headers: { 'Idempotency-Key': idempotencyKey, ...extraHeaders } }),
  booking: (id: string) => request<Booking>(`/api/bookings/${id}`),
  bookingsByEmail: (email: string) => request<Booking[]>(`/api/bookings?email=${encodeURIComponent(email)}`),
  workerEvents: (bookingId: string) => request<WorkerEvent[]>(`/api/worker/events?bookingId=${bookingId}`),
  demoEvent: () => request<{ eventId: string; availableCapacity: number; chaosEnabled: boolean }>('/api/demo/event'),
  signup: (input: { name: string; email: string; password: string }) => request<AuthResult>('/api/auth/signup', { method: 'POST', body: input, anonymous: true }),
  login: (input: { email: string; password: string }) => request<AuthResult>('/api/auth/login', { method: 'POST', body: input, anonymous: true }),
  me: () => request<{ user: AuthUser }>('/api/auth/me'),
  logout: () => request<{ loggedOut: boolean }>('/api/auth/logout', { method: 'POST' }),
  myBookings: () => request<Booking[]>('/api/bookings/mine'),
  flashSale: () => request<FlashSaleState>('/api/demo/flash-sale', { timeoutMs: 5000 }),
  flashSaleReset: (capacity: number) => request<FlashSaleState>('/api/demo/flash-sale/reset', { method: 'POST', body: { capacity } }),
  cacheClear: () => request<{ removedKeys: number }>('/api/cache/clear', { method: 'POST' }),
};
