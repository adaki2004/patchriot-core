import { expect, test } from '@playwright/test';
import { emptyDashboard } from './helpers';

for (const draft of [false, true]) test(`OAuth return waits for the account without flashing the hero (draft ${draft})`, async ({ page }) => {
  await emptyDashboard(page);
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
  if (draft) await page.addInitScript(() => sessionStorage.setItem('patchriot.website-draft', JSON.stringify({ origin: 'https://example.com', expires: Date.now() + 60_000 })));
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/session', async route => {
    await ready;
    await route.fulfill({ json: { account: { id: 'returning-member', display_name: 'Member', role: 'member' }, csrf_token: 'test-only' } });
  });
  // Record every rendered hero, including a transient frame after session resolution.
  await page.addInitScript(() => {
    (window as any).__heroPainted = false;
    new MutationObserver(() => { if (document.querySelector('.exposure-hero')) (window as any).__heroPainted = true; }).observe(document, { childList: true, subtree: true });
  });
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  await page.goto('/#/overview');
  await expect(page.getByRole('heading', { name: 'Opening your workspace…' })).toBeVisible();
  await expect(page.locator('.exposure-hero')).toHaveCount(0);
  release();
  if (draft) {
    await expect(page).toHaveURL(/#\/request$/);
    await expect(page.locator('.request-website')).toContainText('https://example.com');
  } else await expect(page.getByRole('heading', { name: 'Hello, Member.' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__heroPainted)).toBe(false);
  expect(writes).toEqual([]);
});

test('a failed session lookup leaves a usable retry, then opens the public page for a guest', async ({ page }) => {
  await emptyDashboard(page);
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
  let failed = true;
  await page.route('**/api/session', route => failed
    ? route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } })
    : route.fulfill({ json: { account: null, csrf_token: null } }));
  await page.goto('/#/overview');
  await expect(page.getByRole('alert').getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Opening your workspace…' })).toHaveCount(0);
  failed = false;
  await page.getByRole('alert').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.exposure-hero')).toBeVisible();
});
