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

test('website review requires three explicit devices and snapshot-specific sharing consent', async ({ page }) => {
  await setup(page);
  const devices = [1, 2, 3].map(i => ({ device_id: `00000000-0000-4000-8000-00000000000${i + 4}`, operator_id: account.id, operator_name: 'One operator', device_name: `CPU agent ${i}`, declared_model: 'test-model', compute_group: 'same-machine' }));
  await page.route(`**/api/site-checks/${id}`, route => route.fulfill({ json: { ...pending, state: 'collected', evidence_available: true, summary: { homepage_sha256: '2'.repeat(64), external_scripts: 1, inline_scripts: 1, skipped_scripts: 0, script_limit_reached: false, captured_response_bytes: 5000, requests_made: 2, finished_at: 1793448000 } } }));
  await page.route(`**/api/site-checks/${id}/review-plan`, route => route.fulfill({ json: { site_check_id: id, snapshot_sha256: '3'.repeat(64), candidates: devices, review_timeout_seconds: 5700 } }));
  let submitted: Record<string, unknown> | undefined;
  const review = { id: '00000000-0000-4000-8000-000000000200', mode: 'website_agent', state: 'queued', steps: [], created_at: 1793448000, deadline_at: 1793450100, evidence_source: 'operator_reported_static_website_review_not_a_safety_verdict', website: { site_check_id: id, snapshot_sha256: '3'.repeat(64), reviewers: devices } };
  await page.route(`**/api/reviews/${review.id}`, route => route.fulfill({ json: review }));
  await page.route(`**/api/site-checks/${id}/review`, route => {
    submitted = route.request().postDataJSON();
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    return route.fulfill({ json: review });
  });
  await page.getByRole('button', { name: 'https://example.com/', exact: false }).click();
  await page.getByRole('button', { name: 'Choose review agents →' }).click();
  const start = page.getByRole('button', { name: 'Share snapshot & start review →' });
  await expect(start).toBeDisabled();
  for (const [i, role] of ['Investigator', 'Reproducer', 'Challenger'].entries()) await page.getByLabel(`${role} device`).selectOption(devices[i].device_id);
  await expect(page.getByRole('dialog')).toContainText('3 devices · 1 operator · 1 declared compute group');
  await expect(page.getByRole('dialog')).toContainText('up to 95 minutes including waiting');
  await expect(page.getByLabel('Reproducer device').locator(`option[value="${devices[0].device_id}"]`)).toHaveJSProperty('disabled', true);
  await start.click();
  expect(submitted).toBeUndefined();
  await page.getByLabel('I allow these three devices and their named operators').check();
  expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await start.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(submitted).toMatchObject({ snapshot_sha256: '3'.repeat(64), device_ids: devices.map(d => d.device_id), accepts_operator_access: true });
  await expect(page.getByRole('region', { name: 'Review report' })).toContainText('No browser execution or live exploit reproduction was performed.');
});

