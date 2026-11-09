import type { Page } from '@playwright/test';

// Each test can replace these empty personal dashboard responses with its own data.
export async function emptyDashboard(page: Page) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') {
      if (path === '/api/auth/providers') return route.fulfill({ json: { github: false, google: false } });
      if (path === '/api/wallet/config') return route.fulfill({ json: { enabled: false } });
      if (path === '/api/trial') return route.fulfill({ json: { available: false, ends_at: null, claim: null } });
      if (path === '/api/admin/trial') return route.fulfill({ json: { campaign: null, total_claimed: 0, reserved: 0, started: 0 } });
      if (path === '/api/admin/review-stats') return route.fulfill({ json: { requested: 0, live_requested: 0, awaiting_verification: 0, review_runs: 0, awaiting_payment: 0, queued: 0, running: 0, completed: 0, needs_review: 0, failed: 0, cancelled: 0, as_of: 1793808000 } });
      if (path === '/api/analytics') return route.fulfill({ json: { enabled: false } });
      if (['/api/pentests', '/api/pentest-tools', '/api/reviews', '/api/site-checks', '/api/sources', '/api/orders', '/api/review-codes', '/api/agents'].includes(path)) return route.fulfill({ json: [] });
      if (path === '/api/withdrawals') return route.fulfill({ json: { enabled: false, minimum_claim: '10000000', balance: { earned: '0', available: '0', reserved: '0', paid: '0' }, destinations: [], claims: [], receipts: [] } });
      if (path === '/api/earnings') return route.fulfill({ json: { work: [] } });
      if (path === '/api/devices') return route.fulfill({ json: [] });
      if (path === '/api/fleet') return route.fulfill({ json: { online_devices: 0, online_operators: 0, online_compute_groups: 0 } });
    }
    return route.fallback();
  });
}

export async function openAuditTool(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Audits', exact: true }).click();
  await page.getByText('Saved material and test examples', { exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}

// Legacy checkout fixtures explicitly confirm the new final step. Dedicated
// confirmation tests provide their own preparation success/failure responses.
export async function completeStartConfirmation(page: Page) {
  await page.route('**/api/pentests/*/prepare', r => r.fulfill({json:{accepted:true}}));
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('checkbox',{name:/I own this system/}).check();
  await dialog.getByRole('button',{name:'Confirm & start test'}).click();
}
