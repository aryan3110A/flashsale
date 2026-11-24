// Captures screenshots of every page for visual inspection: node tests/helpers/screenshots.mjs <outDir>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const errors = [];
for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  for (const [p, file] of [['/', 'home'], ['/dashboard', 'dashboard'], ['/playground', 'playground'], ['/bookings', 'bookings']]) {
    await page.goto(base + p, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${name}-${file}.png`, fullPage: name === 'desktop' && file !== 'home' });
  }
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.locator('a[href^="/events/"]').first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}-event.png` });
  await ctx.close();
}
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
