import type { DbProvider } from '../../../types/index.js';
import type { AIScanRepository } from '../repository.js';
import type { AIScanRun } from '../types.js';
import { browserContextKey, navigatePersistentBrowser, withPersistentDiscoveryPage } from './persistent-browser-runtime.js';
import { assertScanActive } from '../run-control.js';
import { configuredIdentityAccounts } from '../identity-material.js';
import { applyPreparedIdentityBrowserLogin } from './prepared-identity-login.js';

const excluded=/logout|signout|delete|remove|purchase|checkout|pay|transfer|withdraw|注销|删除|支付|转账|提现/i;

/** Render JavaScript and visit observed links/controls. Account cookies stay in isolated contexts. */
export async function discoverWebPages(db:DbProvider,repo:AIScanRepository,run:AIScanRun,taskId?:string):Promise<void>{
  assertScanActive();
  const accounts=run.scan_config?.account_mode==='manual'?Object.entries(configuredIdentityAccounts(run.scan_config)):[];
  const identities:Array<[string,any]>=accounts.length?accounts.slice(0,3):[['',undefined]];
  const limit=Math.max(1,Math.min(30,Number(run.scan_config?.max_browser_pages)||12));
  const origin=new URL(run.base_url).origin,gaps:string[]=[];let authenticatedCount=0;
  for(const [role,account] of identities){
    assertScanActive();
    const input={repo,scanRunId:run.id,taskId,scope_base_url:run.base_url,identity_key:role||undefined,
      // Discovery receives manual credentials only through the trusted login
      // primitive below. Install its context-lifetime boundary before the
      // first login-page navigation, never after page JavaScript has run.
      ...(account?{credential_boundary:true,authentication_origins:run.scan_config?.authentication_origins}:{}),
    };
    const queue=[run.base_url],seen=new Set<string>(),deadline=Date.now()+180000;
    let signedIn=false,loginAttempted=false;
    while(queue.length&&seen.size<limit&&Date.now()<deadline){
      assertScanActive();
      const url=queue.shift()!,key=`${signedIn}:${url}`;
      if(seen.has(key))continue;seen.add(key);
      const observation=await navigatePersistentBrowser({...input,url,timeout_ms:20000});
      if(!observation?.ok){gaps.push(observation?.error||'页面导航失败');continue;}
      await withPersistentDiscoveryPage(input,async(page,context)=>{
        const password=page.locator('input[type="password"]:visible').first();
        if(account&&!signedIn&&!loginAttempted&&await password.count()){
          loginAttempted=true;
          const login=await applyPreparedIdentityBrowserLogin({page,browser_context:context,base_url:run.base_url,
            authentication_origins:run.scan_config?.authentication_origins,
            identity:{identity_key:role,username:account.username,email:account.email,phone:account.phone,password:account.password}}).catch(()=>undefined);
          assertScanActive();
          if(login?.authenticated){
            signedIn=true;authenticatedCount++;
            // The persistent browser context owns the authenticated session.
            // Never extract browser cookies, tokens, or Web Storage into an
            // account row: that would turn ephemeral browser authentication
            // into broadly readable credential material.  Retain only the
            // operator-supplied login identity for a later fresh task context.
            const fields={...account,role};
            await db.repos.accounts.create({name:`Web ${role} ${run.id.slice(0,8)}`,username:account.username,status:'active',tags:['ai_scan',`scan:${run.id}`,`role:${role}`],fields,auth_profile:{type:'observed_browser_login'},variables:{}} as any);
            // Persist this same private browser context for lifecycle recovery.
            // This is deliberately separate from account material: the account
            // row remains a role/credential binding and never receives values
            // copied from cookies or browser storage.
            const browserContext=browserContextKey({identity_key:role});
            await repo.upsertBrowserContext({scan_run_id:run.id,task_id:taskId,context_key:browserContext.key,
              scope_type:browserContext.scope,identity_key:browserContext.identity,status:'active',
              storage_state_json:await context.storageState(),current_url:page.url(),ttl_seconds:3600,
              expires_at:new Date(Date.now()+3600000).toISOString()});
            queue.unshift(run.base_url);
          }else if(login?.status==='additional_verification_required')gaps.push(`${role} 登录需要验证码或人工验证。`);
          else gaps.push(`${role} 登录未观察到有效会话变化；保留公开页面覆盖。`);
        }
        // SSO is used for login only. Do not crawl, model, or test its application controls.
        if(new URL(page.url()).origin!==origin)return;
        // Navigation controls only. Form submissions require declared business scenarios.
        const controls=page.locator('button,[role="tab"],[role="button"]');
        let clicked=0;
        for(let index=0;index<Math.min(await controls.count(),50)&&clicked<4&&Date.now()<deadline;index++){
          assertScanActive();
          const control=controls.nth(index);
          try {
            const label=`${await control.textContent()||''} ${await control.getAttribute('aria-label')||''}`;
            if(excluded.test(label)||!await control.isVisible()||!await control.isEnabled())continue;
            if(!/view|detail|open|load more|next|menu|list|查看|详情|展开|更多|下一页|菜单|列表/i.test(label))continue;
            if(await control.evaluate((element:any)=>!!element.closest('form')))continue;
            assertScanActive();
            await control.click({timeout:3000});clicked++;
            await page.waitForLoadState('networkidle',{timeout:1500}).catch(()=>undefined);
          }catch {assertScanActive();gaps.push('部分动态控件无法自动操作，覆盖仅包括已观察页面。');}
        }
        const forms:any[]=await page.locator('form').evaluateAll((nodes:any[])=>nodes.map(form=>({
          action:form.action,method:String(form.method||'GET').toUpperCase(),enctype:form.enctype,source_url:form.ownerDocument.location.href,
          inputs:Array.from(form.elements).flatMap((element:any)=>{
            if(!element.name||element.type==='password')return [];
            if(element.tagName==='SELECT')return Array.from(element.selectedOptions).map((option:any)=>({name:element.name,type:'select',value:option.value,disabled:element.disabled}));
            return [{name:element.name,type:element.type||'text',value:element.type==='file'?'':element.value,disabled:element.disabled,checked:element.checked}];
          })
        })));
        for(const form of forms){
          const url=new URL(form.action);
          if(url.origin!==origin||!form.inputs.some((i:any)=>i.type==='file'))continue;
          const endpoint=await repo.upsertEndpoint({scan_run_id:run.id,method:form.method,url:url.href,path:url.pathname,content_type:'multipart/form-data',
            source_type:'browser_form',request_summary:`Observed upload form; fields: ${form.inputs.map((i:any)=>i.name).join(', ')}`,auth_required:signedIn});
          await repo.createArtifact({scan_run_id:run.id,task_id:taskId,artifact_type:'browser_form',source_ref:endpoint.id,title:`${form.method} ${url.pathname}`,content_json:{endpoint_id:endpoint.id,form,has_file_input:true,identity_role:role,rendered:true}});
        }
        const links:string[]=await page.locator('a[href]').evaluateAll((nodes:any[])=>nodes.map(node=>node.href));
        for(const href of links)try{
          const link=new URL(href);
          if(link.origin===origin&&!excluded.test(link.pathname+link.hash)&&!seen.has(`${signedIn}:${link.href}`)&&queue.length<100)queue.push(link.href);
        }catch{}
      });
    }
    if(account&&!signedIn)gaps.push(`${role} 未完成浏览器登录；请检查账号、登录入口、验证码或单点登录依赖。`);
    if(seen.size>=limit||Date.now()>=deadline)gaps.push('页面发现已达到本轮上限。');
  }
  assertScanActive();
  await repo.createArtifact({scan_run_id:run.id,task_id:taskId,artifact_type:'web_discovery_coverage',title:'Browser coverage and gaps',content_json:{gaps:[...new Set(gaps)],page_limit_per_identity:limit,authenticated_identities:authenticatedCount,coverage_scope:'observed_pages_and_requests'}});
}
