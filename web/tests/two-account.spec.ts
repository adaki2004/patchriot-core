import { test, expect, type Page } from '@playwright/test';
import { emptyDashboard } from './helpers';

const id = '00000000-0000-4000-8000-000000000002';
const capabilities = ['artex_engine_v1', 'authenticated_http_v1', 'browser_login_v1', 'active_web_v2', 'multi_account_v1'];

async function setup(page: Page, available = true) {
  await emptyDashboard(page);
  await page.route('**/api/session', route => route.fulfill({ json: { account: { id, display_name: 'Member', role: 'member' }, csrf_token: 'test-csrf' } }));
  await page.route('**/api/pentest-tools', route => route.fulfill({ json: capabilities.map(id => ({ id, available: id !== 'multi_account_v1' || available })) }));
}

for (const available of [true, false]) test(`second account setup follows capability availability ${available}`, async ({ page }) => {
  await setup(page, available);
  let submitted: Record<string, any> | undefined;
  await page.route('**/api/pentests', route => { submitted = route.request().postDataJSON(); return route.fulfill({ json: { id } }); });
  await page.goto('/#/request');
  await page.getByRole('button', { name: 'Choose grey-box', exact: true }).click();
  await page.getByLabel('Website URL').fill('https://example.com');
  const second = page.getByRole('checkbox', { name: 'Add a second test account for access comparisons' });
  await expect(second).not.toBeChecked();
  if (available) {
    await second.check();
    await page.getByLabel('Access method').selectOption('bearer');
    await expect(second).toHaveCount(0);
    await page.getByLabel('Access method').selectOption('session');
    await expect(second).not.toBeChecked();
    await second.check();
  } else {
    await expect(second).toBeDisabled();
    await expect(page.getByText('Two-account testing is currently unavailable.')).toBeVisible();
  }
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await page.getByLabel(/I own this website or have explicit permission/).check();
  await page.getByRole('button', { name: 'Continue to verification' }).click();
  await expect.poll(() => !!submitted).toBe(true);
  expect(submitted?.scope.account_policy).toEqual(available ? { allow_password_changes: false } : undefined);
  expect(submitted?.scope.tools.includes('multi_account_v1')).toBe(available);
  expect(submitted?.scope.methods).toEqual(['GET', 'HEAD', 'OPTIONS']);
  expect(submitted).not.toHaveProperty('credentials');
});

