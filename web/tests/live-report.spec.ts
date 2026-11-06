import { coverageChecks, reportFindings, reportSummary, roleOutcome, stopExplanation, type ReportInput } from '../src/report';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { emptyDashboard } from './helpers';
import { PDFDocument, PDFName } from 'pdf-lib';
import type { LiveResult } from '../src/LiveReport';

const id = '00000000-0000-4000-8000-000000000003';
const fixExample = 'Disable the debug route in production.\n\n```html\n<script>window.fixExecuted=true</script>\n<!-- ' + 'untrusted-example-'.repeat(60) + ' -->\n```\n\nIllustrative only; verify the route returns 404. <img src=x onerror="window.fixExecuted=true">' + '\n\n```nginx\nlocation = /debug {\n    return 404;\n}\n```\n\n```json\n{"debug":true}\n```';
const result: LiveResult = {
  kind: 'pentest_agent_v1', scope_sha256: 'a'.repeat(64),
  execution: { state: 'completed', model: 'fixture-model', provider: 'fixture-provider', duration_ms: 30000, http_requests: 2, inference_calls: 4, cost_upper_microusd: 0, cleanup_confirmed: true },
  tool_runs: [{ tool: 'nuclei', version: '3.11.1', arguments: ['-u', 'http://127.0.0.1:1234'], started_at: 1793640000, duration_ms: 2000, exit_code: 0, failure: null, evidence_ids: [1, 2], output_sha256: 'a'.repeat(64), output_excerpt: '<script>window.toolExecuted=true</script>', output_truncated: true }],
  assessment: { summary: 'Owned fixture: debug information appeared in an unauthenticated response. A control route returned 404.', findings: [{ title: 'Debug metadata exposed', severity: 'low', support: 'observed', explanation: 'The fixture returned debug metadata. This has not been reproduced independently.', reproduction: 'GET /debug?token=synthetic-value\nCompare the 404 control.', suggested_action: fixExample, evidence_ids: [1, 2] }, { title: '<script>window.fake=true</script>', severity: 'info', support: 'needs_review', explanation: 'Target text is displayed literally.', reproduction: 'No execution proof.', suggested_action: 'Review the target input handling.\n```unfinished\nKeep this incomplete example visible.', evidence_ids: [1] }], limitations: ['No authenticated accounts or state-changing operations were tested.'] },
  evidence: [{ id: 1, method: 'GET', url: 'https://owned.example/debug?token=synthetic-value', status: 200, request_headers: {}, headers: { 'content-type': 'application/json' }, body_excerpt: '{"debug":"fixture"}', body_sha256: 'b'.repeat(64), observed_at: 1793640000, truncated: false, error: null }, { id: 2, method: 'GET', url: 'https://owned.example/control', status: 404, headers: {}, body_excerpt: 'Not found', truncated: false, error: null }], raw_summary: '',
};

test('two completed reports are complete only for the resolved conditional policy', async () => {
  const report: ReportInput = { id, state:'completed', created_at:1793640000, origins:['https://owned.example'], review_policy:'investigate_verify_v1', third_review:{reasons:[]}, steps: (['investigator','reproducer'] as const).map(role=>({role,state:'completed',result,evidence_complete:true})) };
  expect(reportSummary(report).partial).toBe(false);
  expect(reportSummary(report).description).toContain('2 of 2 agent reports');
  expect(reportSummary({...report,third_review:undefined}).partial).toBe(true);
  const stopped = reportSummary({...report, state:'needs_review', steps:[report.steps[0],{role:'reproducer',state:'failed',result:null}]});
  expect(stopped.headline).toBe('Run ended · some checks missing');
  expect(stopped.description).toContain('Nothing is still running. Recon did not finish');
  expect(stopped.description).not.toContain('Verifier did not finish');
  expect(reportSummary({...report,review_policy:undefined,third_review:undefined}).partial).toBe(true);
  expect(reportSummary({...report,third_review:{reasons:['serious_finding']}}).description).toContain('2 of 3 agent reports');
});

