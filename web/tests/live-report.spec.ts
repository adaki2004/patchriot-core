import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { emptyDashboard } from './helpers';
import type { LiveResult } from '../src/LiveReport';

const id = '00000000-0000-4000-8000-000000000003';
const fixExample = 'Disable the debug route in production.\n\n```html\n<script>window.fixExecuted=true</script>\n<!-- ' + 'untrusted-example-'.repeat(60) + ' -->\n```\n\nIllustrative only; verify the route returns 404. <img src=x onerror="window.fixExecuted=true">';
const result: LiveResult = {
  kind: 'pentest_agent_v1', scope_sha256: 'a'.repeat(64),
  execution: { state: 'completed', model: 'fixture-model', provider: 'fixture-provider', duration_ms: 30000, http_requests: 2, inference_calls: 4, cost_upper_microusd: 0, cleanup_confirmed: true },
  tool_runs: [{ tool: 'nuclei', version: '3.11.1', arguments: ['-u', 'http://127.0.0.1:1234'], started_at: 1793640000, duration_ms: 2000, exit_code: 0, failure: null, evidence_ids: [1, 2], output_sha256: 'a'.repeat(64), output_excerpt: '<script>window.toolExecuted=true</script>', output_truncated: true }],
  assessment: { summary: 'Owned fixture: debug information appeared in an unauthenticated response. A control route returned 404.', findings: [{ title: 'Debug metadata exposed', severity: 'low', support: 'observed', explanation: 'The fixture returned debug metadata. This has not been reproduced independently.', reproduction: 'GET /debug?token=synthetic-value\nCompare the 404 control.', suggested_action: fixExample, evidence_ids: [1, 2] }, { title: '<script>window.fake=true</script>', severity: 'info', support: 'needs_review', explanation: 'Target text is displayed literally.', reproduction: 'No execution proof.', suggested_action: 'Review the target input handling.\n```unfinished\nKeep this incomplete example visible.', evidence_ids: [1] }], limitations: ['No authenticated accounts or state-changing operations were tested.'] },
  evidence: [{ id: 1, method: 'GET', url: 'https://owned.example/debug?token=synthetic-value', status: 200, request_headers: {}, headers: { 'content-type': 'application/json' }, body_excerpt: '{"debug":"fixture"}', body_sha256: 'b'.repeat(64), observed_at: 1793640000, truncated: false, error: null }, { id: 2, method: 'GET', url: 'https://owned.example/control', status: 404, headers: {}, body_excerpt: 'Not found', truncated: false, error: null }], raw_summary: '',
};

async function setup(page: import('@playwright/test').Page, failed = false) {
  await emptyDashboard(page);
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id, display_name: 'Example owner', role: 'member' }, csrf_token: 'test-csrf' } }));
  await page.route('**/api/fleet', r => r.fulfill({ json: {} }));
  await page.route('**/api/review-codes', r => r.fulfill({ json: [] }));
  await page.route('**/api/devices', r => r.fulfill({ json: [] }));
  const review = { id, mode: 'pentest_agent', state: failed ? 'needs_review' : 'running', created_at: 1793640000, deadline_at: 1793643000, evidence_source: 'operator_reported_live_http', pentest: { pentest_id: id, scope: { origins: ['https://owned.example'], methods: ['GET', 'HEAD', 'OPTIONS'], objective: 'Owned fixture' }, scope_sha256: 'a'.repeat(64), reviewers: [], provider: 'fixture-provider' }, steps: ['investigator', 'reproducer', 'challenger'].map((role, i) => ({ role, state: i === 0 ? 'completed' : i === 1 ? 'leased' : 'waiting', attempts: i === 2 ? 0 : 1, device_id: `device-${i}`, operator_id: 'same-operator', compute_group: 'same-host', fixture_matches: null, progress: i === 1 ? { received_at: 1793640020, progress: { phase: 'scoped_tools', http_requests: 8, inference_calls: 0, completed_tools: 2 } } : null, evidence_complete: !failed && i === 0, result: i === 0 ? failed ? { ...result, assessment: null, execution: { ...result.execution, state: 'failed', failure_reason: 'provider_budget_reached' } } : result : null })) };
  await page.route(`**/api/reviews/${id}`, r => r.fulfill({ json: review }));
  await page.goto(`/#/reviews/${id}`);
}

