import { createHash, randomInt } from 'node:crypto';
import { AppError } from '@flashsale/common';
import { withTransaction } from '../db/pool.js';
import { keysForEvent } from './events.js';

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to keep references readable
const newReference = () => `FS-${Array.from({ length: 8 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('')}`;

export const fingerprint = ({ eventId, quantity, email }) =>
  createHash('sha256').update(`${eventId}|${quantity}|${email}`).digest('hex');

const maskEmail = (e) => e.replace(/^(.).*(@.*)$/, '$1***$2');

export function toBooking(r) {
  return {
    id: r.id,
    reference: r.booking_reference,
    status: r.status,
    quantity: r.quantity,
    totalAmount: r.total_amount,
    eventId: r.event_id,
    eventTitle: r.event_title,
    eventDate: r.event_date ? new Date(r.event_date).toISOString() : undefined,
    venue: r.venue,
    city: r.city,
    customerName: r.customer_name,
    customerEmail: r.customer_email ? maskEmail(r.customer_email) : undefined,
    failureReason: r.failure_reason ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : undefined,
  };
}

const BOOKING_SELECT = `
  SELECT b.*, e.title AS event_title, e.event_date, e.venue, e.city, u.name AS customer_name, u.email AS customer_email
  FROM bookings b
  JOIN events e ON e.id = b.event_id
  JOIN users u ON u.id = b.user_id`;

