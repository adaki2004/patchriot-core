import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const reviewId = '00000000-0000-4000-8000-000000000010';
const siteId = '00000000-0000-4000-8000-000000000020';
const orderId = '00000000-0000-4000-8000-000000000030';
const account = { id: '00000000-0000-4000-8000-000000000001', display_name: 'Navigation fixture', role: 'member', auth_method: 'invite' };

async function setup(page: Page, signedIn = true, permitted = true) {
  const reads: string[] = [], writes: string[] = [];
  const review = { id: reviewId, mode: 'website_agent', state: 'needs_review', created_at: 1793448000, deadline_at: 1793450100, steps: [], evidence_source: 'operator_reported' };
  const site = { id: siteId, requester_id: account.id, state: 'pending_approval', scope: { homepage: 'https://example.com/', script_origins: [] }, authority_note: 'Private authority note for this owned site.', scope_sha256: 'a'.repeat(64), created_at: 1793448000, deadline_at: 1793450100, summary: null, evidence_available: false };
  const future = new Date(Date.now() + 300_000).toISOString();
  const token = { asset_id: 'nep141:fixture.usdc', symbol: 'USDC', decimals: 6, blockchain: 'base' };
  const order = { id: orderId, review_id: reviewId, state: 'awaiting_payment', price: { asset: token.asset_id, amount: '1000000' }, created_at: new Date().toISOString(), expires_at: future, payment: { state: 'pending', received_amount: null, deadline: future }, cancellation: null, requires_attention: false, can_cancel: true };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    (route.request().method() === 'GET' ? reads : writes).push(path);
    if (path === '/api/auth/redeem') { signedIn = true; return route.fulfill({ json: { ok: true } }); }
    if (path === '/api/auth/logout') { signedIn = false; return route.fulfill({ json: { ok: true } }); }
    if (path === '/api/session') return route.fulfill({ json: { account: signedIn ? account : null, csrf_token: signedIn ? 'fixture-csrf' : null } });
    if (path === '/api/fleet') return route.fulfill({ json: { online_devices: 0, online_operators: 0, online_compute_groups: 0 } });
    if (path === '/api/incidents') return route.fulfill({ json: [] });
    if (!signedIn) return route.fulfill({ status: 401, json: { error: 'sign_in_required' } });
    if (path === '/api/devices') return route.fulfill({ json: [] });
    if (path === '/api/checkout') return route.fulfill({ json: { mode: 'paid', offer: { id: 'b'.repeat(64), price: order.price, destination: token, inputs: [token], payment_window_seconds: 300 } } });
    if (path === '/api/review-codes') return route.fulfill({ json: [] });
    if (path === '/api/reviews') return route.fulfill({ json: permitted ? [review] : [] });
    if (path === '/api/site-checks') return route.fulfill({ json: permitted ? [site] : [] });
    if (path === '/api/orders') return route.fulfill({ json: permitted ? [order] : [] });
    if (permitted && path === `/api/reviews/${reviewId}`) return route.fulfill({ json: review });
    if (permitted && path === `/api/site-checks/${siteId}`) return route.fulfill({ json: site });
    if (permitted && path === `/api/orders/${orderId}`) return route.fulfill({ json: order });
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  return { reads, writes };
}

