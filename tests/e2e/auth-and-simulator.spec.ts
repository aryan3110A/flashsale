import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN ?? 'test-admin-token-local-only', 'X-Client-Id': `e2e-admin-${Date.now()}` };
const PASSWORD = 'correct-horse-9';

async function resetTestEvent(request: APIRequestContext, capacity: number) {
  const r = await request.post(`${GATEWAY}/api/admin/test-event/reset`, { headers: ADMIN, data: { capacity } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).data as { eventId: string };
}

async function signUp(page: Page, name: string, email: string) {
  await page.goto('/signup');
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('nav-user')).toHaveText(name);
}

test.describe('accounts', () => {
  test('sign up, stay logged in across reload, log out, log back in', async ({ page }) => {
    const email = `e2e-auth-${Date.now()}@example.com`;
    await signUp(page, 'Asha Rao', email);
    await expect(page).toHaveURL('/');

    await page.reload();                                                    // session survives a reload
    await expect(page.getByTestId('nav-user')).toHaveText('Asha Rao');

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible(); // logout is real, not cosmetic

    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByTestId('nav-user')).toHaveText('Asha Rao');
  });

  test('wrong password and unknown email show the same generic error', async ({ page }) => {
    const email = `e2e-auth-wrong-${Date.now()}@example.com`;
    await signUp(page, 'Wrong Pass', email);
    await page.getByRole('button', { name: 'Log out' }).click();

    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('not-the-password-1');
    await page.getByRole('button', { name: 'Log in' }).click();
    const err = page.getByTestId('auth-error');
    await expect(err).toContainText('Incorrect email or password.');
    const first = await err.textContent();

    await page.getByLabel('Email').fill(`nobody-${Date.now()}@example.com`);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(err).toContainText('Incorrect email or password.');
    expect(await err.textContent()).toBe(first);
    await expect(page.getByTestId('nav-user')).toHaveCount(0);
  });

  test('sign-up form validates in the browser and shows the password rules', async ({ page }) => {
    await page.goto('/signup');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Enter your full name (at least 2 characters).')).toBeVisible();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill('abc');
    await expect(page.getByLabel('Password rules')).toContainText('At least 8 characters (not met)');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await expect(page.getByLabel('Password rules')).toContainText('A digit (met)');
    await page.getByLabel('Confirm password').fill('different-1');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Passwords do not match.')).toBeVisible();
  });

  test('duplicate e-mail is refused with a pointer to log in', async ({ page }) => {
    const email = `e2e-dup-${Date.now()}@example.com`;
    await signUp(page, 'First Owner', email);
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.goto('/signup');
    await page.getByLabel('Full name').fill('Someone Else');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('another-pass-1');
    await page.getByLabel('Confirm password').fill('another-pass-1');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByTestId('auth-error')).toContainText('already exists');
  });

  test('"next" returns you to the page you came from, but never to another site', async ({ page }) => {
    const email = `e2e-next-${Date.now()}@example.com`;
    await signUp(page, 'Next Tester', email);
    await page.getByRole('button', { name: 'Log out' }).click();

    await page.goto('/login?next=%2Fbookings');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/bookings$/);
    await page.getByRole('button', { name: 'Log out' }).click();

    await page.goto('/login?next=%2F%2Fevil.example.com');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByTestId('nav-user')).toBeVisible();
    expect(new URL(page.url()).host).toBe(new URL(process.env.WEB_URL ?? 'http://localhost:3000').host);
  });

  test('a logged-in user books as their account and sees the booking in My bookings without typing an email', async ({ page, request }) => {
    const ev = await resetTestEvent(request, 10);
    const email = `e2e-acct-book-${Date.now()}@example.com`;
    await signUp(page, 'Account Holder', email);

    await page.goto(`/events/${ev.eventId}/book`);
    await expect(page.getByTestId('booking-as')).toContainText('Account Holder');
    await expect(page.getByLabel('Full name')).toHaveAttribute('readonly', '');
    await expect(page.getByLabel(/^Email/)).toHaveValue(email);
    await page.getByRole('button', { name: 'Review booking' }).click();
    await page.getByRole('button', { name: /^Book 1 ticket/ }).click();
    await expect(page.getByText("You're going!")).toBeVisible({ timeout: 30_000 });

    await page.goto('/bookings');
    await expect(page.getByTestId('signed-in-as')).toContainText('Account Holder');
    await expect(page.getByLabel('Email used for booking')).toHaveCount(0);
    await expect(page.getByText('CONFIRMED')).toBeVisible({ timeout: 20_000 });
  });

  test('login and sign-up fit a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ['/login', '/signup']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });
});

