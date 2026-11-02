import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function payment() {
  return {
    invoice_id: '00000000-0000-4000-8000-000000000001', account_id: '00000000-0000-4000-8000-000000000002', account_name: 'Fixture customer', account_disabled: true,
    asset: `nep141:${'a'.repeat(180)}.fixture.near`, required_amount: '9007199254740993', received_amount: '9007199254740993',
    payment_state: 'settled', payment_reason: null, poll_error: null, provider_updated_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ledger_amount: '9007199254740993', ledger_credit: 'customer_funds', order_id: '00000000-0000-4000-8000-000000000003', order_state: 'cancelled', order_error: null,
    review_id: '00000000-0000-4000-8000-000000000004', funding_state: 'delivered', funding_error: null,
    cancel_requested_at: new Date().toISOString(), cancel_confirmed_at: new Date().toISOString(), cancel_review_state: 'cancelled', requires_attention: true,
  };
}

async function setup(page: Page, role: 'admin' | 'member' | null = 'admin') {
  const state = { status: 200, calls: 0, rows: [payment()] };
  await page.route('**/api/session', route => route.fulfill({ json: { account: role ? { id: 'fixture-admin', display_name: 'Fixture admin', role, auth_method: 'invite' } : null, csrf_token: role ? 'fixture-csrf' : null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 0, online_operators: 0, online_compute_groups: 0 } }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
  await page.route('**/api/admin/treasury', route => route.fulfill({ json: { liabilities: '20000000', platform_revenue: '0', observation: null, claims: [], work: [] } }));
  await page.route('**/api/admin/payments', route => {
    expect(route.request().method()).toBe('GET'); state.calls++;
    return route.fulfill(state.status === 200 ? { json: state.rows } : { status: state.status, json: { error: state.status === 403 ? 'admin_required' : state.status === 401 ? 'sign_in_required' : 'database_unavailable' } });
  });
  return state;
}

test('admin sees exact funds and stopped work without a refund action', async ({ page }, info) => {
  await setup(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Payment desk', exact: true }).click();
  const records = page.getByRole('region', { name: 'Admin payment records' });
  await expect(records).toContainText('Newest 50');
  await records.locator('details.payment-record > summary').click();
  await expect(records).toContainText('account disabled');
  await expect(records).toContainText('9007199254740993');
  expect(await records.textContent()).not.toContain('9007199254740992');
  await expect(records).toContainText('settled');
  await expect(records).toContainText('cancelled');
  await expect(records).toContainText('does not authorize a refund');
  await expect(records.getByRole('button', { name: /refund|activate|transfer/i })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('payment-desk.png'), fullPage: true });
});

test('members and visitors have no payment desk navigation or admin reads', async ({ page }) => {
  for (const role of ['member', null] as const) {
    const state = await setup(page, role);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Payment desk', exact: true })).toHaveCount(0);
    expect(state.calls).toBe(0);
  }
});

test('a forbidden or unavailable refresh hides cached admin records', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Payment desk', exact: true }).click();
  await expect(page.getByText('Fixture customer', { exact: false })).toBeVisible();
  for (const status of [503, 403]) {
    state.status = status;
    await page.getByRole('button', { name: 'Refresh payments ↻', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Payment records are hidden');
    await expect(page.getByText('Fixture customer', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No payment records yet.' })).toHaveCount(0);
    state.status = 200;
    await page.getByRole('button', { name: 'Refresh payments ↻', exact: true }).click();
    await expect(page.getByText('Fixture customer', { exact: false })).toBeVisible();
  }
  state.status = 401;
  await page.getByRole('button', { name: 'Refresh payments ↻', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in ↗', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Admin payment records' })).toHaveCount(0);
});

test('an empty history explains that a quote is not a credit', async ({ page }) => {
  const state = await setup(page); state.rows = [];
  await page.goto('/');
  await page.getByRole('button', { name: 'Payment desk', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No payment records yet.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Admin payment records' })).toContainText('quote alone does not create a ledger credit');
});
