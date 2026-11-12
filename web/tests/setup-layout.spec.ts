import { test, expect } from '@playwright/test';
import { emptyDashboard } from './helpers';

const id = '00000000-0000-4000-8000-000000000002';

for (const step of [2, 3] as const) test(`saved setup step ${step} keeps its content and controls readable`, async ({ page }, info) => {
  const writes: string[] = [];
  await page.route('**/api/**', route => {
    if (route.request().method() !== 'GET') {
      writes.push(route.request().url());
      return route.fulfill({ status: 405, json: { error: 'read_only_layout_fixture' } });
    }
    return route.fallback();
  });
  await emptyDashboard(page);
  await page.route('**/api/session', route => route.fulfill({ json: { account: { id, display_name: 'Setup fixture', role: step === 3 ? 'admin' : 'member' }, csrf_token: 'fixture' } }));
  const target = {
    id, scope: { origins: ['https://staging.example.test'], methods: ['GET', 'HEAD', 'OPTIONS', 'POST'], profile: 'web_active_v2', tools: ['artex_engine_v1', 'active_web_v2', 'run_context_v1'] },
    scope_sha256: 'a'.repeat(64), permission_note: 'Owned fixture', expires_at: 9999999999,
    state: step === 3 ? 'approved' : 'pending_approval', ownership_verified: false, staff_authorized: step === 3,
    can_staff_authorize: false, is_requester: true, can_edit_setup: true, can_start: step === 3,
  };
  const team = [1, 2, 3].map(i => ({ device_id: `00000000-0000-4000-8000-00000000001${i}`, operator_id: id, operator_name: 'Patchriot managed team', device_name: `Worker ${i}`, declared_model: 'deepseek-v4-1-flash-1017-uncensored', compute_group: 'fixture' }));
  await page.route('**/api/pentests?*', route => route.fulfill({ json: [target] }));
  await page.route('**/api/pentest-tools', route => route.fulfill({ json: ['artex_engine_v1', 'active_web_v2', 'run_context_v1'].map(id => ({ id, available: true })) }));
  await page.route(`**/api/pentests/${id}/ownership`, route => route.fulfill({ json: { verified: false, challenges: [{ domain: 'staging.example.test', record_name: '_patchriot.staging.example.test', record_value: 'patchriot-domain-verification=' + 'b'.repeat(64), state: 'pending', expires_at: 9999999999, checking_until: null }] } }));
  await page.route(`**/api/pentests/${id}/review-plan`, route => route.fulfill({ json: { pentest_id: id, scope_sha256: target.scope_sha256, candidates: team, recommended_device_ids: team.map(t => t.device_id), provider: 'venice.ai', fallback_model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated', recommended_worker_pool: true, recommended_review_policy: 'investigate_validate_v1' } }));
  await page.route('**/api/checkout', route => route.fulfill({ json: { mode: 'paid' } }));
  await page.route(`**/api/pentests/${id}/credit-offer`, route => route.fulfill({ json: { amount_cents: 199, available_cents: 500, scope_sha256: target.scope_sha256 } }));
  await page.goto(`/#/pentests/${id}`);
  const setup = page.locator('.pentests-page');
  await expect(setup).toHaveAttribute('data-setup-step', String(step));
  const back = page.getByRole('button', { name: '← Back to website settings' });
  const backStyle = await back.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, padding: parseFloat(style.paddingLeft), height: element.getBoundingClientRect().height };
  });
  expect(backStyle.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(backStyle.padding).toBeGreaterThanOrEqual(16);
  expect(backStyle.height).toBeGreaterThanOrEqual(44);
  if (step === 2) {
    await expect(page.getByRole('button', { name: 'Copy DNS value for staging.example.test' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check DNS record', exact: true })).toBeEnabled();
    await expect(page.getByText(/Each check below lasts five minutes/)).toBeVisible();
  } else {
    await expect(page.getByText('Ownership approved by an administrator', { exact: true })).toBeVisible();
    await expect(page.getByText(/without a DNS check/)).toBeVisible();
    await expect(page.getByText(/it is not an approval fee/)).toBeVisible();
    await expect(page.getByText('Backup:', { exact: false })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /I allow these named operators/ })).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Use $1.99 & start test' })).toBeDisabled();
    const consent = await page.locator('.assessment-team-consent').boundingBox();
    const payment = await page.locator('.assessment-payment').boundingBox();
    const actions = await page.locator('.assessment-payment .assessment-actions').boundingBox();
    const start = await page.getByRole('button', { name: 'Use $1.99 & start test' }).boundingBox();
    expect(Math.abs(start!.width - actions!.width)).toBeLessThan(1);
    const width = (await setup.boundingBox())!.width;
    if (width > 800) expect(payment!.x).toBeGreaterThan(consent!.x + consent!.width);
    else expect(payment!.y).toBeGreaterThanOrEqual(consent!.y + consent!.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await setup.screenshot({ path: info.outputPath(`step-${step}.png`) });
  await back.click();
  await expect(page.getByLabel('Website URL')).toHaveValue('https://staging.example.test');
  await expect(setup).not.toHaveAttribute('data-setup-step', /.+/);
  await page.getByRole('button', { name: 'Cancel changes' }).click();
  await expect(setup).toHaveAttribute('data-setup-step', String(step));
  expect(writes).toEqual([]);
});
