import { z } from 'zod';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function bookingSchema(maxQuantity) {
  return z.object({
    eventId: z.string().uuid('eventId must be a valid UUID'),
    quantity: z.number({ error: 'quantity must be a number' }).int('quantity must be a whole number').min(1, 'quantity must be at least 1').max(maxQuantity, `quantity cannot exceed ${maxQuantity}`),
    name: z.string().trim().min(2, 'name must be at least 2 characters').max(100),
    email: z.string().trim().toLowerCase().email('email must be valid').max(200),
  }).strict();
}

const num = (max) => z.coerce.number().min(0).max(max);
const date = z.coerce.date();

export const eventQuerySchema = z.object({
  category: z.string().trim().max(60).optional(),
  city: z.string().trim().max(80).optional(),
  q: z.string().trim().max(100).optional(),
  minPrice: num(1_000_000).optional(),
  maxPrice: num(1_000_000).optional(),
  from: date.optional(),
  to: date.optional(),
  sort: z.enum(['date', 'price-asc', 'price-desc', 'popularity']).optional(),
  availableOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export const emailQuerySchema = z.object({ email: z.string().trim().toLowerCase().email().max(200) });
