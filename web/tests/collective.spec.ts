import { expect, test } from '@playwright/test';
import { emptyDashboard } from './helpers';

test('Collective shows the selected hero, logo and consistent navigation', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { account: null, csrf_token: null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: {} }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
  await page.goto('/#/home');
  await expect(page.locator('html')).toHaveAttribute('data-design', 'collective');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('BUILD YOURDEFENSE NETWORK.');
  await expect(page.locator('header .brand-mark')).toHaveAttribute('src', '/brand/white-hat.png');
  expect((await page.locator('header .brand-mark').boundingBox())!.width).toBeGreaterThanOrEqual(64);
  const navigation = page.getByRole('navigation', { name: 'Website' });
  await expect(navigation.getByRole('button')).toHaveText(['Home', 'Recent events', 'Docs', 'App ↗']);
  await navigation.getByRole('button', { name: 'App', exact: false }).click();
  await expect(page.getByRole('dialog', { name: 'Sign in or request access' }).getByLabel('Username', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Public/private comparison, motion and access work with a keyboard', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { account: null, csrf_token: null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 3, online_operators: 2, online_compute_groups: 2 } }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/home');
  await expect(page.locator('.textmode-landing')).toHaveAttribute('data-paused', 'true');
  await expect(page.locator('animateMotion')).toHaveCount(0);
  await expect(page.getByLabel('Live fleet counts')).toContainText('3 AGENTS ONLINE');
  await expect(page.locator('.compare-heading')).toHaveText('PUBLIC NETWORKYOUR PRIVATE NETWORK');
  await expect(page.locator('.tm-swarms .blueprint-deployments h4')).toHaveText(['Public network', 'Your private network']);
  const geometry = await page.locator('.coordination-map').evaluateAll(maps => maps.map(map => [...map.querySelectorAll('.map-boundary, .map-link, .map-node, .map-target')].map(shape => [...shape.attributes].map(attribute => `${attribute.name}=${attribute.value}`).join(';'))));
  expect(geometry).toHaveLength(2);
  expect(geometry[0]).toEqual(geometry[1]);
  const slider = page.getByRole('slider', { name: 'Compare public and private swarms' });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveValue('0');
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('100');
  await page.locator('.compare-toolbar').getByRole('button', { name: 'SPLIT ↔', exact: true }).click();
  await expect(slider).toHaveValue('50');
  // A later generic input style must not hide the comparison artwork again.
  expect(await slider.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await expect(page.getByRole('heading', { name: 'OWASP BLACK-BOX ETHICAL HACKING ENGINE.' })).toBeVisible();
  await expect(page.getByText('NO SOLO', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'PUT THE SWARM TO WORK', exact: false }).click();
  const access = page.getByRole('dialog', { name: 'Sign in or request access' });
  await expect(access.getByLabel('Your name', { exact: true })).toBeInViewport();
  await access.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(access.getByLabel('Username', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(access).toHaveCount(0);
  const opener = page.locator('header').getByRole('button', { name: 'App' });
  await opener.click();
  await expect(access.getByLabel('Username', { exact: true })).toBeFocused();
  await access.getByRole('button', { name: 'Request access', exact: true }).click();
  await expect(access.getByLabel('Your name', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await page.locator('.tm-workspace-preview').getByRole('button', { name: 'SIGN IN', exact: false }).click();
  await expect(access.getByLabel('Username', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('header .brand-mark')).toHaveAttribute('src', '/brand/white-hat.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the same header keeps Dashboard visible on public and private pages', async ({ page }) => {
  await emptyDashboard(page);
  await page.route('**/api/session', route => route.fulfill({ json: { account: { id: 'theme-test-account', display_name: 'Review owner', role: 'admin' }, csrf_token: 'test-only' } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 2, online_operators: 2, online_compute_groups: 2 } }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  const reads: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) reads.push(new URL(request.url()).pathname + new URL(request.url()).search); });
  await page.goto('/#/docs/start');
  const nav = page.getByRole('navigation', { name: 'Website', exact: true });
  await expect(nav.getByRole('button')).toHaveCount(4);
  await expect(nav.locator('.workspace-nav-bottom')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await nav.getByRole('button', { name: 'App', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Review owner.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request an audit', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('navigation', { name: 'Workspace' }).getByText('Administration', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Access & users', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Audits', exact: true }).click();
  await expect(page).toHaveURL(/#\/audits$/);
  await expect(nav.getByRole('button')).toHaveText(['Home', 'Recent events', 'Docs', 'App ↗']);
  expect(reads.filter(path => /\/api\/(reviews|site-checks|sources)/.test(path)).every(path => path.endsWith('?scope=mine'))).toBe(true);
});

test('agents, orders and earnings keep the normal workspace menu on reload and navigation', async ({ page }) => {
  await emptyDashboard(page);
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id: 'nav-member', display_name: 'Member', role: 'member' }, csrf_token: 'test-csrf' } }));
  await page.route('**/api/agents', r => r.fulfill({ json: [] }));
  for (const [path, label] of [['agents', 'Network agents'], ['orders', 'Orders'], ['earnings', 'Earnings']]) {
    await page.goto(`/#/${path}`);
    const menu = page.getByRole('navigation', { name: 'Workspace', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
    await page.reload();
    await expect(menu.getByRole('button', { name: label, exact: true })).toBeInViewport();
    await menu.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page).toHaveURL(/#\/overview$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('Collective audit choices keep readable text when hovered or focused', async ({ page }) => {
  await emptyDashboard(page);
  await page.route('**/api/session', route => route.fulfill({ json: { account: { id: 'contrast-test', display_name: 'Reviewer', role: 'member' }, csrf_token: 'test-only' } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 0, online_operators: 0, online_compute_groups: 0 } }));
  await page.route('**/api/devices', route => route.fulfill({ json: [] }));
  await page.goto('/#/request');
  const choices = page.locator('button.request-option');
  await expect(choices).toHaveCount(4);
  await expect(page.locator('.roadmap-product[aria-disabled=true]')).toHaveCount(2);
  await expect(choices.first()).toBeVisible();
  await expect(choices.nth(1)).toBeVisible();
  await expect(choices.nth(2)).not.toBeVisible();
  await page.getByText('Existing snapshot and source tools', { exact: true }).click();
  for (const choice of await choices.all()) {
    await choice.hover();
    await choice.focus();
    const ratios = await choice.evaluate(button => {
      function light(color: string) {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
          const channel = Number(value) / 255;
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      }
      const paper = light(getComputedStyle(button).backgroundColor);
      return [...button.querySelectorAll('h2, p, strong')].map(text => {
        const ink = light(getComputedStyle(text).color);
        return (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05);
      });
    });
    for (const ratio of ratios) expect(ratio, 'Audit choice contrast').toBeGreaterThanOrEqual(4.5);
  }
});
