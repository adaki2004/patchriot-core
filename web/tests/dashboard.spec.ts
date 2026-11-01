import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const account = { id: '00000000-0000-4000-8000-000000000001', display_name: 'Test operator', role: 'member', auth_method: 'invite' };
const fleet = { online_devices: 3, online_operators: 1, online_compute_groups: 1 };

async function setup(page: Page, signedIn = false) {
  await page.route('**/api/session', route => route.fulfill({ json: { account: signedIn ? account : null, csrf_token: signedIn ? 'test-csrf' : null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: fleet }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
}

test('shows real fleet dimensions, prototype scope and usable mobile layout', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'More defenders. Fewer blind spots.' })).toBeVisible();
  await expect(page.getByText('3 approved relays online')).toBeVisible();
  await expect(page.getByLabel('Live fleet counts')).toContainText('Distinct operators');
  await expect(page.getByText('Private access is explicit; active penetration tests follow.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Relay setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start with a small contribution.' })).toBeVisible();
});

test('relay setup distinguishes fixture identities from agents and makes private work a separate opt-in', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Relay setup', exact: true }).click();
  const guide = page.getByRole('region', { name: 'Start with a small contribution.' });
  const commands = guide.locator('pre');
  await expect(guide.getByRole('radio', { name: 'Quick fixture check', exact: false })).toBeChecked();
  await expect(commands.filter({ hasText: ' init ' })).toContainText('--state-dir ~/.patchriot-fixture');
  await expect(commands.filter({ hasText: ' init ' })).not.toContainText('--runtime hermes');
  await expect(commands.filter({ hasText: ' connect ' })).toContainText('--fixtures');
  await expect(commands.filter({ hasText: ' connect ' })).not.toContainText('--agents');
  await expect(guide.getByText('Opt in to private website reviews', { exact: true })).toHaveCount(0);

  await guide.getByRole('radio', { name: 'Local agent with Hermes', exact: false }).check();
  await expect(commands.filter({ hasText: ' init ' })).toContainText('--state-dir ~/.patchriot-agent');
  await expect(commands.filter({ hasText: ' init ' })).toContainText('--runtime hermes --runtime-version YOUR-HERMES-VERSION');
  await expect(commands.filter({ hasText: ' init ' })).toContainText('--model YOUR-LOCAL-MODEL');
  await expect(guide.locator('ol')).toContainText('--agents --agent-config .local/agent.json');
  await expect(guide.locator('ol')).not.toContainText('--website-reviews');
  await expect(guide.locator('ol')).not.toContainText('--fixtures');
  await guide.getByText('Opt in to private website reviews', { exact: true }).click();
  await expect(guide.locator('details[open]')).toContainText('a requester must select your device');
  await expect(guide.locator('details[open] pre')).toContainText('--website-reviews');
  // The build leaves a local executable; no unstated PATH installation is needed.
  const text = await commands.allTextContents();
  expect(text.filter(value => value !== 'cargo build --release --locked').every(value => value.startsWith('./target/release/patchriot-relay '))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('an outage keeps the previous count and displays the failure', async ({ page }) => {
  await setup(page);
  let failing = false;
  await page.route('**/api/fleet', route => route.fulfill(failing
    ? { status: 503, json: { error: 'dispatcher_unavailable' } }
    : { json: fleet }));
  await page.goto('/');
  await expect(page.getByText('3 approved relays online')).toBeVisible();
  failing = true;
  await expect(page.getByRole('alert')).toContainText('dispatcher is unavailable', { timeout: 15_000 });
  await expect(page.getByLabel('Live fleet counts')).toContainText('3');
  await expect(page.getByText('Connection interrupted')).toBeVisible();
  failing = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('session expiry clears private views and open dialogs while an outage preserves the workspace', async ({ page }) => {
  await setup(page, true);
  let failure = 0;
  await page.route('**/api/devices', route => route.fulfill(failure
    ? { status: failure, json: { error: failure === 401 ? 'sign_in_required' : 'dispatcher_unavailable' } }
    : { json: [{ id: 'private-device', operator_id: account.id, operator_name: account.display_name, label: 'My private relay', runtime: 'owned_fixture', runtime_version: '0.0.1', compute_group: 'my-machine', approval: 'approved', state: 'online', last_seen_at: null }] }));
  await page.goto('/');
  await page.getByRole('button', { name: 'My relays', exact: true }).click();
  await expect(page.getByText('My private relay', { exact: true })).toBeVisible();
  failure = 503;
  await page.getByRole('button', { name: 'Refresh ↻', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('dispatcher is unavailable');
  await expect(page.getByText('My private relay', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pair a relay +', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  failure = 401;
  await expect(page.getByRole('button', { name: 'Sign in ↗', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('My private relay', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'My relays', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Your session has ended');
  await page.getByRole('button', { name: 'Sign in ↗', exact: true }).click();
  await expect(page.getByLabel('Invitation code', { exact: true })).toBeVisible();
});

test('an expired session can leave the workspace through sign out', async ({ page }) => {
  await setup(page, true);
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 401, json: { error: 'sign_in_required' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in ↗', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const status of [200, 401]) test(`a late ${status} from the previous login does not change the new workspace`, async ({ page }) => {
  await setup(page, true);
  let releaseClaim!: () => void;
  const pending = new Promise<void>(resolve => { releaseClaim = resolve; });
  let claimStarted = false;
  await page.route('**/api/pairings/claim', async route => {
    claimStarted = true;
    await pending;
    await route.fulfill({ status, json: status === 200
      ? { state: 'paired', device_id: '00000000-0000-4000-8000-000000000002' }
      : { error: 'sign_in_required' } });
  });
  await page.route('**/api/auth/logout', route => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/auth/redeem', route => route.fulfill({ json: { ok: true } }));
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'My relays', exact: true }).click();
    await page.getByRole('button', { name: 'Pair a relay +', exact: true }).click();
    await page.getByLabel('Pairing code', { exact: true }).fill('ABCD-EF01-2345');
    await page.getByLabel('I will use assigned data', { exact: false }).check();
    await page.getByRole('button', { name: 'Pair relay →', exact: true }).click();
    await expect.poll(() => claimStarted).toBe(true);
    await page.getByRole('button', { name: 'Close pairing', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.route('**/api/session', route => route.fulfill({ json: { account: { ...account, id: 'new-account', display_name: 'Another member' }, csrf_token: 'new-csrf' } }));
    await page.getByRole('button', { name: 'Sign in ↗', exact: true }).click();
    await page.getByLabel('Invitation code', { exact: true }).fill('a'.repeat(64));
    await page.getByRole('button', { name: 'Open workspace →', exact: true }).click();
    await expect(page.getByText('Another member', { exact: true })).toHaveText('Another member');
    const staleReply = page.waitForResponse('**/api/pairings/claim');
    releaseClaim();
    await (await staleReply).finished();
    await page.getByRole('button', { name: 'My relays', exact: true }).click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Your session has ended' })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Relay paired' })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally { releaseClaim(); }
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
    await page.getByRole('button', { name: 'Sign in ↗', exact: true }).click();
    await page.getByLabel('Invitation code', { exact: true }).fill('a'.repeat(64));
    await page.getByRole('button', { name: 'Open workspace →', exact: true }).click();
    await expect.poll(() => loginStarted).toBe(true);
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
    await expect(page.getByText('Test operator', { exact: true })).toHaveText('Test operator');
  } finally { releaseStartup(); releaseLogin(); }
});

for (const role of ['member', 'admin']) test(`pairing opens the ${role} relay list without self-approving`, async ({ page }) => {
  await setup(page, true);
  await page.route('**/api/session', route => route.fulfill({ json: { account: { ...account, role }, csrf_token: 'test-csrf' } }));
  let submission: Record<string, unknown> | undefined;
  let decisions = 0;
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
    await route.fulfill({ json: { state: 'paired', device_id: '00000000-0000-4000-8000-000000000002' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Pair a relay ↗', exact: true }).click();
  await page.getByLabel('Pairing code', { exact: true }).fill('ABCD-EF01-2345');
  await page.getByLabel('I will use assigned data', { exact: false }).check();
  await page.getByRole('button', { name: 'Pair relay →', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Check its approval and connection status below');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: role === 'admin' ? 'Fleet & approvals' : 'Your relays', exact: true })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Newly paired relay' });
  await expect(row).toContainText('Awaiting approval');
  await expect(row).toContainText('No heartbeat yet');
  expect(submission).toEqual({ user_code: 'ABCD-EF01-2345', display_name: 'Test operator', hosting: 'own_machine', accepts_private_work_rules: true });
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(role === 'admin' ? 1 : 0);
  expect(decisions).toBe(0);
});

test('renders operator-controlled names as text and exposes no admin actions to members', async ({ page }) => {
  await setup(page, true);
  await page.route('**/api/devices', route => route.fulfill({ json: [{
    id: '00000000-0000-4000-8000-000000000002', operator_id: account.id,
    operator_name: '<img src=x onerror=alert(1)>', label: '<script>alert(1)</script>',
    runtime: 'owned_fixture', runtime_version: '0.0.1', declared_model: null, compute_group: 'shared-machine',
    approval: 'pending', state: 'pending', last_seen_at: null,
  }] }));
  await page.goto('/');
  await page.getByRole('button', { name: 'My relays', exact: true }).click();
  await expect(page.getByRole('cell', { name: '<script>alert(1)</script>', exact: false })).toBeVisible();
  await expect(page.locator('td img, td script')).toHaveCount(0);
  await expect(page.getByText('Reports received: —', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
});

test('shows the declared Hermes model without treating presence as model verification', async ({ page }) => {
  await setup(page, true);
  await page.route('**/api/devices', route => route.fulfill({ json: [{
    id: '00000000-0000-4000-8000-000000000003', operator_id: account.id,
    operator_name: 'CPU pilot', label: 'Hermes contributor', runtime: 'hermes',
    runtime_version: '0.22.2', declared_model: 'publisher/model:<img src=x onerror=alert(1)>',
    compute_group: 'shared-cpu', approval: 'approved', state: 'online', last_seen_at: 1793439000,
    reports_received: 7,
  }] }));
  await page.goto('/');
  await page.getByRole('button', { name: 'My relays', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Hermes contributor' });
  await expect(row).toContainText('Version 0.22.2');
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
  await page.route('**/api/reviews', route => route.fulfill({ json: [review] }));
  await page.route(`**/api/reviews/${review.id}`, route => route.fulfill({ json: review }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.getByRole('button', { name: 'Access-control example', exact: false }).click();
  const report = page.getByRole('region', { name: 'Review report' });
  await expect(report).toBeFocused();
  await expect(report.getByRole('heading', { name: 'Needs review' })).toBeInViewport();
  await expect(report.getByRole('heading', { name: 'Needs review' })).toBeVisible();
  await expect(report.getByText('The evidence does not match the expected fixture regression.')).toBeVisible();
  await expect(report.getByRole('heading', { name: 'Example checks complete' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('agent checks are an explicit choice and a retry keeps the same request identity', async ({ page }) => {
  await setup(page, true);
  await page.route('**/api/fleet', route => route.fulfill({ json: { ...fleet, agent_review_timeout_seconds: 5700 } }));
  const submitted: Record<string, unknown>[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/reviews', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) await pending;
    await route.fulfill({ status: 503, json: { error: 'dispatcher_unavailable' } });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Reviews', exact: true }).click();
    await page.getByRole('button', { name: 'New example review +' }).click();
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
  await page.route('**/api/reviews', route => route.fulfill({ json: [review] }));
  await page.route(`**/api/reviews/${review.id}`, route => route.fulfill({ json: review }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
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
