import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { docPages } from '../src/docs-pages';

async function setup(page: Page, member = false) {
  const calls: string[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === '/api/session') return route.fulfill({ json: { account: member ? { id: '00000000-0000-4000-8000-000000000001', display_name: 'Product test', role: 'member' } : null, csrf_token: member ? 'fixture-csrf' : null } });
    if (path === '/api/fleet') return route.fulfill({ json: { online_devices: 0, online_operators: 0, online_compute_groups: 0 } });
    if (path === '/api/pairing-info' && member) return route.fulfill({ json: { relay_origin: 'https://relay.example', audience: 'local-test' } });
    if (['/api/incidents', '/api/devices', '/api/site-checks'].includes(path)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  return calls;
}

test('public documentation is bookmarkable and never requests private records', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/#/docs/privacy');
  await expect(page.getByRole('heading', { name: 'Who can see your data', exact: true })).toBeVisible();
  const docs = page.getByRole('navigation', { name: 'Documentation' });
  for (const section of docPages) {
    await docs.getByRole('button', { name: section.title, exact: true }).click();
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
  expect(calls.every(path => ['/api/session', '/api/fleet', '/api/incidents'].includes(path))).toBe(true);
  await page.goto('/#/docs/../../admin');
  await expect(page.getByRole('heading', { name: 'More defenders. Fewer blind spots.' })).toBeVisible();
});

test('workspace separates requests and pairing from the public introduction', async ({ page }) => {
  await setup(page, true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What are we checking?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'More defenders. Fewer blind spots.' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start a request →' }).click();
  await expect(page.getByRole('heading', { name: 'Start with a clear scope.' })).toBeVisible();
  await page.getByRole('button', { name: 'Set the website scope', exact: false }).click();
  await expect(page).toHaveURL(/#\/sites$/);
  await page.getByRole('button', { name: 'Pair an agent', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect a machine you control.' })).toBeVisible();
  await page.getByRole('button', { name: 'Patchriot home' }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.getByRole('heading', { name: 'More defenders. Fewer blind spots.' })).toBeVisible();
  await page.getByRole('button', { name: 'Open workspace →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What are we checking?' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('public page uses the supplied logo and access requests remain a deliberate action', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/');
  const logo = page.getByRole('img', { name: 'Patchriot’s white hat and circuit mark' });
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByRole('heading', { name: 'The incident notebook.' })).toBeVisible();
  await page.getByRole('button', { name: 'Request early access →' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(calls).not.toContain('/api/access-requests');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Request early access →' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
