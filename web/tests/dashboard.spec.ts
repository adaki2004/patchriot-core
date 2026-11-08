import { emptyDashboard, openAuditTool } from './helpers';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => { await emptyDashboard(page); });

const account = { id: '00000000-0000-4000-8000-000000000001', display_name: 'Test operator', role: 'member', auth_method: 'invite' };
const fleet = { online_devices: 3, online_operators: 1, online_compute_groups: 1 };

async function setup(page: Page, signedIn = false, role = 'member') {
  await page.route('**/api/session', route => route.fulfill({ json: { account: signedIn ? { ...account, role } : null, csrf_token: signedIn ? 'test-csrf' : null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: fleet }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  await page.route('**/api/pairing-info', route => route.fulfill({ json: { relay_origin: 'https://relay.example', audience: 'test-deployment' } }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
  await page.route('**/api/review-codes', route => route.fulfill({ json: [] }));
}

for (const dialog of [
  { name: 'pairing', signedIn: true, trigger: 'I already have a pairing code →', field: 'Pairing code', close: 'Close pairing' },
]) {
  test(`${dialog.name} focuses its code field and returns keyboard focus on close`, async ({ page }) => {
    await setup(page, dialog.signedIn, 'admin');
    await page.goto('/');
    await page.evaluate(() => { location.hash = '/guide'; });
    const trigger = page.getByRole('button', { name: dialog.trigger, exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel(dialog.field, { exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: dialog.close, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

test('shows real fleet dimensions, prototype scope and usable mobile layout', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Security testing. Just your URL.' })).toBeVisible();
  await expect(page.getByLabel('Live fleet counts').getByText('3', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Live fleet counts')).toContainText('1 OPERATORS');
  await expect(page.locator('.tm-footnote')).toContainText('An automated first check, before a human penetration test');
  await expect(page.locator('.tm-footnote')).toContainText('cannot discover every vulnerability or certify a website as safe.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Pair an agent', exact: true })).toHaveCount(0);
  await page.goto('/#/guide');
  await expect(page.getByRole('heading', { name: 'Sign in to continue.' })).toBeVisible();
  await expect(page.locator('.guide pre')).toHaveCount(0);
});

test('relay setup explains installation, remote addresses and private-work consent', async ({ page }) => {
  await setup(page, true, 'admin');
  await page.goto('/#/guide');
  const guide = page.getByRole('region', { name: 'Pair through your approved account.' });
  const steps = page.getByRole('navigation', { name: 'Pairing steps' });
  const commands = guide.locator('pre');
  await expect(guide.getByRole('radio', { name: 'Try the connection first', exact: false })).toBeChecked();
  await steps.getByRole('button', { name: '3 Connect', exact: true }).click();
  await expect(commands).toContainText('--state-dir ~/.patchriot-fixture');
  await expect(commands).toContainText("--dispatcher 'https://relay.example'");
  await expect(commands).toContainText("--audience 'test-deployment'");
  await expect(commands).not.toContainText('--runtime hermes');
  await steps.getByRole('button', { name: '4 Get approved', exact: true }).click();
  await expect(commands).toContainText('--fixtures');
  await expect(commands).not.toContainText('--agents');
  await steps.getByRole('button', { name: '1 Your machine', exact: true }).click();
  await guide.getByRole('radio', { name: 'Local agent with Hermes', exact: false }).check();
  await steps.getByRole('button', { name: '2 Install the relay', exact: true }).click();
  await expect(commands.first()).toContainText('SHA256SUMS &&');
  await expect(commands.first()).toContainText('cd patchriot-relay &&');
  await expect(commands.first()).toContainText('./patchriot-relay --help');
  await expect(commands.last()).toContainText('./patchriot-relay agent-check');
  await steps.getByRole('button', { name: '3 Connect', exact: true }).click();
  await expect(commands).toContainText('--state-dir ~/.patchriot-agent');
  await expect(commands).toContainText('--runtime hermes --runtime-version YOUR-HERMES-VERSION');
  await expect(commands).toContainText('--model YOUR-LOCAL-MODEL');
  await steps.getByRole('button', { name: '4 Get approved', exact: true }).click();
  await expect(commands).toContainText('--agents --agent-config .local/agent.json');
  await expect(commands).not.toContainText('--website-reviews');
  await expect(commands).not.toContainText('--fixtures');
  await guide.getByText('Receiving private reviews', { exact: true }).click();
  await expect(guide.locator('details[open]')).toContainText('requester’s consent');
  await expect(guide.locator('details[open]')).toContainText('--website-reviews');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an outage keeps the previous count and displays the failure', async ({ page }) => {
  await setup(page);
  let failing = false;
  await page.route('**/api/fleet', route => route.fulfill(failing
    ? { status: 503, json: { error: 'dispatcher_unavailable' } }
    : { json: fleet }));
  await page.goto('/');
  await expect(page.getByLabel('Live fleet counts').getByText('3', { exact: true })).toBeVisible();
  failing = true;
  await expect(page.getByRole('alert')).toContainText('dispatcher is unavailable', { timeout: 15_000 });
  await expect(page.getByLabel('Live fleet counts')).toContainText('3');
  await expect(page.getByRole('alert')).toBeVisible();
  failing = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('members can see agent software versions, tools and report counts without host details', async ({ page }) => {
  await setup(page, true);
  await page.route('**/api/agents', route => route.fulfill({ json: [{ id: '00000000-0000-4000-8000-000000000002', reported_os: 'linux', runtime: 'hermes', runtime_version: 'runner-v3', declared_model: 'local-model', state: 'online', last_seen_at: 1793692800, system: { os_name: 'Kali GNU/Linux', os_version: '2026.3', architecture: 'x86_64', relay_version: '0.0.1' }, live_tests: true, live_tools: ['artex_engine_v1'], reports_received: 12, compute_group: 'private-host', operator_name: 'private-operator' }] }));
  await page.goto('/#/agents');
  await expect(page.getByText('Kali GNU/Linux 2026.3', { exact: true })).toBeVisible();
  await expect(page.getByText('Agentic security checks + standard checks', { exact: true })).toBeVisible();
  await expect(page.getByText('runner-v3', { exact: true })).toBeVisible();
  await expect(page.getByText('0.0.1', { exact: true })).toBeVisible();
  await expect(page.locator('.agent-entry')).toContainText('Reports received12');
  await expect(page.getByText(/private-host|private-operator/)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('setup does not invent a deployment endpoint and the agent directory shows only safe fields', async ({ page }) => {
  await setup(page, true, 'admin');
  await page.route('**/api/pairing-info', route => route.fulfill({ status: 503, json: { error: 'pairing_setup_unavailable' } }));
  await page.route('**/api/agents', route => route.fulfill({ json: [{ id: '00000000-0000-4000-8000-000000000002', reported_os: null, runtime: 'hermes', runtime_version: 'example', declared_model: 'local-model', state: 'offline', last_seen_at: null }] }));
  await page.goto('/#/guide');
  await expect(page.getByRole('alert')).toContainText('not configured');
  await expect(page.locator('pre').filter({ hasText: ' init ' })).toHaveCount(0);
  await page.evaluate(() => { location.hash = '/agents'; });
  await expect(page.getByText('Not reported', { exact: true })).toBeVisible();
  await expect(page.getByText('local-model', { exact: true })).toBeVisible();
  await expect(page.getByText('offline', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const phase of ['headers', 'body']) test(`a read timeout during ${phase} preserves the workspace and can recover`, async ({ page }) => {
  await setup(page, true, 'admin');
  await page.route('**/api/devices', route => route.fulfill({ json: [{ id: 'private-device', operator_id: account.id, operator_name: account.display_name, label: 'My private relay', runtime: 'owned_fixture', runtime_version: '0.0.1', compute_group: 'my-machine', approval: 'approved', state: 'online', last_seen_at: null }] }));
  await page.addInitScript(phase => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input.toString(), location.href);
      if (url.pathname !== '/api/devices' || sessionStorage.getItem('interrupt-read') !== 'yes') return originalFetch(input, options);
      const signal = options?.signal;
      if (!signal) throw new Error('The interrupted read needs its real request deadline.');
      if (signal.aborted) throw signal.reason;
      if (phase === 'headers') return new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      // Headers arrived, but JSON has only partly arrived when the deadline fires.
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } }), { headers: { 'content-type': 'application/json' } });
    };
  }, phase);
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent approvals', exact: true }).click();
  await expect(page.getByText('My private relay', { exact: true })).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('interrupt-read', 'yes'));
  await page.getByRole('button', { name: 'Refresh ↻', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Patchriot took too long to respond', { timeout: 15_000 });
  await expect(page.getByText('My private relay', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.evaluate(() => sessionStorage.removeItem('interrupt-read'));
  await page.getByRole('button', { name: 'Refresh ↻', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('session expiry clears private views and open dialogs while an outage preserves the workspace', async ({ page }) => {
  await setup(page, true, 'admin');
  let failure = 0;
  await page.route('**/api/devices', route => route.fulfill(failure
    ? { status: failure, json: { error: failure === 401 ? 'sign_in_required' : 'dispatcher_unavailable' } }
    : { json: [{ id: 'private-device', operator_id: account.id, operator_name: account.display_name, label: 'My private relay', runtime: 'owned_fixture', runtime_version: '0.0.1', compute_group: 'my-machine', approval: 'approved', state: 'online', last_seen_at: null }] }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent approvals', exact: true }).click();
  await expect(page.getByText('My private relay', { exact: true })).toBeVisible();
  failure = 503;
  await page.getByRole('button', { name: 'Refresh ↻', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('dispatcher is unavailable');
  await expect(page.getByText('My private relay', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pair a relay +', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  failure = 401;
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('My private relay', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Agent approvals', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Your session has ended');
  await page.getByRole('button', { name: 'App', exact: true }).click();
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
});

test('an expired session can leave the workspace through sign out', async ({ page }) => {
  await setup(page, true);
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 401, json: { error: 'sign_in_required' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'App', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const status of [200, 401]) test(`a late ${status} from an expired login does not change the new workspace`, async ({ page }) => {
  await setup(page, true, 'admin');
  let releaseClaim!: () => void;
  const pending = new Promise<void>(resolve => { releaseClaim = resolve; });
  let releaseExpiry!: () => void;
  const expiry = new Promise<void>(resolve => { releaseExpiry = resolve; });
  let firstDeviceRead = true;
  await page.route('**/api/devices', async route => {
    if (!firstDeviceRead) return route.fulfill({ json: [] });
    firstDeviceRead = false;
    await expiry;
    return route.fulfill({ status: 401, json: { error: 'sign_in_required' } });
  });
  let claimStarted = false;
  await page.route('**/api/pairings/claim', async route => {
    claimStarted = true;
    await pending;
    await route.fulfill({ status, json: status === 200
      ? { state: 'paired', device_id: '00000000-0000-4000-8000-000000000002' }
      : { error: 'sign_in_required' } });
  });
  await page.route('**/api/auth/redeem', route => route.fulfill({ json: { ok: true } }));
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent approvals', exact: true }).click();
    await page.getByRole('button', { name: 'Pair a relay +', exact: true }).click();
    await page.getByLabel('Pairing code', { exact: true }).fill('ABCD-EF01-2345');
    await page.getByLabel('I will use assigned data', { exact: false }).check();
    await page.getByRole('button', { name: 'Pair relay →', exact: true }).click();
    await expect.poll(() => claimStarted).toBe(true);
    // A background read can expire the session while the claim is still pending.
    // The form must close even though its ordinary close button is disabled.
    releaseExpiry();
    await expect(page.getByRole('status')).toContainText('Your session has ended');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.route('**/api/session', route => route.fulfill({ json: { account: { ...account, id: 'new-account', display_name: 'Another member' }, csrf_token: 'new-csrf' } }));
    await page.getByRole('button', { name: 'App', exact: true }).click();
    await page.getByText('Invitation or pilot code?', { exact: true }).click();
    await page.getByRole('button', { name: 'Use a pilot login code', exact: true }).click();
    await page.getByLabel('Invitation code', { exact: true }).fill('a'.repeat(64));
    await page.getByRole('button', { name: 'Open workspace →', exact: true }).click();
    await expect(page.getByRole('banner').getByText('Another member', { exact: true })).toHaveText('Another member');
    const staleReply = page.waitForResponse('**/api/pairings/claim');
    releaseClaim();
    await (await staleReply).finished();
    await page.getByRole('button', { name: 'My agents', exact: true }).click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Your session has ended' })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Relay paired' })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally { releaseClaim(); releaseExpiry(); }
});

for (const startupFirst of [true, false]) test(`sign-in survives a delayed startup session reply (${startupFirst ? 'startup first' : 'login first'})`, async ({ page }) => {
  await setup(page);
  let releaseStartup!: () => void, releaseLogin!: () => void;
  const startup = new Promise<void>(resolve => { releaseStartup = resolve; });
  const login = new Promise<void>(resolve => { releaseLogin = resolve; });
  let authenticated = false, loginStarted = false;
  await page.route('**/api/session', async route => {
    if (!authenticated) {
      await startup;
      return route.fulfill({ headers: { 'x-fixture-startup': 'true' }, json: { account: null, csrf_token: null } });
    }
    return route.fulfill({ json: { account, csrf_token: 'test-csrf' } });
  });
  await page.route('**/api/auth/redeem', async route => {
    loginStarted = true; await login; authenticated = true;
    return route.fulfill({ json: { ok: true } });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'App', exact: true }).click();
    await page.getByText('Invitation or pilot code?', { exact: true }).click();
    await page.getByRole('button', { name: 'Use a pilot login code', exact: true }).click();
    await page.getByLabel('Invitation code', { exact: true }).fill('a'.repeat(64));
    await page.getByRole('button', { name: 'Open workspace →', exact: true }).click();
    await expect.poll(() => loginStarted).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: 'Account access' })).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Existing pilot account', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Invitation code', { exact: true })).toBeDisabled();
    const startupReply = page.waitForResponse(response => response.url().endsWith('/api/session') && response.headers()['x-fixture-startup'] === 'true');
    if (startupFirst) {
      releaseStartup(); await (await startupReply).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      releaseLogin();
    } else {
      releaseLogin();
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      releaseStartup(); await (await startupReply).finished();
    }
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('banner').getByText('Test operator', { exact: true })).toHaveText('Test operator');
  } finally { releaseStartup(); releaseLogin(); }
});

test('an accepted invitation can retry loading the workspace without redeeming the code again', async ({ page }) => {
  await setup(page);
  let redemptions = 0, sessionReads = 0, retryStarted = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/redeem', route => {
    redemptions++;
    return route.fulfill(redemptions === 1 ? { json: { ok: true } } : { status: 400, json: { error: 'invalid_or_expired_invite' } });
  });
  await page.route('**/api/session', async route => {
    if (!redemptions) return route.fulfill({ json: { account: null, csrf_token: null } });
    if (++sessionReads === 1) return route.fulfill({ status: 503, json: { error: 'database_unavailable' } });
    retryStarted = true; await pending;
    return route.fulfill({ json: { account, csrf_token: 'test-csrf' } });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'App', exact: true }).click();
    await page.getByText('Invitation or pilot code?', { exact: true }).click();
    await page.getByRole('button', { name: 'Use a pilot login code', exact: true }).click();
    await page.getByLabel('Invitation code', { exact: true }).fill('a'.repeat(64));
    await page.getByRole('button', { name: 'Open workspace →', exact: true }).click();
    const dialog = page.getByRole('region', { name: 'Account access' });
    await expect(dialog.getByRole('alert')).toContainText('Account storage is unavailable');
    await expect(dialog.getByRole('button', { name: 'Retry opening workspace', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Retry opening workspace', exact: true }).click();
    await expect.poll(() => retryStarted).toBe(true);
    await expect(dialog.getByLabel('Invitation code', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Existing pilot account', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    release();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.getByRole('banner').getByText('Test operator', { exact: true })).toHaveText('Test operator');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(redemptions).toBe(1);
    expect(sessionReads).toBe(2);
  } finally { release(); }
});

for (const role of ['admin']) test(`pairing opens the ${role} relay list without self-approving`, async ({ page }) => {
  await setup(page, true);
  await page.route('**/api/session', route => route.fulfill({ json: { account: { ...account, role }, csrf_token: 'test-csrf' } }));
  let submission: Record<string, unknown> | undefined;
  let decisions = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/devices', route => route.fulfill({ json: submission ? [{
    id: '00000000-0000-4000-8000-000000000002', operator_id: account.id,
    operator_name: account.display_name, label: 'Newly paired relay', runtime: 'owned_fixture',
    runtime_version: '0.0.1', compute_group: 'my-machine', approval: 'pending', state: 'pending', last_seen_at: null,
  }] : [] }));
  await page.route('**/api/devices/*/decision', route => { decisions++; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/pairings/claim', async route => {
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    expect(route.request().headers()['x-patchriot-role']).toBeUndefined();
    expect(route.request().headers()['authorization']).toBeUndefined();
    submission = route.request().postDataJSON();
    await pending;
    await route.fulfill({ json: { state: 'paired', device_id: '00000000-0000-4000-8000-000000000002' } });
  });
  try {
    await page.goto('/');
    await page.evaluate(() => { location.hash = '/guide'; });
    await page.getByRole('button', { name: 'I already have a pairing code →', exact: true }).click();
    await page.getByLabel('Pairing code', { exact: true }).fill('ABCD-EF01-2345');
    await page.getByLabel('I will use assigned data', { exact: false }).check();
    await page.getByRole('button', { name: 'Pair relay →', exact: true }).click();
    await expect.poll(() => submission).toBeDefined();
    await page.keyboard.press('Escape');
    const pairing = page.getByRole('dialog');
    await expect(pairing).toBeVisible();
    await expect(pairing.getByRole('button', { name: 'Close pairing', exact: true })).toBeDisabled();
    for (const input of await pairing.locator('input, select').all()) await expect(input).toBeDisabled();
    release();
    await expect(page.getByRole('status')).toContainText('Check its approval and connection status below');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: role === 'admin' ? 'Agent approvals' : 'Your agents', exact: true })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'Newly paired relay' });
    await expect(row).toContainText('Awaiting approval');
    await expect(row).toContainText('No heartbeat yet');
    expect(submission).toEqual({ user_code: 'ABCD-EF01-2345', display_name: 'Test operator', hosting: 'own_machine', accepts_private_work_rules: true });
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(role === 'admin' ? 1 : 0);
    expect(decisions).toBe(0);
  } finally { release(); }
});

for (const [code, status, guidance] of [
  ['pairing_expired', 409, /Run pair again.*same state directory/],
  ['pairing_code_unavailable', 404, /Copy the latest code.*same state directory/],
  ['pairing_already_claimed', 409, /different account.*separate state directory/],
] as const) test(`pairing recovers from ${code} without losing the operator profile`, async ({ page }) => {
  await setup(page, true, 'admin');
  const requests: Record<string, unknown>[] = [];
  let accepted = false;
  await page.route('**/api/devices', route => route.fulfill({ json: accepted ? [{
    id: '00000000-0000-4000-8000-000000000002', operator_id: account.id,
    operator_name: 'My operator profile', label: 'Recovered relay', runtime: 'owned_fixture',
    runtime_version: '0.0.1', compute_group: 'my-machine', approval: 'pending', state: 'pending', last_seen_at: null,
  }] : [] }));
  await page.route('**/api/pairings/claim', route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.fulfill({ status, json: { error: code } });
    accepted = true;
    return route.fulfill({ json: { state: 'paired', device_id: '00000000-0000-4000-8000-000000000002' } });
  });
  await page.goto('/#/guide');
  await page.getByRole('button', { name: 'I already have a pairing code →', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Pairing code', { exact: true }).fill('ABCD-EF01-2345');
  await dialog.getByLabel('Operator name', { exact: true }).fill('My operator profile');
  await dialog.getByRole('combobox', { name: 'Where does it run?', exact: true }).selectOption('vps');
  await dialog.getByLabel('I will use assigned data', { exact: false }).check();
  await dialog.getByRole('button', { name: 'Pair relay →', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(guidance);
  await expect(dialog.getByLabel('Pairing code', { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Operator name', { exact: true })).toHaveValue('My operator profile');
  await expect(dialog.getByRole('combobox', { name: 'Where does it run?', exact: true })).toHaveValue('vps');
  await expect(dialog.getByLabel('I will use assigned data', { exact: false })).toBeChecked();
  await dialog.getByLabel('Pairing code', { exact: true }).fill('ABCD-EF01-9999');
  await dialog.getByRole('button', { name: 'Pair relay →', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Recovered relay' })).toContainText('Awaiting approval');
  expect(requests).toEqual(['ABCD-EF01-2345', 'ABCD-EF01-9999'].map(user_code => ({ user_code, display_name: 'My operator profile', hosting: 'vps', accepts_private_work_rules: true })));
});

test('a pending device decision stays visible and an error leaves its reason editable', async ({ page }) => {
  await setup(page, true);
  await page.route('**/api/session', route => route.fulfill({ json: { account: { ...account, role: 'admin' }, csrf_token: 'test-csrf' } }));
  await page.route('**/api/devices', route => route.fulfill({ json: [{
    id: '00000000-0000-4000-8000-000000000002', operator_id: account.id,
    operator_name: account.display_name, label: 'Review agent', runtime: 'hermes',
    runtime_version: 'test', declared_model: 'test-model', compute_group: 'test-machine',
    approval: 'approved', private_work_approved: false, state: 'online', last_seen_at: null,
  }] }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const submissions: unknown[] = [];
  await page.route('**/api/devices/*/decision', async route => {
    submissions.push(route.request().postDataJSON());
    await pending;
    await route.fulfill({ status: 503, json: { error: 'dispatcher_unavailable' } });
  });
  try {
    await page.goto('/#/devices');
    await page.getByRole('button', { name: 'Allow private reviews', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('What did you check?', { exact: true }).fill('Reviewed this operator and isolated example execution.');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Allow private reviews', exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close decision', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('textbox')).toBeDisabled();
    await expect(dialog.getByRole('checkbox')).toBeDisabled();
    release();
    await expect(dialog.getByRole('alert')).toContainText('dispatcher is unavailable');
    await expect(dialog.getByRole('textbox')).toBeEditable();
    await expect(dialog.getByRole('checkbox')).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Close decision', exact: true })).toBeEnabled();
    expect(submissions).toEqual([{ action: 'approve_private', reason: 'Reviewed this operator and isolated example execution.' }]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  } finally { release(); }
});

test('renders operator-controlled names as text and exposes no admin actions to members', async ({ page }) => {
  await setup(page, true, 'admin');
  await page.route('**/api/devices', route => route.fulfill({ json: [{
    id: '00000000-0000-4000-8000-000000000002', operator_id: account.id,
    operator_name: '<img src=x onerror=alert(1)>', label: '<script>alert(1)</script>',
    runtime: 'owned_fixture', runtime_version: '0.0.1', declared_model: null, compute_group: 'shared-machine',
    approval: 'pending', state: 'pending', last_seen_at: null,
  }] }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent approvals', exact: true }).click();
  await expect(page.getByRole('cell', { name: '<script>alert(1)</script>', exact: false })).toBeVisible();
  await expect(page.locator('td img, td script')).toHaveCount(0);
  await expect(page.getByText('Reports received: —', { exact: true })).toBeVisible();
  await page.route('**/api/session', route => route.fulfill({ json: { account, csrf_token: 'test-csrf' } }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Bring your agents. Soon.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
});

test('shows the declared Hermes model without treating presence as model verification', async ({ page }) => {
  await setup(page, true, 'admin');
  await page.route('**/api/devices', route => route.fulfill({ json: [{
    id: '00000000-0000-4000-8000-000000000003', operator_id: account.id,
    operator_name: 'CPU pilot', label: 'Hermes contributor', runtime: 'hermes',
    runtime_version: '0.22.2', declared_model: 'publisher/model:<img src=x onerror=alert(1)>',
    compute_group: 'shared-cpu', approval: 'approved', state: 'online', last_seen_at: 1793439000,
    reports_received: 7,
  }] }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent approvals', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Hermes contributor' });
  await expect(row).toContainText('Runner 0.22.2');
  await expect(row).toContainText('Reports received: 7');
  await expect(row).toContainText('Declared model: publisher/model:<img src=x onerror=alert(1)>');
  await expect(row.locator('img')).toHaveCount(0);
  await expect(page.getByText('Agent versions and model names are operator declarations.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('keeps conflicting evidence visible without presenting it as a successful review', async ({ page }) => {
  await setup(page, true);
  const review = {
    id: '00000000-0000-4000-8000-000000000010', mode: 'owned_fixture', state: 'needs_review',
    created_at: 1793428766, deadline_at: 1793429666, evidence_source: 'device_reported_fixture_not_independently_verified',
    steps: [{ role: 'reproducer', state: 'completed', attempts: 1, device_id: 'device-a', operator_id: 'operator-a', compute_group: 'shared-machine', fixture_matches: false,
      result: { runs: [{ version: 'original', completed: true, elapsed_ms: 10, checks: [{ name: 'another_user_can_read', expected: false, actual: false }] }] } }],
  };
  await page.route('**/api/reviews{,?scope=mine}', route => route.fulfill({ json: [review] }));
  await page.route(`**/api/reviews/${review.id}`, route => route.fulfill({ json: review }));
  await page.goto('/');
  await openAuditTool(page, 'Reports');
  await page.getByRole('button', { name: 'Access-control example', exact: false }).click();
  const report = page.getByRole('region', { name: 'Review report' });
  await expect(report).toBeFocused();
  await expect(report.getByRole('heading', { name: 'Needs review' })).toBeInViewport();
  await expect(report.getByRole('heading', { name: 'Needs review' })).toBeVisible();
  await expect(report.getByText('The evidence does not match the expected fixture regression.')).toBeVisible();
  await expect(report.getByRole('heading', { name: 'Example checks complete' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('staff example checks are explicit and a retry keeps the same request identity', async ({ page }) => {
  await setup(page, true, 'admin');
  await page.route('**/api/fleet', route => route.fulfill({ json: { ...fleet, agent_review_timeout_seconds: 5700 } }));
  const submitted: Record<string, unknown>[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/reviews{,?scope=mine}', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) await pending;
    await route.fulfill({ status: 503, json: { error: 'dispatcher_unavailable' } });
  });
  try {
    await page.goto('/');
    await openAuditTool(page, 'Reports');
    await page.getByText('Developer checks · staff only', { exact: true }).click();
    await page.getByRole('button', { name: 'Run example check' }).click();
    await expect(page.getByRole('radio', { name: 'Quick fixture check', exact: false })).toBeChecked();
    await page.getByRole('radio', { name: 'Local agent check', exact: false }).check();
    await expect(page.getByText('Expires after 95 minutes', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Run agent checks →' }).click();
    await expect.poll(() => submitted.length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close review setup', exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: 'Run agent checks →' }).click();
    await expect.poll(() => submitted.length).toBe(2);
    expect(submitted[0]).toEqual({ request_id: expect.any(String), scenario: 'access_control_v1', mode: 'owned_agent' });
    expect(submitted[1]).toEqual(submitted[0]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: 'Close review setup', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally { release(); }
});

test('agent reports preserve missing evidence and render model prose as inert text', async ({ page }) => {
  await setup(page, true);
  const review = {
    id: '00000000-0000-4000-8000-000000000011', mode: 'owned_agent', state: 'needs_review',
    created_at: 1793428766, deadline_at: 1793430866, evidence_source: 'agent_reported_owned_example_not_independently_verified',
    steps: ['operator-a', 'operator-b'].map((operator, i) => ({ role: i ? 'reproducer' : 'investigator', state: 'completed', attempts: 1, device_id: `device-${i}`, operator_id: operator, compute_group: 'same-name', fixture_matches: false,
      result: { kind: 'owned_agent_v1', outcome: 'failed', model: 'local-profile', declared_model: 'local-base-model', model_digest: 'a'.repeat(64), image_digest: `sha256:${'b'.repeat(64)}`, duration_ms: 500_000, inference_calls: 1, terminal_calls: 0, cleanup_confirmed: true, observation: null, summary: '<img src=x onerror=alert(1)> I think it is fixed.' } })),
  };
  await page.route('**/api/reviews{,?scope=mine}', route => route.fulfill({ json: [review] }));
  await page.route(`**/api/reviews/${review.id}`, route => route.fulfill({ json: review }));
  await page.goto('/');
  await openAuditTool(page, 'Reports');
  await page.getByRole('button', { name: 'Access-control example', exact: false }).click();
  const report = page.getByRole('region', { name: 'Review report' });
  await expect(report.getByRole('heading', { name: 'Needs review' })).toBeVisible();
  await expect(report.getByText('2 devices · 2 operators · 2 declared compute groups.', { exact: false })).toBeVisible();
  await expect(report.getByText('The agent did not provide a complete, matching tool result.')).toHaveCount(2);
  await expect(report.locator('.agent-summary').first()).toContainText('<img src=x onerror=alert(1)>');
  await expect(report.locator('img, script')).toHaveCount(0);
  await report.getByText('Execution details', { exact: true }).first().click();
  await expect(report.getByText(`sha256:${'b'.repeat(64)}`, { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('workspace shows real runner facts and a qualified NEAR integration', async ({page}, info) => {
  await setup(page,true);
  await page.route('**/api/agents',r=>r.fulfill({json:[{id:'fixture-agent',runtime:'hermes',runtime_version:'fixture-runtime-15',declared_model:'fixture-model',state:'online',last_seen_at:1793640020,reports_received:17,system:{os_name:'Kali',os_version:'2026',architecture:'x86_64',relay_version:'fixture-relay'}}]}));
  await page.goto('/');
  const network=page.locator('.network-work');
  await expect(network).toContainText('fixture-runtime-15');
  await expect(network).toContainText('Heartbeat');
  await expect(network).toContainText('17');
  await expect(network.getByRole('img',{name:'NEAR AI',exact:true})).toBeVisible();
  await expect(network).toContainText('Your checkout and report identify the providers used.');
  await expect(page.locator('.workspace-art')).toHaveCSS('object-fit','contain');
  await expect(page.locator('.workspace-art')).toHaveAttribute('src','/brand/workspace-globe-detailed.png');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await expect(page.locator('.workspace-art')).toHaveCSS('animation-name','workspace-orbit-drift');
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(page.locator('.workspace-art')).toHaveCSS('animation-name','none');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.workspace-heading').screenshot({path:info.outputPath('workspace-banner.png')});
  await page.screenshot({path:info.outputPath('workspace-runtime.png'),fullPage:true});
});
