import { emptyDashboard } from './helpers';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { docPages } from '../src/docs-pages';

test.beforeEach(async ({ page }) => { await emptyDashboard(page); });

async function setup(page: Page, member = false) {
  const calls: string[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === '/api/session') return route.fulfill({ json: { account: member ? { id: '00000000-0000-4000-8000-000000000001', display_name: 'Product test', role: 'member' } : null, csrf_token: member ? 'fixture-csrf' : null } });
    if (path === '/api/fleet') return route.fulfill({ json: { online_devices: 0, online_operators: 0, online_compute_groups: 0 } });
    if (path === '/api/pairing-info' && member) return route.fulfill({ json: { relay_origin: 'https://relay.example', audience: 'local-test' } });
    if (['/api/incidents', '/api/devices', '/api/site-checks', '/api/reviews', '/api/sources', '/api/orders', '/api/agents'].includes(path)) return route.fulfill({ json: [] });
    return route.fallback();
  });
  return calls;
}

test('public documentation is bookmarkable and never requests private records', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/#/docs/privacy');
  await expect(page.getByRole('heading', { name: 'Who can see your data', exact: true })).toBeVisible();
  const docs = page.getByRole('navigation', { name: 'Documentation' });
  for (const [index, section] of docPages.entries()) {
    await docs.getByRole('button', { name: `${index + 1}. ${section.title}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/docs/${section.id}$`));
    await expect(page.getByRole('heading', { name: section.title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const diagram = page.locator('.docs-diagram img');
  await expect.poll(() => diagram.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 1000)).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Services and boundaries', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Don’t trust. Verify.', exact: true })).toBeVisible();
  expect(calls.filter(path => !['/api/session', '/api/fleet', '/api/incidents', '/api/analytics'].includes(path))).toEqual([]);
  await page.goto('/#/docs/../../admin');
  await expect(page.getByRole('heading', { name: 'BUILD YOUR DEFENSE NETWORK.' })).toBeVisible();
});

test('workspace separates requests and pairing from the public introduction', async ({ page }) => {
  await setup(page, true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hello, Product test.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'BUILD YOUR DEFENSE NETWORK.' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Request an audit', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'A first check. With evidence.' })).toBeVisible();
  await page.getByText('Existing snapshot and source tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Set the scope →', exact: false }).click();
  await expect(page).toHaveURL(/#\/sites$/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Pair an agent', exact: true })).toHaveCount(0);
  await page.goto('/#/guide');
  await expect(page.getByRole('heading', { name: 'Public pairing is not open yet.' })).toBeVisible();
  await page.getByRole('button', { name: 'Patchriot home' }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.getByRole('heading', { name: 'BUILD YOUR DEFENSE NETWORK.' })).toBeVisible();
  await page.getByRole('button', { name: 'OPEN DASHBOARD', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Product test.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('public page uses the supplied logo and access requests remain a deliberate action', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/');
  const logo = page.locator('img.brand-mark');
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Recent hacks & incidents.' })).toBeVisible();
  await page.locator('header').getByRole('button', { name: 'App' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in or request access' });
  await dialog.getByRole('button', { name: 'Request access', exact: true }).click();
  await expect(dialog.getByLabel('Your name')).toBeVisible();
  expect(calls).not.toContain('/api/access-requests');
  await page.keyboard.press('Escape');
  await expect(page.locator('header').getByRole('button', { name: 'App' })).toBeFocused();
  await expect(logo).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the access link reopens account access after closing the sign-in popup', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  const access = page.getByRole('region', { name: 'Account access' });
  const contribute = page.locator('.access-invitation').getByRole('button', { name: 'Request access', exact: false });
  await contribute.click();
  await expect(access.getByLabel('Your name')).toBeVisible();
  await access.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(access.getByLabel('Username', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await contribute.click();
  await expect(access.getByLabel('Your name')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Sign in or request access' })).toBeVisible();
});

test('members cannot load connection details or open a pairing dialog', async ({ page }) => {
  const calls = await setup(page, true);
  await page.goto('/#/guide');
  await expect(page.getByRole('heading', { name: 'Public pairing is not open yet.' })).toBeVisible();
  expect(calls).not.toContain('/api/pairing-info');
  expect(calls).not.toContain('/api/pairings/claim');
  await page.goto('/#/devices');
  await expect(page.getByRole('button', { name: 'Pair a relay +', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls).not.toContain('/api/pairing-info');
});
