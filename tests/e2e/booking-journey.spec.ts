import { test, expect, type APIRequestContext } from '@playwright/test';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN ?? 'test-admin-token-local-only', 'X-Client-Id': `e2e-admin-${Date.now()}` };

async function resetTestEvent(request: APIRequestContext, capacity: number) {
  const r = await request.post(`${GATEWAY}/api/admin/test-event/reset`, { headers: ADMIN, data: { capacity } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).data as { eventId: string };
}

test.describe('customer journey', () => {
  test('browse → details → book → worker confirms → status survives a page reload', async ({ page, request }) => {
    const email = `e2e+${Date.now()}@example.com`;

    // 1. open the app and browse real events from the database
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Zero oversells/i })).toBeVisible();
    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(10);

    // 2. open an event
    const title = (await cards.nth(2).locator('h3').innerText()).trim();
    await cards.nth(2).getByRole('link', { name: 'Details', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

    // 3. choose quantity
    await page.getByRole('button', { name: 'Increase quantity' }).click();
    await expect(page.locator('output')).toHaveText('2');
    await page.getByRole('link', { name: /Book 2 tickets/ }).click();

    // 4. fill the booking form and confirm
    await expect(page.getByRole('heading', { name: 'Complete your booking' })).toBeVisible();
    await page.getByLabel('Full name').fill('Playwright Tester');
    await page.getByLabel(/^Email/).fill(email);
    await page.getByRole('button', { name: 'Review booking' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Book 2 tickets/ }).click();

    // 5. receive a booking reference, watch the async lifecycle finish
    const ref = page.locator('p.num', { hasText: /^FS-[A-Z2-9]{8}$/ });
    await expect(ref).toBeVisible();
    const reference = (await ref.innerText()).trim();
    await expect(page.getByText("You're going!")).toBeVisible({ timeout: 30_000 });

    // 6. My bookings shows it as CONFIRMED, and it is still there after a reload (persisted in PostgreSQL)
    await page.goto('/bookings');
    await expect(page.getByText(reference)).toBeVisible();
    await expect(page.getByText('CONFIRMED').first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(reference)).toBeVisible();
    await expect(page.getByText('CONFIRMED').first()).toBeVisible();

    // 7. the backend agrees
    const api = await request.get(`${GATEWAY}/api/bookings?email=${encodeURIComponent(email)}`, { headers: { 'X-Client-Id': `e2e-${Date.now()}` } });
    const rows = (await api.json()).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reference, status: 'CONFIRMED', quantity: 2 });
  });

  test('form validation blocks bad input and shows accessible errors', async ({ page, request }) => {
    const { eventId } = await resetTestEvent(request, 5);
    await page.goto(`/events/${eventId}/book?qty=1`);
    await page.getByLabel('Full name').fill('A');
    await page.getByLabel(/^Email/).fill('not-an-email');
    await page.getByRole('button', { name: 'Review booking' }).click();
    await expect(page.getByText('Enter your full name (at least 2 characters).')).toBeVisible();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    await expect(page.getByLabel('Full name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('quantity cannot exceed availability, and a sold-out event cannot be booked', async ({ page, request }) => {
    const { eventId } = await resetTestEvent(request, 2);
    await page.goto(`/events/${eventId}`);
    await expect(page.getByText('2 of 2 left')).toBeVisible();
    const plus = page.getByRole('button', { name: 'Increase quantity' });
    await plus.click();
    await expect(page.locator('output')).toHaveText('2');
    await expect(plus).toBeDisabled();

    // sell the remaining tickets through the API, then reload: UI must show sold out
    const key = `e2e-soldout-${Date.now()}-abcdef`;
    const r = await request.post(`${GATEWAY}/api/bookings`, { headers: { 'Idempotency-Key': key, 'X-Client-Id': `e2e-${Date.now()}` }, data: { eventId, quantity: 2, name: 'Sold Out', email: `so+${Date.now()}@example.com` } });
    expect(r.status()).toBe(202);
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sold out' })).toBeDisabled();
  });

  test('stale page: booking more than what is left shows a clear failure and keeps the form usable', async ({ page, request }) => {
    const { eventId } = await resetTestEvent(request, 3);
    await page.goto(`/events/${eventId}/book?qty=3`);   // page loaded while 3 tickets are available
    await expect(page.getByRole('heading', { name: 'Complete your booking' })).toBeVisible();
    // someone else takes 2 tickets in the meantime
    const r = await request.post(`${GATEWAY}/api/bookings`, { headers: { 'Idempotency-Key': `e2e-race-${Date.now()}-abcdef`, 'X-Client-Id': `e2e-${Date.now()}` }, data: { eventId, quantity: 2, name: 'Racer One', email: `race+${Date.now()}@example.com` } });
    expect(r.status()).toBe(202);
    await page.getByLabel('Full name').fill('Late Buyer');
    await page.getByLabel(/^Email/).fill(`late+${Date.now()}@example.com`);
    await page.getByRole('button', { name: 'Review booking' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Book 3 tickets/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Booking not completed' })).toContainText('Only 1 ticket(s) remain.');
    await expect(page.getByRole('button', { name: 'Review booking' })).toBeEnabled();
  });
});

test.describe('discovery', () => {
  test('search, category filter, sorting and saved events', async ({ page }) => {
    await page.goto('/');
    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible();
    const total = await cards.count();

    await page.getByLabel('Search events').fill('jazz');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Monsoon Jazz Night');
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(cards).toHaveCount(total);

    await page.getByRole('button', { name: /^Sports/ }).click();
    await expect(cards.first()).toBeVisible();
    for (const c of await cards.all()) await expect(c).toContainText('Sports');
    await page.getByRole('button', { name: 'All', exact: true }).click();

    await page.getByLabel('Sort by').selectOption('price-asc');
    await expect(cards.first()).toContainText('₹149');

    // save an event; it persists across reload
    const first = cards.first();
    const name = (await first.locator('h3').innerText()).trim();
    await first.getByRole('button', { name: /^Save / }).click();
    await page.reload();
    await page.getByRole('button', { name: /^Saved/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText(name);
    await cards.first().getByRole('button', { name: /^Remove / }).click();
    await expect(page.getByText('No saved events yet')).toBeVisible();
  });

  test('layout works on a phone viewport with a working mobile menu', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.locator('article').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('link', { name: 'System monitor' }).click();
    await expect(page.getByRole('heading', { name: 'System monitor' })).toBeVisible();
  });
});
