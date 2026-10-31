import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const id = '00000000-0000-4000-8000-000000000100';
const account = { id: '00000000-0000-4000-8000-000000000001', display_name: 'Site owner', role: 'member', auth_method: 'invite' };
const pending = {
  id, request_id: id, requester_id: account.id, scope: { homepage: 'https://example.com/', script_origins: [] }, scope_sha256: '1'.repeat(64), authority_note: 'I operate this owned website.', state: 'pending_approval', created_at: 1793448000, deadline_at: 1793534400, decision_note: null, attempts: 0, error: null, summary: null, evidence_available: false, evidence_expires_at: null,
};

async function setup(page: Page, admin = false) {
  await page.route('**/api/session', route => route.fulfill({ json: { account: { ...account, role: admin ? 'admin' : 'member' }, csrf_token: 'test-csrf' } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 3, online_operators: 1, online_compute_groups: 1 } }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
  await page.route('**/api/site-checks', route => route.fulfill({ json: [pending] }));
  await page.route(`**/api/site-checks/${id}`, route => route.fulfill({ json: pending }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Website checks', exact: true }).click();
}

test('submission fixes scope and permission without pretending to start a scan', async ({ page }) => {
  await setup(page);
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/site-checks', async route => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON();
      expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
      await route.fulfill({ json: pending });
    } else await route.fulfill({ json: [pending] });
  });
  await page.getByRole('button', { name: 'New website snapshot +' }).click();
  await expect(page.getByText('Submitting this form does not start collection.', { exact: false })).toBeVisible();
  await page.getByLabel('Website origin', { exact: true }).fill('https://EXAMPLE.com:443');
  await page.getByLabel('Additional script origins', { exact: false }).fill('https://cdn.example.com');
  await page.getByLabel('Your permission to review this site').fill('I operate this owned website.');
  await page.getByLabel('I own this site or have permission').check();
  await page.getByRole('button', { name: 'Request approval →' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Website evidence' })).toContainText('No website requests have been made.');
  expect(submitted).toMatchObject({ scope: { homepage: 'https://example.com', script_origins: ['https://cdn.example.com'] }, authorized: true, authority_note: 'I operate this owned website.' });
  await expect(page.getByRole('button', { name: 'Record decision' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('invalid origins stay in the form and retries keep the same request identity', async ({ page }) => {
  await setup(page);
  const submissions: { request_id: string }[] = [];
  await page.route('**/api/site-checks', async route => {
    if (route.request().method() === 'POST') {
      submissions.push(route.request().postDataJSON());
      await route.fulfill({ status: 503, json: { error: 'dispatcher_unavailable' } });
    } else await route.fulfill({ json: [] });
  });
  await page.getByRole('button', { name: 'New website snapshot +' }).click();
  await page.getByLabel('Website origin', { exact: true }).fill('https://example.com/private?key=fixture');
  await page.getByLabel('Your permission to review this site').fill('I operate this owned website.');
  await page.getByLabel('I own this site or have permission').check();
  await page.getByRole('button', { name: 'Request approval →' }).click();
  await expect(page.getByRole('alert')).toContainText('without a path');
  expect(submissions).toHaveLength(0);
  await page.getByLabel('Website origin', { exact: true }).fill('https://example.com');
  await page.getByRole('button', { name: 'Request approval →' }).click();
  await expect(page.getByRole('alert')).toContainText('dispatcher is unavailable');
  await page.getByRole('button', { name: 'Request approval →' }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[0].request_id).toBe(submissions[1].request_id);
});

test('admin decision binds the displayed scope and hostile notes stay text', async ({ page }) => {
  await setup(page, true);
  let current = { ...pending, authority_note: '<img src=x onerror=alert(1)> Owned website.' };
  await page.route('**/api/site-checks', route => route.fulfill({ json: [current] }));
  await page.route(`**/api/site-checks/${id}`, route => route.fulfill({ json: current }));
  await page.route(`**/api/site-checks/${id}/decision`, async route => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ action: 'approve', scope_sha256: pending.scope_sha256, reason: 'Verified ownership of this exact fixture.' });
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    current = { ...current, state: 'queued' };
    await route.fulfill({ json: current });
  });
  await page.getByRole('button', { name: 'https://example.com/', exact: false }).click();
  const detail = page.getByRole('region', { name: 'Website evidence' });
  await expect(detail).toContainText('<img src=x onerror=alert(1)>');
  await expect(detail.locator('img, script')).toHaveCount(0);
  await page.getByLabel('Decision note').fill('Verified ownership of this exact fixture.');
  await page.getByLabel('I reviewed the listed origins').check();
  await page.getByRole('button', { name: 'Record decision' }).click();
  await expect(detail.getByRole('heading', { name: 'Approved · waiting' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'https://example.com/', exact: false })).toContainText('Approved · waiting');
  await expect(page.getByRole('button', { name: 'Record decision' })).toHaveCount(0);
});

test('snapshot coverage is explicit and expired evidence is not offered for download', async ({ page }) => {
  await setup(page);
  let available = true;
  await page.route(`**/api/site-checks/${id}`, route => route.fulfill({ json: { ...pending, state: 'collected', evidence_available: available, evidence_expires_at: 1794052800, summary: { homepage_sha256: '2'.repeat(64), external_scripts: 2, inline_scripts: 1, skipped_scripts: 3, script_limit_reached: true, captured_response_bytes: 300000, requests_made: 3, finished_at: 1793448000 } } }));
  await page.getByRole('button', { name: 'https://example.com/', exact: false }).click();
  await expect(page.getByText('Collected does not mean safe.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Snapshot coverage')).toContainText('Skipped scripts');
  await expect(page.getByRole('link', { name: 'Download snapshot JSON ↓' })).toHaveAttribute('href', `/api/site-checks/${id}/evidence`);
  available = false;
  await page.getByRole('button', { name: 'Refresh snapshot ↻' }).click();
  await expect(page.getByRole('link', { name: 'Download snapshot JSON ↓' })).toHaveCount(0);
  await expect(page.getByText('Saved bodies have expired', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
