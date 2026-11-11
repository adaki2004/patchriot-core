import { test, expect, type Page } from '@playwright/test';
import { emptyDashboard } from './helpers';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('../../crates/server/src/analytics.js', import.meta.url), 'utf8');

const consentKey = 'patchriot.workspace-analytics-choice.v2';
const frameOrigin = 'https://counts.patchriot.test';
async function workspace(page: Page, enabled = true) {
  await emptyDashboard(page);
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id: "member", role:"member", display_name:"Private member" }, csrf_token:"fixture-csrf" } }));
  await page.route('**/api/analytics', r => r.fulfill({ json: { enabled, frame_origin: enabled ? frameOrigin : null } }));
  await page.route('**/api/incidents', r => r.fulfill({ json: [] }));
  // Exercise the shipped bridge script on its separate hostname, with the
  // same sandbox and network restrictions as the production frame.
  // Rust route tests separately check the actual HTML and response headers.
  await page.route('**/api/analytics/frame/*', r => {
    const view = new URL(r.request().url()).pathname.split('/').pop();
    const title = 'Patchriot workspace';
    const path = '/workspace/' + view;
    return r.fulfill({ contentType: 'text/html', headers: {
      'content-security-policy': "sandbox allow-scripts allow-same-origin; default-src 'none'; script-src 'nonce-test-nonce' https://www.googletagmanager.com; connect-src https://www.google-analytics.com https://region1.google-analytics.com; frame-ancestors http://127.0.0.1:5174; base-uri 'none'; form-action 'none'",
      'referrer-policy': 'no-referrer',
    }, body: `<script nonce="test-nonce" data-measurement-id="G-EXAMPLE123" data-parent-origin="http://127.0.0.1:5174" data-page-location="http://127.0.0.1:5174${path}" data-page-title="${title}">${bridge}</script>` });
  });
}

