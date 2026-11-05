import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Interface, Wallet } from 'ethers';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { Deposit } from '../src/Checkout';
import { ethereumTransfer, solanaTransfer, walletAsset } from '../src/wallet-transfer';

const origin = 'http://127.0.0.1:5174';
const order = '00000000-0000-4000-8000-000000000003';
const sender = Wallet.createRandom().address;
const recipient = Wallet.createRandom().address;
const asset = {asset_id:'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',symbol:'USDC',decimals:6,blockchain:'eth'};
function deposit(): Deposit {
  return {order_id:order,request_id:order,review_id:order,invoice_id:order,input:{token:asset,amount:'10000001'},output:{token:asset,amount:'10000000'},deposit_address:recipient,deposit_memo:null,refund_address:sender,expires_at:new Date(Date.now()+300_000).toISOString()};
}

async function setup(context: BrowserContext, signedIn = true) {
  const state = { signedIn, quote:deposit(), verification:0, quotes:0, failSession:false };
  await context.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if(path==='/api/wallet/config')return route.fulfill({json:{enabled:true,project_id:'a'.repeat(32),origin}});
    if(path==='/api/auth/providers')return route.fulfill({json:{google:true,github:true,wallet:true}});
    if(path==='/api/session' && state.signedIn && state.failSession)return route.fulfill({status:503,json:{error:'session_unavailable'}});
    if(path==='/api/session')return route.fulfill({json:{account:state.signedIn?{id:order,display_name:'Wallet fixture',role:'member',auth_method:signedIn?'google':'wallet'}:null,csrf_token:state.signedIn?'test-csrf':null}});
    if(path===`/api/orders/${order}/quote`){state.quotes++;expect(route.request().method()).toBe('POST');expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');return route.fulfill({json:state.quote});}
    if(path==='/api/auth/wallet/challenge'){
      expect(route.request().postDataJSON()).toEqual({network:'ethereum',address:sender});
      return route.fulfill({json:{nonce:'b'.repeat(64),message:`127.0.0.1:5174 wants you to sign in with your Ethereum account:\n${sender}\n\nSign in to Patchriot. This does not authorize a payment.\n\nURI: ${origin}\nVersion: 1`,expires_at:new Date(Date.now()+300_000).toISOString()}});
    }
    if(path==='/api/auth/wallet/verify'){state.verification++;expect(route.request().postDataJSON()).toEqual({nonce:'b'.repeat(64),signature:'0x'+'c'.repeat(130)});state.signedIn=true;return route.fulfill({json:{ok:true}});}
    if(path==='/api/analytics')return route.fulfill({json:{enabled:false}});
    if(path==='/api/fleet')return route.fulfill({json:{online_devices:0,online_operators:0,online_compute_groups:0}});
    if(path==='/api/withdrawals')return route.fulfill({json:{enabled:false,minimum_claim:'10000000',balance:{earned:'0',available:'0',reserved:'0',paid:'0'},destinations:[],claims:[],receipts:[]}});
    if(path==='/api/earnings')return route.fulfill({json:{work:[]}});
    return route.fulfill({json:[]});
  });
  await context.addInitScript(({sender})=>{
    const w=window as unknown as {walletCalls:{method:string;params?:unknown[]}[];walletFailure:string;ethereum:{request:(args:{method:string;params?:unknown[]})=>Promise<unknown>}};
    w.walletCalls=[];w.walletFailure='';
    w.ethereum={request:async args=>{
      w.walletCalls.push(args);
      if(args.method==='wallet_switchEthereumChain')return null;
      if(args.method==='eth_requestAccounts'||args.method==='eth_accounts')return[sender];
      if(args.method==='eth_chainId')return'0x1';
      if(args.method==='personal_sign')return'0x'+'c'.repeat(130);
      if(args.method==='eth_sendTransaction'){
        if(w.walletFailure==='reject')throw Object.assign(new Error('declined'),{code:4001});
        if(w.walletFailure==='lost')throw new Error('reply lost after broadcast');
        return '0x'+'d'.repeat(64);
      }
      throw new Error('Unexpected method '+args.method);
    }};
  },{sender});
  return state;
}
async function payment(page:Page) {
  await page.evaluate(async order=>{
    const path='/src/wallet.ts'; const {openWallet}=await import(/* @vite-ignore */ path);
    void openWallet('payment',order).catch(()=>{});
  },order);
  await expect(page.getByRole('heading',{name:'Pay for your assessment',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Browser wallet',exact:true}).click();
  await expect(page.getByRole('button',{name:'Confirm payment',exact:true})).toBeEnabled();
  return page;
}
async function calls(page:Page) { return page.evaluate(()=>(window as unknown as {walletCalls:{method:string;params?:unknown[]}[]}).walletCalls); }

test('wallet sign-in signs only the server message and opens Overview',async({page,context})=>{
  const state=await setup(context,false);const external:string[]=[];page.on('request',r=>{if(new URL(r.url()).origin!==origin)external.push(r.url());});
  await page.goto('/');await page.locator('header').getByRole('button',{name:'App',exact:true}).click();
  await page.getByRole('button',{name:'Connect wallet',exact:true}).click();const popup=page;
  await popup.getByRole('button',{name:'Browser wallet',exact:true}).click();
  await expect.poll(async()=>(await calls(popup)).some(c=>c.method==='personal_sign')).toBe(false);
  await popup.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/overview$/);expect(state.verification).toBe(1);expect(external).toEqual([]);
});

test('Google account can pay the exact server quote without a new login or an approval',async({page,context})=>{
  const state=await setup(context);await page.goto('/');const popup=await payment(page);
  expect((await calls(popup)).some(c=>c.method==='eth_sendTransaction')).toBe(false);
  await popup.getByRole('button',{name:'Confirm payment'}).click();
  await expect(popup.getByRole('status')).toContainText('Transfer sent');
  const sent=(await calls(popup)).filter(c=>c.method==='eth_sendTransaction');expect(sent).toHaveLength(1);
  expect(sent[0].params).toEqual([ethereumTransfer(state.quote,sender)]);
  expect((await calls(popup)).some(c=>c.method==='personal_sign')).toBe(false);expect(state.verification).toBe(0);
  expect(state.quotes).toBe(2);
  await expect(popup.getByText('Your order updates after the server confirms it.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Back to Patchriot',exact:true}).click();await page.evaluate(async order=>{const path='/src/wallet.ts';void(await import(path)).openWallet('payment',order).catch(()=>{});},order);
  const second=page;await expect(second.getByRole('status')).toContainText('already requested');await expect(second.getByRole('button',{name:'Browser wallet'})).toHaveCount(0);
});

test('changed quotes are never sent to the wallet',async({page,context})=>{
  const state=await setup(context);await page.goto('/');const popup=await payment(page);state.quote={...state.quote,input:{...state.quote.input,amount:'20000000'}};
  await popup.getByRole('button',{name:'Confirm payment'}).click();await expect(popup.getByRole('alert')).toContainText('quote changed');
  expect((await calls(popup)).some(c=>c.method==='eth_sendTransaction')).toBe(false);
});

test('declined prompts can retry; a lost send result cannot silently send twice',async({page,context})=>{
  await setup(context);await page.goto('/');const popup=await payment(page);
  await popup.evaluate(()=>{(window as unknown as {walletFailure:string}).walletFailure='reject';});
  await popup.getByRole('button',{name:'Confirm payment'}).click();await expect(popup.getByRole('alert')).toContainText('declined');
  expect(await popup.evaluate(()=>localStorage.getItem('patchriot-payment:00000000-0000-4000-8000-000000000003'))).toBeNull();
  await popup.evaluate(()=>{(window as unknown as {walletFailure:string}).walletFailure='lost';});
  await popup.getByRole('button',{name:'Confirm payment'}).click();await expect(popup.getByRole('status')).toContainText('uncertain');
  await expect(popup.getByRole('button',{name:'Confirm payment'})).toHaveCount(0);
  expect((await calls(popup)).filter(c=>c.method==='eth_sendTransaction')).toHaveLength(2);
});

test('transfer builders reject misleading assets and encode only the quoted payment',()=>{
  const q=deposit();const tx=ethereumTransfer(q,sender);const abi=new Interface(['function transfer(address,uint256)']);
  expect(tx.value).toBe('0x0');expect(tx.chainId).toBe('0x1');expect(abi.decodeFunctionData('transfer',tx.data)).toEqual([recipient,10000001n]);
  for(const change of [{expires_at:'invalid'},{expires_at:new Date(0).toISOString()},{input:{...q.input,token:{...asset,asset_id:'fake'}}},{input:{...q.input,token:{...asset,decimals:18}}},{input:{...q.input,token:{...asset,blockchain:'base'}}}])expect(()=>walletAsset({...q,...change})).toThrow();
  expect(()=>ethereumTransfer({...q,deposit_memo:'unexpected'},sender)).toThrow();
  const from=Keypair.generate().publicKey.toBase58(),to=Keypair.generate().publicKey.toBase58();
  const sol={...q,deposit_address:to,input:{token:{...asset,blockchain:'sol',asset_id:'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near'},amount:'9007199254740993'}};
  const stx=solanaTransfer(sol,from,Keypair.generate().publicKey.toBase58());
  expect(stx.instructions).toHaveLength(2);expect(stx.feePayer?.toBase58()).toBe(from);
  const ix=stx.instructions[1];expect(ix.programId.toBase58()).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  expect(ix.data[0]).toBe(12);expect(ix.data.readBigUInt64LE(1)).toBe(9007199254740993n);expect(ix.data[9]).toBe(6);
  expect(ix.keys.filter(k=>k.isSigner).map(k=>k.pubkey.toBase58())).toEqual([from]);
  const mint=new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');expect(ix.keys[1].pubkey.equals(mint)).toBe(true);
  expect(()=>solanaTransfer({...sol,input:{...sol.input,amount:'18446744073709551616'}},from,to)).toThrow();
});


test('a verified signature retries only session loading and closes the sign-in dialog',async({page,context})=>{
  const state=await setup(context,false);
  await page.goto('/');
  await page.locator('header').getByRole('button',{name:'App',exact:true}).click();
  await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  await page.getByRole('button',{name:'Browser wallet',exact:true}).click();
  state.failSession=true;
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('button',{name:'Open my account',exact:true})).toBeEnabled();
  expect(state.verification).toBe(1);
  state.failSession=false;
  await page.getByRole('button',{name:'Open my account',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/overview$/);
  expect((await calls(page)).filter(c=>c.method==='personal_sign')).toHaveLength(1);
  expect(state.verification).toBe(1);
});

test('closing the wallet returns to sign-in without signing or opening another window',async({page,context})=>{
  await setup(context,false);
  await page.goto('/');
  await page.locator('header').getByRole('button',{name:'App',exact:true}).click();
  await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  await page.getByRole('dialog').filter({has:page.getByRole('button',{name:'Browser wallet',exact:true})}).getByRole('button',{name:'Close',exact:true}).click();
  await expect(page.getByRole('button',{name:'Connect wallet',exact:true})).toBeEnabled();
  expect(context.pages()).toHaveLength(1);
  expect((await calls(page)).some(c=>c.method==='personal_sign')).toBe(false);
});

test('changing the selected account stops signing until it is reconnected',async({page,context})=>{
  await setup(context,false);
  await page.goto('/');
  await page.locator('header').getByRole('button',{name:'App',exact:true}).click();
  await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  await page.getByRole('button',{name:'Browser wallet',exact:true}).click();
  await page.evaluate(()=>{
    const w=window as unknown as {ethereum:{request:(a:{method:string})=>Promise<unknown>}};
    const previous=w.ethereum.request;
    w.ethereum.request=async a=>a.method==='eth_accounts'?['0x'+'0'.repeat(40)]:previous(a);
  });
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('wallet changed');
  expect((await calls(page)).some(c=>c.method==='personal_sign')).toBe(false);
});
