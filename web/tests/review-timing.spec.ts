import { expect, test } from '@playwright/test';
import { emptyDashboard } from './helpers';

for (const scenario of ['first', 'estimate', 'overrun', 'failed'] as const) test(`agent time guide distinguishes ${scenario} from a promised ETA`, async ({ page }) => {
  await emptyDashboard(page);
  const now = Math.floor(Date.now() / 1000);
  await page.clock.install({ time: now * 1000 });
  const id = '00000000-0000-4000-8000-000000000003';
  await page.route('**/api/session', route => route.fulfill({ json: { account: { id, display_name: 'Owner', role: 'member' }, csrf_token: 'test-only' } }));
  const completed = { kind: 'pentest_agent_v1', scope_sha256: 'a'.repeat(64), execution: { state: scenario === 'failed' ? 'failed' : 'completed', duration_ms: 600_000, provider: 'fixture', model: 'fixture', inference_calls: 0, http_requests: 0, cost_upper_microusd: 0, cleanup_confirmed: true }, assessment: null, evidence: [], raw_summary: '' };
  await page.route(`**/api/reviews/${id}`, route => route.fulfill({ json: {
    id, mode: 'pentest_agent', state: 'running', created_at: now - 1000, deadline_at: now + 10800,
    evidence_source: 'operator_reported_live_http',
    timing: { role_limit_seconds: 3600, started_at: now - 1000, active_role_deadline_at: now + 3600 - (scenario === 'overrun' ? 900 : 120), requests_ahead: 0 },
    pentest: { pentest_id: id, scope: { origins: ['https://owned.example'], methods: ['GET'], objective: 'Owned fixture' }, scope_sha256: 'a'.repeat(64), reviewers: [], provider: 'fixture' },
    steps: [
      { role: 'investigator', state: scenario === 'first' ? 'leased' : 'completed', result: scenario === 'first' ? null : completed, evidence_complete: false },
      { role: 'reproducer', state: scenario === 'first' ? 'waiting' : 'leased', result: null },
      { role: 'challenger', state: 'waiting', result: null },
    ],
  } }));
  await page.goto(`/#/reviews/${id}`);
  const guide = page.getByLabel('Agent time guide');
  if (scenario === 'first' || scenario === 'failed') {
    await expect(guide).toContainText('configured time limits');
    await expect(guide).not.toContainText('roughly');
  } else {
    await expect(guide).toContainText('10 min recorded');
    await expect(guide).toContainText('roughly 10 min once started');
    await expect(guide).toContainText('queue waits are extra');
    await expect(guide).toContainText(scenario === 'overrun' ? 'taking longer than the earlier-agent average' : 'roughly 8 min more');
  }
});
