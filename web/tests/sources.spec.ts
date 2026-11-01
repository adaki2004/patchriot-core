import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const id = '00000000-0000-4000-8000-000000000150';
const reviewId = '00000000-0000-4000-8000-000000000250';
const owner = '00000000-0000-4000-8000-000000000001';
const pending = { id, request_id: id, title: 'Owned access module', objective: 'Check record access.', permission_note: 'I wrote this example.', state: 'pending_approval', bundle_sha256: 'a'.repeat(64), files: [{ path: 'access.py', bytes: 42, sha256: 'b'.repeat(64) }], created_at: 1793448000, expires_at: 2000000000, decision_note: null, can_delete: true };
const team = [1, 2, 3].map(i => ({ device_id: `00000000-0000-4000-8000-00000000000${i + 4}`, operator_id: owner, operator_name: 'One operator', device_name: `CPU agent ${i}`, declared_model: 'test-model', compute_group: 'same-machine' }));

async function setup(page: Page, admin = false) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { account: { id: owner, display_name: 'Source owner', role: admin ? 'admin' : 'member' }, csrf_token: 'fixture-csrf' } });
    if (path === '/api/fleet') return route.fulfill({ json: { online_devices: 3, online_operators: 1, online_compute_groups: 1 } });
    if (path === '/api/checkout') return route.fulfill({ json: { mode: 'pilot', offer: null } });
    if (path === '/api/sources') return route.fulfill({ json: [pending] });
    if (path === `/api/sources/${id}`) return route.fulfill({ json: pending });
    if (path === `/api/sources/${id}/review-plan`) return route.fulfill({ json: { source_id: id, snapshot_sha256: 'a'.repeat(64), candidates: team, recommended_device_ids: team.map(device => device.device_id), review_timeout_seconds: 2100 } });
    if (['/api/incidents', '/api/devices', '/api/reviews', '/api/review-codes'].includes(path)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.goto('/#/sources');
}
async function fillUpload(page: Page) {
  await page.getByRole('button', { name: 'Upload source files +' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Owned access module');
  await page.getByLabel('What should the agents check?').fill('Check record access.');
  await page.getByLabel('Your permission to share this code').fill('I wrote this example.');
  await page.getByLabel('I have permission to share these files').check();
}
const file = { name: 'access.py', mimeType: 'text/plain', buffer: Buffer.from('def read(user, owner, data):\n    return data\n') };

test('uploads source as text with explicit storage consent and no automatic agent work', async ({ page }) => {
  await setup(page);
  let submitted: any;
  await page.route('**/api/sources', async route => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON();
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      return route.fulfill({ json: pending });
    }
    return route.fulfill({ json: [pending] });
  });
  await fillUpload(page);
  await page.getByLabel('Source files', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: 'Upload for approval →' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Source upload' })).toContainText('No agent has received these files.');
  expect(submitted).toMatchObject({ accepts_private_storage: true, files: [{ path: 'access.py', text: file.buffer.toString() }] });
  await expect(page.getByRole('button', { name: 'Prepare source review →' })).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('return data');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('archives, invalid UTF-8 and oversized files never reach the server', async ({ page }) => {
  await setup(page); await fillUpload(page);
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST') posts++; });
  for (const [input, message] of [
    [{ ...file, name: 'project.zip' }, 'plain source files'],
    [{ ...file, buffer: Buffer.from([0xff, 0xfe]) }, 'not valid UTF-8'],
    [{ ...file, buffer: Buffer.alloc(16 * 1024 + 1, 'x') }, 'at most 16 KiB'],
  ] as const) {
    await page.getByLabel('Source files', { exact: true }).setInputFiles(input);
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(page.getByRole('button', { name: 'Upload for approval →' })).toBeDisabled();
  }
  expect(posts).toBe(0);
});

test('unchanged failed uploads retain their request identity', async ({ page }) => {
  await setup(page); const ids: string[] = [];
  await page.route('**/api/sources', route => {
    if (route.request().method() === 'POST') { ids.push(route.request().postDataJSON().request_id); return route.fulfill({ status: 503, json: { error: 'dispatcher_unavailable' } }); }
    return route.fulfill({ json: [] });
  });
  await fillUpload(page); await page.getByLabel('Source files', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: 'Upload for approval →' }).click();
  await expect(page.getByRole('alert')).toContainText('dispatcher is unavailable');
  await page.getByRole('button', { name: 'Upload for approval →' }).click();
  await expect.poll(() => ids.length).toBe(2); expect(ids[1]).toBe(ids[0]);
  await page.getByLabel('Title', { exact: true }).fill('Changed scope label');
  await page.getByRole('button', { name: 'Upload for approval →' }).click();
  await expect.poll(() => ids.length).toBe(3); expect(ids[2]).not.toBe(ids[0]);
});

test('approval is deliberate and a team cannot receive source without separate consent', async ({ page }) => {
  await setup(page, true); let state = 'pending_approval';
  await page.route(`**/api/sources/${id}`, route => route.fulfill({ json: { ...pending, state } }));
  await page.route(`**/api/sources/${id}/decision`, route => {
    expect(route.request().postDataJSON()).toEqual({ approve: true, note: 'Verified this owned module.' });
    state = 'approved'; return route.fulfill({ json: { ...pending, state } });
  });
  await page.getByRole('button', { name: 'Owned access module', exact: false }).click();
  await page.getByRole('combobox', { name: 'Decision', exact: true }).selectOption('approve');
  await page.getByLabel('Decision note').fill('Verified this owned module.');
  await page.getByLabel('I checked the requested scope').check();
  await page.getByRole('button', { name: 'Record source decision' }).click();
  await page.getByRole('button', { name: 'Prepare source review →' }).click();
  await expect(page.getByRole('dialog')).toContainText('do not install dependencies, build or execute your code');
  await expect(page.getByRole('dialog')).toContainText('3 devices · 1 operator · 1 declared compute group');
  await expect(page.getByLabel('I allow these three devices')).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Share snapshot & start review →' })).toBeDisabled();
  let consent: any;
  await page.route(`**/api/sources/${id}/review`, route => { consent = route.request().postDataJSON(); return route.fulfill({ json: { id: reviewId } }); });
  await page.getByLabel('I allow these three devices').check();
  await page.getByRole('button', { name: 'Share snapshot & start review →' }).click();
  await expect(page).toHaveURL(new RegExp(`#/reviews/${reviewId}$`));
  expect(consent).toMatchObject({ accepts_operator_access: true, snapshot_sha256: 'a'.repeat(64), device_ids: team.map(device => device.device_id) });
});

test('deleting files requires confirmation and removes the download and review action', async ({ page }) => {
  await setup(page); let state = 'approved';
  await page.route(`**/api/sources/${id}`, route => route.fulfill({ json: { ...pending, state } }));
  await page.route(`**/api/sources/${id}/delete`, route => { state = 'deleted'; return route.fulfill({ json: { ...pending, state } }); });
  await page.goto(`/#/sources/${id}`);
  await expect(page.getByRole('link', { name: 'Download source JSON ↓' })).toHaveAttribute('href', `/api/sources/${id}/evidence`);
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('Existing reports and quotations remain'); await dialog.accept(); });
  await page.getByRole('button', { name: 'Delete uploaded files' }).click();
  await expect(page.getByRole('region', { name: 'Source upload' })).toContainText('Files deleted');
  await expect(page.getByRole('link', { name: 'Download source JSON ↓' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prepare source review →' })).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('region', { name: 'Source upload' })).toContainText('Files deleted');
});

test('unknown private upload displays an error rather than another account’s record', async ({ page }) => {
  await setup(page);
  await page.route(`**/api/sources/${id}`, route => route.fulfill({ status: 404, json: { error: 'not_found' } }));
  await page.goto(`/#/sources/${id}`);
  const detail = page.getByRole('region', { name: 'Source upload' });
  await expect(detail.getByRole('heading', { name: 'Upload unavailable' })).toBeVisible();
  await expect(detail.getByRole('link')).toHaveCount(0);
});
