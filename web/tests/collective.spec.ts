import { expect, test } from '@playwright/test';
import { emptyDashboard } from './helpers';

test.beforeEach(async ({ page }) => {
  await emptyDashboard(page);
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
});

test('Exposure shows the selected hero, logo and consistent navigation', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { account: null, csrf_token: null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: {} }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
  await page.goto('/#/home');
  await expect(page.locator('html')).toHaveAttribute('data-design', 'collective');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Security testing.Just your URL.');
  await expect(page.locator('.exposure-copy h1 em')).toHaveCSS('color', 'rgb(243, 140, 126)');
  await expect(page.locator('.exposure-eyebrow')).toHaveText('WEB APPLICATION SECURITY TESTING');
  await expect(page.locator('.exposure-art img')).toHaveAttribute('src', '/brand/exposure-hero.png');
  await expect(page.locator('.exposure-hero input[type=checkbox]')).toHaveCount(0);
  const input = page.locator('.exposure-input input');
  await expect(input).toHaveAttribute('placeholder', 'https://your-site.com');
  await input.focus();
  await expect(page.locator('.exposure-input')).toHaveCSS('outline-style', 'solid');
  const alignment = await input.evaluate(element => {
    const input = element.getBoundingClientRect(), box = element.parentElement!.getBoundingClientRect();
    return Math.abs((input.top + input.bottom) / 2 - (box.top + box.bottom) / 2);
  });
  expect(alignment).toBeLessThanOrEqual(1);
  await page.locator('.exposure-hero').screenshot({path:test.info().outputPath('hero-focus.png')});
  await expect(page.locator('header .brand-mark')).toHaveAttribute('src', '/brand/white-hat.png');
  expect((await page.locator('header .brand-mark').boundingBox())!.width).toBeGreaterThanOrEqual(64);
  const navigation = page.getByRole('navigation', { name: 'Website' });
  await expect(navigation.getByRole('button')).toHaveText(['Home', 'Recent events', 'Docs', 'App ↗']);
  await navigation.getByRole('button', { name: 'App', exact: false }).click();
  await expect(page.getByRole('dialog', { name: 'Sign in' }).getByLabel('Username', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('the hero prefills the owned-site form without creating or authorizing work', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { account: { id: 'hero-member', display_name: 'Member', role: 'member' }, csrf_token: 'test-only' } }));
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
  await page.goto('/#/home');
  await page.getByLabel('A domain you own').fill('https://EXAMPLE.com/path?draft=example');
  await page.getByRole('button', { name: 'Start a test', exact: false }).click();
  await expect(page).toHaveURL(/#\/request$/);
  await expect(page.locator('.request-website')).toContainText('https://example.com');
  await page.getByRole('button', { name: 'Choose black-box', exact: true }).click();
  await expect(page).toHaveURL(/#\/pentests$/);
  await expect(page.getByLabel('Website URL')).toHaveValue('https://example.com');
  await expect(page.locator('input[name=permissionConfirmed]')).not.toBeChecked();
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Patchriot home' }).click();
  await page.getByLabel('A domain you own').fill('https://user:password@example.com');
  await page.getByRole('button', { name: 'Start a test', exact: false }).click();
  await expect(page.locator('.exposure-form').getByRole('alert')).toContainText('without credentials');
  await expect(page).toHaveURL(/#\/home$/);
  expect(writes).toEqual([]);
});

for (const signIn of ['password', 'redirect']) test('the hero retains only the origin through ' + signIn + ' sign-in', async ({ page }) => {
  let authenticated = false;
  await page.route('**/api/session', route => route.fulfill({ json: { account: authenticated ? { id: 'hero-signin', display_name: 'Member', role: 'member' } : null, csrf_token: authenticated ? 'test-only' : null } }));
  await page.route('**/api/auth/login', route => { authenticated = true; return route.fulfill({ json: {} }); });
  const workWrites: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && !new URL(request.url()).pathname.startsWith('/api/auth/')) workWrites.push(new URL(request.url()).pathname); });
  await page.goto('/#/home');
  await page.getByLabel('A domain you own').fill('https://example.com/private?token=example');
  await page.getByRole('button', { name: 'Start a test', exact: false }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await expect(dialog).toBeVisible();
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('patchriot.website-draft')!));
  expect(draft.origin).toBe('https://example.com');
  expect(JSON.stringify(draft)).not.toContain('token');
  if (signIn === 'password') {
    await dialog.getByLabel('Username', { exact: true }).fill('local-reviewer');
    await dialog.getByLabel('Password', { exact: true }).fill('local-test-password');
    await dialog.getByRole('button', { name: 'Open workspace', exact: false }).click();
  } else {
    authenticated = true;
    // Simulate returning to the app after the provider callback has set the session.
    await page.goto('/');
  }
  await expect(page).toHaveURL(/#\/request$/);
  await expect(page.locator('.request-website')).toContainText('https://example.com');
  await page.getByRole('button', { name: 'Choose black-box', exact: true }).click();
  await expect(page).toHaveURL(/#\/pentests$/);
  await expect(page.getByLabel('Website URL')).toHaveValue('https://example.com');
  await expect(page.locator('input[name=permissionConfirmed]')).not.toBeChecked();
  expect(await page.evaluate(() => sessionStorage.getItem('patchriot.website-draft'))).toBeNull();
  expect(workWrites).toEqual([]);
});