test('finished reports keep coverage limits separate from missing login or interrupted execution', () => {
  const report: ReportInput = { id, state:'needs_review', created_at:1793640000, origins:['https://owned.example'], review_policy:'investigate_verify_v1', third_review:{reasons:[]}, steps: (['investigator','reproducer'] as const).map(role=>({role,state:'completed',result,evidence_complete:false})) };
  const summary = reportSummary(report);
  expect(summary.headline).toBe('Report ready · coverage limits');
  expect(summary.partial).toBe(true);
  expect(summary.complete).toBe(0); // Presentation never upgrades the server's evidence decision.
  expect(roleOutcome(report.steps[0]).label).toBe('Report received · coverage limits');
  expect(reportSummary({...report, browser_login:true}).headline).toBe('Report ready · sign-in not verified');
  for (const execution of [
    {...result.execution, state:'failed', failure_reason:'provider_unavailable'},
    {...result.execution, cleanup_confirmed:false},
  ]) {
    const interrupted = {...report.steps[0], result:{...result,execution}};
    expect(roleOutcome(interrupted).label).toBe('Interrupted assessment');
    expect(reportSummary({...report, steps:[interrupted,report.steps[1]]}).reportsReady).toBe(false);
  }
  expect(reportSummary({...report, third_review:undefined}).reportsReady).toBe(false);
  expect(reportSummary({...report, state:'cancelled'}).reportsReady).toBe(false);
  expect(reportSummary({...report, steps:[report.steps[0], report.steps[0]]}).reportsReady).toBe(false);
  expect(stopExplanation('near_verification_timeout')).toContain('model response or verification');
  expect(stopExplanation('near_signature_invalid')).toContain('verification could not be completed');
});

async function setup(page: import('@playwright/test').Page, failed = false, stopped = false, finished = false, browser?: 'verified' | 'gap') {
  await emptyDashboard(page);
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id, display_name: 'Example owner', role: 'member' }, csrf_token: 'test-csrf' } }));
  await page.route('**/api/fleet', r => r.fulfill({ json: {} }));
  await page.route('**/api/review-codes', r => r.fulfill({ json: [] }));
  await page.route('**/api/devices', r => r.fulfill({ json: [] }));
  const review = { id, mode: 'pentest_agent', state: stopped ? 'failed' : (failed || finished) ? 'needs_review' : 'running', created_at: 1793640000, deadline_at: 1793643000, evidence_source: 'operator_reported_live_http', pentest: { pentest_id: id, scope: { origins: ['https://owned.example'], methods: ['GET', 'HEAD', 'OPTIONS'], objective: 'Owned fixture' }, scope_sha256: 'a'.repeat(64), reviewers: [], provider: 'fixture-provider' }, steps: ['investigator', 'reproducer', 'challenger'].map((role, i) => ({ role, state: i === 0 ? 'completed' : i === 1 ? 'leased' : 'waiting', attempts: i === 2 ? 0 : 1, device_id: `device-${i}`, operator_id: 'same-operator', compute_group: 'same-host', fixture_matches: null, progress: i === 1 ? { received_at: 1793640020, progress: { phase: 'scoped_tools', http_requests: 8, inference_calls: 0, completed_tools: 2 } } : null, evidence_complete: !failed && i === 0, result: i === 0 ? failed ? { ...result, assessment: null, execution: { ...result.execution, state: 'failed', failure_reason: 'provider_budget_reached' } } : result : null })) };
  if (browser) {
    Object.assign(review.pentest.scope, { authentication: 'session', browser_login: {} });
    review.steps[0].evidence_complete = browser === 'verified';
    review.steps[0].result = { ...result, ...(browser === 'verified' ? { browser_access: { authenticated_id: 1, anonymous_id: 2, check: { kind: 'protected_resource' as const } } } : {}), evidence: result.evidence.map((e, i) => ({...e, url:'https://owned.example/account', status:i ? 401 : 200, authenticated:!i, body_excerpt:i ? 'Sign in required' : '{"account":"fixture"}'})) };
  }
  await mockExport(page, review);
  if (stopped) review.steps = review.steps.map((step, i) => ({ ...step, state: i ? 'cancelled' : 'failed', result: null, progress: null }));
  await page.route(`**/api/reviews/${id}`, r => r.fulfill({ json: review }));
  await page.goto(`/#/reviews/${id}`);
}

for (const mode of ['verified', 'gap'] as const) test(`browser access ${mode} is explicit in the report and exports`, async ({page}) => {
  await setup(page, false, false, true, mode);
  await page.getByRole('button', {name:'Agent reports', exact:true}).click();
  // A gap remains visible even when a model returned a plausible report.
  const expected = mode === 'verified' ? 'Signed-in access verified:' : 'Signed-in access was not verified.';
  await expect(page.getByText(expected, {exact:false}).first()).toBeVisible();
  if (mode === 'verified') await expect(page.getByText('Evidence #1 and #2.', {exact:false}).first()).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', {name:'Download vulnerability report'}).click();
  const pdf = await PDFDocument.load(await readFile((await (await download).path())!));
  expect(pdf.getPageCount()).toBeGreaterThan(1);
  await page.getByText('Other downloads & test details', {exact:true}).click();
  const readable = page.waitForEvent('download');
  await page.getByRole('button', {name:'Download readable report'}).click();
  const body = await readFile((await (await readable).path())!, 'utf8');
  expect(body).toContain(expected);
  expect(body).toContain('Signed-in access was not verified.'); // unfinished roles
});

