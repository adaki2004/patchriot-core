import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { emptyDashboard } from './helpers';

async function setup(page: Page, role: 'admin' | 'member' | null = null) {
  await emptyDashboard(page);
  await page.route('**/api/session', r => r.fulfill({ json: { account: role ? { id: '00000000-0000-4000-8000-000000000001', display_name: 'Example', role } : null, csrf_token: role ? 'example-csrf' : null } }));
  await page.route('**/api/fleet', r => r.fulfill({ json: { online_devices: 0, online_operators: 0, online_compute_groups: 0 } }));
  await page.route('**/api/devices', r => r.fulfill({ json: [] }));
  await page.route('**/api/contact', r => r.fulfill({ json: { email: 'contact@example.com' } }));
}

test('enterprise contact is public and a retry retains the same inquiry identity', async ({ page }) => {
  await setup(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/contact', r => {
    if (r.request().method() !== 'POST') return r.fallback();
    bodies.push(r.request().postDataJSON());
    return bodies.length === 1 ? r.fulfill({ status: 503, json: { error: 'database_unavailable' } }) : r.fulfill({ status: 202, json: { received: true } });
  });
  await page.goto('/#/contact');
  await expect(page.getByRole('heading', { name: 'Plan your network.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'contact@example.com' })).toHaveAttribute('href', 'mailto:contact%40example.com');
  await page.getByLabel('Your name').fill('Example owner');
  await page.getByLabel('Work email').fill('owner@example.com');
  await page.getByLabel('Company or team').fill('Owned systems');
  await page.getByLabel('What do you need?').fill('A private network for our authorized staging website tests.');
  await page.getByRole('button', { name: 'Send inquiry' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Send inquiry' }).click();
  await expect(page.getByRole('heading', { name: 'Inquiry received.' })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
  await expect(page.getByText('This does not create an account or start a test.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a member cannot open or fetch the enterprise staff inbox', async ({ page }) => {
  await setup(page, 'member');
  let reads = 0;
  await page.route('**/api/admin/inquiries', r => { reads++; return r.fulfill({ json: [] }); });
  await page.goto('/#/contact-inbox');
  await expect(page.getByRole('heading', { name: 'Administrator access required.' })).toBeVisible();
  expect(reads).toBe(0);
});

test('the staff inbox renders untrusted messages as text and records handled state', async ({ page }) => {
  await setup(page, 'admin');
  const item = { id: '00000000-0000-4000-8000-000000000002', name: 'Owner', email: 'owner@example.com', organization: 'Owned fixture', message: '<img src=x onerror="window.exposed=true">\nKeep the literal message.', state: 'open', created_at: '2026-11-02T12:00:00Z', updated_at: '2026-11-02T12:00:00Z' };
  await page.route('**/api/admin/inquiries', r => r.fulfill({ json: [item] }));
  await page.route(`**/api/admin/inquiries/${item.id}`, r => {
    expect(r.request().headers()['x-csrf-token']).toBe('example-csrf');
    expect(r.request().postDataJSON()).toEqual({ handled: true });
    item.state = 'handled';
    return r.fulfill({ json: { saved: true } });
  });
  await page.goto('/#/contact-inbox');
  await expect(page.getByRole('heading', { name: 'Contact inbox.' })).toBeVisible();
  await expect(page.locator('.inquiry-message')).toContainText('<img src=x');
  await expect(page.locator('.inquiry-message img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark handled' }).click();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