test('two account permissions bind credentials to the updated scope and protect the reference account', async ({ page }, info) => {
  await setup(page);
  let target = {
    id, scope: { origins: ['https://example.com'], methods: ['GET', 'HEAD', 'OPTIONS'], profile: 'web_baseline_v1', tools: capabilities.filter(id => id !== 'active_web_v2'), authentication: 'session', browser_login: {}, account_policy: { allow_password_changes: false } },
    scope_sha256: 'a'.repeat(64), permission_note: 'Explicit permission', state: 'approved', expires_at: 9999999999, ownership_verified: true, is_requester: true, can_edit_setup: true, can_set_credentials: true, can_start: false,
  };
  await page.route('**/api/pentests?*', route => route.fulfill({ json: [target] }));
  await page.route(`**/api/pentests/${id}/ownership`, route => route.fulfill({ json: { verified: true, challenges: [] } }));
  const edits: Record<string, any>[] = [];
  await page.route(`**/api/pentests/${id}/setup`, route => {
    const body = route.request().postDataJSON();
    expect(body.scope_sha256).toBe(target.scope_sha256);
    edits.push(body);
    target = { ...target, scope: body.scope, scope_sha256: String(edits.length).repeat(64) };
    return route.fulfill({ json: target });
  });
  let saved: Record<string, any> | undefined;
  await page.route(`**/api/pentests/${id}/credentials`, route => { saved = route.request().postDataJSON(); return route.fulfill({ json: {} }); });
  await page.goto(`/#/pentests/${id}`);
  await page.getByLabel('Account 1 username / email').fill('fixture-testing');
  await page.getByLabel('Account 1 password', { exact: true }).fill('fixture-testing-password');
  await page.getByLabel('Account 2 username / email').fill('fixture-reference');
  await page.getByLabel('Account 2 password', { exact: true }).fill('fixture-reference-password');
  const passwordPermission = page.getByLabel('Allow password-change tests on Account 1', { exact: true });
  const postPermission = page.getByLabel('Allow form and API submissions (POST)');
  await expect(passwordPermission).toBeDisabled();
  await expect(passwordPermission).not.toBeChecked();
  await postPermission.check();
  await passwordPermission.check();
  await expect(postPermission).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save test accounts', exact: true })).toBeDisabled();
  await page.getByLabel(/I authorize form and API submissions/).check();
  await page.getByRole('button', { name: 'Save testing permissions' }).click();
  await expect.poll(() => edits.length).toBe(1);
  expect(edits[0].scope.account_policy).toEqual({ allow_password_changes: true });
  expect(edits[0].scope.tools).toContain('multi_account_v1');
  expect(edits[0].scope.tools).toContain('active_web_v2');
  expect(edits[0].accepts_state_changes).toBe(true);
  await expect(page.getByLabel('Account 2 password', { exact: true })).toHaveValue('fixture-reference-password');
  await expect(page.getByText('We will not request changes to its password or account settings. It helps compare access between accounts.')).toBeVisible();
  await expect(page.getByText(/Password reset and recovery flows remain blocked/)).toBeVisible();
  await page.locator('.pentests-page').screenshot({ path: info.outputPath('two-account-permissions.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Save test accounts', exact: true }).click();
  await expect.poll(() => saved?.scope_sha256).toBe('1'.repeat(64));
  expect(saved?.credentials).toEqual({ kind: 'session_accounts', testing: { username: 'fixture-testing', password: 'fixture-testing-password' }, reference: { username: 'fixture-reference', password: 'fixture-reference-password' } });
  await expect(page.getByLabel('Account 1 password', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Account 2 password', { exact: true })).toHaveValue('');
  expect(JSON.stringify(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })))).not.toContain('fixture-');
  await passwordPermission.uncheck();
  await postPermission.uncheck();
  await page.getByRole('button', { name: 'Save testing permissions' }).click();
  await expect.poll(() => edits.length).toBe(2);
  expect(edits[1].scope.account_policy).toEqual({ allow_password_changes: false });
  expect(edits[1].scope.tools).toContain('multi_account_v1');
  expect(edits[1].scope.tools).not.toContain('active_web_v2');
  expect(edits[1].scope.methods).not.toContain('POST');
  await page.reload();
  await expect(page.getByLabel('Account 1 username / email')).toHaveValue('');
  await expect(page.getByLabel('Account 2 username / email')).toHaveValue('');
});

test('editing two account setup preserves the saved password permission and scope fingerprint', async ({ page }) => {
  await setup(page);
  const target = { id, scope: { origins: ['https://example.com'], methods: ['GET', 'HEAD', 'OPTIONS', 'POST'], profile: 'web_active_v2', tools: capabilities, authentication: 'session', browser_login: { entry_path: '/login' }, account_policy: { allow_password_changes: true } }, scope_sha256: 'a'.repeat(64), permission_note: 'Explicit permission', state: 'pending_approval', expires_at: 9999999999, is_requester: true, can_edit_setup: true, can_start: false };
  await page.route('**/api/pentests?*', route => route.fulfill({ json: [target] }));
  await page.route(`**/api/pentests/${id}/ownership`, route => route.fulfill({ json: { verified: false, challenges: [] } }));
  let saved: Record<string, any> | undefined;
  await page.route(`**/api/pentests/${id}/setup`, route => { saved = route.request().postDataJSON(); return route.fulfill({ json: target }); });
  await page.goto(`/#/pentests/${id}`);
  await page.getByRole('button', { name: 'Your website · Edit' }).click();
  await expect(page.getByRole('checkbox', { name: 'Add a second test account for access comparisons' })).toBeChecked();
  await page.getByLabel('Website URL').fill('https://updated.example');
  await page.getByLabel(/I authorize form and API submissions/).check();
  await page.getByLabel(/I own this website or have explicit permission/).check();
  await page.getByRole('button', { name: 'Save website settings' }).click();
  await expect.poll(() => saved?.scope_sha256).toBe(target.scope_sha256);
  expect(saved?.scope.account_policy).toEqual({ allow_password_changes: true });
  expect(saved?.scope.browser_login).toEqual({ entry_path: '/login' });
  expect(saved?.scope.tools).toContain('multi_account_v1');
  expect(saved).not.toHaveProperty('credentials');
});
