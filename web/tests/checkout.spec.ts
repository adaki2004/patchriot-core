import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { CheckoutSettings, Deposit } from '../src/Checkout';

const account = { id: '00000000-0000-4000-8000-000000000001', display_name: 'Checkout fixture', role: 'member', auth_method: 'invite' };
const siteId = '00000000-0000-4000-8000-000000000002';
const orderId = '00000000-0000-4000-8000-000000000003';
const reviewId = '00000000-0000-4000-8000-000000000004';
const codeId = '00000000-0000-4000-8000-000000000005';
const input = { asset_id: 'nep141:fixture.near', symbol: 'NEAR', decimals: 24, blockchain: 'near' };
const output = { asset_id: 'nep141:fixture.usdc.near', symbol: 'USDC', decimals: 6, blockchain: 'near' };
const devices = [1, 2, 3].map(i => ({ device_id: `00000000-0000-4000-8000-00000000001${i}`, operator_id: account.id, operator_name: 'One fixture operator', device_name: `CPU agent ${i}`, declared_model: 'fixture-model', compute_group: 'one-host' }));
const offer = { id: 'a'.repeat(64), price: { asset: output.asset_id, amount: '1000000' }, destination: output, inputs: [input], payment_window_seconds: 300 };
type Submission = { consent: { request_id: string; device_ids: string[]; snapshot_sha256: string; accepts_operator_access: boolean }; offer_id: string; origin_asset: string; refund_address: string };
type CodeSubmission = { code: string; consent: Submission['consent'] };
type CodeReservation = { id: string; label: string; site_check_id: string; request_id: string; consent: Submission['consent']; reserved_at: string; review_id: string | null; last_error: string | null };

