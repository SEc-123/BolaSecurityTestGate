import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {closePersistentBrowserContextsForScan,interactPersistentBrowser,navigatePersistentBrowser} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';

async function runtimeFixture(t,html) {
 const priorMode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';
 t.after(()=>{if(priorMode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=priorMode;});
 let mutations=0;
 const target=http.createServer((req,res)=>{
  if(req.url==='/mutation'){mutations++;res.end('ok');return;}
  res.setHeader('content-type','text/html');res.end(html);
 });
 target.listen(0,'127.0.0.1');await once(target,'listening');
 t.after(()=>new Promise(resolve=>{target.closeAllConnections();target.close(resolve);}));
 const url=`http://127.0.0.1:${target.address().port}/`,db=await database(),repo=new AIScanRepository(db);
 const run=await repo.createRun({base_url:url,scan_config:{surface:'web',driving_mode:'autopilot'}});
 const task=await repo.createTask({scan_run_id:run.id,title:'Local selector regression',task_type:'autonomous_agent_task',execution_plan:{intent:'discover_target'}});
 t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
 const input={repo,scanRunId:run.id,taskId:task.id,scope_base_url:url,timeout_ms:500};
 const navigation=await navigatePersistentBrowser({...input,url});assert.equal(navigation.ok,true);
 return {input,navigation,get mutations(){return mutations;}};
}

// Raw selectors remain a trusted runtime contract. They are deliberately kept
// out of every model reply below: the model-facing browser boundary accepts
// only opaque references projected from the current observation.
for(const [scenario,operation,code] of [
 ['ambiguous assertion',{action:'assert',selector:'text=Fixture total',text:'Fixture total'},'selector_ambiguous'],
 ['missing assertion',{action:'assert',selector:'#absent',text:'Fixture total'},'selector_no_match'],
 ['invalid assertion selector',{action:'assert',selector:'[',text:'Fixture total'},'selector_invalid'],
 ['disabled click',{action:'click',selector:'#disabled'},'selector_not_enabled'],
])test(`trusted runtime preserves ${scenario} pre-action feedback`,{timeout:30000},async t=>{
 const f=await runtimeFixture(t,'<html><body><span id="total">Fixture total</span><span>Fixture total</span><button id="disabled" disabled>Disabled</button></body></html>');
 const result=await interactPersistentBrowser({...f.input,operation});
 assert.equal(result.ok,false);assert.equal(result.error_code,code);
 assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);assert.equal(f.mutations,0);
});

test('trusted runtime accepts a unique selector assertion', {timeout:30000}, async t=>{
 const f=await runtimeFixture(t,'<html><body><span id="total">Fixture total</span></body></html>');
 const result=await interactPersistentBrowser({...f.input,operation:{action:'assert',selector:'#total',text:'Fixture total'}});
 assert.equal(result.ok,true);
});

test('id-less opaque-route navigation controls receive finite targets without DOM disclosure', {timeout:30000}, async t=>{
 const f=await runtimeFixture(t,'<html><body><nav><a href="/opaque/alpha">Personal details</a><a href="/opaque/bravo" title="Desk supplies">Catalog</a><a href="/opaque/charlie" aria-label="Notebook">Library</a></nav><button onclick="fetch(\'/mutation\',{method:\'POST\'})">Create note</button><input value="PRIVATE_INPUT"><div data-sensitive>PRIVATE_SENSITIVE</div></body></html>');
 const controls=f.navigation.observation?.controls||[];
 const profile=controls.find(control=>control.navigation_target==='profile');
 const cart=controls.find(control=>control.navigation_target==='cart');
 const notes=controls.find(control=>control.navigation_target==='notes');
 const button=controls.find(control=>control.tag==='button');
 for(const control of [profile,cart,notes,button])assert.equal(typeof control?.control_ref,'string');
 assert.equal(profile.intent,'navigation');assert.equal(cart.intent,'navigation');
 assert.equal(notes.intent,'navigation');
 assert.deepEqual(controls.filter(control=>control.tag==='a').map(control=>control.navigation_target).sort(),['cart','notes','profile']);
 const wire=JSON.stringify(f.navigation);
 for(const privateValue of ['/opaque/','alpha','bravo','charlie','Personal details','Desk supplies','Notebook','Catalog','Library','Create note','PRIVATE_'])assert.equal(wire.includes(privateValue),false);
 const followed=await interactPersistentBrowser({...f.input,operation:{action:'click',control_ref:profile.control_ref}});
 assert.equal(followed.ok,true);
 const refreshedButton=followed.observation?.controls?.find(control=>control.tag==='button');
 assert.equal(typeof refreshedButton?.control_ref,'string');
 const clicked=await interactPersistentBrowser({...f.input,operation:{action:'click',control_ref:refreshedButton.control_ref}});
 assert.equal(clicked.ok,true);assert.equal(f.mutations,1);
});

