import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const account = { id: '00000000-0000-4000-8000-000000000001', display_name: 'Test operator', role: 'member', auth_method: 'invite' };
const fleet = { online_devices: 3, online_operators: 1, online_compute_groups: 1 };

async function setup(page: Page, signedIn = false) {
  await page.route('**/api/session', route => route.fulfill({ json: { account: signedIn ? account : null, csrf_token: signedIn ? 'test-csrf' : null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: fleet }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
}

test('shows real fleet dimensions, prototype scope and usable mobile layout', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'More defenders. Fewer blind spots.' })).toBeVisible();
  await expect(page.getByText('3 approved relays online')).toBeVisible();
  await expect(page.getByLabel('Live fleet counts')).toContainText('Distinct operators');
  await expect(page.getByText('customer assessments and paid reviews are not enabled.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Relay setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start with a small contribution.' })).toBeVisible();
});

test('an outage keeps the previous count and displays the failure', async ({ page }) => {
  await setup(page);
  let failing = false;
  await page.route('**/api/fleet', route => route.fulfill(failing
    ? { status: 503, json: { error: 'dispatcher_unavailable' } }
    : { json: fleet }));
  await page.goto('/');
  await expect(page.getByText('3 approved relays online')).toBeVisible();
  failing = true;
  await expect(page.getByRole('alert')).toContainText('dispatcher is unavailable', { timeout: 15_000 });
  await expect(page.getByLabel('Live fleet counts')).toContainText('3');
  await expect(page.getByText('Connection interrupted')).toBeVisible();
  failing = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('pairing collects consent, sends the session CSRF and does not self-approve', async ({ page }) => {
  await setup(page, true);
  let submission: Record<string, unknown> | undefined;
  await page.route('**/api/pairings/claim', async route => {
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    expect(route.request().headers()['x-patchriot-role']).toBeUndefined();
    expect(route.request().headers()['authorization']).toBeUndefined();
    submission = route.request().postDataJSON();
    await route.fulfill({ json: { state: 'paired', device_id: '00000000-0000-4000-8000-000000000002' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'My relays', exact: true }).click();
  await page.getByRole('button', { name: 'Pair a relay +' }).click();
  await page.getByLabel('Pairing code', { exact: true }).fill('ABCD-EF01-2345');
  await page.getByLabel('I will use assigned data', { exact: false }).check();
  await page.getByRole('button', { name: 'Pair relay →', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('administrator must approve');
  expect(submission).toEqual({ user_code: 'ABCD-EF01-2345', display_name: 'Test operator', hosting: 'own_machine', accepts_private_work_rules: true });
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
});

test('renders operator-controlled names as text and exposes no admin actions to members', async ({ page }) => {
  await setup(page, true);
  await page.route('**/api/devices', route => route.fulfill({ json: [{
    id: '00000000-0000-4000-8000-000000000002', operator_id: account.id,
    operator_name: '<img src=x onerror=alert(1)>', label: '<script>alert(1)</script>',
    runtime: 'owned_fixture', runtime_version: '0.0.1', declared_model: null, compute_group: 'shared-machine',
    approval: 'pending', state: 'pending', last_seen_at: null,
  }] }));
  await page.goto('/');
  await page.getByRole('button', { name: 'My relays', exact: true }).click();
  await expect(page.getByRole('cell', { name: '<script>alert(1)</script>', exact: false })).toBeVisible();
  await expect(page.locator('td img, td script')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
});