test('page counts start without a questionnaire and a manual opt-out persists', async ({ page }, testInfo) => {
  await workspace(page);
  const google: string[] = [];
  await page.route('https://www.googletagmanager.com/**', r => {
    google.push(r.request().url());
    return r.fulfill({ contentType: 'text/javascript', body: '' });
  });
  await page.goto('/#/overview');
  await expect(page.locator('iframe')).toHaveCount(1);
  await expect.poll(() => google.length).toBe(1);
  await expect(page.getByLabel('Page count settings')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Allow page counts' })).toHaveCount(0);
  await page.screenshot({ path: `test-results/analytics-automatic-${testInfo.project.name}.png` });
  await page.getByRole('button', { name: 'Privacy choices' }).click();
  await expect(page.getByText('Workspace page counts are on')).toBeVisible();
  await page.getByRole('button', { name: 'Turn off page counts' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Privacy choices' })).toBeVisible();
  await expect(page.getByLabel('Page count settings')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(google).toHaveLength(1);
  await page.getByRole('button', { name: 'Privacy choices' }).click();
  await expect(page.getByText('Workspace page counts are off')).toBeVisible();
  await page.getByRole('button', { name: 'Turn on page counts' }).click();
  await expect(page.locator('iframe')).toHaveCount(1);
  await expect.poll(() => google.length).toBe(2);
});

test('a previously saved decline is respected before any Google request', async ({ page }) => {
  await workspace(page);
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ choice: 'decline', expires: Date.now() + 86400000 })), consentKey);
  const google: string[] = [];
  page.on('request', r => { if (r.url().includes('google')) google.push(r.url()); });
  await page.goto('/#/overview');
  await expect(page.getByRole('button', { name: 'Privacy choices' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByLabel('Page count settings')).toHaveCount(0);
  expect(google).toEqual([]);
});

test('the shipped bridge cannot read private DOM, cookies, storage or APIs and sends only a fixed workspace category', async ({ page }) => {
  await workspace(page);
  const google: { url: string; referer?: string }[] = [];
  let frameApi = 0;
  page.on('request', r => {
    if (r.url().includes('/api/session') && r.frame() !== page.mainFrame()) frameApi++;
  });
  await page.route('https://www.googletagmanager.com/**', r => {
    google.push({ url: r.request().url(), referer: r.request().headers().referer });
    return r.fulfill({ contentType: 'text/javascript', body: `
      window.probe = {};
      for (const [key, read] of Object.entries({ parent: () => parent.document.body.innerText, storage: () => parent.localStorage.getItem('private-test'), cookie: () => parent.document.cookie })) {
        try { window.probe[key] = read(); } catch { window.probe[key] = 'blocked'; }
      }
      fetch('/api/session').then(() => window.probe.api = 'read').catch(() => window.probe.api = 'blocked');
      window.ownCookies = document.cookie;
      window.commands = window.dataLayer.map(v => Array.from(v));
    ` });
  });
  await page.addInitScript(() => {
    localStorage.setItem('private-test', 'PRIVATE_REPORT');
    document.cookie = 'private-test=PRIVATE_SESSION; SameSite=Strict; Path=/';
    document.addEventListener('DOMContentLoaded', () => {
      const marker = document.createElement('div'); marker.textContent = 'PRIVATE_REPORT'; document.body.append(marker);
    });
  });
  await page.goto('/?email=PRIVATE_EMAIL&token=PRIVATE_TOKEN#/overview');
  await expect.poll(() => google.length).toBe(1);
  const frame = page.frames().find(f => f.url().includes('/api/analytics/frame/dashboard'))!;
  await expect.poll(() => frame.evaluate(() => (window as any).probe?.api)).toBe('blocked');
  expect(await frame.evaluate(() => (window as any).probe)).toEqual({ parent: 'blocked', storage: 'blocked', cookie: 'blocked', api: 'blocked' });
  expect(await frame.evaluate(() => (window as any).ownCookies)).not.toContain('PRIVATE_SESSION');
  expect(new URL(frame.url()).origin).toBe(frameOrigin);
  expect(frameApi).toBe(0);
  expect(google[0].referer).toBeUndefined();
  const commands = await frame.evaluate(() => (window as any).commands);
  expect(JSON.stringify(commands)).not.toMatch(/PRIVATE_|docs\/start|token=|email=/);
  expect(commands).toContainEqual(['event', 'page_view', { page_location: 'http://127.0.0.1:5174/workspace/dashboard', page_title: 'Patchriot workspace', page_referrer: '' }]);
  expect(commands[0]).toEqual(['consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' }]);
  await page.getByRole('button', { name: 'Privacy choices' }).click();
  await page.getByRole('button', { name: 'Turn off page counts' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(google.length).toBe(1);
});

test('public navigation and sign-out remove automatic page counts',async({page})=>{
  await workspace(page);
  await page.addInitScript(key=>localStorage.setItem(key,JSON.stringify({choice:'allow',expires:Date.now()+86400000})),consentKey);
  await page.route('https://www.googletagmanager.com/**',r=>r.fulfill({contentType:'text/javascript',body:''}));
  await page.goto('/#/overview');
  await expect(page.locator('iframe')).toHaveCount(1);
  for(const route of ['/#/home','/#/docs/architecture','/#/incidents']) {
    await page.goto(route);await expect(page.locator('iframe')).toHaveCount(0);
  }
  await page.goto('/#/overview');
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.route('**/api/session',r=>r.fulfill({json:{account:null}}));
  await page.route('**/api/auth/logout',r=>r.fulfill({json:{ok:true}}));
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  for(const route of ['/#/overview','/#/audits','/#/reviews/22222222-2222-4222-8222-222222222222']) {
    await page.goto(route);await expect(page.locator('iframe')).toHaveCount(0);
  }
});

test('disabled configuration and signed-in public pages never load analytics', async ({ page }) => {
  await workspace(page, false);
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ choice: 'allow', expires: Date.now() + 86400000 })), consentKey);
  const google: string[] = [];
  page.on('request', r => { if (r.url().includes('google')) google.push(r.url()); });
  await page.goto('/#/overview');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.route('**/api/analytics', r => r.fulfill({ json: { enabled: true, frame_origin: frameOrigin } }));
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id: 'member', role: 'member', display_name: 'Private member' }, csrf_token: 'fixture-csrf' } }));
  await page.goto('/#/home');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(google).toEqual([]);
});

test('a missing, same-host or invalid analytics origin cannot load third-party code', async ({ page }) => {
  await workspace(page);
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ choice: 'allow', expires: Date.now() + 86400000 })), consentKey);
  const google: string[] = [];
  page.on('request', r => { if (r.url().includes('google')) google.push(r.url()); });
  for (const origin of [null, 'http://127.0.0.1:5174', 'http://127.0.0.1:9999', 'javascript:alert(1)', frameOrigin + '/path']) {
    await page.route('**/api/analytics', r => r.fulfill({ json: { enabled: true, frame_origin: origin } }));
    await page.goto('/#/overview');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
  }
  expect(google).toEqual([]);
});
