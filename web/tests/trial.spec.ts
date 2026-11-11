import { expect, test, type Page } from '@playwright/test';
import { emptyDashboard, completeStartConfirmation } from './helpers';

const id = '00000000-0000-4000-8000-000000000002';
const coupon = { id, label:'Welcome · one website assessment', code: `pr-${'a'.repeat(64)}`, expires_at: '2099-01-08T00:00:00Z', reserved_at: null, review_id: null, revoked_at: null };
async function session(page: Page, role = 'member') {
  await emptyDashboard(page);
  await page.route('**/api/session', r => r.fulfill({ json: { account: { id, display_name: 'Example owner', role }, csrf_token: 'test-csrf' } }));
}

test('granted coupon comes from the server beside credit without automatic grants',async({page},info)=>{
  await session(page);let grants=0;
  await page.route('**/api/credits',r=>r.fulfill({json:{available_cents:200}}));
  await page.route('**/api/coupons',r=>r.fulfill({json:[coupon]}));
  await page.route('**/api/coupons/welcome',r=>{expect(r.request().headers()['x-csrf-token']).toBe('test-csrf');grants++;return r.fulfill({json:{ok:true}});});
  await page.goto('/#/overview');
  await expect(page.locator('.coupon-balance')).toContainText('1 free audit');
  await expect(page.locator('.workspace-credit-summary')).toContainText('$2.00');
  await page.reload();await expect(page.locator('.coupon-balance')).toContainText('1 free audit');
  expect(await page.evaluate(()=>JSON.stringify({...localStorage}))).not.toContain(coupon.id); expect(grants).toBe(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('welcome-coupon.png'),fullPage:true});
  await page.getByRole('button',{name:'Use coupon',exact:true}).click();await expect(page).toHaveURL(/#\/request$/);
});

test('a requested coupon fills checkout but does not submit work or replace consent', async ({ page }) => {
  await session(page);
  await page.route('**/api/coupons',r=>r.fulfill({json:[coupon]}));
  const target = { id, scope: { origins: ['https://owned.example'], methods: ['GET', 'HEAD', 'OPTIONS'] }, scope_sha256: 'a'.repeat(64), state: 'approved', ownership_verified: true, is_requester: true, can_start: true, expires_at: 9999999999 };
  const team = [1, 2, 3].map(i => ({ device_id: `00000000-0000-4000-8000-00000000001${i}`, operator_id: id, operator_name: 'Example operator', device_name: `Kali ${i}`, declared_model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated', compute_group: 'one-host' }));
  await page.route('**/api/pentests?*', r => r.fulfill({ json: [target] }));
  await page.route('**/api/checkout', r => r.fulfill({ json: { mode: 'coupons' } }));
  await page.route(`**/api/pentests/${id}/review-plan`, r => r.fulfill({ json: { pentest_id: id, scope_sha256: target.scope_sha256, candidates: team, recommended_device_ids: team.map(t => t.device_id), provider: 'near.ai' } }));
  let starts = 0; let received:Record<string,unknown>|undefined;
  await page.route(`**/api/pentests/${id}/review-code`, r => { starts++; received=r.request().postDataJSON(); return r.fulfill({ status: 409, json: { error: 'request_conflict' } }); });
  await page.goto(`/#/pentests/${id}`);
  await page.getByLabel('Choose a coupon').selectOption(coupon.id);
  await expect(page.getByLabel('Choose a coupon')).toHaveValue(coupon.id);
  await expect(page.getByRole('button',{name:'New website test +'})).toHaveCount(0);
  const start = page.getByRole('button', { name: 'Use coupon & start test' });
  await expect(start).toBeDisabled();
  expect(starts).toBe(0);
  await page.getByRole('checkbox', { name: /I allow these named operators/ }).check();
  await expect(start).toBeEnabled();
  await start.click();await completeStartConfirmation(page);
  await expect.poll(()=>starts).toBe(1);expect(received?.coupon_id).toBe(coupon.id);expect(received).not.toHaveProperty('code');
});

test('admin reserves exactly eight judge codes separately and can recover them',async({page},info)=>{
  await session(page,'admin');let rows:unknown[]=[];let posts=0;
  await page.route('**/api/admin/coupons/judges',r=>{
    if(r.request().method()==='POST'){posts++;expect(r.request().headers()['x-csrf-token']).toBe('test-csrf');rows=Array.from({length:8},(_,i)=>({slot:i+1,code:'pr-'+String(i).repeat(64),expires_at:'2099-01-01T00:00:00Z',used:false}));}
    return r.fulfill({json:rows});
  });
  await page.goto('/#/audit-desk');
  await page.getByRole('button',{name:'Reserve eight judge coupons'}).click();
  await expect(page.getByRole('button',{name:'Copy DM text'})).toHaveCount(8);
  await page.reload();await expect(page.getByRole('button',{name:'Copy DM text'})).toHaveCount(8);expect(posts).toBe(1);
  await page.screenshot({path:info.outputPath('judge-coupons.png'),fullPage:true});
});

test('closed or exhausted trials do not advertise free work; members do not read admin stats', async ({ page }) => {
  await session(page);
  const reads: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/admin/')) reads.push(r.url()); });
  await page.goto('/#/overview');
  await expect(page.getByRole('heading', { name: 'Hello, Example owner.' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Free trial' })).toHaveCount(0);
  await page.goto('/#/audits');
  await expect(page.getByRole('region', { name: 'Network usage' })).toHaveCount(0);
  expect(reads).toHaveLength(0);
});

test('stage one navigation uses filled controls and saved requests remain reachable',async({page},info)=>{
  await session(page);
  await page.route('**/api/pentests?*',r=>r.fulfill({json:[{id,scope:{origins:['https://owned.example'],methods:['GET']},scope_sha256:'a'.repeat(64),state:'pending_approval',expires_at:9999999999}]}));
  await page.goto('/#/pentests');
  const back=page.getByRole('button',{name:'Back to audits',exact:false});
  const saved=page.getByRole('button',{name:'Saved requests (1)',exact:true});
  await expect(back).toHaveCSS('background-color','rgb(40, 54, 75)');
  await expect(saved).toHaveCSS('background-color','rgb(40, 54, 75)');
  await page.screenshot({path:info.outputPath('stage-one-controls.png'),fullPage:true});
  await saved.click();await expect(page.getByRole('heading',{name:'Saved website requests.'})).toBeVisible();
});

test('free audit request is explicit and stays pending without blocking paid tests',async({page},info)=>{
  await session(page);let posts=0;let request:unknown=null;
  await page.route('**/api/coupons/request',route=>{
    if(route.request().method()==='POST') {posts++;expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');request={id,status:'pending',note:'',created_at:'2026-11-11T00:00:00Z'};}
    return route.fulfill({json:route.request().method()==='POST'?request:{request}});
  });
  await page.goto('/#/overview');
  await expect(page.getByRole('button',{name:'Request free coupon',exact:true})).toBeEnabled();
  expect(posts).toBe(0);
  await page.getByRole('button',{name:'Request free coupon',exact:true}).click();
  await expect(page.locator('.coupon-balance')).toContainText('Coupon requested');expect(posts).toBe(1);
  await expect(page.locator('.coupon-balance')).not.toContainText('1 free audit');
  await page.reload();await expect(page.locator('.coupon-balance')).toContainText('Awaiting approval');expect(posts).toBe(1);
  await expect(page.getByRole('button',{name:'Request an audit',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('coupon-pending.png'),fullPage:true});
});
