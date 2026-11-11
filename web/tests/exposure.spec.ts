import { expect, test } from '@playwright/test';
import { exposureData } from '../src/exposure';
import type { HttpRecord, LiveStep, LiveToolRun } from '../src/LiveReport';
import { emptyDashboard } from './helpers';

const origin = 'https://owned.example';
function record(id: number, overrides: Partial<HttpRecord> = {}): HttpRecord {
  return { id, method: 'GET', url: origin + '/api/me', status: 200, headers: { 'content-type': 'application/json', 'Content-Security-Policy': "default-src 'self'" }, body_excerpt: 'Private body should not be summarized', truncated: false, error: null, ...overrides };
}
function tool(name: string, ids: number[], overrides: Partial<LiveToolRun> = {}): LiveToolRun {
  return { tool: name, version: 'fixture', arguments: [], started_at: 1, duration_ms: 1, exit_code: 0, failure: null, evidence_ids: ids, output_sha256: 'a'.repeat(64), output_excerpt: '{}', output_truncated: false, ...overrides };
}
function step(evidence: HttpRecord[], tools: LiveToolRun[] = [], role: LiveStep['role'] = 'investigator'): LiveStep {
  return { role, state: 'completed', evidence_complete: true, result: { kind: 'pentest_agent_v1', scope_sha256: 'a'.repeat(64), raw_summary: '', evidence, tool_runs: tools, assessment: { summary: 'No confirmed findings', findings: [], limitations: [] }, execution: { state: 'completed', model: 'fixture', provider: 'fixture', duration_ms: 1000, http_requests: evidence.length, inference_calls: 0, cost_upper_microusd: 0, cleanup_confirmed: true } } };
}

test('exposure uses retained requests, preserves access contexts and scopes references by agent', () => {
  const data = exposureData([
    step([record(1, { status: 401 }), record(2, { authenticated: true }), record(3, { url: origin + '/missing', status: 404 })], [tool('patchriot-baseline', [1, 3]), tool('patchriot-deep', [1, 2]), tool('patchriot-coverage', [1, 2, 3])]),
    step([record(1, { authenticated: true })], [], 'reproducer'),
  ], [origin]);
  expect(data.requests).toBe(4);
  expect(data.routes).toHaveLength(2);
  expect(data.routes[0]).toMatchObject({ path: '/api/me', requests: 3, statuses: [401, 200], contexts: ['Public', 'Signed-in'], refs: ['Scout #1', 'Scout #2', 'Recon #1'], stages: ['baseline', 'deep', 'agent'] });
  expect(data.stages.map(s => [s.id, s.requests])).toEqual([['baseline', 2], ['deep', 2], ['agent', 1]]);
  expect(data.services).toEqual([{ origin, host: 'owned.example', protocol: 'HTTPS', port: 443, responses: 4 }]);
  expect(data.headers[0]).toMatchObject({ present: 4, responses: 4 });
});

test('exposure never imports query values, credentials, fragments, response bodies or scanner loopback', () => {
  const records = [
    record(1, { url: origin + '/login?token=secret-value&return=private-value#private-fragment', login: true, request_headers: { authorization: 'private-header' } }),
    record(2, { url: 'http://127.0.0.1:1234/private' }),
    record(3, { url: 'https://name:password@owned.example/private' }),
    record(4, { url: 'javascript:alert(1)' }),
    record(5, { url: 'https://outside.example/' }),
    record(6, { url: 'malformed' }),
  ];
  const data = exposureData([step(records)], [origin]);
  expect(data.requests).toBe(1);
  expect(data.excluded).toBe(5);
  expect(data.routes[0]).toMatchObject({ path: '/login', queryNames: ['return', 'token'], contexts: ['Sign-in step'], stages: ['access'] });
  const serialized = JSON.stringify(data);
  for (const secret of ['secret-value', 'private-value', 'private-fragment', 'private-header', 'Private body', '127.0.0.1', 'outside.example']) expect(serialized).not.toContain(secret);
});

test('HTTP service visibility requires a response and never infers unrelated open ports', () => {
  const data = exposureData([step([
    record(1, { status: null, error: 'timeout' }),
    record(2, { url: 'https://owned.example:8443/blocked', status: 403 }),
    record(3, { url: origin + '/broker-error', status: 200, error: 'transport_denied' }),
  ])], [origin, 'https://owned.example:8443']);
  expect(data.requests).toBe(3);
  expect(data.services).toEqual([{ origin: 'https://owned.example:8443', host: 'owned.example', protocol: 'HTTPS', port: 8443, responses: 1 }]);
  expect(data.routes.reduce((n, r) => n + r.failed, 0)).toBe(2);
  expect(data.headers[0].responses).toBe(1);
});

