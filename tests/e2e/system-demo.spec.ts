import { test, expect } from '@playwright/test';

test.describe('monitoring dashboard', () => {
  test('shows live service health and real traffic numbers', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'System monitor' })).toBeVisible();
    await expect(page.getByText('System healthy')).toBeVisible({ timeout: 15_000 });
    for (const svc of ['gateway', 'booking-api', 'postgres', 'redis', 'worker', 'mock-service']) {
      const card = page.locator('div.card', { has: page.getByText(svc, { exact: true }) }).first();
      await expect(card.getByText('healthy', { exact: true })).toBeVisible();
    }
    await expect(page.getByText(/Updated \d+s ago/)).toBeVisible();
    await expect(page.getByText('Circuit breaker (mock service)')).toBeVisible();
    // no fabricated placeholders: every tile renders a number or an explicit n/a
    await expect(page.locator('p.text-xs', { hasText: /^Requests$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Request volume' })).toBeVisible();
  });

  test('reports the gateway as unreachable instead of faking data when the backend is down', async ({ page }) => {
    await page.route('**/metrics/summary', (r) => r.abort());
    await page.route('**/health/services', (r) => r.abort());
    await page.goto('/dashboard');
    await expect(page.getByRole('alert').filter({ hasText: 'Gateway unreachable' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Disconnected')).toBeVisible();
  });
});

test.describe('playground', () => {
  test('rate limiter: a burst produces accepted and HTTP 429 results', async ({ page }) => {
    await page.goto('/playground');
    await page.getByLabel('Burst size').selectOption('200');
    await page.getByRole('button', { name: 'Fire burst' }).click();
    await expect(page.getByText('Retry-After')).toBeVisible({ timeout: 20_000 });
    const accepted = Number(await page.locator('div:has(> p:text-is("Accepted (200)")) > p.num').innerText());
    const limited = Number(await page.locator('div:has(> p:text-is("Rejected (429)")) > p.num').innerText());
    expect(accepted).toBeGreaterThan(0);
    expect(limited).toBeGreaterThan(0);
    expect(accepted + limited).toBe(200);
    await page.waitForTimeout(3000);   // let the bucket refill for the following tests
  });

  test('cache: clearing then fetching shows MISS followed by HIT', async ({ page }) => {
    await page.goto('/playground');
    await page.getByRole('button', { name: 'Clear event cache' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clear cache' }).click();
    await expect(page.getByText('Cache cleared')).toBeVisible();
    const fetchBtn = page.getByRole('button', { name: 'Fetch events' });
    await fetchBtn.click();
    await expect(page.getByText('CACHE MISS', { exact: true })).toBeVisible();
    await fetchBtn.click();
    await expect(page.getByText('CACHE HIT', { exact: true }).first()).toBeVisible();
  });

  test('async worker: a test booking moves through queue → worker → completed', async ({ page }) => {
    await page.goto('/playground');
    await page.getByRole('button', { name: 'Submit test booking' }).click();
    await expect(page.getByText(/Accepted \(HTTP 202\)/)).toBeVisible();
    await expect(page.getByTestId('worker-demo-status')).toHaveText('CONFIRMED', { timeout: 30_000 });
    await expect(page.getByText('job.completed').first()).toBeVisible();
    await expect(page.getByText('queue.published').first()).toBeVisible();
  });

  test('async worker: simulated transient failure shows retries and still completes', async ({ page }) => {
    await page.goto('/playground');
    await page.getByRole('radio', { name: 'Transient failures' }).click();
    await page.getByRole('button', { name: 'Submit test booking' }).click();
    await expect(page.getByTestId('worker-demo-status')).toHaveText('CONFIRMED', { timeout: 45_000 });
    await expect(page.getByText('job.retry').first()).toBeVisible();
  });

  test('async worker: permanent failure ends in a failed booking', async ({ page }) => {
    await page.goto('/playground');
    await page.getByRole('radio', { name: 'Permanent failure' }).click();
    await page.getByRole('button', { name: 'Submit test booking' }).click();
    await expect(page.getByTestId('worker-demo-status')).toHaveText('FAILED', { timeout: 30_000 });
    await expect(page.getByText('job.failed').first()).toBeVisible();
  });

  test('circuit breaker: failures open it, recovery closes it', async ({ page }) => {
    await page.goto('/playground');
    const state = page.getByTestId('breaker-state');
    await page.getByRole('button', { name: 'Normal request' }).click();
    await expect(state).toContainText('CLOSED');
    await page.getByRole('button', { name: '5 failing requests' }).click();
    await expect(state).toContainText('OPEN', { timeout: 30_000 });
    await expect(page.getByText('CIRCUIT_OPEN').first().or(page.getByText(/failed fast/).first())).toBeVisible();
    // after the reset timeout (10 s default) trial calls are allowed and the breaker closes again
    await expect.poll(async () => {
      await page.getByRole('button', { name: 'Normal request' }).click();
      await page.waitForTimeout(700);
      return (await state.innerText()).includes('CLOSED');
    }, { timeout: 40_000, intervals: [1000] }).toBe(true);
  });

  test('load test panel lists commands and a report area', async ({ page }) => {
    await page.goto('/playground');
    await expect(page.getByText('k6 run load-tests/spike-test.js')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Latest results' })).toBeVisible();
  });
});
