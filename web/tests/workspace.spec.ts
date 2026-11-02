import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { emptyDashboard } from './helpers';

const owner = { id: '00000000-0000-4000-8000-000000000001', display_name: 'Workspace owner', role: 'admin' };
const siteId = '00000000-0000-4000-8000-000000000002';
const runId = '00000000-0000-4000-8000-000000000003';
const sourceId = '00000000-0000-4000-8000-000000000004';
const timestamp = 1793448000;

async function setup(page: Page) {
  await emptyDashboard(page);
  await page.route('**/api/session', route => route.fulfill({ json: { account: owner, csrf_token: 'fixture-csrf' } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 3, online_operators: 2, online_compute_groups: 2 } }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
}

test('personal audits join material to its latest report while staff records stay in their own desk', async ({ page }) => {
  await setup(page);
  const reads: string[] = [];
  const run = { id: runId, mode: 'website_agent', state: 'running', created_at: timestamp + 2, steps: [{ state: 'completed' }, { state: 'running' }, { state: 'waiting' }], website: { site_check_id: siteId } };
  const site = { id: siteId, scope: { homepage: 'https://owned.example/' }, state: 'collected', created_at: timestamp };
  const source = { id: sourceId, title: 'My payment module', state: 'pending_approval', created_at: timestamp + 1 };
  await page.route(/\/api\/(reviews|site-checks|sources)\?scope=(mine|all)$/, route => {
    const url = new URL(route.request().url()); reads.push(url.pathname + url.search);
    if (url.pathname === '/api/reviews') return route.fulfill({ json: [run, { ...run, id: '00000000-0000-4000-8000-000000000005', state: 'cancelled', created_at: timestamp - 1 }] });
    if (url.pathname === '/api/sources') return route.fulfill({ json: [source] });
    return route.fulfill({ json: url.searchParams.get('scope') === 'all' ? [site, { ...site, id: '00000000-0000-4000-8000-000000000006', scope: { homepage: 'https://staff-only.example/' } }] : [site] });
  });
  await page.goto('/?design=signal#/overview');
  await expect(page.locator('.recent-work .audit-row')).toHaveCount(2);
  await expect(page.getByLabel('1 of 3 role reports received')).toBeVisible();
  await expect(page.locator('.recent-work .card-note')).toContainText('2 recent audits in your account.');
  await expect(page.getByText('https://staff-only.example/', { exact: true })).toHaveCount(0);
  expect(reads.every(path => path.endsWith('?scope=mine'))).toBe(true);
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Audits', exact: true }).click();
  await expect(page.locator('.audit-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Source code', exact: true }).click();
  await expect(page.locator('.audit-row')).toHaveCount(1);
  await expect(page.getByText('My payment module', { exact: true })).toBeVisible();
  await page.getByText('Administration', { exact: true }).click();
  await page.getByRole('button', { name: 'Audit approvals', exact: true }).click();
  await expect(page.getByText('https://staff-only.example/', { exact: true })).toBeVisible();
  expect(reads.some(path => path.endsWith('?scope=all'))).toBe(true);
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await expect(page.locator('.recent-work .audit-row')).toHaveCount(2);
  await expect(page.getByText('https://staff-only.example/', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('dashboard puts older decisions ahead of ready reports and newer running work', async ({ page }) => {
  await setup(page);
  const rows = [
    { id: 'running', state: 'running', created_at: timestamp + 30 },
    { id: 'completed', state: 'completed', created_at: timestamp + 20 },
    { id: 'needs-review', state: 'needs_review', created_at: timestamp },
    { id: 'payment', state: 'awaiting_payment', created_at: timestamp - 10 },
    { id: 'cancelled', state: 'cancelled', created_at: timestamp + 40 },
    { id: 'failed', state: 'failed', created_at: timestamp - 20 },
  ].map(item => ({ ...item, mode: 'source_agent', steps: [] }));
  await page.route('**/api/reviews?scope=mine', route => route.fulfill({ json: rows }));
  await page.goto('/#/overview');
  const work = page.locator('.recent-work');
  await expect(work.getByRole('heading', { name: 'What needs your attention?' })).toBeVisible();
  await expect(work.locator('.audit-state .status-chip')).toHaveText(['Needs attention', 'Awaiting payment', 'Incomplete', 'Report ready', 'Agents working']);
  await expect(page.getByLabel('Workspace summary')).toHaveText('3Need attention1Reports ready1In progress');
  expect((await work.boundingBox())!.y).toBeLessThan((await page.getByLabel('Workspace summary').boundingBox())!.y);
  await work.locator('.audit-title').first().click();
  await expect(page).toHaveURL(/#\/reviews\/needs-review$/);
});

test('unavailable personal data is not reported as zero earnings or an empty audit history', async ({ page }) => {
  await setup(page);
  let failed = true;
  await page.route('**/api/reviews?scope=mine', route => route.fulfill(failed ? { status: 503, json: { error: 'dispatcher_unavailable' } } : { json: [] }));
  await page.route('**/api/withdrawals', route => route.fulfill(failed ? { status: 503, json: { error: 'database_unavailable' } } : { json: { balance: { available: '12500000', earned: '12500000', reserved: '0', paid: '0' } } }));
  await page.goto('/#/overview');
  await expect(page.getByRole('alert').filter({ hasText: 'Earnings could not refresh' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Audits could not fully refresh' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Your available earnings' })).toContainText('—');
  await expect(page.getByText('A fresh pair of eyes.', { exact: true })).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: 'Retry earnings', exact: true }).click();
  await page.getByRole('button', { name: 'Retry audits', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Your available earnings' })).toContainText('12.5');
  await expect(page.getByText('A fresh pair of eyes.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('pairing uses the configured address, warns for loopback and shell-quotes its audience', async ({ page }) => {
  await setup(page);
  await page.route('**/api/pairing-info', route => route.fulfill({ json: { relay_origin: 'http://127.0.0.1:7511', audience: "operator's pilot" } }));
  await page.goto('/?design=terminal&relay=https://untrusted.example#/guide');
  await page.getByRole('navigation', { name: 'Pairing steps' }).getByRole('button', { name: '3 Connect', exact: true }).click();
  await expect(page.locator('.connection-address')).toContainText('http://127.0.0.1:7511');
  await expect(page.locator('.pair-command pre')).toContainText("--audience 'operator'\\''s pilot'");
  await expect(page.locator('.pair-command pre')).not.toContainText('untrusted.example');
  await expect(page.getByText('This is a local address.', { exact: false })).toContainText('administrator-configured tunnel');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('private pairing explains Tailscale admission separately from device approval', async ({ page }) => {
  await setup(page);
  await page.route('**/api/pairing-info', route => route.fulfill({ json: { relay_origin: 'https://dispatcher.example-tail.ts.net', audience: 'private-team' } }));
  await page.goto('/#/guide');
  await page.getByRole('navigation', { name: 'Pairing steps' }).getByRole('button', { name: '3 Connect', exact: true }).click();
  await expect(page.locator('.connection-address')).toContainText('Private Tailscale connection');
  await expect(page.locator('.pair-note').filter({ hasText: 'Join the private network first.' })).toContainText('mesh-check --dispatcher');
  await expect(page.locator('.pair-note').filter({ hasText: 'Join the private network first.' })).toContainText('tailscale status');
  await expect(page.locator('.pair-command').filter({ hasText: './patchriot-relay init' })).toContainText("--audience 'private-team'");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