test('a review bookmark survives reload and browser history without submitting work', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`/#/reviews/${reviewId}`);
  const report = page.getByRole('region', { name: 'Review report' });
  await expect(report.getByRole('heading', { name: 'Needs review', exact: true })).toBeVisible();
  await page.reload();
  await expect(report.getByRole('heading', { name: 'Needs review', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Watch log', exact: true }).click();
  await expect(page).toHaveURL(/#\/incidents$/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/reviews/${reviewId}$`));
  await expect(report.getByRole('heading', { name: 'Needs review', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#\/incidents$/);
  await expect(report).toHaveCount(0);
  await page.getByRole('button', { name: 'Pair an agent', exact: true }).click();
  const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
  await skip.focus(); await skip.click();
  await expect(page).toHaveURL(/#\/guide$/);
  await expect(page.locator('main')).toBeFocused();
  expect(calls.writes).toEqual([]);
});

test('late history loading cannot move a bookmarked report below the screen', async ({ page }) => {
  await setup(page);
  await page.route('**/api/reviews', async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({ json: Array.from({ length: 30 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, mode: 'website_agent', state: 'needs_review', created_at: 1793448000, deadline_at: 1793450100, steps: [] })) });
  });
  await page.goto(`/#/reviews/${reviewId}`);
  const heading = page.getByRole('region', { name: 'Review report' }).getByRole('heading', { name: 'Needs review', exact: true });
  await expect(heading).toBeInViewport();
  await expect(page.getByText('30 reviews', { exact: true })).toBeVisible();
  await expect(heading).toBeInViewport();
});

test('an anonymous bookmark waits for sign-in and a denied read exposes no report', async ({ page }) => {
  const calls = await setup(page, false);
  await page.goto(`/#/reviews/${reviewId}`);
  await expect(page.getByRole('heading', { name: 'This page is private.', exact: true })).toBeVisible();
  expect(calls.reads.some(path => path.startsWith('/api/reviews'))).toBe(false);
  await page.getByRole('button', { name: 'Sign in to open this page →', exact: true }).click();
  await page.getByRole('button', { name: 'Use a pilot login code', exact: true }).click();
  await page.getByLabel('Invitation code', { exact: true }).fill('a'.repeat(64));
  await page.getByRole('button', { name: 'Open workspace →', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Review report' }).getByRole('heading', { name: 'Needs review', exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/reviews/${reviewId}$`));
  expect(calls.writes).toEqual(['/api/auth/redeem']);

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(page.getByRole('region', { name: 'Review report' })).toHaveCount(0);
  await setup(page, true, false);
  await page.goto(`/#/reviews/${reviewId}`);
  // A hash-only navigation retains the current session. Reload to establish
  // this fixture's other account, just as opening the bookmark in a new tab.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Review report' }).getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs review', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download evidence JSON ↓', exact: true })).toHaveCount(0);
});

test('snapshot and order bookmarks restore selection without restoring payment instructions', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`/#/sites/${siteId}`);
  await expect(page.getByRole('region', { name: 'Website evidence' })).toContainText('Private authority note for this owned site.');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Website evidence' })).toContainText('Private authority note for this owned site.');
  await page.goto(`/#/orders/${orderId}/report`);
  await expect(page.getByRole('region', { name: 'Order details' })).toContainText('No payment confirmed');
  await expect(page.getByRole('region', { name: 'Review report' }).getByRole('heading', { name: 'Needs review', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Review report' })).toContainText(reviewId);
  await page.getByRole('button', { name: 'Close report ×', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/orders/${orderId}$`));
  await expect(page.getByRole('button', { name: 'Show current payment instructions →', exact: true })).toBeVisible();
  expect(calls.writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('invalid paths cannot become API paths and member links cannot open admin desks', async ({ page }) => {
  const calls = await setup(page);
  for (const hash of [`#/reviews/${reviewId}/cancel`, '#/reviews/../../admin/payments', `#/sites/${siteId}?token=not-a-token`, '#/devices/anything', `#/orders/${orderId}/report/extra`]) {
    await page.goto(`/${hash}`);
    await expect(page.getByRole('heading', { name: 'What are we checking?', exact: true })).toBeVisible();
  }
  for (const view of ['incident-desk', 'payment-desk']) {
    await page.goto(`/#/${view}`);
    await expect(page.getByRole('heading', { name: 'Administrator access required.', exact: true })).toBeVisible();
  }
  expect(calls.reads.every(path => ['/api/session', '/api/fleet', '/api/devices', '/api/incidents'].includes(path))).toBe(true);
  expect(calls.writes).toEqual([]);
});
