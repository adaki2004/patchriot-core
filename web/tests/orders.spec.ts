import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const account = { id: '00000000-0000-4000-8000-000000000001', display_name: 'Test requester', role: 'member', auth_method: 'invite' };
const orderId = '00000000-0000-4000-8000-000000000002';
const reviewId = '00000000-0000-4000-8000-000000000003';
const amount = '9007199254740993';

function example() {
  return {
    id: orderId, review_id: reviewId, state: 'awaiting_payment',
    price: { asset: `nep141:${'a'.repeat(190)}.fixture.near`, amount },
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString(),
    payment: { state: 'pending', received_amount: null as string | null, deadline: new Date(Date.now() + 300_000).toISOString() },
    cancellation: null as null | { requested_at: string; confirmed_at: string | null; review_state: string | null },
    requires_attention: false, can_cancel: true,
  };
}

async function setup(page: Page, signedIn = true) {
  await page.route('**/api/checkout', route => route.fulfill({ json: { mode: 'pilot', offer: null } }));
  await page.route('**/api/session', route => route.fulfill({ json: { account: signedIn ? account : null, csrf_token: signedIn ? 'test-csrf' : null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 0, online_operators: 0, online_compute_groups: 0 } }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
}

async function openOrder(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByRole('region', { name: 'Order history' }).getByRole('button').click();
  return page.getByRole('region', { name: 'Order details' });
}

test('order history is private navigation and an empty pilot is not a checkout', async ({ page }) => {
  await setup(page, false);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Orders', exact: true })).toHaveCount(0);
  await setup(page);
  await page.route('**/api/orders', route => route.fulfill({ json: [] }));
  await page.reload();
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No paid orders yet.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Order history' })).toContainText('Paid checkout is not enabled');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('cancellation stays pending until acknowledged and recorded funds are not called a refund', async ({ page }) => {
  await setup(page);
  const order = example();
  let requests = 0;
  await page.route('**/api/orders', route => route.fulfill({ json: [order] }));
  await page.route(`**/api/orders/${orderId}`, route => route.fulfill({ json: order }));
  await page.route(`**/api/orders/${orderId}/cancel`, async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    expect(route.request().postDataJSON()).toEqual({});
    requests += 1;
    order.state = 'cancelled'; order.can_cancel = false;
    order.cancellation = { requested_at: new Date().toISOString(), confirmed_at: null, review_state: null };
    await route.fulfill({ json: order });
  });
  const detail = await openOrder(page);
  await expect(detail.getByRole('heading', { name: 'Waiting for payment', exact: true })).toBeVisible();
  page.once('dialog', dialog => {
    expect(dialog.message()).toContain('does not issue a refund');
    void dialog.accept();
  });
  await detail.getByRole('button', { name: 'Request cancellation', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Cancellation requested', exact: true })).toBeVisible();
  await expect(detail.getByRole('status')).toContainText('Confirmation that the review stopped is still pending');
  await expect(detail.getByRole('button', { name: 'Request cancellation', exact: true })).toHaveCount(0);
  expect(requests).toBe(1);
  order.cancellation!.confirmed_at = new Date().toISOString(); order.cancellation!.review_state = 'cancelled';
  order.requires_attention = true; order.payment.state = 'held'; order.payment.received_amount = amount;
  await detail.getByRole('button', { name: 'Refresh order ↻', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Work stopped', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Order history' })).toContainText('Work stopped');
  await expect(detail).toContainText('no refund is issued by cancelling work');
  await detail.getByText('Payment record', { exact: true }).click();
  expect(await detail.locator('code').allTextContents()).toContain(amount);
  expect(await detail.locator('code').allTextContents()).not.toContain('9007199254740992');
  await expect(detail).toContainText(order.price.asset);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('order-stopped-with-funds.png'), fullPage: true });
});