test.describe('live flash-sale simulator', () => {
  test('10 users x 10 tickets for 50: charts fill, exactly 5 win, nothing oversold, services panel shows the stack', async ({ page }) => {
    await page.goto('/simulator');
    await expect(page.getByRole('heading', { name: 'Flash-sale simulator' })).toBeVisible();
    await page.getByLabel('Virtual users').fill('10');
    await page.getByLabel('Tickets per user').fill('10');
    await page.getByLabel('Clicks per user').fill('8');
    await page.getByLabel('Tickets on sale').fill('50');
    await page.getByTestId('sim-start').click();

    await expect(page.getByTestId('sim-phase')).toContainText('Finished', { timeout: 90_000 });
    await expect(page.getByTestId('stock-left')).toContainText('0');
    await expect(page.getByTestId('stock-card')).toContainText('SOLD_OUT');

    const verdict = page.getByTestId('sim-verdict');
    await expect(verdict).toBeVisible();
    await expect(verdict.getByLabel('passed')).toHaveCount(4);
    await expect(verdict.getByLabel('failed')).toHaveCount(0);
    await expect(page.getByText('5 of 10 got tickets')).toBeVisible();
    await expect(page.getByTestId('sim-users').getByText('got tickets', { exact: true })).toHaveCount(5);
    await expect(page.getByTestId('sim-users').getByText('sold out', { exact: true })).toHaveCount(5);
    await expect(page.getByTestId('sim-users').getByText('CONFIRMED')).toHaveCount(5);

    // charts rendered (recharts draws SVG) and the live services panel is populated
    await expect(page.locator('.recharts-wrapper')).toHaveCount(3);
    for (const svc of ['gateway', 'booking-api', 'postgres', 'redis', 'worker']) {
      await expect(page.getByTestId(`svc-${svc}`)).toContainText('healthy');
    }
  });

  test('raw flood without retries: the gateway sheds load with 429s and the data is still consistent', async ({ page }) => {
    await page.goto('/simulator');
    await page.getByLabel('Virtual users').fill('20');
    await page.getByLabel('Tickets per user').fill('10');
    await page.getByLabel('Clicks per user').fill('20');
    await page.getByLabel('Tickets on sale').fill('50');
    await page.getByRole('radio', { name: 'Raw flood (no retry)' }).click();
    await expect(page.getByRole('radio', { name: 'Raw flood (no retry)' })).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('sim-start').click();

    await expect(page.getByTestId('sim-phase')).toContainText('Finished', { timeout: 90_000 });
    const verdict = page.getByTestId('sim-verdict');
    await expect(verdict.getByLabel('failed')).toHaveCount(0);
    const limited = page.locator('div.card', { hasText: 'Rate limited (429)' }).filter({ hasText: 'gateway shed the load' }).first();
    const n = Number((await limited.locator('.num').first().textContent())?.replace(/,/g, ''));
    expect(n).toBeGreaterThan(0);                                          // 400 requests in a burst cannot all fit the bucket
  });

  test('simulator and monitor pages fit a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/simulator');
    await expect(page.getByRole('heading', { name: 'Flash-sale simulator' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
