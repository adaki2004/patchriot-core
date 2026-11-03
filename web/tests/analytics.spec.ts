import { test, expect, type Page } from '@playwright/test';
import { emptyDashboard } from './helpers';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('../../crates/server/src/analytics.js', import.meta.url), 'utf8');

const consentKey = 'patchriot.analytics-choice.v1';
async function publicPage(page: Page, enabled = true) {
  await emptyDashboard(page);
  await page.route('**/api/session', r => r.fulfill({ json: { account: null } }));
  await page.route('**/api/analytics', r => r.fulfill({ json: { enabled } }));
  await page.route('**/api/incidents', r => r.fulfill({ json: [] }));
  // Exercise the shipped bridge script inside an opaque, CSP-restricted frame.
  // Rust route tests separately check the actual HTML and response headers.
  await page.route('**/api/analytics/frame/*', r => {
    const view = new URL(r.request().url()).pathname.split('/').pop();
    const title = view === 'docs' ? 'Patchriot documentation' : 'Patchriot';
    const path = view === 'home' ? '/' : '/' + view;
    return r.fulfill({ contentType: 'text/html', headers: {
      'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'nonce-test-nonce' https://www.googletagmanager.com; connect-src https://www.google-analytics.com https://region1.google-analytics.com; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      'referrer-policy': 'no-referrer',
    }, body: `<script nonce="test-nonce" data-measurement-id="G-EXAMPLE123" data-parent-origin="http://127.0.0.1:5174" data-page-location="http://127.0.0.1:5174${path}" data-page-title="${title}">${bridge}</script>` });
  });
}

test('analytics is absent until consent and declining persists without Google requests', async ({ page }, testInfo) => {
  await publicPage(page);
  const google: string[] = [];
  page.on('request', r => { if (r.url().includes('google')) google.push(r.url()); });
  await page.goto('/');
  await expect(page.getByLabel('Optional analytics')).toBeVisible();
  await page.screenshot({ path: `test-results/analytics-consent-${testInfo.project.name}.png` });
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(google).toEqual([]);
  await page.getByRole('button', { name: 'No thanks' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Privacy choices' })).toBeVisible();
  await expect(page.getByLabel('Optional analytics')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(google).toEqual([]);
});

test('the shipped bridge cannot read private DOM, cookies, storage or APIs and sends only a fixed public page', async ({ page }) => {
  await publicPage(page);
  const google: { url: string; referer?: string }[] = [];
  let frameApi = 0;
  page.on('request', r => {
    if (r.url().includes('/api/session') && r.frame() !== page.mainFrame()) frameApi++;
  });
  await page.route('https://www.googletagmanager.com/**', r => {
    google.push({ url: r.request().url(), referer: r.request().headers().referer });
    return r.fulfill({ contentType: 'text/javascript', body: `
      window.probe = {};
      for (const [key, read] of Object.entries({ parent: () => parent.document.body.innerText, storage: () => parent.localStorage.getItem('private-test'), cookie: () => document.cookie })) {
        try { window.probe[key] = read(); } catch { window.probe[key] = 'blocked'; }
      }
      fetch('/api/session').then(() => window.probe.api = 'read').catch(() => window.probe.api = 'blocked');
      window.commands = window.dataLayer.map(v => Array.from(v));
    ` });
  });
  await page.goto('/?email=PRIVATE_EMAIL&token=PRIVATE_TOKEN#/docs/start');
  await page.evaluate(() => {
    localStorage.setItem('private-test', 'PRIVATE_REPORT');
    const marker = document.createElement('div'); marker.textContent = 'PRIVATE_REPORT'; document.body.append(marker);
  });
  await page.getByRole('button', { name: 'Allow page counts' }).click();
  await expect.poll(() => google.length).toBe(1);
  const frame = page.frames().find(f => f.url().includes('/api/analytics/frame/docs'))!;
  await expect.poll(() => frame.evaluate(() => (window as any).probe?.api)).toBe('blocked');
  expect(await frame.evaluate(() => (window as any).probe)).toEqual({ parent: 'blocked', storage: 'blocked', cookie: 'blocked', api: 'blocked' });
  expect(frameApi).toBe(0);
  expect(google[0].referer).toBeUndefined();
  const commands = await frame.evaluate(() => (window as any).commands);
  expect(JSON.stringify(commands)).not.toMatch(/PRIVATE_|docs\/start|token=|email=/);
  expect(commands).toContainEqual(['event', 'page_view', { page_location: 'http://127.0.0.1:5174/docs', page_title: 'Patchriot documentation', page_referrer: '' }]);
  expect(commands[0]).toEqual(['consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' }]);
  await page.getByRole('button', { name: 'Privacy choices' }).click();
  await page.getByRole('button', { name: 'No thanks' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(google.length).toBe(1);
});

test('private navigation and opening sign-in remove the frame even after consent', async ({ page }) => {
  await publicPage(page);
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ choice: 'allow', expires: Date.now() + 86400000 })), consentKey);
  const google: string[] = [];
  await page.route('https://www.googletagmanager.com/**', r => { google.push(r.request().url()); return r.fulfill({ contentType: 'text/javascript', body: '' }); });
  await page.goto('/');
  await expect.poll(() => google.length).toBe(1);
  await page.getByRole('navigation', { name: 'Website', exact: true }).getByRole('button', { name: 'App' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  for (const path of ['/#/orders/11111111-1111-4111-8111-111111111111', '/#/reviews/22222222-2222-4222-8222-222222222222', '/#/pentests', '/#/reviews/invalid-private-id', '/activate#' + 'a'.repeat(64)]) {
    await page.goto(path);
    await expect(page.locator('iframe')).toHaveCount(0);
  }
  expect(google.length).toBe(1);
});

test('disabled configuration and signed-in public pages never load analytics', async ({ page }) => {
  await publicPage(page, false);
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ choice: 'allow', expires: Date.now() + 86400000 })), consentKey);
  const google: string[] = [];
  page.on('request', r => { if (r.url().includes('google')) google.push(r.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.route('**/api/analytics', r => r.fulfill({ json: { enabled: true } }));
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id: 'member', role: 'member', display_name: 'Private member' }, csrf_token: 'fixture-csrf' } }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(google).toEqual([]);
});