test('private transaction wording becomes ordered finite intents without entering the observation', {timeout:30000}, async t=>{
 const f=await runtimeFixture(t,'<html><body><form><button type="submit">Add desk supply</button></form><form><button type="submit">Review purchase</button></form><form><button type="submit">Place purchase</button></form></body></html>');
 const controls=f.navigation.observation?.controls||[];
 assert.equal(controls.filter(control=>control.intent==='add').length,1);
 assert.equal(controls.filter(control=>control.intent==='review').length,1);
 assert.equal(controls.filter(control=>control.intent==='confirm').length,1);
 const wire=JSON.stringify(f.navigation);
 for(const privateValue of ['Add desk supply','Review purchase','Place purchase'])assert.equal(wire.includes(privateValue),false);
});

test('anchor eligibility excludes external, download, target, script, and destructive routes even with ids', {timeout:30000}, async t=>{
 const f=await runtimeFixture(t,'<html><body><a href="/profile/private-member">Profile</a><a id="external-link" name="external-link" href="https://external.invalid/profile">External</a><a id="download-link" href="/cart" download>Download</a><a id="target-link" href="/notes" target="_blank">New tab</a><a id="script-link" href="javascript:alert(1)">Script</a><a id="logout-link" href="/logout">Logout</a></body></html>');
 const controls=f.navigation.observation?.controls||[];
 assert.equal(controls.length,1);assert.equal(controls[0].navigation_target,'profile');
 const wire=JSON.stringify(f.navigation);
 for(const privateValue of ['private-member','external.invalid','Download','New tab','javascript:','Logout','/logout'])assert.equal(wire.includes(privateValue),false);
});

test('a structural opaque ref expires when DOM reordering would retarget it', {timeout:30000}, async t=>{
 const f=await runtimeFixture(t,'<html><body><button onclick="fetch(\'/mutation\',{method:\'POST\'})">First</button><button onclick="fetch(\'/mutation\',{method:\'POST\'})">Second</button><script>setTimeout(()=>document.body.insertBefore(document.body.lastElementChild.previousElementSibling,document.body.firstElementChild),2000)</script></body></html>');
 const ref=f.navigation.observation?.controls?.find(control=>control.tag==='button')?.control_ref;
 assert.equal(typeof ref,'string');
 await new Promise(resolve=>setTimeout(resolve,2300));
 const result=await interactPersistentBrowser({...f.input,operation:{action:'click',control_ref:ref}});
 assert.equal(result.ok,false);assert.equal(result.error_code,'observation_reference_expired');
 assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);assert.equal(f.mutations,0);
 assert.ok(result.observation?.controls?.some(control=>typeof control.control_ref==='string'));
});

test('an anchor opaque ref expires when its safe navigation semantics mutate in place', {timeout:30000}, async t=>{
 const f=await runtimeFixture(t,'<html><body><a id="profile" href="/profile/private-member">Profile</a><script>setTimeout(()=>document.querySelector("a").setAttribute("href","/logout"),1800)</script></body></html>');
 const ref=f.navigation.observation?.controls?.find(control=>control.navigation_target==='profile')?.control_ref;
 assert.equal(typeof ref,'string');
 await new Promise(resolve=>setTimeout(resolve,2300));
 const result=await interactPersistentBrowser({...f.input,operation:{action:'click',control_ref:ref}});
 assert.equal(result.ok,false);assert.equal(result.error_code,'observation_reference_expired');
 assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);
});

test('opaque refs reject incompatible actions before a browser dispatch', {timeout:30000}, async t=>{
 const f=await runtimeFixture(t,'<html><body><button id="action" onclick="fetch(\'/mutation\',{method:\'POST\'})">Action</button><input id="field"><select id="choice"><option value="one">One</option></select><div id="state">Ready</div></body></html>');
 const expectMismatch=result=>{assert.equal(result.ok,false);assert.equal(result.error_code,'observation_reference_action_mismatch');assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);};
 let observation=f.navigation.observation;
 let result=await interactPersistentBrowser({...f.input,operation:{action:'fill',control_ref:observation.controls.find(control=>control.tag==='button').control_ref,value:'x'}});
 expectMismatch(result);observation=result.observation;
 result=await interactPersistentBrowser({...f.input,operation:{action:'fill',control_ref:observation.controls.find(control=>control.tag==='select').control_ref,value:'one'}});
 expectMismatch(result);observation=result.observation;
 result=await interactPersistentBrowser({...f.input,operation:{action:'select',control_ref:observation.controls.find(control=>control.tag==='input').control_ref,value:'one'}});
 expectMismatch(result);observation=result.observation;
 result=await interactPersistentBrowser({...f.input,operation:{action:'click',assertion_ref:observation.assertion_targets[0].assertion_ref}});
 expectMismatch(result);assert.equal(f.mutations,0);
});