async function setup(page: Page) {
  const deadline = new Date(Date.now() + 300_000).toISOString();
  const quote: Deposit = { order_id: orderId, request_id: siteId, review_id: reviewId, invoice_id: orderId, input: { token: input, amount: '1000000000000000000000001' }, output: { token: output, amount: '1000000' }, deposit_address: 'deposit.checkout-fixture.near', deposit_memo: 'fixture-memo', refund_address: 'customer.fixture.near', expires_at: deadline };
  const state = {
    settings: { mode: 'paid', offer } as CheckoutSettings, settingsError: false, statusError: 0, quoteError: false, wrongRequest: false, quote,
    submissions: [] as Submission[], resumed: 0, freeSubmissions: 0,
    codeSubmissions: [] as CodeSubmission[], codeReservations: [] as CodeReservation[], codeError: false, codeWrongBinding: false, codeResumed: 0,
    order: { id: orderId, review_id: reviewId, state: 'awaiting_payment', price: offer.price, created_at: new Date().toISOString(), expires_at: deadline, payment: { state: 'pending', received_amount: null as string | null, deadline }, cancellation: null as null | { requested_at: string; confirmed_at: string | null; review_state: string | null }, requires_attention: false, can_cancel: true },
  };
  const site = { id: siteId, request_id: siteId, requester_id: account.id, scope: { homepage: 'https://checkout.example/', script_origins: [] }, scope_sha256: '1'.repeat(64), authority_note: 'Owned test site.', state: 'collected', created_at: 1, deadline_at: 9999999999, evidence_available: true, evidence_expires_at: 9999999999, summary: { homepage_sha256: '2'.repeat(64), external_scripts: 0, inline_scripts: 1, skipped_scripts: 0, script_limit_reached: false, captured_response_bytes: 1000, requests_made: 1, finished_at: 1 } };
  await page.route('**/api/session', route => route.fulfill({ json: { account, csrf_token: 'test-csrf' } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 3, online_operators: 1, online_compute_groups: 1 } }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
  await page.route('**/api/review-codes', route => route.fulfill({ json: state.codeReservations }));
  await page.route('**/api/site-checks', route => route.fulfill({ json: [site] }));
  await page.route(`**/api/site-checks/${siteId}`, route => route.fulfill({ json: site }));
  await page.route(`**/api/site-checks/${siteId}/review-plan`, route => route.fulfill({ json: { site_check_id: siteId, snapshot_sha256: '3'.repeat(64), candidates: devices, review_timeout_seconds: 5700 } }));
  await page.route('**/api/checkout', route => route.fulfill(state.settingsError ? { status: 503, json: { error: 'checkout_unavailable' } } : { json: state.settings }));
  await page.route(`**/api/site-checks/${siteId}/review`, route => { state.freeSubmissions++; return route.fulfill({ status: 402, json: { error: 'payment_required' } }); });
  await page.route(`**/api/site-checks/${siteId}/checkout`, route => {
    const body: Submission = route.request().postDataJSON();
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    state.submissions.push(body); state.quote.request_id = state.wrongRequest ? siteId : body.consent.request_id;
    return route.fulfill(state.quoteError ? { status: 503, json: { error: 'checkout_unavailable' } } : { json: state.quote });
  });
  const review = { id: reviewId, mode: 'website_agent', state: 'queued', created_at: Math.floor(Date.now() / 1000), deadline_at: Math.floor(Date.now() / 1000) + 2100, steps: [], evidence_source: 'Browser fixture', website: { site_check_id: siteId, snapshot_sha256: '3'.repeat(64), reviewers: devices } };
  await page.route('**/api/reviews', route => route.fulfill({ json: state.codeSubmissions.length ? [review] : [] }));
  await page.route(`**/api/reviews/${reviewId}`, route => route.fulfill({ json: review }));
  await page.route(`**/api/site-checks/${siteId}/review-code`, route => {
    const body: CodeSubmission = route.request().postDataJSON();
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    state.codeSubmissions.push(body);
    state.codeReservations = [{ id: codeId, label: 'Invited tester', site_check_id: siteId, request_id: body.consent.request_id, consent: body.consent, reserved_at: new Date().toISOString(), review_id: state.codeError ? null : reviewId, last_error: state.codeError ? 'dispatcher_unavailable' : null }];
    return route.fulfill(state.codeError ? { status: 503, json: { error: 'dispatcher_unavailable' } } : { json: { redemption_id: codeId, request_id: state.codeWrongBinding ? siteId : body.consent.request_id, review_id: reviewId } });
  });
  await page.route(`**/api/review-codes/${codeId}/resume`, route => {
    expect(route.request().postDataJSON()).toEqual({});
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    state.codeResumed++;
    state.codeReservations[0].review_id = reviewId;
    return route.fulfill({ json: { redemption_id: codeId, request_id: state.codeReservations[0].request_id, review_id: reviewId } });
  });
  await page.route('**/api/orders', route => route.fulfill({ json: [state.order] }));
  await page.route(`**/api/orders/${orderId}`, route => route.fulfill(state.statusError ? { status: state.statusError, json: { error: state.statusError === 401 ? 'sign_in_required' : 'database_unavailable' } } : { json: state.order }));
  await page.route(`**/api/orders/${orderId}/quote`, route => {
    state.resumed++;
    expect(route.request().postDataJSON()).toEqual({});
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    return route.fulfill({ json: state.quote });
  });
  return state;
}

test('a code covers one consented review without payment instructions or browser storage', async ({ page }, info) => {
  const state = await setup(page); state.settings = { mode: 'coupons', offer: null };
  await choose(page);
  const submit = page.getByRole('button', { name: 'Use code & start review →', exact: true });
  await expect(submit).toBeDisabled();
  const code = `pr-${'a'.repeat(64)}`;
  await page.getByLabel('Review code', { exact: true }).fill(code);
  await expect(page.getByRole('dialog')).toContainText('Cancellation does not restore the code');
  await page.getByRole('dialog').screenshot({ path: info.outputPath('review-code-consent.png') });
  await submit.click();
  await expect(page.getByRole('region', { name: 'Review report' })).toBeVisible();
  expect(state.codeSubmissions).toHaveLength(1);
  expect(state.codeSubmissions[0].consent.device_ids).toEqual(devices.map(device => device.device_id));
  expect(state.codeSubmissions[0].consent.accepts_operator_access).toBe(true);
  expect(state.submissions).toHaveLength(0); expect(state.freeSubmissions).toBe(0);
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }))).not.toContain(code);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('paid mode offers a review code alongside the unchanged payment route', async ({ page }) => {
  const state = await setup(page);
  await choose(page);
  await page.getByLabel('Use a review code instead of payment', { exact: true }).check();
  await page.getByLabel('Review code', { exact: true }).fill(`pr-${'b'.repeat(64)}`);
  await page.getByRole('button', { name: 'Use code & start review →', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Review report' })).toBeVisible();
  expect(state.codeSubmissions).toHaveLength(1); expect(state.submissions).toHaveLength(0); expect(state.freeSubmissions).toBe(0);
});

test('a lost code reply survives refresh and resumes only the saved request', async ({ page }, info) => {
  const state = await setup(page); state.settings = { mode: 'coupons', offer: null }; state.codeError = true;
  await choose(page);
  await page.getByLabel('Review code', { exact: true }).fill(`pr-${'c'.repeat(64)}`);
  await page.getByRole('button', { name: 'Use code & start review →', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('you will not need the code again');
  const original = state.codeSubmissions[0];
  await page.getByRole('button', { name: 'Close agent selection', exact: true }).click();
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.reload();
  const history = page.getByRole('region', { name: 'Sponsored reviews', exact: true });
  await expect(history).toContainText('Start not confirmed');
  await history.getByText('Saved sharing permission', { exact: true }).click();
  await expect(history).toContainText(original.consent.snapshot_sha256);
  await history.screenshot({ path: info.outputPath('sponsored-review-recovery.png') });
  await history.getByRole('button', { name: 'Resume saved request →', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Review report' })).toBeVisible();
  expect(state.codeResumed).toBe(1); expect(state.codeSubmissions).toHaveLength(1);
  expect(state.codeReservations[0].request_id).toBe(original.consent.request_id);
  expect(state.submissions).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a mismatched code reply never opens another review', async ({ page }) => {
  const state = await setup(page); state.settings = { mode: 'coupons', offer: null }; state.codeWrongBinding = true;
  await choose(page);
  await page.getByLabel('Review code', { exact: true }).fill(`pr-${'d'.repeat(64)}`);
  await page.getByRole('button', { name: 'Use code & start review →', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be matched');
  await expect(page.getByRole('region', { name: 'Review report' })).toHaveCount(0);
  expect(state.codeSubmissions).toHaveLength(1);
});

test('switching to codes-only access exposes the code field even from the payment step', async ({ page }) => {
  const state = await setup(page);
  await choose(page);
  await page.getByRole('button', { name: 'Continue to payment →', exact: true }).click();
  state.settings = { mode: 'coupons', offer: null };
  await page.getByRole('button', { name: 'Refresh eligible devices ↻', exact: true }).click();
  await expect(page.getByLabel('Review code', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Pay with', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use code & start review →', exact: true })).toBeDisabled();
  expect(state.submissions).toHaveLength(0); expect(state.codeSubmissions).toHaveLength(0);
});

async function choose(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Website checks', exact: true }).click();
  await page.getByRole('button', { name: 'https://checkout.example/', exact: false }).click();
  await page.getByRole('button', { name: 'Choose review agents →' }).click();
  for (const [i, role] of ['Investigator', 'Reproducer', 'Challenger'].entries()) await page.getByLabel(`${role} device`).selectOption(devices[i].device_id);
  await page.getByLabel('I allow these three devices and their named operators').check();
}

async function prepare(page: Page) {
  await choose(page);
  await page.getByRole('button', { name: 'Continue to payment →', exact: true }).click();
  await page.getByLabel('Pay with', { exact: true }).selectOption(input.asset_id);
  await page.getByLabel('Refund address on NEAR', { exact: false }).fill('customer.fixture.near');
  await page.getByRole('button', { name: 'Reserve review & get quote →', exact: true }).click();
}

test('paid review shows the price before an exact network-specific deposit and never uses the free route', async ({ page }, info) => {
  const state = await setup(page);
  await choose(page);
  const modal = page.getByRole('dialog');
  await expect(modal).toContainText('1 USDC');
  await expect(modal).toContainText('3 devices · 1 operator · 1 declared compute group');
  await page.getByRole('button', { name: 'Continue to payment →', exact: true }).click();
  expect(state.submissions).toHaveLength(0);
  const submit = page.getByRole('button', { name: 'Reserve review & get quote →', exact: true });
  await expect(submit).toBeDisabled();
  await page.getByLabel('Pay with', { exact: true }).selectOption(input.asset_id);
  await page.getByLabel('Refund address on NEAR', { exact: false }).fill('customer.fixture.near');
  await modal.screenshot({ path: info.outputPath('checkout-consent.png') });
  await submit.click();
  await expect(modal).toHaveCount(0);
  const instructions = page.getByRole('region', { name: 'Payment instructions' });
  await expect(instructions.getByRole('heading', { name: 'Send 1.000000000000000000000001 NEAR', exact: true })).toBeVisible();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { (window as Window & { copiedAmount?: string }).copiedAmount = value; } } }));
  await instructions.getByRole('button', { name: 'Copy exact amount', exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { copiedAmount?: string }).copiedAmount)).toBe('1.000000000000000000000001');
  await expect(instructions).toContainText('Required deposit memo');
  await expect(instructions).toContainText('fixture-memo');
  await expect(page.getByRole('region', { name: 'Order details' })).toContainText('No payment confirmed');
  expect(state.submissions).toHaveLength(1);
  expect(Object.keys(state.submissions[0]).sort()).toEqual(['consent', 'offer_id', 'origin_asset', 'refund_address']);
  expect(state.submissions[0].consent.device_ids).toEqual(devices.map(d => d.device_id));
  expect(state.quote.request_id).toBe(state.submissions[0].consent.request_id);
  expect(state.quote.review_id).not.toBe(state.quote.request_id);
  expect(state.freeSubmissions).toBe(0);
  expect(state.resumed).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('region', { name: 'Order details' }).screenshot({ path: info.outputPath('checkout-deposit.png') });
});

test('a lost preparation reply keeps the same request and warns before creating another payment', async ({ page }) => {
  const state = await setup(page); state.quoteError = true;
  await prepare(page);
  await expect(page.getByRole('alert')).toContainText('check Orders before preparing another payment');
  expect(state.submissions).toHaveLength(1);
  state.quoteError = false;
  await page.getByRole('button', { name: 'Reserve review & get quote →', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toBeVisible();
  expect(state.submissions).toHaveLength(2);
  expect(state.submissions[0]).toEqual(state.submissions[1]);
});

test('a delayed checkout reply cannot open the old order after another account signs in', async ({ page }) => {
  const state = await setup(page);
  let releaseQuote!: () => void;
  const pending = new Promise<void>(resolve => { releaseQuote = resolve; });
  await page.route(`**/api/site-checks/${siteId}/checkout`, async route => {
    const body: Submission = route.request().postDataJSON();
    state.submissions.push(body); state.quote.request_id = body.consent.request_id;
    await pending;
    await route.fulfill({ json: state.quote });
  });
  await page.route('**/api/auth/redeem', route => route.fulfill({ json: { ok: true } }));
  let oldOrderReads = 0;
  try {
    await prepare(page);
    await expect.poll(() => state.submissions.length).toBe(1);
    // The same event is emitted when a background request confirms expiry.
    await page.evaluate(() => window.dispatchEvent(new Event('patchriot:session-expired')));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.route('**/api/session', route => route.fulfill({ json: { account: { ...account, id: '00000000-0000-4000-8000-000000000099', display_name: 'New customer' }, csrf_token: 'new-csrf' } }));
    await page.route('**/api/orders', route => route.fulfill({ json: [] }));
    await page.route(`**/api/orders/${orderId}`, route => { oldOrderReads++; return route.fulfill({ status: 404, json: { error: 'not_found' } }); });
    await page.getByRole('button', { name: 'Sign in ↗', exact: true }).click();
    await page.getByLabel('Invitation code', { exact: true }).fill('a'.repeat(64));
    await page.getByRole('button', { name: 'Open workspace →', exact: true }).click();
    await expect(page.getByText('New customer', { exact: true })).toHaveText('New customer');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    const staleReply = page.waitForResponse(`**/api/site-checks/${siteId}/checkout`);
    releaseQuote(); await (await staleReply).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(/#\/overview$/);
    await expect(page.getByRole('region', { name: 'Order details' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
    await expect(page.getByText(state.quote.deposit_address, { exact: true })).toHaveCount(0);
    expect(oldOrderReads).toBe(0);
    expect(state.submissions).toHaveLength(1); expect(state.resumed).toBe(0);
  } finally { releaseQuote(); }
});

test('a quote for another request is rejected even when price and refund address match', async ({ page }) => {
  const state = await setup(page); state.wrongRequest = true;
  await prepare(page);
  await expect(page.getByRole('alert')).toContainText('quote does not match your request');
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('an unavailable or closed checkout cannot fall back to a free review', async ({ page }) => {
  const state = await setup(page); state.settingsError = true;
  await choose(page);
  await expect(page.getByRole('alert')).toContainText('Checkout is unavailable');
  await expect(page.getByRole('button', { name: 'Share snapshot & start review →', exact: true })).toBeDisabled();
  state.settingsError = false; state.settings = { mode: 'closed', offer: null };
  await page.getByRole('button', { name: 'Refresh eligible devices ↻', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('New website reviews are paused');
  await expect(page.getByRole('button', { name: 'Share snapshot & start review →', exact: true })).toBeDisabled();
  expect(state.submissions).toHaveLength(0); expect(state.freeSubmissions).toBe(0);
});

test('expiry removes the address and amount without creating a replacement quote', async ({ page }) => {
  await page.clock.install();
  const state = await setup(page);
  await prepare(page);
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toBeVisible();
  await page.clock.fastForward(301_000);
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
  await expect(page.getByText(state.quote.deposit_address, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Order details' }).getByRole('heading', { name: 'Payment window ended', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show current payment instructions →', exact: true })).toHaveCount(0);
  expect(state.submissions).toHaveLength(1); expect(state.resumed).toBe(0);
});

test('processing hides instructions, settlement does not claim completed work, and logout clears private data', async ({ page }) => {
  const state = await setup(page);
  await prepare(page);
  const detail = page.getByRole('region', { name: 'Order details' });
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toBeVisible();
  state.order.payment.state = 'processing';
  await detail.getByRole('button', { name: 'Refresh order ↻', exact: true }).click();
  await expect(detail).toContainText('Transfer being processed');
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
  state.order.payment.state = 'settled'; state.order.payment.received_amount = '1000000'; state.order.state = 'activated';
  await detail.getByRole('button', { name: 'Refresh order ↻', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Work activated', exact: true })).toBeVisible();
  await expect(detail).toContainText('Open the report for its current progress and result');
  state.statusError = 401;
  await detail.getByRole('button', { name: 'Refresh order ↻', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in ↗', exact: true })).toBeVisible();
  await expect(detail).toHaveCount(0);
  await expect(page.getByText(state.quote.deposit_address, { exact: true })).toHaveCount(0);
});

test('an outage retains order history while hiding payment instructions', async ({ page }) => {
  const state = await setup(page);
  await prepare(page);
  const detail = page.getByRole('region', { name: 'Order details' });
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toBeVisible();
  state.statusError = 503;
  await detail.getByRole('button', { name: 'Refresh order ↻', exact: true }).click();
  await expect(detail.getByRole('alert')).toContainText('may be out of date');
  await expect(detail.getByRole('heading', { name: 'Waiting for payment', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
  await expect(page.getByText(state.quote.deposit_address, { exact: true })).toHaveCount(0);
});

test('a pending order resumes explicitly and a sent hint cannot mark it as funded', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByRole('region', { name: 'Order history' }).getByRole('button').click();
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show current payment instructions →', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toBeVisible();
  expect(state.resumed).toBe(1); expect(state.submissions).toHaveLength(0);
  await page.getByRole('button', { name: 'I’ve sent it · hide instructions', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Order details' })).toContainText('Your click does not confirm payment');
  await expect(page.getByRole('region', { name: 'Order details' })).toContainText('No payment confirmed');
  await expect(page.getByRole('button', { name: 'Show current payment instructions →', exact: true })).toHaveCount(0);
  state.order.payment.state = 'settled'; state.order.payment.received_amount = '1000000'; state.order.state = 'activated';
  const detail = page.getByRole('region', { name: 'Order details' });
  await detail.getByRole('button', { name: 'Refresh order ↻', exact: true }).click();
  await expect(detail).toContainText('Funds recorded');
  await expect(detail.getByText('Waiting for confirmation.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
});

test('malformed payment amounts are not rounded or shown as deposit instructions', async ({ page }) => {
  const state = await setup(page); state.quote.input.amount = 1000000000000000000000001 as unknown as string;
  await prepare(page);
  await expect(page.getByRole('alert')).toContainText('payment instructions could not be verified');
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('closing checkout hides an already displayed quote without erasing the order', async ({ page }) => {
  await page.clock.install();
  const state = await setup(page);
  await prepare(page);
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toBeVisible();
  state.settings = { mode: 'closed', offer: null };
  await page.clock.fastForward(10_100);
  await expect(page.getByText('New payments are paused.', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Order history' }).getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Show current payment instructions →', exact: true })).toHaveCount(0);
  expect(state.submissions).toHaveLength(1); expect(state.resumed).toBe(0);
});

test('cancellation removes deposit instructions even when its response is lost', async ({ page }) => {
  const state = await setup(page);
  await page.route(`**/api/orders/${orderId}/cancel`, route => {
    state.order.state = 'cancelled'; state.order.can_cancel = false;
    state.order.cancellation = { requested_at: new Date().toISOString(), confirmed_at: null, review_state: null };
    return route.fulfill({ status: 503, json: { error: 'database_unavailable' } });
  });
  await prepare(page);
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toBeVisible();
  page.once('dialog', dialog => void dialog.accept());
  const detail = page.getByRole('region', { name: 'Order details' });
  await detail.getByRole('button', { name: 'Request cancellation', exact: true }).click();
  await expect(detail.getByRole('alert')).toContainText('storage is unavailable');
  await expect(page.getByRole('region', { name: 'Payment instructions' })).toHaveCount(0);
  await detail.getByRole('button', { name: 'Refresh order ↻', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Cancellation requested', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show current payment instructions →', exact: true })).toHaveCount(0);
});
