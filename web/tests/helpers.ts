import type { Page } from '@playwright/test';

// Each test can replace these empty personal dashboard responses with its own data.
export async function emptyDashboard(page: Page) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') {
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