for (const action of ['click', 'fill']) for (const [kind,selector,code] of [
 ['missing','#absent','selector_no_match'],['hidden','#hidden','selector_not_visible'],['ambiguous','.duplicate','selector_ambiguous'],
]) test(`trusted runtime ${action} ${kind} selector is rejected before mutation`, {timeout:30000}, async t => {
 const controls=action==='fill'
  ? '<input id="visible" class="duplicate" oninput="fetch(\'/mutation\',{method:\'POST\'})"><input class="duplicate"><input id="hidden" style="display:none">'
  : '<button id="visible" class="duplicate" onclick="fetch(\'/mutation\',{method:\'POST\'})">Visible</button><button class="duplicate">Other</button><button id="hidden" style="display:none">Hidden</button>';
 const f=await runtimeFixture(t,`<html><body>${controls}<input value="PRIVATE_INPUT"><input type="password" value="PRIVATE_PASSWORD"><div data-sensitive>PRIVATE_SENSITIVE</div></body></html>`);
 const result=await interactPersistentBrowser({...f.input,operation:{action,selector,value:'fixture-value'}});
 assert.equal(result.ok,false);assert.equal(result.error_code,code);
 assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);assert.equal(result.retryable,true);
 assert.equal(f.mutations,0);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('model correction protocol selects only exact current opaque references', {timeout:30000}, async t => {
 const priorMode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';
 t.after(()=>{if(priorMode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=priorMode;});
 let mutations=0,dismissals=0,requests=0;const contexts=[];
 const target=http.createServer((req,res)=>{
  if(req.url==='/mutation'){mutations++;res.end('ok');return;}
  if(req.url==='/dismiss'){dismissals++;res.end('ok');return;}
  res.setHeader('content-type','text/html');res.end('<html><body><button id="apply" onclick="fetch(\'/mutation\',{method:\'POST\'})">Apply</button><span id="state">Done</span><input value="PRIVATE_INPUT"><div data-sensitive>PRIVATE_SENSITIVE</div><div role="dialog" aria-modal="true" style="position:fixed;inset:0"><button id="dismiss" onclick="this.parentElement.remove();fetch(\'/dismiss\',{method:\'POST\'})">Close</button></div></body></html>');
 });
 target.listen(0,'127.0.0.1');await once(target,'listening');t.after(()=>new Promise(resolve=>{target.closeAllConnections();target.close(resolve);}));
 const url=`http://127.0.0.1:${target.address().port}/`;
 const latestObservation=context=>context.task_tool_invocations.at(-1)?.output_json?.observation||{};
 const currentControlRef=(context,index)=>{
  const controls=latestObservation(context).controls||[];
  const ref=controls[index<0?controls.length+index:index]?.control_ref;
  assert.equal(typeof ref,'string');return ref;
 };
 const currentAssertionRef=context=>{
  const ref=latestObservation(context).assertion_targets?.[0]?.assertion_ref;assert.equal(typeof ref,'string');return ref;
 };
 const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const context=JSON.parse(JSON.parse(raw).messages.find(message=>message.role==='user').content).context;contexts.push(context);requests++;
  const decision=requests===1?{action:'tool_call',tool_name:'browser.navigate',arguments:{url}}
   :requests===2?{action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',control_ref:currentControlRef(context,-1)}}}
   :requests===3?{action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',control_ref:currentControlRef(context,0)}}}
   :requests===4?{action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',control_ref:currentControlRef(context,0)}}}
   :requests===5?{action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'assert',assertion_ref:currentAssertionRef(context)}}}
   :{action:'complete_task',summary:'Opaque fixture completed.'};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:`opaque-${requests}`,model:'fixture',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
 const db=await database(),repo=new AIScanRepository(db);await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',['selector-fixture','Opaque protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'test-only','fixture',1,1]);
 const run=await repo.createRun({base_url:url,scan_config:{surface:'web',driving_mode:'autopilot'}});t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
 await repo.createTask({scan_run_id:run.id,title:'Observed reference protocol',task_type:'autonomous_agent_task',execution_plan:{intent:'discover_target'}});
 await new AIScanAgentRuntime(db).run(run.id);
 const snapshot=await repo.getSnapshot(run.id),interactions=snapshot.tool_invocations.filter(invocation=>invocation.tool_name==='browser.interact');
 assert.equal(snapshot.run.status,'completed');assert.equal(requests,6);assert.equal(mutations,1);assert.equal(dismissals,1);
 assert.equal(interactions.length,4);assert.equal(interactions.filter(invocation=>invocation.status==='failed').length,1);
 assert.equal(interactions.find(invocation=>invocation.status==='failed')?.output_json.error_code,'selector_actionability_timeout');
 assert.ok(interactions.every(invocation=>!Object.hasOwn(invocation.input_json.operation,'selector')));
 assert.ok(interactions.some(invocation=>typeof invocation.input_json.operation.control_ref==='string'));
 assert.ok(interactions.some(invocation=>typeof invocation.input_json.operation.assertion_ref==='string'));
 assert.equal(JSON.stringify(contexts).includes('PRIVATE_'),false);
});