test('a lost cancellation reply is recovered by refreshing, without claiming success from the error', async ({ page }) => {
  await setup(page);
  const order = example();
  await page.route('**/api/orders', route => route.fulfill({ json: [order] }));
  await page.route(`**/api/orders/${orderId}`, route => route.fulfill({ json: order }));
  await page.route(`**/api/orders/${orderId}/cancel`, async route => {
    order.state = 'cancelled'; order.can_cancel = false;
    order.cancellation = { requested_at: new Date().toISOString(), confirmed_at: null, review_state: null };
    await route.fulfill({ status: 503, json: { error: 'database_unavailable' } });
  });
  const detail = await openOrder(page);
  page.once('dialog', dialog => void dialog.accept());
  await detail.getByRole('button', { name: 'Request cancellation', exact: true }).click();
  await expect(detail.getByRole('alert')).toContainText('storage is unavailable');
  await expect(detail.getByRole('heading', { name: 'Work stopped', exact: true })).toHaveCount(0);
  await detail.getByRole('button', { name: 'Refresh order ↻', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Cancellation requested', exact: true })).toBeVisible();
  await expect(detail.getByRole('alert')).toHaveCount(0);
});

test('an outage preserves the last order while session expiry clears it', async ({ page }) => {
  await setup(page);
  const order = example();
  let failure = 0;
  await page.route('**/api/orders', route => route.fulfill(failure === 503 ? { status: 503, json: { error: 'database_unavailable' } } : { json: [order] }));
  await page.route(`**/api/orders/${orderId}`, route => route.fulfill(failure ? { status: failure, json: { error: failure === 401 ? 'sign_in_required' : 'database_unavailable' } } : { json: order }));
  const detail = await openOrder(page);
  await expect(detail.getByRole('heading', { name: 'Waiting for payment', exact: true })).toBeVisible();
  failure = 503;
  await page.getByRole('button', { name: 'Refresh orders ↻', exact: true }).click();
  await detail.getByRole('button', { name: 'Refresh order ↻', exact: true }).click();
  await expect(detail.getByRole('alert')).toContainText('may be out of date');
  await expect(detail.getByRole('heading', { name: 'Waiting for payment', exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Request cancellation', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'No paid orders yet.' })).toHaveCount(0);
  failure = 401;
  await detail.getByRole('button', { name: 'Refresh order ↻', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in ↗', exact: true })).toBeVisible();
  await expect(detail).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Orders', exact: true })).toHaveCount(0);
});

test('finished work is preserved and paid reports direct cancellation to the saved order', async ({ page }) => {
  await setup(page);
  const order = example();
  order.state = 'needs_review'; order.requires_attention = true; order.can_cancel = false;
  order.cancellation = { requested_at: new Date().toISOString(), confirmed_at: new Date().toISOString(), review_state: 'completed' };
  await page.route('**/api/orders', route => route.fulfill({ json: [order] }));
  await page.route(`**/api/orders/${orderId}`, route => route.fulfill({ json: order }));
  await page.route(`**/api/reviews/${reviewId}`, route => route.fulfill({ json: {
    id: reviewId, mode: 'website_agent', state: 'running', created_at: 1, deadline_at: 9999999999, steps: [], evidence_source: 'fixture',
    payment: { price: order.price, expires_at: 9999999999, invoice_id: orderId, funded_at: 1 },
  } }));
  const detail = await openOrder(page);
  await expect(detail.getByRole('heading', { name: 'Work already finished', exact: true })).toBeVisible();
  await expect(detail).toContainText('Its actual result is preserved');
  await detail.getByRole('button', { name: 'Open review report →', exact: true }).click();
  const report = page.getByRole('region', { name: 'Review report' });
  await expect(report).toContainText('Manage cancellation in Orders');
  await expect(report.getByRole('button', { name: 'Cancel review', exact: true })).toHaveCount(0);
  await report.getByRole('button', { name: 'Open orders →', exact: true }).click();
  await expect(report).toHaveCount(0);
  await expect(detail).toBeVisible();
});
