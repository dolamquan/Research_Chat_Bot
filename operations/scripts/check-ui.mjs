import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core'); }
catch (error) {
  if (process.env.PLAYWRIGHT_MODULE) throw error;
  const links = path.join(homedir(), 'AppData/Local/ms-playwright/.links');
  for (const entry of await readdir(links).catch(() => [])) {
    try { playwright = require((await readFile(path.join(links, entry), 'utf8')).trim()); break; } catch {}
  }
  if (!playwright) throw new Error('Install playwright-core for browser checks, or set PLAYWRIGHT_MODULE to an existing installation.');
}
const { chromium } = playwright;
const base = process.env.OPS_URL || 'http://127.0.0.1:5174';
const output = fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1512, height: 1050 } });
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(`${base}/?demo=1`);
  await page.getByRole('heading', { name: 'Your research, at a glance.' }).waitFor();
  await page.locator('.spend-chart .recharts-surface').waitFor();
  assert.match(await page.locator('.metric-main').first().innerText(), /\$[1-9]/);
  await page.screenshot({ path: `${output}/overview-desktop.png`, fullPage: true });
  await page.locator('.model-legend button').first().click();
  await page.getByRole('heading', { name: 'Follow every call.' }).waitFor();
  assert.equal(await page.getByLabel('Operation type').inputValue(), 'llm');
  assert.equal(await page.locator('tbody tr').count(), 25);
  const firstCall = await page.locator('tbody tr').first().innerText();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  assert.notEqual(await page.locator('tbody tr').first().innerText(), firstCall);
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.locator('tbody tr .call-name').first().click();
  const drawer = page.getByRole('dialog');
  await drawer.waitFor();
  assert.ok(await drawer.locator('.timeline-row').count() >= 3);
  await drawer.getByRole('tab', { name: 'Call details' }).click();
  await drawer.getByText('Cached input tokens', { exact: true }).waitFor();
  await page.screenshot({ path: `${output}/call-inspector.png` });
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Search calls, models, users').fill('alex.rivera');
  await page.waitForTimeout(400);
  assert.ok(await page.locator('tbody tr').count() > 0);
  const users = await page.locator('.user-cell').allTextContents();
  assert.ok(users.every(u => u.includes('alex.rivera')));
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Call status').selectOption('error');
  assert.ok(await page.locator('tbody tr').count() > 0);
  assert.ok((await page.locator('tbody .status').allTextContents()).every(s => s === 'Failed'));
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
  assert.equal(download.suggestedFilename(), 'sample-research-ops-calls.csv');
  await page.getByRole('button', { name: 'Cost explorer', exact: true }).click();
  await page.getByRole('heading', { name: 'Every token, accounted for.' }).waitFor();
  await page.screenshot({ path: `${output}/cost-explorer.png`, fullPage: true });
  await page.getByRole('button', { name: 'Issues', exact: false }).first().click();
  const before = await page.locator('.issue-card').count();
  assert.ok(before > 0);
  await page.getByRole('button', { name: 'Mark resolved' }).first().click();
  await page.waitForFunction(expected => document.querySelectorAll('.issue-card').length === expected, before - 1);
  assert.equal(await page.locator('.issue-card').count(), before - 1);
  await page.getByLabel('Show resolved').check();
  await page.waitForFunction(expected => document.querySelectorAll('.issue-card').length === expected, before);
  assert.equal(await page.locator('.issue-card').count(), before);
  await page.getByRole('button', { name: 'Reopen issue' }).click();
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await page.getByRole('heading', { name: 'Know your workspace.' }).waitFor();
  await page.locator('.user-name').first().click();
  assert.notEqual(await page.getByLabel('User filter').inputValue(), '');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Monthly budget (USD)').fill('150');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByRole('status').filter({ hasText: 'Sample settings updated' }).waitFor();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  assert.match(await page.locator('.budget-amount').innerText(), /150/);
  await page.getByLabel('Time period').selectOption('1');
  await page.getByText('Today · UTC · estimated USD').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${output}/overview-mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Overview overflows the mobile viewport');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Calls & traces', exact: true }).click();
  assert.equal(await page.locator('.sidebar.mobile-open').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  // Exercise real-data UI states without calling providers or a production API.
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { mode: 'disabled' } });
    if (path === '/api/ops/identity') return route.fulfill({ status: 403, json: { detail: 'Administrator access required.' } });
    return route.fulfill({ status: 500, json: { detail: 'Unexpected request' } });
  });
  await page.goto(base);
  await page.getByText('Administrator access required.').waitFor();
  await page.screenshot({ path: `${output}/admin-access.png` });
  await page.unroute('**/api/**');
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { detail: 'Backend temporarily unavailable.' } }));
  await page.goto(base);
  await page.getByText('Backend temporarily unavailable.').waitFor();
  await page.getByRole('link', { name: 'Explore with sample data' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: charts, filters, pagination, inspector, search, export, issues, users, settings, mobile, admin rejection and backend outage.');
} finally { await browser.close(); }
