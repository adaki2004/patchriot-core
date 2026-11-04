import { expect, test, type Page } from '@playwright/test';
import { emptyDashboard } from './helpers';

const id = '00000000-0000-4000-8000-000000000002';
const coupon = { id, code: `pr-${'a'.repeat(64)}`, expires_at: '2099-01-08T00:00:00Z', reserved_at: null, review_id: null, revoked_at: null };
async function session(page: Page, role = 'member') {
  await emptyDashboard(page);
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id, display_name: 'Example owner', role }, csrf_token: 'test-csrf' } }));
}

test('sign-in offers a trial; only an explicit request claims it and reload recovers it', async ({ page }, info) => {
  await session(page);
  let writes = 0;
  await page.route('**/api/trial', r => {
    if (r.request().method() === 'POST') {
      expect(r.request().headers()['x-csrf-token']).toBe('test-csrf');
      expect(r.request().postDataJSON()).toEqual({ accepts_trial: true });
      writes++; return r.fulfill({ json: coupon });
    }
    return r.fulfill({ json: { available: !writes, ends_at: '2099-01-02T00:00:00Z', claim: writes ? coupon : null } });
  });
  await page.goto('/#/overview');
  const trial = page.getByRole('complementary', { name: 'Free trial' });
  await expect(trial.getByRole('button', { name: 'Request my free test' })).toBeVisible();
  expect(writes).toBe(0);
  await trial.getByRole('button', { name: 'Request my free test' }).click();
  await expect(trial.getByRole('heading')).toHaveText('Your free test is ready.');
  await expect(trial.getByRole('heading')).toHaveCSS('color', 'rgb(21, 33, 57)');
  await page.reload();
  await trial.getByText('Your personal coupon', { exact: true }).click();
  await expect(trial.locator('code')).toHaveText(coupon.code);
  expect(writes).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('trial-dashboard.png'), fullPage: true });
  await trial.getByRole('button', { name: 'Start my free test' }).click();
  await expect(page).toHaveURL(/#\/request$/);
  await expect(page.getByRole('button', { name: /black.box/i })).toBeVisible();
});

test('a requested coupon fills checkout but does not submit work or replace consent', async ({ page }) => {
  await session(page);
  await page.route('**/api/trial', r => r.fulfill({ json: { available: false, ends_at: null, claim: coupon } }));
  const target = { id, scope: { origins: ['https://owned.example'], methods: ['GET', 'HEAD', 'OPTIONS'] }, scope_sha256: 'a'.repeat(64), state: 'approved', ownership_verified: true, is_requester: true, can_start: true, expires_at: 9999999999 };
  const team = [1, 2, 3].map(i => ({ device_id: `00000000-0000-4000-8000-00000000001${i}`, operator_id: id, operator_name: 'Example operator', device_name: `Kali ${i}`, declared_model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated', compute_group: 'one-host' }));
  await page.route('**/api/pentests?*', r => r.fulfill({ json: [target] }));
  await page.route('**/api/checkout', r => r.fulfill({ json: { mode: 'coupons' } }));
  await page.route(`**/api/pentests/${id}/review-plan`, r => r.fulfill({ json: { pentest_id: id, scope_sha256: target.scope_sha256, candidates: team, recommended_device_ids: team.map(t => t.device_id), provider: 'near.ai' } }));
  let starts = 0;
  await page.route(`**/api/pentests/${id}/review-code`, r => { starts++; return r.fulfill({ status: 409, json: { error: 'request_conflict' } }); });
  await page.goto(`/#/pentests/${id}`);
  await page.getByRole('button', { name: 'Use my free-test coupon' }).click();
  await expect(page.getByLabel('Free-test coupon', { exact: true })).toHaveValue(coupon.code);
  const start = page.getByRole('button', { name: 'Use coupon & start test' });
  await expect(start).toBeDisabled();
  expect(starts).toBe(0);
  await page.getByRole('checkbox', { name: /I allow these named operators/ }).check();
  await expect(start).toBeEnabled();
});

test('admin gets full totals and explicitly opens and stops a capped campaign', async ({ page }, info) => {
  await session(page, 'admin');
  const writes: unknown[] = [];
  let campaign: null | { ends_at: string; stopped_at: null; claim_limit: number; claimed: number } = null;
  await page.route('**/api/admin/trial', r => {
    if (r.request().method() === 'POST') {
      const input = r.request().postDataJSON(); writes.push(input);
      expect(r.request().headers()['x-csrf-token']).toBe('test-csrf');
      campaign = input.action === 'start' ? { ends_at: '2099-01-03T00:00:00Z', stopped_at: null, claim_limit: input.claim_limit, claimed: 0 } : null;
      return r.fulfill({ json: { ok: true } });
    }
    return r.fulfill({ json: { campaign, total_claimed: 12, reserved: 8, started: 7 } });
  });
  await page.route('**/api/admin/review-stats', r => r.fulfill({ json: { requested: 126, live_requested: 120, awaiting_verification: 4, review_runs: 200, awaiting_payment: 2, queued: 3, running: 2, completed: 180, needs_review: 10, failed: 1, cancelled: 2, as_of: 1793808000 } }));
  await page.goto('/#/audit-desk');
  await expect(page.getByRole('heading', { name: 'Audit activity' })).toBeVisible();
  const totals = page.getByRole('region', { name: 'Network usage' });
  await expect(totals).toContainText('126');
  await expect(totals).toContainText('180');
  await expect(totals).toContainText('Counts include records beyond the recent list');
  await page.getByLabel('Claim window').selectOption('48');
  await page.getByLabel('Maximum free assessments').fill('25');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Open free-test campaign' }).click();
  await expect(page.getByRole('button', { name: 'Stop new claims' })).toBeVisible();
  expect(writes).toEqual([{ action: 'start', hours: 48, claim_limit: 25 }]);
  await page.screenshot({ path: info.outputPath('admin-trial.png'), fullPage: true });
  await page.getByRole('button', { name: 'Stop new claims' }).click();
  await expect(page.getByRole('button', { name: 'Open free-test campaign' })).toBeVisible();
  expect(writes[1]).toEqual({ action: 'stop' });
});

test('closed or exhausted trials do not advertise free work; members do not read admin stats', async ({ page }) => {
  await session(page);
  const reads: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/admin/')) reads.push(r.url()); });
  await page.goto('/#/overview');
  await expect(page.getByRole('heading', { name: 'Hello, Example owner.' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Free trial' })).toHaveCount(0);
  await page.goto('/#/audits');
  await expect(page.getByRole('region', { name: 'Network usage' })).toHaveCount(0);
  expect(reads).toHaveLength(0);
});
