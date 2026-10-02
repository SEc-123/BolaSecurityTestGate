/**
 * The browser runtime has one serial lease per shared identity context. These
 * tests use the explicit Playwright protocol double only to control ordering;
 * they exercise the production runtime's capture and cleanup functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

process.env.BSTG_PLAYWRIGHT_MODULE=new URL('../live-browser/browser-double.mjs',import.meta.url).href;
process.env.BSTG_BROWSER_MODE='headless';

const runtime=await import('../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts');
const browserDouble=await import('../live-browser/browser-double.mjs');

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

function runtimeRepo(){
  const records=new Map(),artifacts=[];
  return {
    records,artifacts,
    getRun:async()=>({scan_config:{}}),
    getTask:async()=>null,
    getBrowserContext:async(_scanRunId,contextKey)=>records.get(contextKey)||null,
    upsertBrowserContext:async value=>{
      const row={...records.get(value.context_key),...value,id:records.get(value.context_key)?.id||`context-${records.size+1}`};
      records.set(value.context_key,row);
      return row;
    },
    createArtifact:async value=>{const artifact={...value,id:`artifact-${artifacts.length+1}`};artifacts.push(artifact);return artifact;},
    listBrowserContexts:async()=>[...records.values()],
    closeBrowserContextRecord:async(_scanRunId,contextKey,status)=>{
      const existing=records.get(contextKey);
      if(existing)records.set(contextKey,{...existing,status});
    },
  };
}

test('a queued foreign action is rejected after capture owns the shared browser lease',async t=>{
  const repo=runtimeRepo();
  const scanRunId=`capture-lease-${randomUUID()}`;
  const owner={repo,scanRunId,taskId:'capture-owner',scope_base_url:'https://authorized.example',identity_key:'member',context_key:'identity:member'};
  const foreign={...owner,taskId:'queued-foreign'};
  const captureEvents=[];
  browserDouble.calls.splice(0);
  t.after(async()=>{
    await runtime.closePersistentBrowserContextsForScan(repo,scanRunId);
  });

  assert.equal((await runtime.navigatePersistentBrowser({...owner,url:'https://authorized.example/home'})).ok,true);

  // Keep the first lease active. startPersistentBusinessCapture queues behind
  // it, then each foreign operation queues behind capture before it starts.
  const entered=deferred(),releaseHolder=deferred();
  const holder=runtime.withPersistentDiscoveryPage(owner,async()=>{
    entered.resolve();
    await releaseHolder.promise;
    return {held:true};
  });
  await entered.promise;

  const capture=runtime.startPersistentBusinessCapture({...owner,sink:{id:'capture-session',record:async event=>{captureEvents.push(event);}}});
  // Let startPersistentBusinessCapture install its lease behind holder. It
  // cannot yet set businessCapture because holder remains unresolved.
  await turn();await turn();
  const queuedInteract=runtime.interactPersistentBrowser({...foreign,operation:{action:'click',selector:'#foreign-write'}});
  const queuedNavigate=runtime.navigatePersistentBrowser({...foreign,url:'https://authorized.example/foreign'});
  await turn();await turn();

  releaseHolder.resolve();
  await holder;
  const started=await capture;
  const [interaction,navigation]=await Promise.all([queuedInteract,queuedNavigate]);

  assert.equal(interaction.ok,false);
  // Browser runtime results are model-safe projections: the stable error code
  // proves the lease rejection without reintroducing a free-form error string.
  assert.equal(interaction.error_code,'browser_capture_owned_elsewhere');
  assert.equal(navigation?.ok,false);
  assert.match(navigation?.error||'',/recording another task's business flow/);
  assert.equal(browserDouble.calls.some(call=>call[0]==='click'&&call[1]==='#foreign-write'),false,'the foreign click never reaches the browser dispatch boundary');
  assert.equal(browserDouble.calls.some(call=>call[0]==='goto'&&call[1]==='https://authorized.example/foreign'),false,'the foreign navigation never reaches the browser dispatch boundary');
  assert.equal(captureEvents.some(event=>event.task_id==='queued-foreign'),false,'a rejected foreign action cannot enter the owner capture stream');

  await runtime.stopPersistentBusinessCapture({...owner,capture_id:started.capture_id});
});

test('terminal owner cleanup interrupts its capture without closing a shared identity browser',async t=>{
  const repo=runtimeRepo();
  const scanRunId=`terminal-capture-cleanup-${randomUUID()}`;
  const owner={repo,scanRunId,taskId:'terminal-owner',scope_base_url:'https://authorized.example',identity_key:'member',context_key:'identity:member'};
  const successor={...owner,taskId:'next-owner'};
  const ended=[];
  t.after(async()=>{
    await runtime.closePersistentBrowserContextsForScan(repo,scanRunId);
  });

  assert.equal((await runtime.navigatePersistentBrowser({...owner,url:'https://authorized.example/home'})).ok,true);
  const capture=await runtime.startPersistentBusinessCapture({...owner,sink:{id:'terminal-session',record:async()=>undefined,ended:async(reason,errors)=>{ended.push({reason,errors});}}});

  const cleanup=await runtime.interruptPersistentBusinessCapturesForTask({scanRunId,taskId:owner.taskId});

  assert.deepEqual(cleanup,{interrupted:1,errors:[]});
  assert.deepEqual(ended,[{reason:'task_terminal',errors:[]}]);
  assert.equal(runtime.getLiveBrowserContextCount(scanRunId),1,'the identity context stays open for the next normal flow');
  assert.equal((await runtime.navigatePersistentBrowser({...successor,url:'https://authorized.example/next'})).ok,true,'the next task can reuse the authenticated identity context');
  const nextCapture=await runtime.startPersistentBusinessCapture({...successor,sink:{id:'next-session',record:async()=>undefined}});
  await runtime.stopPersistentBusinessCapture({...successor,capture_id:nextCapture.capture_id});
  assert.equal(capture.context_key,'identity:member');
});

test('task cleanup closes an active persisted task context with no live process entry',async()=>{
  const repo=runtimeRepo();
  const scanRunId=`persisted-task-cleanup-${randomUUID()}`;
  repo.records.set('task:completed-task',{
    id:'persisted-task',scan_run_id:scanRunId,context_key:'task:completed-task',scope_type:'task',task_id:'completed-task',identity_key:'',status:'active',
  });
  repo.records.set('task:other-task',{
    id:'other-task',scan_run_id:scanRunId,context_key:'task:other-task',scope_type:'task',task_id:'other-task',identity_key:'',status:'active',
  });
  repo.records.set('identity:member',{
    id:'shared-identity',scan_run_id:scanRunId,context_key:'identity:member',scope_type:'identity',task_id:'completed-task',identity_key:'member',status:'active',
  });

  const closed=await runtime.closeTaskBrowserContexts(repo,scanRunId,'completed-task');

  assert.equal(closed,1);
  assert.equal(repo.records.get('task:completed-task').status,'closed');
  assert.equal(repo.records.get('task:other-task').status,'active');
  assert.equal(repo.records.get('identity:member').status,'active');
  assert.equal(runtime.getLiveBrowserContextCount(scanRunId),0,'the regression uses only a persisted record, as after a process restart');
});