async function mockExport(page: import('@playwright/test').Page, review: unknown) {
  let first: number | undefined;
  await page.route(`**/api/reviews/${id}/report`, r => {
    expect(r.request().method()).toBe('POST');
    expect(r.request().headers()['x-csrf-token']).toBe('test-csrf');
    first ??= Math.floor(Date.now() / 1000);
    return r.fulfill({ json: { ...(review as object), retention: { first_downloaded_at: first, expires_at: first + 12 * 3600, content_deleted: false } } });
  });
}

test('NEAR report advice needs consent, renders inert text and exports through retention', async ({ page }) => {
  await page.clock.install();
  let state = 'not_requested', writes = 0, exports = 0, reads = 0;
  const advice = { duplicate_groups: [['investigator-1', 'reproducer-1']], review_ids: ['challenger-1'], explanation: '<img src=x onerror="window.checkExecuted=true"> Compare the evidence.' };
  const result = { advisory_only: true, advice, omitted_findings: 0, receipt: { kind: 'provider_tee', request_sha256: 'a'.repeat(64), response_sha256: 'b'.repeat(64), signer: 'fixture' } };
  await page.route(`**/api/reviews/${id}/consistency-check`, async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
      expect(route.request().postDataJSON()).toEqual({ accepts_near_ai: true });
      writes++; state = 'queued';
    } else reads++;
    await route.fulfill({ json: { state, can_request: state === 'not_requested', model: 'fixture-model', result: state === 'verified' ? result : null } });
  });
  page.on('request', r => { if (r.url().endsWith('/report')) exports++; });
  await setup(page, false, false, true);
  const check = page.getByLabel('NEAR AI report check');
  await check.locator('summary').first().click();
  await expect(check.getByRole('button', { name: 'Check this report' })).toBeDisabled();
  expect(writes).toBe(0); expect(exports).toBe(0);
  await check.getByRole('checkbox').check();
  await check.getByRole('button', { name: 'Check this report' }).click();
  await expect(check.getByText('Waiting for the report checker.')).toBeVisible();
  state = 'verified'; await page.clock.fastForward(5000);
  await expect(check.getByText('1 possible overlap', { exact: true })).toBeVisible();
  await expect(check.getByText('Scout #1 · Recon #1')).not.toBeVisible();
  await check.getByText('What was compared?', { exact: true }).click();
  await expect(check.getByText('Scout #1 · Recon #1')).toBeVisible();
  await expect(check.locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => 'checkExecuted' in window)).toBe(false);
  const previous = reads; await page.clock.fastForward(60_000); expect(reads).toBe(previous);
  const download = page.waitForEvent('download');
  await check.getByText('Verification receipt', { exact: true }).click();
  await check.getByRole('button', { name: 'Download check & signature ↓' }).click();
  const file = await download;
  expect(JSON.parse(await readFile((await file.path())!, 'utf8'))).toEqual(result);
  expect(exports).toBe(1); expect(writes).toBe(1);
  await expect(page.getByText('Save a copy before', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an unavailable checker keeps the original findings and never shows a proof badge', async ({ page }) => {
  let writes = 0;
  await page.route(`**/api/reviews/${id}/consistency-check`, route => {
    if (route.request().method() === 'POST') writes++;
    return route.fulfill({ json: { state: 'unavailable', can_request: false, model: 'fixture-model', error_code: 'response_signature_unavailable' } });
  });
  await setup(page, false, false, true);
  const check = page.getByLabel('NEAR AI report check'); await check.locator('summary').first().click();
  await expect(check.getByText(/could not be completed and verified/)).toBeVisible();
  await expect(check.getByRole('button')).toHaveCount(0);
  await expect(page.locator('.report-check-summary')).toHaveCount(0);
  await expect(page.getByText('Debug metadata exposed', { exact: true })).toBeVisible(); expect(writes).toBe(0);
});

test('expired receipt download cannot save stale model advice', async ({ page }) => {
  await page.route(`**/api/reviews/${id}/consistency-check`, route => route.fulfill({ json: { state: 'verified', can_request: false, model: 'fixture-model', result: { advisory_only: true, advice: { duplicate_groups: [], review_ids: [], explanation: 'Fixture.' }, omitted_findings: 0, receipt: { kind: 'provider_tee' } } } }));
  await setup(page, false, false, true);
  await page.route(`**/api/reviews/${id}/report`, route => route.fulfill({ status: 410, json: { error: 'report_content_deleted' } }));
  let downloads = 0; page.on('download', () => downloads++);
  const check = page.getByLabel('NEAR AI report check'); await check.locator('summary').first().click();
  await check.getByText('Verification receipt', { exact: true }).click();
  await check.getByRole('button', { name: 'Download check & signature ↓' }).click();
  await expect(check.getByRole('alert')).toBeVisible(); expect(downloads).toBe(0);
});