test('fingerprints need a structured supported receipt and in-scope request reference', () => {
  const data = exposureData([step([record(1), record(2)], [
    tool('ares-web-surface', [1], { output_excerpt: JSON.stringify({ technology_hints: ['nginx', '<script>evil()</script>', 'invented'], root_evidence_id: 1, observations: [{ technology_hints: ['WordPress'], evidence_id: 2 }, { technology_hints: ['PHP'], evidence_id: 99 }] }) }),
    tool('ares-web-surface', [2], { output_excerpt: '{"technology_hints":[' }),
  ])], [origin]);
  expect(data.technologies).toEqual([{ name: 'nginx', refs: ['Scout #1'] }]);
});

test('deep component receipts belong to deep scan and an empty result is not a safety verdict', () => {
  expect(exposureData([{ role: 'investigator', state: 'leased', result: null }], [origin])).toMatchObject({ requests: 0, routes: [], services: [], technologies: [] });
  const data = exposureData([step([record(1)], [tool('patchriot-surface', [1], { arguments: ['scoped', '--deep-suite'] })])], [origin]);
  expect(data.stages.map(s => s.id)).toEqual(['deep']);
});

test('exposure map works with zero findings, traces stages, filters contexts and keeps interactions local', async ({ page }, info) => {
  await emptyDashboard(page);
  const id = '00000000-0000-4000-8000-000000000003';
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id, display_name: 'Fixture owner', role: 'member' }, csrf_token: 'fixture-csrf' } }));
  await page.route('**/api/reviews/*/consistency-check', r => r.fulfill({ json: { state: 'not_started' } }));
  const records = [record(1, { url: origin + '/' }), record(2, { status: 401 }), record(3, { authenticated: true }), record(4, { url: origin + '/admin', status: 404 }), record(5, { url: origin + '/api/search?q=private-search-value' }), ...Array.from({ length: 9 }, (_, i) => record(i + 6, { url: origin + '/pages/' + i }))];
  const tools = [tool('patchriot-baseline', [1]), tool('patchriot-crawl', [1, 6, 7, 8, 9, 10, 11, 12, 13, 14]), tool('patchriot-discovery', [2, 3, 4]), tool('patchriot-deep', [4, 5]), tool('ares-web-surface', [1], { output_excerpt: JSON.stringify({ root_evidence_id: 1, technology_hints: ['nginx'] }) })];
  const review = { id, mode: 'pentest_agent', state: 'completed', created_at: 1, deadline_at: 3600, pentest: { scope: { origins: [origin], methods: ['GET'], authentication: 'session' }, review_policy: 'investigate_validate_v1', reviewers: [], provider: 'fixture' }, steps: [step(records, tools), step([record(1, { url: origin + '/', authenticated: true })], [], 'reproducer')] };
  await page.route(`**/api/reviews/${id}`, r => r.fulfill({ json: review }));
  const targetRequests: string[] = [];
  page.on('request', request => { if (request.url().startsWith(origin)) targetRequests.push(request.url()); });
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.goto(`/#/reviews/${id}`);
  const map = page.getByRole('region', { name: 'What your site exposes' });
  await expect(map).toBeVisible();
  await expect(map).toContainText('This is not a port scan');
  await expect(map).toContainText('nginx');
  await map.getByRole('button', { name: /Deep scan.*route and method pairs/ }).click();
  await expect(map.getByRole('group', { name: 'Observed routes' }).getByRole('button')).toHaveCount(2);
  await map.getByRole('button', { name: /GET.*\/api\/search/ }).click();
  await expect(map.getByLabel('Selected route details')).toContainText('Values are hidden');
  await expect(map).not.toContainText('private-search-value');
  await map.getByRole('button', { name: /Show request references/ }).click();
  await expect(map.getByLabel('Selected route details')).toContainText('Scout #5');
  await expect(map.locator('.exposure-stage[data-related=true] strong')).toHaveText(['Deep scan']);
  await map.screenshot({ path: info.outputPath('exposure-selected.png') });
  await map.getByRole('button', { name: /Assessment target/ }).click();
  await map.getByLabel('Filter request context').selectOption('Signed-in');
  await expect(map.getByRole('group', { name: 'Observed routes' }).getByRole('button')).toHaveCount(2);
  await map.getByLabel('Filter request context').selectOption('all');
  await map.getByLabel('Filter observed responses').selectOption('missing');
  await expect(map.getByRole('group', { name: 'Observed routes' }).getByRole('button')).toHaveCount(1);
  await map.getByLabel('Filter observed responses').selectOption('all');
  await map.getByRole('button', { name: 'Next observed routes' }).click();
  await expect(map).toContainText('8–');
  await map.getByRole('button', { name: 'Previous observed routes' }).click();
  await map.getByLabel('Search observed routes').fill('/api/');
  await expect(map.getByRole('group', { name: 'Observed routes' }).getByRole('button')).toHaveCount(2);
  await map.getByLabel('Search observed routes').fill('');
  for (const width of info.project.name === 'desktop' ? [1440, 1024] : [390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await map.screenshot({ path: info.outputPath(`exposure-${width}.png`) });
  }
  expect(targetRequests).toEqual([]);
  expect(writes).toEqual([]);
});
