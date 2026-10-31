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
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Revoke relay', exact: true }).click();
  await expect(row.locator('.badge')).toHaveText('revoked');
  assert.throws(() => relayCommand('connect', '--once'));
  deviceId = undefined;
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({ passed: true, checks: ['browser sign-in', 'real relay pairing', 'pending approval', 'cross-account isolation', 'admin approval', 'heartbeat', 'pause/resume', 'revocation', 'production CSP'], accounts: 3, real_model_calls: 0 }));
} finally {
  if (deviceId && ownerPage && owner) {
    const status = await ownerPage.evaluate(async ({ id, csrf }) => {
      const response = await fetch(`/api/devices/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ action: 'revoke', reason: 'Browser smoke cleanup' }) });
      return response.status;
    }, { id: deviceId, csrf: owner.session.csrf_token });
    if (status !== 200) console.error('Smoke relay cleanup needs operator attention.');
  }
  await browser.close();
  for (const id of accounts) command(core, ['disable-account', id], { ...safeEnv, DATABASE_URL: process.env.DATABASE_URL });
  rmSync(directory, { recursive: true, force: true });
}