test('cancelling sign-in clears a draft and expired drafts do not redirect an account', async ({ page }) => {
  let authenticated = false;
  await page.route('**/api/session', route => route.fulfill({ json: { account: authenticated ? { id: 'hero-expiry', display_name: 'Member', role: 'member' } : null, csrf_token: authenticated ? 'test-only' : null } }));
  await page.goto('/#/home');
  await page.getByLabel('A domain you own').fill('example.com');
  await page.getByRole('button', { name: 'Start a test', exact: false }).click();
  await expect(page.getByRole('dialog', { name: 'Sign in' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Sign in' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('patchriot.website-draft'))).toBeNull();
  await page.evaluate(() => sessionStorage.setItem('patchriot.website-draft', JSON.stringify({ origin: 'https://example.com', expires: Date.now() - 1 })));
  authenticated = true;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hello, Member.' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('patchriot.website-draft'))).toBeNull();
});

test('one service diagram explains scope, agents and inference and respects reduced motion', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { account: null, csrf_token: null } }));
  await page.route('**/api/fleet', route => route.fulfill({ json: { online_devices: 3, online_operators: 2, online_compute_groups: 2 } }));
  await page.route('**/api/incidents', route => route.fulfill({ json: [] }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/home');
  await expect(page.locator('animateMotion')).toHaveCount(0);
  await expect(page.getByLabel('Live fleet counts')).toContainText('3 AGENTS ONLINE');
  await expect(page.locator('.service-map')).toHaveCount(1);
  await expect(page.getByRole('slider')).toHaveCount(0);
  await expect(page.locator('.service-map')).toContainText('Verify your domain');
  await expect(page.locator('.service-map')).toContainText('Confirm access');
  await expect(page.locator('.service-map .map-key strong')).toHaveText(['1. Your web app', '2. Dispatcher', '3. Isolated Hermes agents', '4. NEAR AI']);
  await expect(page.locator('.service-map')).toContainText('PRIVATE TEE');
  await expect(page.locator('.service-map')).toHaveAttribute('data-paused', 'true');
  await expect(page.locator('link[rel=icon]')).toHaveAttribute('href', '/brand/white-hat.png');
  await expect(page.getByRole('heading', { name: 'YOUR WEB APP. UNDER REVIEW.' })).toBeVisible();
  await expect(page.getByText('NO SOLO', { exact: false })).toHaveCount(0);
  await page.getByLabel('A domain you own').fill('example.com');
  await page.locator('.exposure-hero').getByRole('button', { name: 'Start a test', exact: false }).click();
  const access = page.getByRole('dialog', { name: 'Sign in' });
  await expect(access.getByRole('heading', { name: 'Sign in to Patchriot.' })).toBeInViewport();
  await expect(access.getByLabel('Username', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(access).toHaveCount(0);
  const opener = page.locator('header').getByRole('button', { name: 'App' });
  await opener.click();
  await expect(access.getByLabel('Username', { exact: true })).toBeFocused();
  await expect(access.getByLabel('Your name', { exact: true })).toHaveCount(0);
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
  const choices = page.locator('button.assessment-mode');
  await expect(choices).toHaveCount(2);
  await expect(page.locator('.assessment-mode.roadmap-product')).toHaveCount(1);
  await expect(choices.first()).toBeVisible();
  await expect(choices.nth(1)).toBeVisible();
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
      return [...button.querySelectorAll('h3, p, strong')].map(text => {
        const ink = light(getComputedStyle(text).color);
        return (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05);
      });
    });
    for (const ratio of ratios) expect(ratio, 'Audit choice contrast').toBeGreaterThanOrEqual(4.5);
  }
});


