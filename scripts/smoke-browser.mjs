#!/usr/bin/env node
// Real browser + Rust CLI + PostgreSQL onboarding. Run only on a local demo DB.
import { chromium, expect } from '../web/node_modules/@playwright/test/index.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:7410';
const core = fileURLToPath(new URL('../target/debug/patchriot-core', import.meta.url));
const relay = fileURLToPath(new URL('../../patchriot-relay/target/debug/patchriot-relay', import.meta.url));
if (!process.env.DATABASE_URL || !process.env.PATCHRIOT_AUDIENCE) throw new Error('DATABASE_URL and PATCHRIOT_AUDIENCE are required for the local demo.');
const database = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) throw new Error('This smoke test requires a local demo database.');
const safeEnv = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: tmpdir() };
const directory = mkdtempSync(join(tmpdir(), 'patchriot-browser-'));
const state = join(directory, 'relay');
const label = `Browser smoke ${randomUUID().slice(0, 8)}`;
const accounts = [];
const cleanupDevices = new Set();
const browser = await chromium.launch({ env: safeEnv });
let owner, ownerPage, adminPage, deviceId;
const browserErrors = [];

function command(executable, args, env = safeEnv) {
  return execFileSync(executable, args, { encoding: 'utf8', env, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function relayCommand(action, ...args) {
  const output = command(relay, [action, '--state-dir', state, ...args]);
  return output ? JSON.parse(output) : null;
}
async function login(role, name) {
  const invitation = command(core, ['invite', role, name], { ...safeEnv, DATABASE_URL: process.env.DATABASE_URL });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Sign in ↗', exact: true }).click();
  await page.getByLabel('Invitation code', { exact: true }).fill(invitation);
  await page.getByRole('button', { name: 'Open workspace →', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const session = await page.evaluate(() => fetch('/api/session').then(response => response.json()));
  accounts.push(session.account.id);
  assert.equal(session.account.role, role);
  return { page, context, session };
}

try {
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  relayCommand('init', '--dispatcher', 'http://127.0.0.1:7411', '--audience', process.env.PATCHRIOT_AUDIENCE, '--label', label, '--compute-group', 'browser-smoke-host');
  const pairing = relayCommand('pair');
  owner = await login('member', 'Browser smoke owner');
  ownerPage = owner.page;
  await ownerPage.getByRole('button', { name: 'My relays', exact: true }).click();
  await ownerPage.getByRole('button', { name: 'Pair a relay +' }).click();
  await ownerPage.getByLabel('Pairing code', { exact: true }).fill(pairing.user_code);
  await ownerPage.getByLabel('I will use assigned data', { exact: false }).check();
  await ownerPage.getByRole('button', { name: 'Pair relay →', exact: true }).click();
  await expect(ownerPage.getByText('Awaiting approval', { exact: true })).toBeVisible();
  const devices = await ownerPage.evaluate(() => fetch('/api/devices').then(response => response.json()));
  assert.equal(devices.length, 1);
  deviceId = devices[0].id;
  cleanupDevices.add(deviceId);
  assert.equal(relayCommand('connect', '--once').state, 'awaiting_approval');

  const outsider = await login('member', 'Browser smoke unrelated user');
  const outsideDevices = await outsider.page.evaluate(() => fetch('/api/devices').then(response => response.json()));
  assert.deepEqual(outsideDevices, []);
  const forbidden = await outsider.page.evaluate(async ({ id, csrf }) => {
    const response = await fetch(`/api/devices/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ action: 'revoke', reason: 'Cross-account boundary test' }) });
    return response.status;
  }, { id: deviceId, csrf: outsider.session.csrf_token });
  assert.equal(forbidden, 404);

  const admin = await login('admin', 'Browser smoke admin');
  adminPage = admin.page;
  await adminPage.getByRole('button', { name: 'Fleet & approvals', exact: true }).click();
  const row = adminPage.getByRole('row').filter({ hasText: label });
  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Approve relay', exact: true }).click();
  await expect(row.getByText('approved', { exact: true })).toBeVisible();
  assert.equal(relayCommand('connect', '--once').state, 'online');
  await ownerPage.getByRole('button', { name: 'Refresh ↻', exact: true }).click();
  await expect(ownerPage.getByText('online', { exact: true })).toBeVisible();
  relayCommand('pause');
  assert.equal(relayCommand('connect', '--once').state, 'paused');
  await ownerPage.getByRole('button', { name: 'Refresh ↻', exact: true }).click();
  await expect(ownerPage.getByText('paused', { exact: true })).toBeVisible();
  relayCommand('resume');
  assert.equal(relayCommand('connect', '--once').state, 'online');

  const relayStates = [state];
  for (let i = 2; i <= 3; i++) {
    const nextState = join(directory, `relay-${i}`);
    relayStates.push(nextState);
    const nextLabel = `${label}-${i}`;
    command(relay, ['init', '--state-dir', nextState, '--dispatcher', 'http://127.0.0.1:7411', '--audience', process.env.PATCHRIOT_AUDIENCE, '--label', nextLabel, '--compute-group', 'browser-smoke-host']);
    const pair = JSON.parse(command(relay, ['pair', '--state-dir', nextState]));
    await ownerPage.getByRole('button', { name: 'Pair a relay +' }).click();
    await ownerPage.getByLabel('Pairing code', { exact: true }).fill(pair.user_code);
    await ownerPage.getByLabel('I will use assigned data', { exact: false }).check();
    await ownerPage.getByRole('button', { name: 'Pair relay →', exact: true }).click();
    await expect(ownerPage.getByRole('row').filter({ hasText: nextLabel })).toBeVisible();
    const current = await ownerPage.evaluate(() => fetch('/api/devices').then(response => response.json()));
    cleanupDevices.add(current.find(device => device.label === nextLabel).id);
    await adminPage.getByRole('button', { name: 'Refresh ↻', exact: true }).click();
    const nextRow = adminPage.getByRole('row').filter({ hasText: nextLabel });
    await nextRow.getByRole('button', { name: 'Approve', exact: true }).click();
    await adminPage.getByRole('button', { name: 'Approve relay', exact: true }).click();
    await expect(nextRow.getByText('approved', { exact: true })).toBeVisible();
  }
  await ownerPage.getByRole('button', { name: 'Reviews', exact: true }).click();
  await ownerPage.getByRole('button', { name: 'New example review +' }).click();
  await ownerPage.getByRole('button', { name: 'Run the owned example →', exact: true }).click();
  const reportPanel = ownerPage.getByRole('region', { name: 'Review report' });
  await expect(reportPanel.getByRole('heading', { name: 'Waiting for a relay' })).toBeVisible();
  for (const relayState of relayStates) {
    const events = command(relay, ['connect', '--state-dir', relayState, '--once', '--fixtures']).split('\n').map(line => JSON.parse(line));
    assert(events.some(event => event.event === 'fixture_result_accepted' && event.fixture_matches === true));
  }
  await ownerPage.getByRole('button', { name: 'Refresh report ↻', exact: true }).click();
  await expect(reportPanel.getByRole('heading', { name: 'Example checks complete' })).toBeVisible();
  await expect(reportPanel.getByText('3 devices · 1 operator · 1 declared compute group.', { exact: false })).toBeVisible();
  const downloadLink = reportPanel.getByRole('link', { name: 'Download evidence JSON ↓' });
  const reportPath = await downloadLink.getAttribute('href');
  assert.equal((await outsider.context.request.get(`${origin}${reportPath}`)).status(), 404);
  const downloadPromise = ownerPage.waitForEvent('download');
  await downloadLink.click();
  const download = await downloadPromise;
  assert(download.suggestedFilename().startsWith('patchriot-review-'));
  assert.equal(await download.failure(), null);

  // The row locator also matches the added labels, so pin the exact first device.
  const firstRow = adminPage.getByRole('row').filter({ has: adminPage.getByText(label, { exact: true }) });
  await firstRow.getByRole('button', { name: 'Revoke', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Revoke relay', exact: true }).click();
  await expect(firstRow.locator('.badge')).toHaveText('revoked');
  assert.throws(() => relayCommand('connect', '--once'));
  deviceId = undefined;
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({ passed: true, checks: ['browser sign-in', 'real relay pairing', 'pending approval', 'cross-account isolation', 'admin approval', 'heartbeat', 'pause/resume', 'three-role review', 'private evidence download', 'revocation', 'production CSP'], accounts: 3, relay_instances: 3, real_model_calls: 0 }));
} finally {
  if (ownerPage && owner) for (const device of cleanupDevices) {
    const status = await ownerPage.evaluate(async ({ id, csrf }) => {
      const response = await fetch(`/api/devices/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ action: 'revoke', reason: 'Browser smoke cleanup' }) });
      return response.status;
    }, { id: device, csrf: owner.session.csrf_token });
    if (status !== 200) console.error('Smoke relay cleanup needs operator attention.');
  }
  await browser.close();
  for (const id of accounts) command(core, ['disable-account', id], { ...safeEnv, DATABASE_URL: process.env.DATABASE_URL });
  rmSync(directory, { recursive: true, force: true });
}
