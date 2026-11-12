import { expect, test } from '@playwright/test';

const account='00000000-0000-4000-8000-000000000003';
const topup='00000000-0000-4000-8000-000000000004';
const token={asset_id:'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',symbol:'USDC',decimals:6,blockchain:'base'};

for (const cents of [100, 250, 500]) test(`$${cents / 100} top-up waits for server credit and keeps manual payment details recoverable`,async({page},info)=>{
  let confirmed=false,created=false;
  const offer={id:'a'.repeat(64),price:{asset:token.asset_id,amount:'10000000'},destination:token,inputs:[token],payment_window_seconds:300};
  await page.route('**/api/**',async r=>{
    const path=new URL(r.request().url()).pathname;
    if(path==='/api/session')return r.fulfill({json:{account:{id:account,display_name:'Test member',role:'member',auth_method:'google'},csrf_token:'fixture-csrf'}});
    if(path==='/api/credits')return r.fulfill({json:{available_cents:confirmed?cents:0,history:confirmed?[{id:topup,kind:'topup',amount_cents:cents,created_at:new Date().toISOString(),topup_id:topup,purchase_id:null}]:[],purchases:[],topups:created?[{id:topup,amount_cents:cents,state:confirmed?'settled':'pending',expires_at:new Date(Date.now()+300000).toISOString(),created_at:new Date().toISOString()}]:[],topup_offer:offer,minimum_topup_cents:100,maximum_topup_cents:500,prices:{black:100,grey:250,white:999},white_available:false}});
    if(path==='/api/credits/topups'){
      const body=r.request().postDataJSON();expect(body.amount_cents).toBe(cents);expect(body.refund_address).toBe('0x'+'1'.repeat(40));expect(r.request().headers()['x-csrf-token']).toBe('fixture-csrf');created=true;
      return r.fulfill({json:{payment_kind:'topup',order_id:topup,request_id:body.request_id,invoice_id:topup,amount_cents:cents,input:{token,amount:String(cents * 10000 + 20000)},output:{token,amount:String(cents * 10000)},deposit_address:'0x'+'2'.repeat(40),deposit_memo:null,refund_address:body.refund_address,expires_at:new Date(Date.now()+300000).toISOString()}});
    }
    if(path==='/api/wallet/config')return r.fulfill({json:{enabled:false}});
    if(path==='/api/analytics')return r.fulfill({json:{enabled:false}});
    if(path==='/api/fleet')return r.fulfill({json:{online_devices:3,online_operators:1,online_compute_groups:1}});
    return r.fulfill({json:[]});
  });
  await page.goto('/#/account');
  await expect(page.getByRole('heading',{name:'Your account.'})).toBeVisible();
  await expect(page.locator('.balance-amount')).toHaveText('$0.00');
  await expect(page.getByText('$1.00',{exact:true})).toBeVisible();await expect(page.getByText('Roadmap',{exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('account.png'),fullPage:true});
  await page.getByRole('button',{name:'Add credit',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('button',{name:'$100',exact:true})).toHaveCount(0);
  await expect(dialog.getByText('per top-up during the pilot.',{exact:false})).toBeVisible();
  await dialog.getByRole('button',{name:`$${cents / 100}`,exact:true}).click();
  await dialog.getByRole('radio',{name:'USDC · Base',exact:true}).check();
  await dialog.getByLabel('Refund address on Base').fill('0x'+'1'.repeat(40));
  const amount = dialog.getByLabel('Or choose a credit amount in USD');
  for (const invalid of ['5.01', '1000', '0.99', '2.001']) {
    await amount.fill(invalid);
    await expect(dialog.getByRole('button', {name: /^Continue/})).toBeDisabled();
    expect(created).toBe(false);
  }
  await amount.fill('2.01');
  await expect(dialog.getByRole('button', {name: 'Continue · $2.01', exact: true})).toBeEnabled();
  await amount.fill(String(cents / 100));
  await page.screenshot({path:info.outputPath('topup.png'),fullPage:false});
  await dialog.getByRole('button',{name:`Continue · $${(cents / 100).toFixed(2)}`,exact:true}).click();
  await expect(dialog.getByRole('heading',{name:'How would you like to pay?'})).toBeVisible();
  await expect(dialog.getByLabel('Exact top-up amount')).toContainText(`Send exactly ${(cents / 100 + 0.02).toFixed(2)} USDC on Base. Do not round it to the dollar credit amount.`);
  await expect(dialog.getByText('0x'+'2'.repeat(40),{exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Send to an address',exact:false}).click();
  await expect(dialog.getByRole('heading',{name:`Send exactly ${(cents / 100 + 0.02).toFixed(2)} USDC`})).toBeVisible();
  await dialog.getByRole('button',{name:'Exact transfer amount warning'}).focus();
  await expect(dialog.getByRole('tooltip')).toBeVisible();
  const tooltipBox=await dialog.getByRole('tooltip').boundingBox();
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);expect(tooltipBox!.x+tooltipBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(dialog.getByRole('tooltip')).toHaveText('Send this exact amount to the address below. A different token or network may not be recoverable.');
  await expect(dialog.getByText('NEAR Intents 1Click',{exact:false})).toBeVisible();
  await dialog.screenshot({path:info.outputPath('topup-direct.png')});
  await dialog.getByRole('button',{name:'I’ve sent it',exact:true}).click();
  await expect(dialog.getByText('Waiting for transfer',{exact:true})).toBeVisible();
  await expect(page.locator('.balance-amount')).toHaveText('$0.00');
  await dialog.getByRole('button',{name:'Show payment details',exact:true}).click();
  await dialog.getByRole('button',{name:'Send to an address',exact:false}).click();
  await expect(dialog.getByText('0x'+'2'.repeat(40),{exact:true})).toBeVisible();
  confirmed=true;
  await dialog.getByRole('button',{name:'I’ve sent it',exact:true}).click();
  await expect(dialog.getByRole('heading',{name:'Credit added',exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
  await expect(page.locator('.balance-amount')).toHaveText(`$${(cents / 100).toFixed(2)}`);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});


test('credit-paid cancellation is requested explicitly without claiming a refund',async({page})=>{
  let cancelRequested=false;
  await page.route('**/api/**',async r=>{
    const path=new URL(r.request().url()).pathname;
    if(path==='/api/session')return r.fulfill({json:{account:{id:account,display_name:'Test member',role:'member'},csrf_token:'fixture-csrf'}});
    if(path==='/api/credits')return r.fulfill({json:{available_cents:301,topups:[],history:[],purchases:[{id:topup,pentest_id:account,product:'black',amount_cents:199,state:'activated',review_id:account,created_at:new Date().toISOString(),cancel_requested_at:cancelRequested?new Date().toISOString():null}],topup_offer:null,prices:{black:100,grey:250,white:999},white_available:false}});
    if(path===`/api/credits/purchases/${topup}/cancel`){expect(r.request().method()).toBe('POST');expect(r.request().headers()['x-csrf-token']).toBe('fixture-csrf');cancelRequested=true;return r.fulfill({json:{}});}
    if(path==='/api/analytics')return r.fulfill({json:{enabled:false}});
    return r.fulfill({json:[]});
  });
  await page.goto('/#/account');
  await page.getByRole('tab',{name:'Paid tests'}).click();
  page.once('dialog',dialog=>void dialog.accept());
  await page.getByRole('button',{name:'Cancel test',exact:true}).click();
  await expect(page.getByText('Cancellation requested',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Cancel test',exact:true})).toBeDisabled();
  await expect(page.locator('.balance-amount')).toHaveText('$3.01');
});
