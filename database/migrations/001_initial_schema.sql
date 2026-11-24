-- FlashSale schema v1: users, events, bookings, transactional outbox.
-- UUIDs use gen_random_uuid() (built into PostgreSQL 13+, no extension needed).

CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL CHECK (char_length(btrim(name)) >= 2),
  email       TEXT        NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)
);

CREATE TABLE events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                TEXT          NOT NULL,
  title               TEXT          NOT NULL,
  description         TEXT          NOT NULL DEFAULT '',
  category            TEXT          NOT NULL,
  venue               TEXT          NOT NULL,
  city                TEXT          NOT NULL,
  event_date          TIMESTAMPTZ   NOT NULL,
  image_url           TEXT,
  ticket_price        NUMERIC(10,2) NOT NULL CHECK (ticket_price >= 0),
  total_capacity      INTEGER       NOT NULL CHECK (total_capacity > 0),
  available_capacity  INTEGER       NOT NULL,
  status              TEXT          NOT NULL DEFAULT 'ON_SALE' CHECK (status IN ('ON_SALE', 'SOLD_OUT', 'CANCELLED')),
  is_featured         BOOLEAN       NOT NULL DEFAULT FALSE,
  is_test             BOOLEAN       NOT NULL DEFAULT FALSE,   -- hidden from public listings; used by tests / demos
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT events_slug_key UNIQUE (slug),
  -- The hard guarantee behind "never oversell": the database itself refuses a negative or
  -- larger-than-capacity inventory, regardless of what application code does.
  CONSTRAINT events_capacity_range CHECK (available_capacity >= 0 AND available_capacity <= total_capacity)
);
CREATE INDEX events_public_listing_idx ON events (event_date) WHERE is_test = FALSE;
CREATE INDEX events_category_idx ON events (category) WHERE is_test = FALSE;
CREATE INDEX events_city_idx ON events (city) WHERE is_test = FALSE;
CREATE INDEX events_featured_idx ON events (event_date) WHERE is_featured AND is_test = FALSE;

CREATE TABLE bookings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_reference    TEXT          NOT NULL,
  user_id              UUID          NOT NULL REFERENCES users (id),
  event_id             UUID          NOT NULL REFERENCES events (id),
  quantity             INTEGER       NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  total_amount         NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
  status               TEXT          NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'CONFIRMED', 'FAILED')),
  idempotency_key      TEXT          NOT NULL,
  request_fingerprint  TEXT          NOT NULL,   -- hash of (event, quantity, email): detects key reuse with a different payload
  failure_reason       TEXT,
  request_id           TEXT,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  confirmed_at         TIMESTAMPTZ,
  CONSTRAINT bookings_reference_key UNIQUE (booking_reference),
  CONSTRAINT bookings_idempotency_key_key UNIQUE (idempotency_key)
);
CREATE INDEX bookings_user_created_idx ON bookings (user_id, created_at DESC);
CREATE INDEX bookings_event_idx ON bookings (event_id);
CREATE INDEX bookings_status_idx ON bookings (status) WHERE status = 'PROCESSING';

-- Transactional outbox: written in the SAME transaction as the booking, published to BullMQ later.
CREATE TABLE outbox_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type       TEXT        NOT NULL,
  aggregate_id     UUID        NOT NULL,
  payload          JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
  attempts         INTEGER     NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at     TIMESTAMPTZ
);
CREATE INDEX outbox_pending_idx ON outbox_events (next_attempt_at, created_at) WHERE status = 'PENDING';
CREATE INDEX outbox_aggregate_idx ON outbox_events (aggregate_id);
