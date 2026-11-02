import { emptyDashboard } from './helpers';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => { await emptyDashboard(page); });

async function setup(page: Page, available = '18000000') {
  const destinations = [
    { asset_id: 'fixture-eth-usdc', symbol: 'USDC', blockchain: 'eth' },
    { asset_id: 'fixture-eth-usdt', symbol: 'USDT', blockchain: 'eth' },
    { asset_id: 'fixture-sol-usdc', symbol: 'USDC', blockchain: 'sol' },
    { asset_id: 'fixture-sol-usdt', symbol: 'USDT', blockchain: 'sol' },
  ];
  const data = { enabled: true, minimum_claim: '10000000', balance: { earned: available, available, reserved: '0', paid: '0' }, destinations, claims: [] as Array<{ id: string; state: string; amount: string; recipient: string; destination_asset: string; expected_amount: string; minimum_amount: string; expires_at: string; last_error: null }>, receipts: [] };
  const state = { data, confirms: 0, errors: false, requests: [] as Record<string, string>[] };
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id: '00000000-0000-4000-8000-000000000001', display_name: 'Fixture operator', role: 'member', auth_method: 'invite' }, csrf_token: 'fixture-csrf' } }));
  await page.route('**/api/fleet', r => r.fulfill({ json: { online_devices: 3, online_operators: 1, online_compute_groups: 1 } }));
  await page.route('**/api/devices', r => r.fulfill({ json: [] }));
  await page.route('**/api/earnings', r => r.fulfill({ json: { work: [] } }));
  await page.route('**/api/withdrawals', async r => {
    if (r.request().method() === 'GET') return r.fulfill(state.errors ? { status: 503, json: { error: 'database_unavailable' } } : { json: data });
    expect(r.request().headers()['x-csrf-token']).toBe('fixture-csrf');
    const input = r.request().postDataJSON(); state.requests.push(input);
    data.claims = [{ ...input, state: 'quoted', expected_amount: '9950000', minimum_amount: '9850000', expires_at: new Date(Date.now() + 300_000).toISOString(), last_error: null }];
    data.balance.available = (BigInt(available) - BigInt(input.amount)).toString(); data.balance.reserved = input.amount;
    return r.fulfill({ json: data.claims[0] });
  });
  await page.route('**/api/withdrawals/*/confirm', r => {
    expect(r.request().headers()['x-csrf-token']).toBe('fixture-csrf'); expect(r.request().postDataJSON()).toEqual({});
    state.confirms++; data.claims[0].state = 'queued'; return r.fulfill({ json: { accepted: true } });
  });
  await page.route('**/api/withdrawals/*/cancel', r => {
    data.claims[0].state = 'cancelled'; data.balance.available = available; data.balance.reserved = '0'; return r.fulfill({ json: { cancelled: true } });
  });
  await page.goto('/#/earnings');
  return state;
}

test('withdrawal requires reviewing the network, address and net amount', async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByRole('heading', { name: 'Earnings', exact: true })).toBeVisible();
  await page.getByLabel('Receive as', { exact: true }).selectOption('fixture-sol-usdt');
  await page.getByLabel('Receiving wallet on Solana').fill('So11111111111111111111111111111111111111112');
  await page.getByRole('button', { name: 'Get withdrawal quote' }).click();
  const claim = page.getByRole('region', { name: 'Withdraw earnings', exact: true });
  await expect(claim).toContainText('9.95 USDT');
  await expect(claim).toContainText('9.85');
  await expect(claim).toContainText('Solana');
  await expect(claim.getByRole('button', { name: 'Confirm withdrawal' })).toBeDisabled();
  expect(state.confirms).toBe(0);
  expect(state.requests[0].amount).toBe('10000000');
  expect(state.requests[0].destination_asset).toBe('fixture-sol-usdt');
  await page.getByLabel('I checked the receiving network').check();
  await page.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
  await expect(claim).toContainText('queued');
  expect(state.confirms).toBe(1);
  await expect(page.getByRole('region', { name: 'Your balance' })).toContainText('8 USDC');
  await page.reload();
  await expect(claim).toContainText('queued');
  await expect(page.getByRole('button', { name: 'Get withdrawal quote' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('below-threshold earnings cannot request payment and network changes clear the address', async ({ page }) => {
  await setup(page, '9000000');
  await expect(page.getByRole('button', { name: 'Get withdrawal quote' })).toBeDisabled();
  await expect(page.getByText('The balance has not reached the withdrawal minimum.')).toBeVisible();
  await page.getByLabel('Receiving wallet on Ethereum').fill('0x1111111111111111111111111111111111111111');
  await page.getByLabel('Receive as', { exact: true }).selectOption('fixture-sol-usdc');
  await expect(page.getByLabel('Receiving wallet on Solana')).toHaveValue('');
});

test('cancelling unsigned work restores available balance; an unavailable read hides money controls', async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel('Receiving wallet on Ethereum').fill('0x1111111111111111111111111111111111111111');
  await page.getByRole('button', { name: 'Get withdrawal quote' }).click();
  await page.getByRole('button', { name: 'Cancel unsigned withdrawal' }).click();
  await expect(page.getByRole('region', { name: 'Your balance' })).toContainText('18 USDC');
  await expect(page.getByRole('button', { name: 'Get withdrawal quote' })).toBeEnabled();
  state.errors = true;
  await page.getByRole('button', { name: 'Refresh earnings', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your balance' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Get withdrawal quote' })).toHaveCount(0);
});