export function createBookingService({ pool, cache, metrics, cfg, dispatcher, logger }) {
  async function findByIdempotencyKey(key, db = pool) {
    const { rows } = await db.query(`${BOOKING_SELECT} WHERE b.idempotency_key = $1`, [key]);
    return rows[0] ?? null;
  }

  function replayOrConflict(existing, fp) {
    if (existing.request_fingerprint !== fp) {
      metrics.bookings.inc({ outcome: 'idempotency_conflict' });
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
    }
    metrics.bookings.inc({ outcome: 'replayed' });
    return { booking: toBooking(existing), replayed: true };
  }

  /**
   * Reserve inventory + record the booking + enqueue the follow-up work, all or nothing.
   *
   *   BEGIN
   *     upsert user
   *     UPDATE events SET available = available - q WHERE id=$1 AND available >= q   <- atomic, row-locked
   *     INSERT booking (idempotency_key UNIQUE)
   *     INSERT outbox_events
   *   COMMIT
   *
   * Overselling is impossible: the conditional UPDATE takes the row lock, concurrent buyers queue on
   * it, and each re-evaluates `available >= q` against the latest committed value. The CHECK
   * constraint is a second, independent guard.
   */
  async function create({ input, idempotencyKey, requestId, simulate }) {
    const { eventId, quantity, name, email } = input;
    const fp = fingerprint(input);

    const existing = await findByIdempotencyKey(idempotencyKey);
    if (existing) return replayOrConflict(existing, fp);

    let committed;
    try {
      committed = await withTransaction(pool, async (db) => {
        // 1. user (no row lock taken on conflict, so same-user bookings do not serialise)
        let { rows: u } = await db.query(
          'INSERT INTO users (name, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id', [name, email]);
        if (!u[0]) ({ rows: u } = await db.query('SELECT id FROM users WHERE email = $1', [email]));
        const userId = u[0].id;

        // 2. atomic conditional inventory reservation
        const upd = await db.query(
          `UPDATE events
              SET available_capacity = available_capacity - $2,
                  status = CASE WHEN available_capacity - $2 = 0 THEN 'SOLD_OUT' ELSE status END,
                  updated_at = now()
            WHERE id = $1 AND status = 'ON_SALE' AND available_capacity >= $2 AND event_date > now()
        RETURNING ticket_price, category, title`, [eventId, quantity]);

        if (upd.rowCount === 0) {
          const { rows: ev } = await db.query('SELECT status, available_capacity, event_date FROM events WHERE id = $1', [eventId]);
          if (!ev[0]) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found.');
          if (ev[0].status === 'CANCELLED' || new Date(ev[0].event_date) <= new Date()) {
            throw new AppError(409, 'EVENT_NOT_ON_SALE', 'This event is no longer on sale.');
          }
          throw new AppError(409, 'INSUFFICIENT_INVENTORY',
            ev[0].available_capacity === 0 ? 'This event is sold out.' : `Only ${ev[0].available_capacity} ticket(s) remain.`,
            { available: ev[0].available_capacity, requested: quantity });
        }
        const { ticket_price: price, category, title } = upd.rows[0];
        const total = Math.round(price * quantity * 100) / 100;

        // 3. booking row (savepoint lets us retry a (vanishingly unlikely) reference collision)
        let booking;
        for (let attempt = 0; attempt < 3 && !booking; attempt++) {
          await db.query('SAVEPOINT ref');
          try {
            const { rows } = await db.query(
              `INSERT INTO bookings (booking_reference, user_id, event_id, quantity, total_amount, status,
                                     idempotency_key, request_fingerprint, request_id)
               VALUES ($1,$2,$3,$4,$5,'PROCESSING',$6,$7,$8) RETURNING *`,
              [newReference(), userId, eventId, quantity, total, idempotencyKey, fp, requestId]);
            booking = rows[0];
          } catch (err) {
            if (err.code === '23505' && err.constraint === 'bookings_reference_key') { await db.query('ROLLBACK TO SAVEPOINT ref'); continue; }
            throw err;
          }
        }
        if (!booking) throw new AppError(503, 'REFERENCE_GENERATION_FAILED', 'Could not allocate a booking reference. Please retry.');

        // 4. outbox row - same transaction, so a committed booking can never lose its follow-up work
        const payload = { bookingId: booking.id, bookingReference: booking.booking_reference, eventId, quantity, requestId, ...(simulate ? { simulate } : {}) };
        await db.query(
          'INSERT INTO outbox_events (event_type, aggregate_id, payload) VALUES ($1, $2, $3)',
          ['booking.created', booking.id, JSON.stringify(payload)]);

        return { booking, event: { id: eventId, category, title } };
      }, metrics);
    } catch (err) {
      // Two concurrent requests with the same key: the loser violates the UNIQUE constraint and its
      // whole transaction (including its inventory decrement) is rolled back. Serve the winner's row.
      if (err.code === '23505' && err.constraint === 'bookings_idempotency_key_key') {
        const winner = await findByIdempotencyKey(idempotencyKey);
        if (winner) return replayOrConflict(winner, fp);
      }
      if (err instanceof AppError) metrics.bookings.inc({ outcome: err.code === 'INSUFFICIENT_INVENTORY' ? 'rejected_inventory' : 'rejected' });
      else metrics.bookings.inc({ outcome: 'error' });
      throw err;
    }

    metrics.bookings.inc({ outcome: 'accepted' });
    // Post-commit, best effort: the cache is only an optimisation and PostgreSQL stays authoritative.
    await cache.invalidate(keysForEvent(committed.event));
    dispatcher?.kick();

    const full = await findByIdempotencyKey(idempotencyKey);
    logger.info({ requestId, bookingId: committed.booking.id, reference: committed.booking.booking_reference, eventId, quantity }, 'booking accepted');
    return { booking: toBooking(full), replayed: false };
  }

  async function getById(id) {
    const { rows } = await pool.query(`${BOOKING_SELECT} WHERE b.id = $1`, [id]);
    if (!rows[0]) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
    return toBooking(rows[0]);
  }

  async function listByEmail(email) {
    const { rows } = await pool.query(`${BOOKING_SELECT} WHERE u.email = $1 ORDER BY b.created_at DESC LIMIT 50`, [email]);
    return rows.map(toBooking);
  }

  return { create, getById, listByEmail };
}