test('live reports show saved progress, inert findings, and referenced requests', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('progressbar', { name: 'Role reports received' })).toHaveAttribute('value', '1');
  await expect(page.getByText('1 of 3 role reports received', { exact: true })).toBeVisible();
  await expect(page.getByText('Running scoped tools', { exact: true })).toBeVisible();
  await expect(page.getByText('8 requests · 0 model calls · 2 tool runs recorded', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scout', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recon', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verifier', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '<script>window.fake=true</script>' })).toBeVisible();
  expect(await page.evaluate(() => 'fake' in window)).toBe(false);
  await page.getByRole('combobox', { name: 'Filter findings', exact: true }).selectOption('unconfirmed');
  await expect(page.getByRole('heading', { name: 'Debug metadata exposed' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Filter findings', exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Inspect 2 supporting requests' }).click();
  await expect(page.getByText('HTTP #1', { exact: true })).toBeVisible();
  await expect(page.getByText('HTTP #2', { exact: true })).toBeVisible();
  await page.getByText('Request and response headers', { exact: true }).first().click();
  await expect(page.getByText('Recorded response headers', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('report and endpoint exports preserve scope without putting query values in Postman', async ({ page }) => {
  await setup(page);
  const postman = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export observed endpoints' }).click();
  const download = await postman;
  const body = await readFile((await download.path())!, 'utf8');
  const collection = JSON.parse(body);
  expect(body).not.toContain('synthetic-value');
  expect(collection.item).toHaveLength(2);
  expect(collection.item[0].request.url.query).toEqual([{ key: 'token', value: '', disabled: true, description: 'Observed name; value omitted from export.' }]);
  const report = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download readable report' }).click();
  const saved = await report;
  const md = await readFile((await saved.path())!, 'utf8');
  expect(md).toContain('https://owned.example');
  expect(md).toContain('investigator#1');
  expect(md).toContain('Recommended fix (not tested)');
  expect(md).toContain('```text\n<script>window.fake=true</script>');
  expect(md).toContain('### Recorded tools');
  expect(md).toContain('3.11.1');
  expect(md).toContain(fixExample);
  expect(md).toContain('````text\nDisable the debug route');
});

test('fix examples stay inert, preserve code, and fit the viewport', async ({ page }) => {
  await setup(page);
  const finding = page.locator('.live-finding').first();
  await finding.getByText('Recommended fix', { exact: true }).click();
  await expect(finding.getByText('Suggested example · html', { exact: true })).toBeVisible();
  await expect(finding.locator('.remediation-example code')).toHaveText(fixExample.split('```html\n')[1].split('```')[0]);
  await expect(finding.locator('.remediation')).toContainText('<img src=x onerror="window.fixExecuted=true">');
  await expect(finding.locator('.remediation script, .remediation img')).toHaveCount(0);
  expect(await page.evaluate(() => 'fixExecuted' in window)).toBe(false);
  const example = finding.locator('.remediation-example pre');
  await expect(example).toBeVisible();
  expect(await example.evaluate(el => ({ scrolling: el.scrollWidth > el.clientWidth, whitespace: getComputedStyle(el).whiteSpace }))).toEqual({ scrolling: true, whitespace: 'pre' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const unfinished = page.locator('.live-finding').nth(1);
  await unfinished.getByText('Recommended fix', { exact: true }).click();
  await expect(unfinished.locator('.remediation')).toContainText('```unfinished');
  await expect(unfinished.locator('.remediation')).toContainText('Keep this incomplete example visible.');
});

test('tool transcripts remain inert and open actual HTTP references', async ({ page }) => {
  await setup(page);
  await page.getByText('Tools run (1)', { exact: true }).click();
  await expect(page.getByText('nuclei · 3.11.1', { exact: true })).toBeVisible();
  await expect(page.getByText('<script>window.toolExecuted=true</script>', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'toolExecuted' in window)).toBe(false);
  await page.getByRole('button', { name: 'Inspect tool requests' }).click();
  await expect(page.getByText('HTTP #1', { exact: true })).toBeVisible();
  await expect(page.getByText('HTTP #2', { exact: true })).toBeVisible();
});

test('a failed role retains requests and does not present missing assessment as a clean test', async ({ page }) => {
  await setup(page, true);
  await expect(page.getByRole('heading', { name: 'This role needs review.' })).toBeVisible();
  await expect(page.getByText('Stopped: provider budget reached.')).toBeVisible();
  await expect(page.getByText('No findings match this filter.')).toHaveCount(0);
  await page.getByText('Request evidence (2)', { exact: true }).click();
  await expect(page.getByText('HTTP #1', { exact: true })).toBeVisible();
});
