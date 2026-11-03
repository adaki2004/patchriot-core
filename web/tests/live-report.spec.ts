import { coverageChecks, reportFindings, reportSummary, type ReportInput } from '../src/report';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { emptyDashboard } from './helpers';
import { PDFDocument, PDFName } from 'pdf-lib';
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

async function setup(page: import('@playwright/test').Page, failed = false, stopped = false) {
  await emptyDashboard(page);
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id, display_name: 'Example owner', role: 'member' }, csrf_token: 'test-csrf' } }));
  await page.route('**/api/fleet', r => r.fulfill({ json: {} }));
  await page.route('**/api/review-codes', r => r.fulfill({ json: [] }));
  await page.route('**/api/devices', r => r.fulfill({ json: [] }));
  const review = { id, mode: 'pentest_agent', state: stopped ? 'failed' : failed ? 'needs_review' : 'running', created_at: 1793640000, deadline_at: 1793643000, evidence_source: 'operator_reported_live_http', pentest: { pentest_id: id, scope: { origins: ['https://owned.example'], methods: ['GET', 'HEAD', 'OPTIONS'], objective: 'Owned fixture' }, scope_sha256: 'a'.repeat(64), reviewers: [], provider: 'fixture-provider' }, steps: ['investigator', 'reproducer', 'challenger'].map((role, i) => ({ role, state: i === 0 ? 'completed' : i === 1 ? 'leased' : 'waiting', attempts: i === 2 ? 0 : 1, device_id: `device-${i}`, operator_id: 'same-operator', compute_group: 'same-host', fixture_matches: null, progress: i === 1 ? { received_at: 1793640020, progress: { phase: 'scoped_tools', http_requests: 8, inference_calls: 0, completed_tools: 2 } } : null, evidence_complete: !failed && i === 0, result: i === 0 ? failed ? { ...result, assessment: null, execution: { ...result.execution, state: 'failed', failure_reason: 'provider_budget_reached' } } : result : null })) };
  if (stopped) review.steps = review.steps.map((step, i) => ({ ...step, state: i ? 'cancelled' : 'failed', result: null, progress: null }));
  await page.route(`**/api/reviews/${id}`, r => r.fulfill({ json: review }));
  await page.goto(`/#/reviews/${id}`);
}

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
  await setup(page);
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
  expect(md).toContain(fixExample);
});

test('finding text and suggested code remain inert and fit mobile', async ({ page }) => {
  await setup(page);
  const finding = page.locator('.report-finding').first();
  await finding.locator('summary').first().click();
  await expect(finding.getByText('Suggested example · html', { exact: true })).toBeVisible();
  await expect(finding.locator('.remediation-example code')).toHaveText(fixExample.split('```html\n')[1].split('```')[0]);
  await expect(finding.locator('.remediation')).toContainText('<img src=x onerror="window.fixExecuted=true">');
  await expect(finding.locator('.remediation script, .remediation img')).toHaveCount(0);
  expect(await page.evaluate(() => 'fixExecuted' in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.report-finding > summary').nth(1).click();
  await expect(page.locator('.report-finding').nth(1)).toContainText('Keep this incomplete example visible.');
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
  await page.getByRole('button', { name: 'Agent reports', exact: true }).click();
  await expect(page.getByText('No assessment', { exact: true })).toBeVisible();
  await expect(page.getByText(/The agent reached its allowed AI usage budget/)).toBeVisible();
  await page.getByRole('button', { name: 'View recorded evidence' }).click();
  await page.getByText('Request evidence (2)', { exact: true }).click();
  await expect(page.getByText('HTTP #1', { exact: true })).toBeVisible();
});

test('stopped tests retain a report without fake motion or example actions', async ({ page }) => {
  await setup(page, false, true);
  await expect(page.getByRole('heading', { name: 'The test stopped early.' })).toBeVisible();
  await expect(page.getByText(/Scout stopped before its report arrived/)).toBeVisible();
  await expect(page.getByRole('button', { name: /New example|Run example|Cancel test/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Test a website' })).toBeVisible();
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
  expect(reportSummary(report).description).toContain('grouping 6 agent claims');
  expect(report.steps.every(s => s.result!.assessment!.findings.length === 2)).toBe(true);
});

test('matching labels do not merge different paths, query values, auth contexts or POST bodies', () => {
  for (const change of ['path', 'query', 'auth', 'body', 'missing']) {
    const report = repeatedReport();
    const evidence = report.steps[1].result!.evidence[0];
    if (change === 'path') evidence.url = 'https://owned.example/other?token=synthetic-value';
    if (change === 'query') evidence.url = 'https://owned.example/debug?token=another-value';
    if (change === 'auth') evidence.authenticated = true;
    if (change === 'body') { evidence.method = 'POST'; evidence.request_body_sha256 = 'c'.repeat(64); }
    if (change === 'missing') report.steps[1].result!.evidence.shift();
    expect(reportFindings(report), change).toHaveLength(4);
  }
  const report = repeatedReport();
  report.steps[0].result!.assessment!.findings.push(structuredClone(result.assessment!.findings[0]));
  expect(reportFindings(report)).toHaveLength(3); // Never erase two claims by one author.
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
  await page.route(`**/api/reviews/${id}`, r => r.fulfill({ json: { ...report, mode: 'pentest_agent', deadline_at: 1793643000, pentest: { scope: { origins: report.origins, methods: ['GET'] }, reviewers: [] } } }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Findings (2)', exact: true })).toBeVisible();
  await expect(page.getByText(/Roles differ — review needed/)).toBeVisible();
  await page.locator('.report-finding > summary').first().click();
  await expect(page.getByRole('button', { name: 'Inspect Verifier evidence' })).toBeVisible();
  await page.getByText('Other downloads & test details', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download readable report' }).click();
  const md = await readFile((await (await download).path())!, 'utf8');
  expect(md).toContain('## Observations (2)');
  expect(md).toContain('Roles differ — review needed.');
  for (const role of ['investigator', 'reproducer', 'challenger']) expect(md).toContain(`${role}#1`);
  expect(md.match(/^### [SRV]-\d+$/gm)).toHaveLength(2);
});