test('a compact report preserves the author, uncertainty and request references', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('progressbar', { name: 'Role reports received' })).toHaveAttribute('value', '1');
  await page.getByText('Latest activity', { exact: true }).click();
  await expect(page.getByText('Running scoped tools', { exact: true })).toBeVisible();
  await expect(page.getByText('8 requests · 0 model calls · 2 tool runs recorded', { exact: true })).toBeVisible();
  await expect(page.getByText('Debug metadata exposed', { exact: true })).toBeVisible();
  await expect(page.locator('.report-finding-body').first()).not.toBeVisible();
  await expect(page.getByText('<script>window.fake=true</script>', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'fake' in window)).toBe(false);
  await page.getByRole('combobox', { name: 'Filter by severity' }).selectOption('high');
  await expect(page.getByText('No observations at this severity.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Filter by severity' }).selectOption('all');
  await page.locator('.report-finding > summary').first().click();
  await page.getByRole('button', { name: 'Inspect evidence' }).click();
  await page.getByText('Request evidence (2)', { exact: true }).click();
  await expect(page.getByText('HTTP #1', { exact: true })).toBeVisible();
  await page.getByText('Request and response headers', { exact: true }).first().click();
  await expect(page.getByText('Recorded response headers', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('PDF, original report and endpoint downloads keep their distinct purposes', async ({ page }) => {
  await setup(page, false, false, true);
  const pdfDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download vulnerability report' }).click();
  const pdfFile = await pdfDownload;
  expect(pdfFile.suggestedFilename()).toBe(`patchriot-${id}-report.pdf`);
  const pdf = await PDFDocument.load(await readFile((await pdfFile.path())!));
  expect(pdf.getTitle()).toBe('Patchriot vulnerability report');
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(8);
  expect(pdf.catalog.get(PDFName.of('OpenAction'))).toBeUndefined();
  await page.getByText('Other downloads & test details', { exact: true }).click();
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
  const md = await readFile((await (await report).path())!, 'utf8');
  expect(md).toContain('https://owned.example');
  expect(md).toContain('investigator#1');
  expect(md).toContain('Recommended fix (not tested)');
  expect(md).toContain('```html\n<script>window.fixExecuted=true</script>');
  expect(md).toContain('&lt;img src=x');
  expect(md).not.toContain('\n<img src=x');
  expect(md).toContain('```json');
});

test('large evidence stays intact while the report and PDF stay concise', async ({ page }) => {
  await setup(page);
  const review = await page.evaluate(async id => (await fetch(`/api/reviews/${id}`)).json(), id);
  review.state = 'completed';
  for (const step of review.steps) {
    step.state = 'completed'; step.evidence_complete = true; step.progress = null;
    step.result = structuredClone(result);
    step.result.evidence[0].body_excerpt = 'x'.repeat(4 * 1024 * 1024 - 16384) + '-END-OF-PRIVATE-EVIDENCE';
    step.result.evidence[0].truncated = true;
  }
  const wire = JSON.stringify(review);
  expect(wire.length).toBeGreaterThan(11 * 1024 * 1024);
  await page.route(`**/api/reviews/${id}`, r => r.fulfill({ contentType: 'application/json', body: wire }));
  await mockExport(page, review);
  await page.reload();
  await expect(page.getByText('Debug metadata exposed', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const pdfDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download vulnerability report' }).click();
  const pdfBytes = await readFile((await (await pdfDownload).path())!);
  expect(pdfBytes.length).toBeLessThan(1024 * 1024);
  expect((await PDFDocument.load(pdfBytes)).getPageCount()).toBeGreaterThan(5);
  await page.getByText('Other downloads & test details', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download evidence JSON', exact: false }).click();
  const body = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  delete body.retention;
  expect(JSON.stringify(body)).toBe(wire);
});

test('finding text and suggested code remain inert and fit mobile', async ({ page }) => {
  await setup(page);
  const finding = page.locator('.report-finding').first();
  await finding.locator('summary').first().click();
  await expect(finding.getByText('Code / evidence · html', { exact: true })).toBeVisible();
  await expect(finding.locator('.remediation-example code')).toHaveCount(3);
  await expect(finding.locator('.remediation-example code').nth(0)).toHaveText(fixExample.split('```html\n')[1].split('```')[0]);
  await expect(finding.locator('.remediation-example code').nth(1)).toContainText('return 404;');
  await expect(finding.locator('.remediation-example code').nth(2)).toHaveText('{\n  "debug": true\n}');
  await expect(finding.locator('.report-prose').nth(1)).toContainText('<img src=x onerror="window.fixExecuted=true">');
  await expect(finding.locator('.report-prose script, .report-prose img')).toHaveCount(0);
  expect(await page.evaluate(() => 'fixExecuted' in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.report-finding > summary').nth(1).click();
  await expect(page.locator('.report-finding').nth(1)).toContainText('Keep this incomplete example visible.');
});

test('viewing unfinished work does not start a download or deletion clock', async ({ page }) => {
  let exports = 0;
  page.on('request', r => { if (r.url().endsWith('/report')) exports++; });
  await setup(page);
  await expect(page.getByRole('button', { name: 'Download vulnerability report' })).toBeDisabled();
  await expect(page.getByText(/Downloads become available when the test ends/)).toBeVisible();
  await page.getByText('Other downloads & test details', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download readable report' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download evidence JSON' })).toBeDisabled();
  expect(exports).toBe(0);
});

test('finished evidence stops polling and remains refreshable', async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  page.on('request', r => { if (r.url().endsWith(`/api/reviews/${id}`)) reads++; });
  await setup(page, false, false, true);
  await expect(page.getByText('Debug metadata exposed', { exact: true })).toBeVisible();
  // The development server uses React StrictMode, which can start and abort
  // an extra initial read. Check that finished work adds no polling reads.
  const initialReads = reads;
  expect(initialReads).toBeGreaterThanOrEqual(1);
  expect(initialReads).toBeLessThanOrEqual(2);
  await page.clock.fastForward(600_000);
  expect(reads).toBe(initialReads);
  await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect.poll(() => reads).toBe(initialReads + 1);
});

test('the first export shows a fixed deadline and the open page hides expired findings', async ({ page }) => {
  await page.clock.install();
  await setup(page, false, false, true);
  await page.getByText('Other downloads & test details', { exact: true }).click();
  const first = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download evidence JSON' }).click();
  const firstBody = JSON.parse(await readFile((await (await first).path())!, 'utf8'));
  const firstNotice = await page.locator('.report-retention').innerText();
  expect(firstNotice).toContain('further downloads do not extend');
  const second = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download evidence JSON' }).click();
  const secondBody = JSON.parse(await readFile((await (await second).path())!, 'utf8'));
  expect(secondBody.retention).toEqual(firstBody.retention);
  expect(await page.locator('.report-retention').innerText()).toBe(firstNotice);
  await page.clock.fastForward(12 * 3600 * 1000 + 1000);
  await expect(page.getByRole('heading', { name: 'Private report deleted' })).toBeVisible();
  await expect(page.getByText('Debug metadata exposed', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Download/ })).toHaveCount(0);
});

test('a refused export never saves stale evidence from an open page', async ({ page }) => {
  await setup(page, false, false, true);
  await page.route(`**/api/reviews/${id}/report`, r => r.fulfill({ status: 410, json: { error: 'report_content_deleted' } }));
  let downloads = 0; page.on('download', () => downloads++);
  await page.getByText('Other downloads & test details', { exact: true }).click();
  await page.getByRole('button', { name: 'Download evidence JSON' }).click();
  await expect(page.getByRole('alert')).toContainText('private content has been deleted');
  expect(downloads).toBe(0);
});

test('raw tool output is hidden until requested and never interpreted as HTML', async ({ page }) => {
  await setup(page);
  await expect(page.getByText('<script>window.toolExecuted=true</script>', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Technical evidence', exact: true }).click();
  await page.getByText('Tools run (1)', { exact: true }).click();
  await expect(page.getByText('nuclei · 3.11.1', { exact: true })).toBeVisible();
  await expect(page.getByText('<script>window.toolExecuted=true</script>', { exact: true })).not.toBeVisible();
  await page.getByText('Tool output', { exact: true }).click();
  await expect(page.getByText('<script>window.toolExecuted=true</script>', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'toolExecuted' in window)).toBe(false);
  await page.getByRole('button', { name: 'Inspect tool requests' }).click();
  await expect(page.getByText('HTTP #1', { exact: true })).toBeVisible();
});

test('a missing assessment is explained as unfinished work, not zero vulnerabilities', async ({ page }) => {
  await setup(page, true);
  await expect(page.getByText('No agent has returned a usable assessment.', { exact: false })).toBeVisible();
  await expect(page.locator('.report-counts div').filter({ hasText: 'Observations' }).locator('dd')).toHaveText('—');
  await page.getByRole('button', { name: 'Agent reports', exact: true }).click();
  await expect(page.getByText('No assessment', { exact: true })).toBeVisible();
  await expect(page.locator('.report-agent').first().locator('dl div').filter({ hasText: 'Observations' }).locator('dd')).toHaveText('—');
  await expect(page.getByText(/The agent reached its allowed AI usage budget/)).toBeVisible();
  await page.getByRole('button', { name: 'View recorded evidence' }).click();
  await page.getByText('Request evidence (2)', { exact: true }).click();
  await expect(page.getByText('HTTP #1', { exact: true })).toBeVisible();
});

test('requested discovery without a receipt is unconfirmed and summary waits stay visible', async ({ page }) => {
  await setup(page);
  let recovered = false;
  await page.route(`**/api/reviews/${id}`, async route => {
    const response = { id, mode:'pentest_agent', state:'running', created_at:1793640000,
      pentest:{scope:{origins:['https://owned.example'],tools:['artex_engine_v1']},reviewers:[]},
      steps:[{role:'investigator',state:'completed',result:{...result,assessment:null},evidence_complete:false},
        {role:'reproducer',state:'leased',result:recovered ? {...result,tool_runs:[{...result.tool_runs![0],tool:'artex-engine'}]} : null,progress:{received_at:1793640020,progress:{
          phase:'investigating',http_requests:12,inference_calls:5,completed_tools:1,
          model_request:{purpose:'summary',elapsed_seconds:95}}}}] };
    await route.fulfill({json:response});
  });
  await page.reload();
  await page.getByText('Latest activity', {exact:true}).click();
  await expect(page.getByText('Summarizing the investigation · 95s', {exact:true})).toBeVisible();
  await page.getByRole('button', {name:'Coverage & tools',exact:true}).click();
  await expect(page.getByText('ARTEX was requested, but Scout returned no engine completion record.', {exact:false})).toBeVisible();
  recovered = true;
  await page.reload();
  await page.getByRole('button', {name:'Coverage & tools',exact:true}).click();
  await expect(page.getByText('ARTEX was requested, but Scout returned no engine completion record.', {exact:false})).toHaveCount(0);
  await expect(page.getByRole('row').filter({hasText:'artex-engine'})).toContainText('Recon');
});

test('stopped tests retain a report without fake motion or example actions', async ({ page }) => {
  await setup(page, false, true);
  await expect(page.getByRole('heading', { name: 'The test stopped early.' })).toBeVisible();
  await expect(page.getByText(/Scout stopped before its report arrived/)).toBeVisible();
  await expect(page.getByRole('button', { name: /New example|Run example|Cancel test/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Test a web application' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No findings available yet' })).toBeVisible();
  expect(await page.locator('.assessment-orbit-signal').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
});

test('active decoration respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page);
  await expect(page.getByRole('heading', { name: 'Recon is on the case.' })).toBeVisible();
  expect(await page.locator('.assessment-orbit-signal').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
});

test('coverage accepts recorded checks with valid provenance and rejects invented request IDs', () => {
  const check = { id: 'cors', origin: 'https://owned.example', title: 'CORS', status: 'finding', summary: 'Review the credentialed-origin response.', evidence_ids: [1] };
  const tool = { tool: 'patchriot-baseline', version: 'web-checks-v1', output_truncated: false, evidence_ids: [1], output_excerpt: JSON.stringify({ profile: 'web-checks-v1', checks: [check] }) };
  const source = { ...result, tool_runs: [tool] } as unknown as LiveResult;
  expect(coverageChecks(source)).toEqual([check]);
  tool.output_excerpt = JSON.stringify({ profile: 'web-checks-v1', checks: [{ ...check, evidence_ids: [999] }] });
  expect(coverageChecks(source)).toEqual([]);
  tool.output_excerpt = '<script>fixture only</script>';
  expect(coverageChecks(source)).toEqual([]);
});

function repeatedReport(): ReportInput {
  return { id, state: 'completed', created_at: 1, origins: ['https://owned.example'], steps: (['investigator', 'reproducer', 'challenger'] as const).map(role => ({ role, state: 'completed', evidence_complete: true, result: structuredClone(result) })) };
}

test('repeated findings count once while keeping all roles, citations and conflicting conclusions', () => {
  const report = repeatedReport();
  report.steps[1].result!.assessment!.findings[0].support = 'reproduced';
  report.steps[2].result!.assessment!.findings[0].support = 'not_reproduced';
  report.steps[2].result!.assessment!.findings[0].severity = 'info';
  const findings = reportFindings(report);
  expect(findings).toHaveLength(2);
  expect(findings[0].disputed).toBe(true);
  expect(findings[0].finding.severity).toBe('low');
  expect(findings[0].contributions.map(c => c.role)).toEqual(['investigator', 'reproducer', 'challenger']);
  expect(findings[0].contributions[2].finding.support).toBe('not_reproduced');
  expect(findings[0].contributions.every(c => c.finding.evidence_ids.join(',') === '1,2')).toBe(true);
  expect(reportSummary(report).description).toContain('from 6 agent observations');
  expect(report.steps.every(s => s.result!.assessment!.findings.length === 2)).toBe(true);
});

test('matching labels group request variants without altering their distinct evidence', () => {
  for (const change of ['path', 'query', 'body']) {
    const report = repeatedReport();
    const evidence = report.steps[1].result!.evidence[0];
    if (change === 'path') evidence.url = 'https://owned.example/other?token=synthetic-value';
    if (change === 'query') evidence.url = 'https://owned.example/debug?token=another-value';
    if (change === 'body') { evidence.method = 'POST'; evidence.request_body_sha256 = 'c'.repeat(64); }
    const original = JSON.stringify(report);
    const grouped = reportFindings(report);
    expect(grouped, change).toHaveLength(2);
    expect(grouped.every(g => g.variedRequests)).toBe(true);
    expect(grouped[0].contributions[1].result.evidence[0]).toEqual(evidence);
    expect(JSON.stringify(report)).toBe(original);
  }
});

test('missing evidence, different origins and separate claims by one author stay separate', () => {
  for (const change of ['missing', 'origin', 'mixed-origins', 'malformed']) {
    const report = repeatedReport();
    const evidence = report.steps[1].result!.evidence;
    if (change === 'missing') evidence.shift();
    if (change === 'origin') evidence.forEach(e => { e.url = e.url.replace('owned.example', 'other.example'); });
    if (change === 'mixed-origins') evidence[0].url = 'https://other.example/debug';
    if (change === 'malformed') evidence[0].url = 'invalid URL';
    expect(reportFindings(report), change).toHaveLength(4);
  }
  const report = repeatedReport();
  report.steps[0].result!.assessment!.findings.push(structuredClone(result.assessment!.findings[0]));
  expect(reportFindings(report)).toHaveLength(3); // Never erase two claims by one author.
});

test('the same schema-error observation across endpoints appears once with all examples', () => {
  const report = repeatedReport();
  for (const [i, step] of report.steps.entries()) {
    const r = step.result!;
    r.assessment!.findings = [{ ...r.assessment!.findings[0], title: 'Verbose deserialization errors disclose request schema', severity: 'info', evidence_ids: [1] }];
    r.evidence[0] = { ...r.evidence[0], method: 'POST', url: `https://owned.example/${['auth/challenge', 'market-check', 'drafts'][i]}`, status: 422, request_body_sha256: String(i).repeat(64) };
  }
  report.steps[2].result!.assessment!.findings[0].support = 'not_reproduced';
  const original = JSON.stringify(report);
  const rows = reportFindings(report);
  expect(rows).toHaveLength(1);
  expect(rows[0].variedRequests).toBe(true);
  expect(rows[0].disputed).toBe(true);
  expect(rows[0].contributions.map(c => c.result.evidence[0].url)).toEqual(['auth/challenge', 'market-check', 'drafts'].map(p => `https://owned.example/${p}`));
  expect(rows[0].contributions.map(c => c.finding.evidence_ids)).toEqual([[1], [1], [1]]);
  expect(JSON.stringify(report)).toBe(original);
});

test('anonymous and account checks group without losing conflicting evidence or changing originals', () => {
  const report = repeatedReport();
  report.steps[0].result!.evidence[0].authenticated = true;
  report.steps[1].result!.evidence[0].authenticated = false;
  report.steps[1].result!.assessment!.findings[0].support = 'not_reproduced';
  report.steps[2].evidence_complete = false;
  const original = JSON.stringify(report);
  const findings = reportFindings(report);
  expect(findings).toHaveLength(2);
  expect(findings[0].disputed).toBe(true);
  expect(findings[0].complete).toBe(false);
  expect(findings[0].contributions.map(c => c.result.evidence[0].authenticated)).toEqual([true, false, undefined]);
  expect(findings[0].contributions[1].finding.support).toBe('not_reproduced');
  expect(JSON.stringify(report)).toBe(original);
});

test('only the narrow HSTS spelling variant is normalized, without hiding a different conclusion', () => {
  const report = repeatedReport();
  for (const step of report.steps) step.result!.assessment!.findings[0].title = 'Strict-Transport-Security header absent on all responses';
  report.steps[1].result!.assessment!.findings[0].title = 'Strict-Transport-Security absent on all responses';
  expect(reportFindings(report)).toHaveLength(2);
  report.steps[2].result!.assessment!.findings[0].title = 'Strict-Transport-Security header present on all responses';
  expect(reportFindings(report)).toHaveLength(3);
});

test('the grouped report and downloaded Markdown retain all contributions without counting them twice', async ({ page }) => {
  await setup(page);
  const report = repeatedReport();
  report.steps[2].result!.assessment!.findings[0].support = 'not_reproduced';
  report.steps[0].result!.evidence[0].authenticated = true;
  report.steps[2].result!.evidence[0].url = 'https://owned.example/another-example';
  const review = { ...report, mode: 'pentest_agent', deadline_at: 1793643000, pentest: { scope: { origins: report.origins, methods: ['GET'] }, reviewers: [] } };
  await page.route(`**/api/reviews/${id}`, r => r.fulfill({ json: review }));
  await mockExport(page, review);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Findings (2)', exact: true })).toBeVisible();
  await expect(page.getByText(/Roles differ — review needed/)).toBeVisible();
  await page.locator('.report-finding > summary').first().click();
  await expect(page.locator('.report-finding').first().getByText(/Different request examples/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inspect Verifier evidence' })).toBeVisible();
  await expect(page.locator('.report-finding').first().getByText(/Scout · Test account · GET/)).toBeVisible();
  await expect(page.locator('.report-finding').first().getByText(/Recon · Anonymous · GET/)).toBeVisible();
  await page.getByText('Other downloads & test details', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download readable report' }).click();
  const md = await readFile((await (await download).path())!, 'utf8');
  expect(md).toContain('## Observations (2)');
  expect(md).toContain('Roles differ — review needed.');
  expect(md).toContain('First cited request: Test account · GET');
  expect(md).toContain('First cited request: Anonymous · GET');
  expect(md).toContain('https://owned.example/another-example');
  expect(md).toContain('Different request examples:');
  for (const role of ['investigator', 'reproducer', 'challenger']) expect(md).toContain(`${role}#1`);
  expect(md.match(/^### [SRV]-\d+$/gm)).toHaveLength(2);
});

test('queue waiting and active role deadlines are explained separately', async ({ page }) => {
  await setup(page);
  const review = { ...repeatedReport(), mode: 'pentest_agent', state: 'queued', deadline_at: 1793726400,
    timing: { role_limit_seconds: 3600, started_at: null as number | null, active_role_deadline_at: null as number | null, requests_ahead: 2 },
    pentest: { scope: { origins: ['https://owned.example'], methods: ['GET'] }, reviewers: [] },
    steps: (['investigator', 'reproducer', 'challenger'] as const).map(role => ({ role, state: 'queued', result: null })),
  };
  await page.route(`**/api/reviews/${id}`, r => r.fulfill({ json: review }));
  await page.reload();
  await expect(page.getByText(/2 earlier tests share your selected agents/)).toBeVisible();
  await expect(page.getByText(/Each agent gets up to 60 minutes after its own work starts/)).toBeVisible();
  await expect(page.getByText(/Run window ends/)).toHaveCount(0);
  await expect(page.getByText(/This agent’s time limit ends/)).toHaveCount(0);
  review.state = 'running'; review.steps[0].state = 'leased';
  review.timing.started_at = 1793640000; review.timing.active_role_deadline_at = 1793643600;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Scout is on the case.' })).toBeVisible();
  await expect(page.getByText(/This agent’s time limit ends/)).toBeVisible();
  await expect(page.getByText(/2 earlier tests share your selected agents/)).toHaveCount(0);
  await page.getByText('Timing & permission', { exact: true }).click();
  await expect(page.getByText(/Work must stop if permission or test-account access expires/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Venice recovery is disclosed on the report and readable export', async ({page}) => {
  await emptyDashboard(page);
  await page.route('**/api/session', r=>r.fulfill({json:{account:{id,display_name:'Owner',role:'member'},csrf_token:'test-csrf'}}));
  const routed={...result,execution:{...result.execution,provider:'near.ai',model:'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated',fallback:{model:'deepseek-v4-1-flash-1017-uncensored',reason:'provider_rate_limited',primary_attempts:1,fallback_attempts:4,fallback_completed:4}}};
  const review={id,mode:'pentest_agent',state:'needs_review',created_at:1793640000,deadline_at:1793643000,
    pentest:{pentest_id:id,scope:{origins:['https://owned.example'],methods:['GET'],objective:'Owned fixture'},scope_sha256:'a'.repeat(64),reviewers:[],provider:'near.ai',allows_venice_fallback:true},
    steps:[{role:'investigator',state:'completed',evidence_complete:true,result:routed}]};
  await mockExport(page,review);
  await page.route(`**/api/reviews/${id}`,r=>r.fulfill({json:review}));
  await page.goto(`/#/reviews/${id}`);
  await expect(page.getByRole('status').filter({hasText:'Venice recovery was attempted'})).toContainText('Backup inference is not NEAR TEE execution.');
  await page.getByRole('button',{name:'Technical evidence',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Venice fallback:'})).toContainText('4 completed replies');
  await page.getByText('Other downloads & test details', {exact:true}).click();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download readable report ↓'}).click();
  const file=await download;
  const body=await readFile((await file.path())!,'utf8');
  expect(body).toContain('deepseek-v4-1-flash-1017-uncensored');
  expect(body).toContain('4 completed replies from 4 attempts; 1 NEAR attempts.');
  expect(body).toContain('not NEAR TEE execution');
});