test('website reports keep model claims as text and do not label completion a safety verdict', async ({ page }) => {
  await setup(page);
  const result = { kind: 'website_agent_v1', snapshot_sha256: '1'.repeat(64), inspected_snapshot_sha256: '1'.repeat(64), raw_summary: '', execution: { state: 'completed', model: 'local-test-model', declared_model: 'local-test-model', model_digest: '2'.repeat(64), image_digest: `sha256:${'3'.repeat(64)}`, duration_ms: 2000, inference_calls: 2, terminal_calls: 1, cleanup_confirmed: true }, assessment: { summary: '<img src=x onerror=alert(1)> Saved text was inspected.', findings: [], limitations: ['No live tests.'] } };
  const review = { id, mode: 'website_agent', state: 'completed', steps: ['investigator', 'reproducer', 'challenger'].map((role, i) => ({ role, state: 'completed', attempts: 1, device_id: String(i), operator_id: account.id, compute_group: 'one-host', result, fixture_matches: null, evidence_complete: true })), created_at: 1793448000, deadline_at: 1793450100, evidence_source: 'operator_reported_static_website_review_not_a_safety_verdict' };
  await page.route('**/api/reviews', route => route.fulfill({ json: [review] }));
  await page.route(`**/api/reviews/${id}`, route => route.fulfill({ json: review }));
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.getByRole('button', { name: 'Website snapshot review', exact: false }).click();
  const detail = page.getByRole('region', { name: 'Review report' });
  await expect(detail.getByRole('heading', { name: 'Reports received' })).toBeVisible();
  await expect(detail).toContainText('Reasoning is unverified.');
  await expect(detail).toContainText('No supported finding was reported. This does not establish that the site is safe.');
  await expect(detail.locator('img, script')).toHaveCount(0);
  await expect(detail).not.toContainText('Original flaw reproduced');
  const execution = detail.locator('.execution-details').first();
  await expect(execution.getByText('Recorded for this snapshot', { exact: true })).not.toBeVisible();
  await execution.getByText('Execution details', { exact: true }).click();
  await expect(execution.getByText('Recorded for this snapshot', { exact: true })).toBeVisible();
  await expect(execution).toContainText('which the runtime may run before inference');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('recorded website timeouts show what stopped instead of implying a completed assessment', async ({ page }) => {
  await setup(page);
  const result = { kind: 'website_agent_v1', snapshot_sha256: '1'.repeat(64), inspected_snapshot_sha256: null, raw_summary: '', assessment: null, execution: { state: 'timed_out', model: 'local-test-model', declared_model: 'local-test-model', model_digest: '2'.repeat(64), image_digest: `sha256:${'3'.repeat(64)}`, duration_ms: 51000, inference_calls: 1, terminal_calls: 0, cleanup_confirmed: true } };
  const review = { id, mode: 'website_agent', state: 'needs_review', steps: ['investigator', 'reproducer', 'challenger'].map((role, i) => ({ role, state: 'completed', attempts: 1, device_id: String(i), operator_id: account.id, compute_group: 'one-host', result: { ...result, inspected_snapshot_sha256: i === 0 ? result.snapshot_sha256 : i === 1 ? null : '4'.repeat(64), execution: { ...result.execution, duration_ms: i === 0 ? 51000 : 0, inference_calls: i === 0 ? 1 : 0, terminal_calls: i === 0 ? 1 : 0 } }, fixture_matches: null, evidence_complete: false })), created_at: 1793448000, deadline_at: 1793450100, evidence_source: 'operator_reported_static_website_review_not_a_safety_verdict' };
  await page.route('**/api/reviews', route => route.fulfill({ json: [review] }));
  await page.route(`**/api/reviews/${id}`, route => route.fulfill({ json: review }));
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.getByRole('button', { name: 'Website snapshot review', exact: false }).click();
  const detail = page.getByRole('region', { name: 'Review report' });
  await expect(detail.getByRole('heading', { name: 'Needs review' })).toBeVisible();
  await expect(detail.getByText('Timed out', { exact: true })).toHaveCount(3);
  await expect(detail).toContainText('This role reached its time limit. Its assessment is incomplete.');
  await expect(detail.getByText('The time limit was reached before a model call started. No security assessment was made.')).toHaveCount(2);
  await expect(detail.getByText('Reported', { exact: true })).toHaveCount(0);
  await expect(detail).not.toContainText('No supported finding was reported.');
  for (const [i, state] of ['Recorded for this snapshot', 'Not confirmed', 'Not confirmed'].entries()) {
    const execution = detail.locator('.execution-details').nth(i);
    await execution.getByText('Execution details', { exact: true }).click();
    await expect(execution.locator('dt').filter({ hasText: /^Snapshot read$/ }).locator('+ dd')).toHaveText(state);
  }
  await expect(detail.getByRole('heading', { name: 'Needs review' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('snapshot comparison is an explicit private read and displays gaps without declaring removal', async ({ page }) => {
  await setup(page);
  const baseline = '00000000-0000-4000-8000-000000000101';
  const summary = { homepage_sha256: '2'.repeat(64), external_scripts: 1, inline_scripts: 0, skipped_scripts: 0, script_limit_reached: false, captured_response_bytes: 5000, requests_made: 2, finished_at: 1793448000 };
  const current = { ...pending, state: 'collected', evidence_available: true, summary };
  let retained = true;
  await page.route('**/api/site-checks', route => route.fulfill({ json: [current, { ...current, id: baseline, evidence_available: retained, summary: { ...summary, finished_at: summary.finished_at - 100 } }, { ...current, id: 'not-my-capture', requester_id: 'another-owner' }, { ...current, id: 'another-scope', scope_sha256: 'f'.repeat(64) }] }));
  await page.route(`**/api/site-checks/${id}`, route => route.fulfill({ json: current }));
  const fingerprint = { sha256: '1'.repeat(64), bytes: 20, content_type: 'text/html', headers: { 'content-security-policy': "default-src 'self'" } };
  let reads = 0;
  await page.route(`**/api/site-checks/${id}/compare/${baseline}`, route => {
    expect(route.request().method()).toBe('GET'); reads++;
    return route.fulfill({ json: { baseline_id: baseline, current_id: id, baseline_finished_at: summary.finished_at - 100, current_finished_at: summary.finished_at, script_references_changed: true, baseline_coverage: { captured_scripts: 1, skipped_scripts: 0, data_only_scripts: 0, script_limit_reached: false }, current_coverage: { captured_scripts: 0, skipped_scripts: 1, data_only_scripts: 0, script_limit_reached: false }, resources: [{ kind: 'homepage', url: 'https://example.com/', change: 'changed', before: fingerprint, after: { ...fingerprint, headers: { 'content-security-policy': '<img src=x onerror=alert(1)>' } } }, { kind: 'external_script', url: 'https://example.com/app.js', change: 'only_earlier', before: fingerprint, after: null }] } });
  });
  await page.getByRole('button', { name: 'https://example.com/', exact: false }).first().click();
  const comparison = page.getByRole('region', { name: 'Compare saved snapshots' });
  await expect(comparison.getByRole('combobox')).toBeVisible();
  await expect(comparison.getByRole('option')).toHaveCount(2);
  expect(reads).toBe(0);
  await comparison.getByLabel('Earlier snapshot').selectOption(baseline);
  await expect(comparison.getByRole('heading', { name: 'Captured evidence differs.' })).toBeVisible();
  expect(reads).toBe(1);
  await expect(comparison).toContainText('Missing captures do not prove removal.');
  await expect(comparison).toContainText('Only in earlier capture');
  await comparison.getByText('https://example.com/', { exact: true }).click();
  await expect(comparison).toContainText('<img src=x onerror=alert(1)>');
  await expect(comparison.locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  retained = false;
  await page.getByRole('button', { name: 'Refresh websites ↻' }).click();
  await expect(comparison.getByRole('heading', { name: 'Captured evidence differs.' })).toHaveCount(0);
  await expect(comparison).toContainText('No earlier retained snapshot');
});

test('matching snapshots are not a safety verdict and failed comparison reads can be retried', async ({ page }) => {
  await setup(page);
  const baseline = '00000000-0000-4000-8000-000000000101';
  const summary = { homepage_sha256: '2'.repeat(64), external_scripts: 0, inline_scripts: 0, skipped_scripts: 0, script_limit_reached: false, captured_response_bytes: 5000, requests_made: 1, finished_at: 1793448000 };
  const current = { ...pending, state: 'collected', evidence_available: true, summary };
  await page.route('**/api/site-checks', route => route.fulfill({ json: [current, { ...current, id: baseline, summary: { ...summary, finished_at: summary.finished_at - 100 } }] }));
  await page.route(`**/api/site-checks/${id}`, route => route.fulfill({ json: current }));
  const coverage = { captured_scripts: 0, skipped_scripts: 0, data_only_scripts: 0, script_limit_reached: false };
  const fingerprint = { sha256: '1'.repeat(64), bytes: 20, content_type: 'text/html', headers: {} };
  let fail = true;
  await page.route(`**/api/site-checks/${id}/compare/${baseline}`, route => fail ? route.fulfill({ status: 503, json: { error: 'dispatcher_unavailable' } }) : route.fulfill({ json: { baseline_id: baseline, current_id: id, baseline_finished_at: summary.finished_at - 100, current_finished_at: summary.finished_at, script_references_changed: false, baseline_coverage: coverage, current_coverage: coverage, resources: [{ kind: 'homepage', url: 'https://example.com/', change: 'unchanged', before: fingerprint, after: fingerprint }] } }));
  await page.getByRole('button', { name: 'https://example.com/', exact: false }).first().click();
  const comparison = page.getByRole('region', { name: 'Compare saved snapshots' });
  await comparison.getByLabel('Earlier snapshot').selectOption(baseline);
  await expect(comparison.getByRole('alert')).toBeVisible();
  await expect(comparison.getByRole('heading', { name: 'Captured values match.' })).toHaveCount(0);
  fail = false;
  await comparison.getByRole('button', { name: 'Retry comparison' }).click();
  await expect(comparison.getByRole('heading', { name: 'Captured values match.' })).toBeVisible();
  await expect(comparison).toContainText('Matching captures do not establish safety.');
  await expect(comparison.getByRole('alert')).toHaveCount(0);
});
