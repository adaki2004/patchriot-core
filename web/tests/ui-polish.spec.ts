import {expect,test} from '@playwright/test';
import {emptyDashboard} from './helpers';

test('workspace cards, contributor previews and audit action remain coherent',async({page},info)=>{
  await emptyDashboard(page);
  await page.route('**/api/session',r=>r.fulfill({json:{account:{id:'synthetic-owner',display_name:'Example owner',role:'member'},csrf_token:'test-csrf'}}));
  await page.route('**/api/fleet',r=>r.fulfill({json:{online_devices:1,online_operators:1,online_compute_groups:1}}));
  await page.route('**/api/agents',r=>r.fulfill({json:[0,1,2].map(i=>({id:`fixture-agent-${i}`,runtime:'hermes',runtime_version:'fixture-v1',declared_model:'fixture-model',reported_os:'Linux',state:i?'paused':'online',last_seen_at:1793990000,reports_received:i}))}));
  const privateReads:string[]=[];page.on('request',req=>{const path=new URL(req.url()).pathname;if(['/api/pairing-info','/api/withdrawals','/api/earnings'].includes(path))privateReads.push(path);});
  await page.goto('/#/overview');
  await expect(page.getByRole('heading',{name:'Hello, Example owner.'})).toBeVisible();
  await expect(page.locator('.workspace-welcome')).toContainText('Your proactive defense workspace');
  await expect(page.locator('footer').getByRole('link',{name:'X / Twitter',exact:true})).toHaveAttribute('href','https://x.com/patchriot_net');
  await expect(page.locator('footer').getByRole('link',{name:'GitHub',exact:true})).toHaveAttribute('href','https://github.com/adaki2004/patchriot-core');
  await expect(page.locator('.compact-agents .agent-entry')).toHaveCount(3);
  await expect(page.locator('.workspace-art')).toHaveCSS('mix-blend-mode','normal');
  const red=await page.getByRole('button',{name:'Request an audit',exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.workspace-dashboard').screenshot({path:info.outputPath('workspace.png')});
  await page.goto('/#/agents');
  await expect(page.locator('.network-agent-row')).toHaveCount(3);
  await page.locator('.network-agent-details > summary').first().click();
  await expect(page.locator('.network-agent-details[open]')).toContainText('fixture-v1');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.network-agent-panel').screenshot({path:info.outputPath('network-agents.png')});
  for(const [path,region] of [['devices','Contributor agents preview'],['earnings','Contributor earnings preview']]) {
    await page.goto(`/#/${path}`);const preview=page.getByRole('region',{name:region});
    await expect(preview).toContainText('COMING SOON');await expect(preview.getByRole('listitem')).toHaveCount(3);
    await expect(preview.getByRole('button')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await preview.screenshot({path:info.outputPath(`${path}-preview.png`)});
  }
  expect(privateReads).toEqual([]);
  await page.goto('/#/audits');
  await expect(page.getByRole('button',{name:'Request an audit',exact:true})).toHaveCSS('background-color',red);
});
