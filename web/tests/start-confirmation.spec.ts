import { test, expect } from '@playwright/test';
import { emptyDashboard } from './helpers';
const id='00000000-0000-4000-8000-000000000002';
const run='00000000-0000-4000-8000-000000000003';
for (const screening of ['accepted','unavailable','rejected'] as const) {
  test(`final confirmation keeps gate secrets separate and screening ${screening}`,async({page},info)=>{
    await emptyDashboard(page);
    await page.route('**/api/session',r=>r.fulfill({json:{account:{id,display_name:'Member',role:'member'},csrf_token:'fixture'}}));
    const target={id,scope:{origins:['https://owned.example'],methods:['GET','HEAD','OPTIONS'],profile:'web_baseline_v1',tools:['artex_engine_v1','run_context_v1']},scope_sha256:'a'.repeat(64),state:'approved',ownership_verified:true,is_requester:true,can_start:true,expires_at:9999999999};
    const team=[1,2].map(i=>({device_id:`00000000-0000-4000-8000-00000000001${i}`,operator_id:id,operator_name:'Fixture operator',device_name:`Worker ${i}`,declared_model:'deepseek-v4-1-flash-1017-uncensored',compute_group:'fixture'}));
    await page.route('**/api/pentests?*',r=>r.fulfill({json:[target]}));
    await page.route(`**/api/pentests/${id}/ownership`,r=>r.fulfill({json:{verified:true,challenges:[]}}));
    await page.route(`**/api/reviews/${run}`,r=>r.fulfill({status:404,json:{error:'not_found'}}));
    await page.route('**/api/checkout',r=>r.fulfill({json:{mode:'pilot'}}));
    await page.route(`**/api/pentests/${id}/review-plan`,r=>r.fulfill({json:{pentest_id:id,scope_sha256:target.scope_sha256,candidates:team,recommended_device_ids:team.map(t=>t.device_id),provider:'venice.ai',recommended_review_policy:'investigate_validate_v1'}}));
    let prepared:any,started:any;
    const attempts:any[]=[];
    await page.route(`**/api/pentests/${id}/prepare`,r=>{
      prepared=r.request().postDataJSON();attempts.push(prepared);
      if(screening==='accepted'||prepared.testing_context==='Inspect the public interface within the approved permissions.') return r.fulfill({json:{accepted:true}});
      return r.fulfill(screening==='rejected'?{status:400,json:{error:'testing_context_not_accepted'}}:{status:503,json:{error:'context_screening_unavailable'}});
    });
    await page.route(`**/api/pentests/${id}/review`,r=>{started=r.request().postDataJSON();return r.fulfill({json:{id:run}});});
    await page.goto(`/#/pentests/${id}`);
    await page.getByRole('checkbox',{name:/I allow these named operators/}).check();
    await page.getByRole('button',{name:'Start web app test'}).click();
    const dialog=page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button',{name:'Confirm & start test'})).toBeDisabled();
    expect(prepared).toBeUndefined();expect(started).toBeUndefined();
    await dialog.getByRole('textbox',{name:/Extra testing context/}).fill('Focus on target-exposed API keys and access controls.');
    await dialog.getByText('Optional site access',{exact:true}).click();
    await dialog.getByRole('checkbox',{name:/Site has an access gate/}).check();
    await dialog.getByLabel('Gate username',{exact:true}).fill('fixture');
    await dialog.getByLabel('Gate password',{exact:true}).fill('synthetic-gate-secret');
    await dialog.getByRole('checkbox',{name:/I own this system/}).check();
    expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('confirmation.png')});
    await dialog.getByRole('button',{name:'Confirm & start test'}).click();
    await expect.poll(()=>!!prepared).toBe(true);
    expect(prepared.testing_context).not.toContain('synthetic-gate-secret');
    expect(prepared.environment_gate.kind).toBe('basic');
    expect(prepared.terms_version).toBe('testing-risk-v1');
    if(screening==='accepted'){
      await expect.poll(()=>!!started).toBe(true);
      expect(started).toEqual(prepared.consent);
      expect(JSON.stringify(started)).not.toContain('synthetic-gate-secret');
    }else{
      const message=screening==='rejected'?'extra testing context was not accepted':'instruction check is unavailable';
      await expect(dialog.getByRole('alert')).toContainText(message);
      expect(started).toBeUndefined();
      await expect(dialog.getByRole('button',{name:'Confirm & start test'})).toBeEnabled();
      const firstId=prepared.consent.request_id;
      await dialog.getByRole('button',{name:'Confirm & start test'}).click();
      await expect.poll(()=>attempts.length).toBe(2);
      expect(prepared.consent.request_id).toBe(firstId);
      await expect(dialog.getByRole('alert')).toContainText(message);
      expect(started).toBeUndefined();
      await dialog.getByRole('textbox',{name:/Extra testing context/}).fill('Inspect the public interface within the approved permissions.');
      await dialog.getByRole('button',{name:'Confirm & start test'}).click();
      await expect.poll(()=>!!started).toBe(true);
      expect(prepared.consent.request_id).not.toBe(firstId);
      expect(started).toEqual(prepared.consent);
      expect(JSON.stringify(started)).not.toContain('synthetic-gate-secret');
    }
  });
}
