import { emptyDashboard } from './helpers';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => { await emptyDashboard(page); });

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

test('public catalogue supports keyboard selection and reads source text without executing it', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Recent events', exact: true }).click();
  const rows = page.getByRole('table', { name: 'Published incidents' }).getByRole('button');
  await expect(rows).toHaveCount(2);
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  const detail = page.locator('.incident-reading');
  await expect(detail).toContainText('<img src=x onerror=alert(1)>');
  await expect(detail.locator('img, script')).toHaveCount(0);
  await expect(detail).toContainText('Reported · details developing');
  await expect(detail.getByRole('link', { name: 'Source advisory' })).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await detail.getByRole('button', { name: 'Back to catalogue', exact: false }).click();
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(detail).toContainText('A source-backed advisory');
  await detail.getByRole('button', { name: 'Next incident →' }).click();
  await expect(detail).toContainText('<script>alert(1)</script>');
  await detail.getByRole('button', { name: 'Back to catalogue', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Incident desk', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('catalogue text remains readable when idle, hovered or keyboard-focused', async ({ page }) => {
  await setup(page);
  await page.goto('/#/incidents');
    const table = page.getByRole('table', { name: 'Published incidents' });
  await expect(table.getByRole('button')).toHaveCount(2);
  for (const state of ['initial', 'hover', 'focused']) {
    if (state === 'hover') await table.getByRole('button').nth(1).hover();
    if (state === 'focused') {
      await table.getByRole('button').first().focus();
      await page.keyboard.press('ArrowDown');
      await expect(table.getByRole('button').nth(1)).toBeFocused();
    }
    const ratios = await table.locator('strong, td > span').evaluateAll(elements => {
      function luminance(color: string) {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
          const channel = Number(value) / 255;
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      }
      return elements.map(element => {
        let background = element.parentElement!;
        while (getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)' && background.parentElement) background = background.parentElement;
        const ink = luminance(getComputedStyle(element).color);
        const paper = luminance(getComputedStyle(background).backgroundColor);
        return (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05);
      });
    });
    for (const ratio of ratios) expect(ratio, `${state}: text needs 4.5:1 contrast`).toBeGreaterThanOrEqual(4.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a failed refresh keeps previous entries and explicitly marks them stale', async ({ page }) => {
  await setup(page);
  let failing = false;
  await page.route('**/api/incidents', route => route.fulfill(failing ? { status: 503, json: { error: 'database_unavailable' } } : { json: entries }));
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('table', { name: 'Published incidents' }).getByRole('button')).toHaveCount(2);
  failing = true;
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('alert')).toContainText('last successful response');
  await expect(page.getByRole('table', { name: 'Published incidents' }).getByRole('button')).toHaveCount(2);
  failing = false;
  await page.getByRole('button', { name: 'Retry watch log' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a catalogue row opens all report sections, full remediation and attributed source links', async ({ page }) => {
  await setup(page);
  const catalogue = {
    short_name: 'Example release', qualifying: 'October disclosure; intrusion began earlier', category: 'Release-channel compromise',
    fix: 'Replace the affected build and rotate credentials.',
    report: { label: 'Original research report', url: 'https://example.com/public-report' },
    sections: [{ label: 'Impact and limits', body: 'Downloads do not establish infections.' }, { label: 'Unknown', body: '<script>untrusted source text</script>' }],
  };
  await page.route('**/api/incidents', route => route.fulfill({ json: [{ ...entries[0], content: { ...content, catalogue } }] }));
  await page.goto('/#/incidents');
  const table = page.getByRole('table', { name: 'Published incidents' });
  await expect(table.getByRole('columnheader')).toHaveText(['Short name', 'Qualifying disclosure / investigation', 'Category', 'Fix / status']);
  await expect(table).toContainText(catalogue.fix);
  await table.getByText(catalogue.qualifying).click();
  const detail = page.getByRole('article', { name: content.title });
  await expect(detail).toContainText(content.summary);
  await expect(detail).toContainText(content.takeaway);
  for (const section of catalogue.sections) await expect(detail).toContainText(section.body);
  await expect(detail.locator('script')).toHaveCount(0);
  await expect(detail.getByRole('link', { name: 'Original research report' })).toHaveAttribute('href', catalogue.report.url);
  await detail.getByRole('button', { name: 'Back to catalogue', exact: false }).click();
  await expect(table.getByRole('button', { name: 'Example release' })).toBeFocused();
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
  await page.getByText('Administration', { exact: true }).click();
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

test('replacing an incident draft asks before discarding unsaved edits', async ({ page }) => {
  await setup(page, 'admin');
  const drafts = ['first', 'second'].map(id => ({ id, revision: 1, content: { ...content, title: `${id} draft` }, published_revision: null, published_at: null, updated_at: '2025-01-04T00:00:00Z' }));
  await page.route('**/api/admin/incidents', route => route.fulfill({ json: drafts }));
  const writes: unknown[] = [];
  await page.route('**/api/admin/incidents/*', route => { writes.push(route.request().postDataJSON()); return route.abort(); });
  let discard = false;
  const confirmations: string[] = [];
  page.on('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm'); confirmations.push(dialog.message());
    if (discard) await dialog.accept(); else await dialog.dismiss();
  });
  await page.goto('/');
  await page.getByText('Administration', { exact: true }).click();
  await page.getByRole('button', { name: 'Incident desk', exact: true }).click();
  const list = page.getByRole('complementary', { name: 'Saved incident drafts' });
  await list.getByRole('button').filter({ hasText: 'first draft' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Keep my source review');
  for (const button of [page.getByRole('button', { name: 'New entry +' }), list.getByRole('button').filter({ hasText: 'second draft' }), list.getByRole('button').filter({ hasText: 'first draft' })]) {
    await button.click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep my source review');
  }
  expect(confirmations).toHaveLength(3);
  discard = true;
  await list.getByRole('button').filter({ hasText: 'second draft' }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('second draft');
  expect(confirmations).toHaveLength(4);
  // Saved entries and untouched blank forms can be replaced without a warning.
  await page.getByRole('button', { name: 'New entry +' }).click();
  await page.getByRole('button', { name: 'New entry +' }).click();
  expect(confirmations).toHaveLength(4);
  expect(writes).toEqual([]);
});

test('declining an imported replacement preserves both the current edits and research JSON', async ({ page }) => {
  await setup(page, 'admin');
  await page.route('**/api/admin/incidents', route => route.fulfill({ json: [] }));
  const writes: unknown[] = [];
  await page.route('**/api/admin/incidents/*', route => { writes.push(route.request().postDataJSON()); return route.abort(); });
  let discard = false;
  const confirmations: string[] = [];
  page.on('dialog', async dialog => {
    confirmations.push(dialog.message());
    if (discard) await dialog.accept(); else await dialog.dismiss();
  });
  await page.goto('/');
  await page.getByText('Administration', { exact: true }).click();
  await page.getByRole('button', { name: 'Incident desk', exact: true }).click();
  await page.getByRole('button', { name: 'New entry +' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Current unsaved review');
  await page.getByRole('button', { name: 'Load research JSON' }).click();
  const raw = JSON.stringify(content);
  await page.getByLabel('Or paste one JSON entry').fill(raw);
  await page.getByRole('button', { name: 'Open as unsaved draft →' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Or paste one JSON entry')).toHaveValue(raw);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Current unsaved review');
  expect(confirmations).toHaveLength(1);
  discard = true;
  await page.getByRole('button', { name: 'Open as unsaved draft →' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(content.title);
  discard = false;
  await page.getByRole('button', { name: 'New entry +' }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(content.title);
  expect(confirmations).toHaveLength(3);
  expect(writes).toEqual([]);
});

for (const reopened of ['first', 'second']) test(`a delayed incident save preserves unsaved work after opening the ${reopened} draft`, async ({ page }) => {
  await setup(page, 'admin');
  let discard = true;
  const confirmations: string[] = [];
  page.on('dialog', async dialog => {
    confirmations.push(dialog.message());
    if (discard) await dialog.accept(); else await dialog.dismiss();
  });
  const drafts = ['first', 'second'].map(id => ({ id, revision: 1, content: { ...content, title: `${id} draft` }, published_revision: null, published_at: null, updated_at: '2025-01-04T00:00:00Z' }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const writes: unknown[] = [];
  await page.route('**/api/admin/incidents', route => route.fulfill({ json: drafts }));
  await page.route('**/api/admin/incidents/first', async route => {
    const body = route.request().postDataJSON(); writes.push(body); started = true;
    if (writes.length > 1) return route.fulfill({ status: 409, json: { error: 'incident_changed' } });
    await pending;
    drafts[0] = { ...drafts[0], revision: 2, content: body.content };
    await route.fulfill({ json: drafts[0] });
  });
  try {
    await page.goto('/');
    await page.getByText('Administration', { exact: true }).click();
  await page.getByRole('button', { name: 'Incident desk', exact: true }).click();
    const list = page.getByRole('complementary', { name: 'Saved incident drafts' });
    await list.getByRole('button').filter({ hasText: 'first draft' }).click();
    await page.getByLabel('Title', { exact: true }).fill('First draft saved slowly');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await list.getByRole('button').filter({ hasText: `${reopened} draft` }).click();
    await page.getByLabel('Title', { exact: true }).fill('Keep this newer unsaved wording');
    release();
    await expect(list.getByRole('button').filter({ hasText: 'First draft saved slowly' })).toBeVisible();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep this newer unsaved wording');
    await expect(page.getByRole('region', { name: 'Incident editor' })).toContainText('Unsaved changes');
    await expect(page.getByRole('button', { name: 'Publish saved draft' })).toBeDisabled();
    expect(writes).toEqual([{ action: 'save', revision: 1, content: { ...content, title: 'First draft saved slowly' } }]);
    // The old save must not clear the new editor's discard protection either.
    discard = false;
    await page.getByRole('button', { name: 'New entry +' }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep this newer unsaved wording');
    expect(confirmations).toHaveLength(2);
    if (reopened === 'first') {
      // Reopening the same saved version does not silently adopt a later revision.
      // The server must still detect the conflict and preserve the unsaved text.
      await page.getByRole('button', { name: 'Save draft', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('This entry changed');
      expect(writes[1]).toEqual({ action: 'save', revision: 1, content: { ...content, title: 'Keep this newer unsaved wording' } });
      await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep this newer unsaved wording');
    }
  } finally { release(); }
});

test('research import stays local and unsaved until the admin saves the editable draft', async ({ page }) => {
  await setup(page, 'admin');
  await page.route('**/api/admin/incidents', route => route.fulfill({ json: [] }));
  const writes: unknown[] = [];
  await page.route('**/api/admin/incidents/*', async route => {
    const body = route.request().postDataJSON(); writes.push(body);
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    await route.fulfill({ json: { id: route.request().url().split('/').at(-1), revision: 1, content: body.content, published_revision: null, published_at: null, updated_at: '2025-01-04T00:00:00Z' } });
  });
  await page.goto('/');
  await page.getByText('Administration', { exact: true }).click();
  await page.getByRole('button', { name: 'Incident desk', exact: true }).click();
  await page.getByRole('button', { name: 'Load research JSON' }).click();
  const imported = { ...content, title: '<img src=x onerror=alert(1)>', summary: 'Untrusted research claim. Check its sources.' };
  await page.getByLabel('JSON file').setInputFiles({ name: 'research.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await expect(page.getByLabel('Or paste one JSON entry')).toHaveValue(JSON.stringify(imported));
  await expect(page.getByRole('status')).toContainText('Loaded research.json');
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Open as unsaved draft →' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(imported.title);
  await expect(page.getByRole('region', { name: 'Incident editor' })).toContainText('Unsaved changes');
  await expect(page.getByRole('button', { name: 'Publish saved draft' })).toHaveCount(0);
  await expect(page.locator('.incident-editor img, .incident-editor script')).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.getByLabel('Title', { exact: true }).fill('Edited after checking the source');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('public entry has not changed');
  expect(writes).toEqual([{ action: 'save', revision: 0, content: { ...imported, title: 'Edited after checking the source' } }]);
  await expect(page.getByRole('button', { name: 'Publish saved draft' })).toBeDisabled();
});

test('research brief copies a dated public-only request without starting work or publishing', async ({ page }) => {
  await setup(page, 'admin');
  await page.route('**/api/admin/incidents', route => route.fulfill({ json: [{ id: 'private-draft', revision: 1, published_revision: null, updated_at: '2025-01-04T00:00:00Z', content: { ...content, title: 'Private draft canary' } }] }));
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  await page.goto('/');
  await page.getByText('Administration', { exact: true }).click();
  await page.getByRole('button', { name: 'Incident desk', exact: true }).click();
  await expect(page.getByText('Private draft canary', { exact: true })).toBeVisible();
  const before = Date.now();
  await page.getByRole('button', { name: 'Load research JSON' }).click();
  await page.getByText('Need a brief for your research agent?', { exact: true }).click();
  const brief = page.getByLabel('Research brief', { exact: true });
  await expect(brief).toHaveAttribute('readonly', '');
  const text = await brief.inputValue();
  const window = text.match(/Research window: (\S+) to (\S+) \(UTC\)/)!;
  expect(window).not.toBeNull();
  const start = Date.parse(window[1]), end = Date.parse(window[2]);
  expect(end - start).toBe(72 * 60 * 60 * 1000);
  expect(end).toBeGreaterThanOrEqual(before);
  expect(end).toBeLessThanOrEqual(Date.now());
  for (const privateValue of ['Private draft canary', 'admin-test', 'Test editor', 'test-csrf']) expect(text).not.toContain(privateValue);
  expect(text).toContain('one JSON object');
  expect(text).toContain('human source review');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { document.documentElement.dataset.copiedBrief = value; } } }));
  await page.getByRole('button', { name: 'Copy research brief', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Research brief copied.');
  expect(await page.evaluate(() => document.documentElement.dataset.copiedBrief)).toBe(text);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied'); } } }));
  await page.getByRole('button', { name: 'Copy research brief', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('copy it manually');
  await expect(brief).toHaveValue(text);
  expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Open as unsaved draft →' })).toBeDisabled();
  await page.getByRole('button', { name: 'Close research import' }).click();
  expect(writes).toEqual([]);
  await expect(page.getByRole('region', { name: 'Incident editor' })).toHaveCount(0);
});

test('research import rejects oversized files, extra fields and incomplete reports without saving', async ({ page }) => {
  await setup(page, 'admin');
  await page.route('**/api/admin/incidents', route => route.fulfill({ json: [] }));
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  await page.goto('/');
  await page.getByText('Administration', { exact: true }).click();
  await page.getByRole('button', { name: 'Incident desk', exact: true }).click();
  await page.getByRole('button', { name: 'Load research JSON' }).click();
  await page.getByLabel('JSON file').setInputFiles({ name: 'too-large.json', mimeType: 'application/json', buffer: Buffer.alloc(12_001, 65) });
  await expect(page.getByRole('alert')).toContainText('at most 12 KB');
  const input = page.getByLabel('Or paste one JSON entry');
  for (const raw of ['```json\n{}\n```', JSON.stringify([content]), JSON.stringify({ ...content, private_report: 'do not import' }), JSON.stringify({ ...content, sources: [] }), JSON.stringify({ ...content, title: ['not text'] })]) {
    await input.fill(raw);
    await page.getByRole('button', { name: 'Open as unsaved draft →' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
  }
  await page.getByText('Expected JSON format', { exact: true }).click();
  expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close research import' }).click();
  expect(writes).toEqual([]);
  await expect(page.getByRole('region', { name: 'Incident editor' })).toHaveCount(0);
});
