import { test, expect, type Page } from '@playwright/test';
import { emptyDashboard } from './helpers';

const id = 'G-EXAMPLE123';
async function setup(page: Page, signedIn = false, config: object = { enabled: true, measurement_id: id }) {
  await emptyDashboard(page);
  await page.route('**/api/session', r => r.fulfill({ json: {
    account: signedIn ? { id: 'PRIVATE_ACCOUNT', role: 'member', display_name: 'PRIVATE_NAME' } : null,
    csrf_token: signedIn ? 'fixture-csrf' : null,
  } }));
  await page.route('**/api/analytics', r => r.fulfill({ json: config }));
  await page.route('**/api/incidents', r => r.fulfill({ json: [] }));
  await page.route('**/api/reviews/*', r => r.fulfill({ status: 404, json: { error: 'not_found' } }));
  const scripts: string[] = [];
  await page.route('https://www.googletagmanager.com/**', r => {
    scripts.push(r.request().url());
    return r.fulfill({ contentType: 'text/javascript', body: '' });
  });
  return scripts;
}
const commands = (page: Page) => page.evaluate(() => ((window as any).dataLayer || []).map((v: IArguments) => Array.from(v)));
const views = async (page: Page) => (await commands(page)).filter((v: unknown[]) => v[0] === 'event' && v[1] === 'page_view');

test('public homepage loads the standard tag once without a popup and counts SPA navigation', async ({ page, baseURL }) => {
  const scripts = await setup(page);
  await page.goto('/');
  await expect.poll(() => scripts.length).toBe(1);
  expect(scripts).toEqual(['https://www.googletagmanager.com/gtag/js?id=' + id]);
  await expect.poll(async () => (await views(page)).length).toBe(1);
  expect((await views(page))[0][2]).toEqual({ page_location: baseURL + '/', page_title: 'Patchriot', page_referrer: '' });
  await expect(page.getByRole('button', { name: 'Privacy choices' })).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Website' }).getByRole('button', { name: 'Docs', exact: true }).click();
  await expect.poll(async () => (await views(page)).length).toBe(2);
  expect((await views(page))[1][2].page_location).toBe(baseURL + '/docs');
  await page.getByRole('navigation', { name: 'Website' }).getByRole('button', { name: 'Recent events' }).click();
  await expect.poll(async () => (await views(page)).length).toBe(3);
  await page.goBack();
  await expect.poll(async () => (await views(page)).length).toBe(4);
  expect((await views(page))[3][2].page_location).toBe(baseURL + '/docs');
  expect(scripts).toHaveLength(1);
  const all = await commands(page);
  expect(all.filter((v: unknown[]) => v[0] === 'js')).toHaveLength(1);
  expect(JSON.stringify(all)).not.toContain('analytics_storage');
  expect(all.find((v: unknown[]) => v[0] === 'config')[2]).toMatchObject({ send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false });
});

test('private page events and engagement defaults omit identifiers, queries and raw titles', async ({ page, baseURL }) => {
  const scripts = await setup(page, true);
  await page.addInitScript(() => { document.title = 'PRIVATE_REPORT'; });
  await page.goto('/?email=PRIVATE_EMAIL&token=PRIVATE_TOKEN#/reviews/22222222-2222-4222-8222-222222222222');
  await expect.poll(() => scripts.length).toBe(1);
  await expect.poll(async () => (await views(page)).length).toBe(1);
  expect((await views(page))[0][2]).toEqual({ page_location: baseURL + '/workspace/report', page_title: 'Patchriot report', page_referrer: '' });
  const all = await commands(page);
  expect(JSON.stringify(all)).not.toMatch(/PRIVATE_|22222222|fixture-csrf/);
  expect(all.find((v: unknown[]) => v[0] === 'set' && typeof v[1] === 'object')[1]).toEqual((await views(page))[0][2]);
  await page.getByRole('navigation', { name: 'Website' }).getByRole('button', { name: 'Home', exact: true }).click();
  await expect.poll(async () => (await views(page)).length).toBe(2);
  expect((await views(page))[1][2].page_location).toBe(baseURL + '/');
  expect(scripts).toHaveLength(1);
});

test('activation and wallet pages never initialize Google', async ({ page }) => {
  const scripts = await setup(page);
  for (const path of ['/activate#' + 'a'.repeat(64), '/wallet']) {
    await page.goto(path);
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(await commands(page)).toEqual([]);
  }
  expect(scripts).toEqual([]);
});

test('disabled or malformed configuration never loads Google and does not break navigation', async ({ page }) => {
  const scripts = await setup(page);
  for (const config of [
    { enabled: false, measurement_id: id },
    { enabled: true, measurement_id: null },
    { enabled: true, measurement_id: 'G-EXAMPLE?token=SECRET' },
    { enabled: true, measurement_id: 'https://elsewhere.example/script.js' },
  ]) {
    await page.route('**/api/analytics', r => r.fulfill({ json: config }));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await commands(page)).toEqual([]);
  }
  expect(scripts).toEqual([]);
});

test('private workspace counters run only with a session and Google failures do not block the app', async ({ page }) => {
  await setup(page, true, { enabled: true, measurement_id: id, workspace_counts_enabled: true });
  await page.route('https://www.googletagmanager.com/**', r => r.abort());
  let activity = 0;
  await page.route('**/api/analytics/activity', r => { activity++; return r.fulfill({ json: { ok: true } }); });
  await page.goto('/#/overview');
  await expect(page.getByRole('heading', { name: 'Hello, PRIVATE_NAME.' })).toBeVisible();
  await expect.poll(() => activity).toBe(1);
  await page.getByRole('navigation', { name: 'Website' }).getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(activity).toBe(1);
  await page.route('**/api/session', r => r.fulfill({ json: { account: null } }));
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(activity).toBe(1);
});
