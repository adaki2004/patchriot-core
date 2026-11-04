import { emptyDashboard } from './helpers';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => { await emptyDashboard(page); });

const admin = { id: '00000000-0000-4000-8000-000000000001', display_name: 'Owner', role: 'admin', auth_method: 'password' };
const member = { ...admin, id: '00000000-0000-4000-8000-000000000002', display_name: 'Judge', role: 'member' };
const invitation = 'a'.repeat(64);
const coupon = { id: '00000000-0000-4000-8000-000000000003', code: `pr-${'b'.repeat(64)}`, expires_at: '2027-01-08T12:00:00Z' };
const grant = { account_id: member.id, invitation, expires_at: '2027-01-02T12:00:00Z', coupon };

async function setup(page: Page, account: typeof admin | null = null) {
  await page.route('**/api/session', route => route.fulfill({ json: { account, csrf_token: account ? 'test-csrf' : null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 0, online_operators: 0, online_compute_groups: 0 } }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
}

test('password login is persistent and clears sensitive fields after success', async ({ page }) => {
  await setup(page);
  let sent: unknown;
  await page.route('**/api/auth/login', async route => {
    sent = route.request().postDataJSON();
    await page.route('**/api/session', request => request.fulfill({ json: { account: admin, csrf_token: 'test-csrf' } }));
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/#/home');
  await page.locator('header').getByRole('button', { name: 'App' }).click();
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('owner_example');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: 'Open workspace →', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(sent).toEqual({ username: 'owner_example', password: 'browser-test-password' });
  await page.reload();
  await page.getByText('Administration', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Access & users', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test('an activation fragment is removed and a failed session read does not redeem it twice', async ({ page }) => {
  await setup(page);
  let activations = 0, reads = 0;
  await page.route('**/api/auth/activate', route => {
    activations++;
    expect(route.request().postDataJSON()).toEqual({ code: invitation, username: 'new_judge', password: 'browser-test-password' });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/session', route => {
    if (!activations) return route.fulfill({ json: { account: null, csrf_token: null } });
    if (++reads === 1) return route.fulfill({ status: 503, json: { error: 'database_unavailable' } });
    return route.fulfill({ json: { account: member, csrf_token: 'test-csrf' } });
  });
  await page.goto(`/activate#${invitation}`);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Set up your account' })).toBeVisible();
  await expect(page.getByLabel('Invitation code')).toHaveValue(invitation);
  await page.getByLabel('Username', { exact: true }).fill('new_judge');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: 'Create password and sign in' }).click();
  await expect(page.getByRole('region', { name: 'Account access' }).getByRole('alert')).toContainText('Account storage');
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry opening workspace' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(activations).toBe(1);
});

test('SSO replaces public registration while pilot sign-in stays available', async ({ page }) => {
  await setup(page);
  await page.route('**/api/auth/providers', route => route.fulfill({ json: { github: true, google: true } }));
  await page.goto('/');
  await page.locator('.access-invitation').getByRole('button', { name: 'Get started' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in', exact: true });
  await expect(dialog.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(dialog.getByLabel('Username', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Your name')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Existing pilot account' }).click();
  await expect(dialog.getByLabel('Username', { exact: true })).toBeVisible();
});

for (const provider of ['github', 'google']) test(`starts ${provider} only through the same-origin POST`, async ({ page }) => {
  await setup(page);
  await page.route('**/api/auth/providers', route => route.fulfill({ json: { github: true, google: true } }));
  const destination = provider === 'github' ? 'https://github.com/login/oauth/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth';
  let started = 0;
  await page.route(`**/api/auth/${provider}/start`, route => {
    started++; expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON()).toEqual({});
    const url = new URL(destination); url.searchParams.set('redirect_uri', `${new URL(route.request().url()).origin}/api/auth/${provider}/callback`); url.searchParams.set('state', 'a'.repeat(64)); url.searchParams.set('response_type', 'code');
    return route.fulfill({ json: { authorization_url: url.href } });
  });
  // A local fixture answers navigation; this test never calls a provider.
  await page.route(`${destination}**`, route => route.fulfill({ contentType: 'text/html', body: '<p>Provider sign-in fixture</p>' }));
  await page.goto('/'); await page.locator('header').getByRole('button', { name: 'App' }).click();
  await page.getByRole('button', { name: `Continue with ${provider === 'github' ? 'GitHub' : 'Google'}` }).click();
  await expect(page).toHaveURL(new RegExp(provider === 'github' ? '^https://github\\.com/login/oauth/authorize' : '^https://accounts\\.google\\.com/o/oauth2/v2/auth'));
  expect(started).toBe(1);
});

test('rejects an unexpected OAuth destination and clears generic callback failure from the URL', async ({ page }) => {
  await setup(page);
  await page.route('**/api/auth/providers', route => route.fulfill({ json: { github: true, google: false } }));
  await page.route('**/api/auth/github/start', route => route.fulfill({ json: { authorization_url: 'https://attacker.example/?secret=bad' } }));
  await page.goto('/?signin=failed#/request');
  await expect(page).toHaveURL(/\/#\/request$/);
  await expect(page.getByText('Sign-in was not completed. Please try again.')).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Sign in', exact: true });
  await dialog.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Sign-in could not be started');
  await expect(page).toHaveURL(/\/#\/request$/);
  await expect(dialog.getByRole('button', { name: 'Continue with GitHub' })).toBeEnabled();
});

test('admin can approve access and share an account-specific setup link and coupon', async ({ page }) => {
  await setup(page, admin);
  let approved = false;
  await page.route('**/api/admin/access', route => route.fulfill({ json: {
    requests: [{ id: member.id, display_name: 'Judge', email: 'judge@example.com', note: 'Review my project.', status: approved ? 'approved' : 'pending', created_at: '2026-11-01T10:00:00Z', account_id: approved ? member.id : null }],
    accounts: [{ ...admin, contact_email: null, username: 'owner_example', disabled: false, unused_coupons: 0 }, ...(approved ? [{ ...member, contact_email: 'judge@example.com', username: null, disabled: false, unused_coupons: 1 }] : [])],
  } }));
  await page.route(`**/api/admin/access/${member.id}/decision`, route => {
    expect(route.request().postDataJSON()).toEqual({ decision: 'approve', with_coupon: true });
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf'); approved = true;
    return route.fulfill({ json: grant });
  });
  await page.goto('/#/access-desk');
  await page.getByRole('button', { name: 'Approve Judge', exact: true }).click();
  const details = page.getByLabel('Private access details', { exact: true });
  await expect(details).toContainText(`/activate#${invitation}`);
  await expect(details).toContainText(coupon.code);
  await page.getByRole('button', { name: 'Close private access details' }).click();
  await expect(page.getByText('No pending requests.')).toBeVisible();
  await expect(page.getByText('Password not set', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(coupon.code, { exact: false })).toHaveCount(0);
});

test('member bookmarks cannot open the access desk or fetch its contents', async ({ page }) => {
  await setup(page, member);
  let reads = 0;
  await page.route('**/api/admin/access', route => { reads++; return route.fulfill({ status: 403, json: { error: 'admin_required' } }); });
  await page.goto('/#/access-desk');
  await expect(page.getByRole('heading', { name: 'Administrator access required.' })).toBeVisible();
  expect(reads).toBe(0);
});


test('a pending provider redirect cannot race a password sign-in or close the dialog', async ({ page }) => {
  await setup(page);
  await page.route('**/api/auth/providers', route => route.fulfill({ json: { github: true, google: true } }));
  let release!: () => void, started = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/github/start', async route => { started = true; await pending; return route.fulfill({ status: 503, json: { error: 'sso_unavailable' } }); });
  try {
    await page.goto('/'); await page.locator('header').getByRole('button', { name: 'App' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in', exact: true });
    await dialog.getByRole('button', { name: 'Existing pilot account' }).click();
    await dialog.getByRole('button', { name: 'Continue with GitHub' }).click();
    await expect.poll(() => started).toBe(true);
    await expect(dialog.getByLabel('Username', { exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Open workspace →' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    release();
    await expect(dialog.getByRole('alert')).toContainText('not available');
    await expect(dialog.getByLabel('Username', { exact: true })).toBeEnabled();
  } finally { release(); }
});
