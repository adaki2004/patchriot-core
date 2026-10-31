import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const content = {
  title: 'A source-backed advisory', occurred_on: '2025-01-01', evidence: 'advisory',
  summary: 'An explicit browser-test example, not a real incident.', takeaway: 'Check the affected version.',
  sources: [{ label: 'Source advisory', url: 'https://github.com/advisories/GHSA-example' }],
};
const entries = [
  { id: 'first', revision: 2, published_at: '2025-01-02T00:00:00Z', content },
  { id: 'second', revision: 4, published_at: '2025-01-03T00:00:00Z', content: { ...content, title: '<script>alert(1)</script>', summary: '<img src=x onerror=alert(1)>', evidence: 'reported' } },
];

async function setup(page: Page, role?: 'member' | 'admin') {
  await page.route('**/api/session', route => route.fulfill({ json: { account: role ? { id: 'admin-test', display_name: 'Test editor', role, auth_method: 'invite' } : null, csrf_token: role ? 'test-csrf' : null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 0, online_operators: 0, online_compute_groups: 0 } }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  await page.route('**/api/incidents', route => route.fulfill({ json: entries }));
}

test('public log supports keyboard and touch selection without executing source text', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Watch log', exact: true }).click();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await tabs.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('.incident-terminal img, .incident-terminal script')).toHaveCount(0);
  await expect(page.getByRole('tabpanel')).toContainText('Reported · details developing');
  await page.keyboard.press('Home');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await tabs.nth(1).click();
  await expect(page.getByRole('tabpanel')).toContainText('<script>alert(1)</script>');
  const source = page.getByRole('link', { name: 'Source advisory' });
  await expect(source).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(page.getByRole('button', { name: 'Incident desk', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a failed refresh keeps previous entries and explicitly marks them stale', async ({ page }) => {
  await setup(page);
  let failing = false;
  await page.route('**/api/incidents', route => route.fulfill(failing ? { status: 503, json: { error: 'database_unavailable' } } : { json: entries }));
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(2);
  failing = true;
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('alert')).toContainText('last successful response');
  await expect(page.getByRole('tab')).toHaveCount(2);
  failing = false;
  await page.getByRole('button', { name: 'Retry watch log' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('admin saves separately from publication and cannot publish unsaved changes', async ({ page }) => {
  await setup(page, 'admin');
  let saved: { id: string; revision: number; content: typeof content; published_revision: number | null; published_at: string | null; updated_at: string } | null = null;
  const actions: string[] = [];
  await page.route('**/api/admin/incidents', route => route.fulfill({ json: saved ? [saved] : [] }));
  await page.route('**/api/admin/incidents/*', async route => {
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    const body = route.request().postDataJSON();
    actions.push(body.action);
    if (body.action === 'save') {
      expect(body.revision).toBe(saved?.revision ?? 0);
      saved = { id: route.request().url().split('/').at(-1)!, revision: body.revision + 1, content: body.content, published_revision: saved?.published_revision ?? null, published_at: saved?.published_at ?? null, updated_at: '2025-01-04T00:00:00Z' };
    } else {
      expect(saved).not.toBeNull();
      expect(body.sources_reviewed).toBe(true);
      saved = { ...saved!, revision: saved!.revision + 1, published_revision: saved!.revision + 1, published_at: '2025-01-04T00:00:00Z' };
    }
    await route.fulfill({ json: saved });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Incident desk', exact: true }).click();
  await page.getByRole('button', { name: 'New entry +' }).click();
  await page.getByLabel('Title', { exact: true }).fill(content.title);
  await page.getByLabel('Incident or advisory date (UTC)').fill(content.occurred_on);
  await page.getByLabel('What happened?', { exact: true }).fill(content.summary);
  await page.getByLabel('Practical takeaway', { exact: true }).fill(content.takeaway);
  await page.getByLabel('Source 1 name').fill(content.sources[0].label);
  await page.getByLabel('Source 1 URL').fill(content.sources[0].url);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('public entry has not changed');
  await expect(page.getByRole('button', { name: 'Publish saved draft' })).toBeDisabled();
  await page.getByLabel('I checked the public sources').check();
  await page.getByRole('button', { name: 'Publish saved draft' }).click();
  await expect(page.getByRole('status')).toContainText('Published to the watch log');
  // Reopen the saved record: textarea contents must not become part of its label.
  await page.getByRole('complementary', { name: 'Saved incident drafts' }).getByRole('button').filter({ hasText: content.title }).click();
  await page.getByLabel('What happened?', { exact: true }).fill('A draft correction with its own evidence.');
  await page.getByLabel('Practical takeaway', { exact: true }).fill('The published version stays visible until this correction is approved.');
  await page.getByLabel('Title', { exact: true }).fill('Draft correction');
  await expect(page.getByRole('button', { name: 'Publish saved draft' })).toBeDisabled();
  await expect(page.getByLabel('I checked the public sources')).toBeDisabled();
  expect(actions).toEqual(['save', 'publish']);
  await expect(page.getByRole('region', { name: 'Incident editor' })).toContainText('Save your changes before publishing');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