test('the architecture animation continues while visible without a pause control', async ({ page }) => {
  await page.route('**/api/session', r => r.fulfill({ json: { account: null, csrf_token: null } }));
  await page.route('**/api/incidents', r => r.fulfill({ json: [] }));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const path of ['/#/home', '/#/docs/workflow']) {
    await page.goto(path);
    const map = page.locator('.service-map');
    await map.scrollIntoViewIfNeeded();
    await expect(map.locator('animateMotion')).toHaveCount(5);
    await expect(map.getByRole('button')).toHaveCount(0);
    // It previously stopped at four seconds. Confirm both continued activity
    // and actual movement, not just an animation element in the DOM.
    await page.waitForTimeout(4500);
    await expect(map).toHaveAttribute('data-paused', 'false');
    const position = () => map.locator('animateMotion').first().evaluate(animation => {
      const matrix = (animation.parentElement as unknown as SVGGraphicsElement).getCTM();
      return [matrix?.e, matrix?.f];
    });
    const before = await position();
    await expect.poll(position).not.toEqual(before);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(map).toHaveAttribute('data-paused', 'true');
    await expect(map.locator('animateMotion')).toHaveCount(0);

  }
});

test('mode selection preserves an edited domain and keeps white-box unavailable', async ({ page }, info) => {
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id: 'mode-member', display_name: 'Member', role: 'member' }, csrf_token: 'test-only' } }));
  await page.goto('/#/request');
  await expect(page.getByRole('button', { name: 'Choose black-box' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose grey-box' })).toBeVisible();
  await expect(page.locator('.assessment-mode.roadmap-product')).toContainText('Coming later');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: `test-results/v009-mode-picker-${info.project.name}.png`, fullPage: true});
  await page.getByRole('button', { name: 'Choose black-box' }).click();
  await expect(page.getByLabel('Access method')).toHaveCount(0);
  await page.getByLabel('Website URL').fill('https://example.com/secret?token=not-kept');
  await page.getByRole('button', { name: 'Change test type' }).click();
  await expect(page.locator('.request-website')).toContainText('https://example.com');
  await page.getByRole('button', { name: 'Choose grey-box' }).click();
  await expect(page.getByLabel('Website URL')).toHaveValue('https://example.com');
  await expect(page.getByLabel('Access method')).toHaveValue('session');
  await page.getByText('Optional sign-in hints', { exact: true }).click();
  await expect(page.getByLabel('Login page', {exact: false})).toBeVisible();
  await expect(page.getByLabel('Username field name')).toHaveCount(0);
  await expect(page.getByLabel('Test password', {exact: true})).toHaveCount(0);
});
