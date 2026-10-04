#!/usr/bin/env node
/** Real-model acceptance infrastructure. No canned model decisions, scenario
 * steps, opaque routes, fault modes, or oracle assertions enter the model prompt. */
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID,X509Certificate} from 'node:crypto';
import {createBusinessLearningFixture} from './business-learning-fixture.mjs';
import {loadAcceptanceProvider,providerReference,verifyModelDecisions} from './live-provider.mjs';
import {redactWorkerCapability} from '../../scripts/live-browser/local-container-runtime.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(root,'server/package.json'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=async()=>{const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;};
const DEFAULT_GOAL='The operator owns this disposable test site and supplied the test accounts. Discover its visible business functions, then complete and semantically verify normal login, profile, cart, purchase review/order, and private-note flows. Record the actual requests, dynamic dependencies, and reproducible normal-flow evidence.';
// These are outcome-level requirements, not fixture routes or scripted UI
// actions. They are deliberately carried in the normal-stage projection so a
// real model plans the complete business surface without receiving the later
// security-assessment prompt.
export const DEFAULT_NORMAL_OBJECTIVES=Object.freeze([
  {label:'Sign in with a supplied test identity and verify the authenticated normal state.',requires_prepared_identity:true,operation:{method:'POST',route_shape:'/r/k01',side_effect_class:'authentication'}},
  {label:'Update the signed-in profile, then read the account state again and verify the saved value persisted.',requires_prepared_identity:true,completion:{required_response_paths:['body.alias']},operation:{method:'POST',route_shape:'/r/k12',side_effect_class:'update'}},
  {label:'Add an available item to the cart, then read the account state again and verify the saved cart quantity.',requires_prepared_identity:true,completion:{required_response_paths:['body.cart.0.quantity']},operation:{method:'POST',route_shape:'/r/k22',side_effect_class:'add'}},
  {label:'Complete the normal purchase review and order-confirmation path, then read the account state again and verify the saved order.',requires_prepared_identity:true,completion:{required_response_paths:['body.orders.0.id','body.orders.0.status']},operation:{method:'POST',route_shape:'/r/k24',side_effect_class:'transaction'}},
  {label:'Create a private note, then read the same object again and verify its saved ID and owner.',requires_prepared_identity:true,completion:{required_response_paths:['body.id','body.owner']},operation:{method:'POST',route_shape:'/r/k32',side_effect_class:'create'}},
]);
const REQUEST_TIMEOUT_MS=15000;
const PROVIDER_PREFLIGHT_TIMEOUT_MS=150000;
// A normal-only acceptance may legitimately execute an initial capture plus
// one server-bounded coverage-recovery capture.  Keep its task/run allowances
// aligned with the product's bounded normal-learning policy so the harness
// tests that complete path instead of failing midway through it.
const DEFAULT_ACCEPTANCE_MAX_STEPS=480;
const DEFAULT_ACCEPTANCE_TIMEOUT_MS=2700000;
const DEFAULT_PROGRESS_POLL_INTERVAL_MS=1000;
const TRANSIENT_PROGRESS_READ_ATTEMPTS=3;
const SAFE_RUN_STATUSES=new Set(['created','discovering','planning','running','completed','failed','cancelled','awaiting_selection']);
const SAFE_TASK_STATUSES=new Set(['pending','running','completed','failed','blocked','skipped','waiting_selection']);
const SAFE_PROGRESS_TOTALS=new Set(['tests','completed','failed','blocked','review','pending','normal_flows','verified_flows','learning_flows','blocked_flows','experiments','confirmed_risks']);
const REQUIRED_ACCEPTANCE_MODEL='gpt-5.6-terra';
const DEFAULT_TLS_RUNTIME_IMAGE='hahawo65/bstg-browser-runtime:pw-1.62.1';

function childOutcome(child, label, onOutput) {
  return new Promise((resolve, reject) => {
    let output='';
    child.stdout?.on('data', chunk => { output += chunk; onOutput?.(chunk.toString()); });
    child.stderr?.on('data', chunk => { output += chunk; onOutput?.(chunk.toString()); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({code, signal, output, label}));
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child,'exit'),sleep(10000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child,'exit'),sleep(1000)]);
  }
}

function configuredCaFingerprint(pem) {
  const certificates=String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)||[];
  if (!certificates.length) throw Error('The disposable TLS fixture did not contain a CA certificate.');
  const hashes=certificates.map(certificate=>createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex')).sort();
  return createHash('sha256').update(hashes.join(':')).digest('hex');
}

async function waitForPrivateBrowserCapability(runtimeFile, worker, getOutput, getFailure, timeoutMs=45000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    if(getFailure?.()) throw Error('The isolated HTTPS browser worker could not start.');
    if(worker.exitCode!==null) throw Error('The isolated HTTPS browser worker stopped before becoming ready.');
    try {
      const record=JSON.parse(await readFile(runtimeFile,'utf8'));
      const endpoint=String(record?.browser_ws_endpoint||'');
      const url=new URL(endpoint);
      if(url.protocol==='ws:'&&url.hostname==='127.0.0.1'&&/^\/[A-Za-z0-9-]{12,}$/.test(url.pathname)) return endpoint;
    } catch {}
    await sleep(100);
  }
  // The worker controller itself redacts capabilities before emitting any
  // diagnostics. Keep its bounded message private and never write it into a
  // product acceptance report.
  void getOutput?.();
  throw Error('The isolated HTTPS browser worker did not become ready in time.');
}

/**
 * Strict real-model acceptance owns its disposable CA and Linux browser
 * worker. The browser capability lives only in a 0600 runtime file and is
 * injected into the managed backend child; neither it nor the CA path/value is
 * returned in reports. This is the same trust topology used by the standalone
 * HTTPS capture acceptance, now applied to the actual Agent loop.
 */
async function startStrictTlsRuntime(out) {
  const tlsDirectory=path.join(out,'private-target-tls');
  const runtimeDirectory=path.join(out,'private-browser-runtime');
  const runtimeFile=path.join(runtimeDirectory,`capability-${randomUUID()}.json`);
  await mkdir(tlsDirectory,{recursive:true,mode:0o700});
  await chmod(tlsDirectory,0o700);
  await mkdir(runtimeDirectory,{recursive:true,mode:0o700});
  await chmod(runtimeDirectory,0o700);
  const prepare=spawn('python3',['tests/fixtures/prepare-local-tls.py','--output',tlsDirectory],{cwd:root,stdio:['ignore','pipe','pipe']});
  const prepared=await childOutcome(prepare,'prepare controlled TLS fixture');
  if(prepared.code!==0) throw Error('Could not prepare the disposable controlled HTTPS target.');
  const [key,cert,ca]=await Promise.all([
    readFile(path.join(tlsDirectory,'key.pem')),
    readFile(path.join(tlsDirectory,'cert.pem')),
    readFile(path.join(tlsDirectory,'ca.pem'),'utf8'),
  ]);
  const workerPort=await freePort();
  const worker=spawn(process.execPath,['scripts/live-browser/local-container-runtime.mjs'],{
    cwd:root,
    env:{...process.env,
      BSTG_RUNTIME_IMAGE:process.env.BSTG_RUNTIME_IMAGE||DEFAULT_TLS_RUNTIME_IMAGE,
      BSTG_TARGET_CA_FILE:path.join(tlsDirectory,'ca.pem'),
      BSTG_BROWSER_RUNTIME_FILE:runtimeFile,
      BSTG_WORKER_PORT:String(workerPort),
    },
    stdio:['ignore','pipe','pipe'],
  });
  let workerOutput='';
  let workerFailure;
  worker.stdout?.on('data',chunk=>{workerOutput+=redactWorkerCapability(chunk.toString());});
  worker.stderr?.on('data',chunk=>{workerOutput+=redactWorkerCapability(chunk.toString());});
  // A failed child-process spawn otherwise emits an unhandled `error` event
  // and turns a concrete worker startup failure into a slow acceptance hang.
  worker.once('error',error=>{workerFailure=error;});
  try {
    const endpoint=await waitForPrivateBrowserCapability(runtimeFile,worker,()=>workerOutput,()=>workerFailure);
    return {
      fixtureTls:{key,cert},
      backendEnv:{
        BSTG_TARGET_CA_FILE:path.join(tlsDirectory,'ca.pem'),
        BSTG_BROWSER_TRUSTED_CA_SHA256:configuredCaFingerprint(ca),
        BSTG_BROWSER_WS_ENDPOINT:endpoint,
        BSTG_BROWSER_EXPOSE_NETWORK:'<loopback>',
      },
      async close(){
        await stopChild(worker);
        await rm(runtimeDirectory,{recursive:true,force:true});
        await rm(tlsDirectory,{recursive:true,force:true});
      },
    };
  } catch(error) {
    await stopChild(worker);
    await rm(runtimeDirectory,{recursive:true,force:true});
    await rm(tlsDirectory,{recursive:true,force:true});
    throw error;
  }
}

/**
 * This acceptance starts `scripts/start-server.mjs`, which intentionally runs
 * the compiled production entry point.  Build it in the isolated acceptance
 * process immediately before that entry point starts: otherwise a source-only
 * change can combine newer test/oracle code with older server behavior.
 *
 * Use the checked-in TypeScript compiler directly rather than a shell command
 * so the process has no ambient command expansion or package lifecycle side
 * effects.  The caller retains the bounded, redacted build output alongside
 * the isolated backend log when a build fails.
 */
async function buildManagedAcceptanceBackend(onOutput){
  const compiler=path.join(root,'server','node_modules','typescript','lib','tsc.js');
  const build=spawn(process.execPath,[compiler,'-p',path.join(root,'server','tsconfig.json')],{
    cwd:root,env:process.env,stdio:['ignore','pipe','pipe'],
  });
  let output='';
  build.stdout.on('data',chunk=>output+=chunk);
  build.stderr.on('data',chunk=>output+=chunk);
  const outcome=await new Promise((resolve,reject)=>{
    build.once('error',reject);
    build.once('exit',(code,signal)=>resolve({code,signal}));
  });
  onOutput?.(output);
  if(outcome.code!==0)throw Error(`Isolated acceptance backend build failed${outcome.signal?` (${outcome.signal})`:''}.`);
}

function boundedAcceptanceMaxSteps(value=process.env.BSTG_BUSINESS_ACCEPTANCE_MAX_STEPS||DEFAULT_ACCEPTANCE_MAX_STEPS){
  const parsed=Number(value);
  if(!Number.isInteger(parsed)||parsed<1||parsed>10000)throw Error('BSTG business-learning acceptance max_steps must be an integer between 1 and 10000.');
  return parsed;
}

/** The normal-only stage never pauses for an interactive task choice. */
export function assertNormalOnlyRunProgress(state){
  if(state?.run?.status==='awaiting_selection'){
    throw Error('A normal-only business-learning acceptance entered awaiting_selection instead of completing its native normal-flow evidence.');
  }
}

/** Keep acceptance artifacts useful without persisting dynamic CSRF or other
 * private fixture values alongside the report. */
export function safeFixtureStateForReport(fixtureState){
  const metricNames=['logins','profile_updates','profile_readbacks','cart_additions','cart_readbacks','tickets_created','normal_orders','order_readbacks','notes_created','note_readbacks',
    'csrf_rejections','unauthorized_reads','unauthorized_updates','invalid_orders'];
  const metrics=Object.fromEntries(metricNames.map(name=>[name,Number(fixtureState?.metrics?.[name]||0)]));
  return {
    mode:['secure','misleading-response','object-boundary','quantity-boundary'].includes(fixtureState?.mode)?fixtureState.mode:'unknown',
    transport:fixtureState?.transport==='https'?'https':'http',
    metrics,
    unresolved_values:Number(fixtureState?.unresolved_values||0),
    csrf_value_count:Array.isArray(fixtureState?.csrf_values)?fixtureState.csrf_values.length:0,
    request_count:Number(fixtureState?.request_count||0),
  };
}

async function fetchWithDeadline(url,init,deadline,label,requestTimeoutMs=REQUEST_TIMEOUT_MS){
  const remaining=deadline-Date.now();
  if(remaining<=0)throw Error(`${label} exceeded its acceptance deadline before it started.`);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),Math.max(1,Math.min(requestTimeoutMs,remaining)));
  try{return await fetch(url,{...init,signal:controller.signal});}
  catch(error){
    if(controller.signal.aborted||Date.now()>=deadline||error?.name==='AbortError')throw Error(`${label} exceeded its acceptance deadline.`);
    throw error;
  }finally{clearTimeout(timeout);}
}

/** Keep both headers and the JSON body inside the same acceptance budget. */
export async function fetchJsonWithDeadline(url,init,deadline,label,requestTimeoutMs=REQUEST_TIMEOUT_MS){
  const remaining=deadline-Date.now();
  if(remaining<=0)throw Error(`${label} exceeded its acceptance deadline before it started.`);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),Math.max(1,Math.min(requestTimeoutMs,remaining)));
  try{
    const response=await fetch(url,{...init,signal:controller.signal});
    return {response,json:await response.json()};
  }catch(error){
    if(controller.signal.aborted||Date.now()>=deadline||error?.name==='AbortError')throw Error(`${label} exceeded its acceptance deadline.`);
    throw error;
  }finally{clearTimeout(timeout);}
}

/**
 * The acceptance backend runs the real model loop in the same isolated
 * process.  A reused local HTTP socket can occasionally reset while that
 * process is under model/provider pressure even though the run remains live.
 * Retrying only bounded progress reads avoids treating that transport blip as
 * a product verdict; the outer acceptance deadline remains authoritative.
 */
function retryableProgressRead(error,deadline){
  if(Date.now()>=deadline)return false;
  if(error?.name==='Error'&&/exceeded its acceptance deadline\.$/i.test(String(error?.message||'')))return true;
  if(error?.name!=='TypeError')return false;
  const message=String(error?.message||error||'');
  return /fetch failed|network|socket|connection|terminated|ECONNRESET|UND_ERR/i.test(message);
}

export async function fetchJsonWithProgressRetry(url,init,deadline,label,{attempts=TRANSIENT_PROGRESS_READ_ATTEMPTS,requestTimeoutMs=REQUEST_TIMEOUT_MS}={}){
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{return await fetchJsonWithDeadline(url,init,deadline,label,requestTimeoutMs);}
    catch(error){
      lastError=error;
      if(attempt>=attempts||!retryableProgressRead(error,deadline))throw error;
      const remaining=deadline-Date.now();
      if(remaining<=0)throw error;
      await sleep(Math.min(250*attempt,remaining));
    }
  }
  throw lastError;
}

function safeCount(value){return Number.isSafeInteger(value)&&value>=0&&value<=1_000_000?value:undefined;}

/** Product state is browser-facing, but acceptance reports still retain only
 * bounded lifecycle facts so malformed or future fields cannot masquerade as
 * progress or be written to local evidence. */
export function safeProgressObservation({state,technical,fixtureState,at=new Date().toISOString()}={}){
  const rawTotals=state?.totals&&typeof state.totals==='object'?state.totals:{};
  const totals=Object.fromEntries([...SAFE_PROGRESS_TOTALS].flatMap(key=>{
    const value=safeCount(rawTotals[key]);return value===undefined?[]:[[key,value]];
  }));
  const taskStatuses={};
  for(const task of technical?.tasks||[]){
    const status=String(task?.status||'');
    if(SAFE_TASK_STATUSES.has(status))taskStatuses[status]=(taskStatuses[status]||0)+1;
  }
  return {at,status:SAFE_RUN_STATUSES.has(state?.run?.status)?state.run.status:'unknown',
    phase:typeof technical?.run?.current_phase==='string'?technical.run.current_phase:
      typeof state?.run?.current_phase==='string'?state.run.current_phase:null,
    totals,task_statuses:taskStatuses,artifact_count:safeCount((technical?.artifacts||[]).length)||0,
    metrics:safeFixtureStateForReport(fixtureState).metrics};
}

/** Connection checks are an explicit real-model proof, but their report must
 * never retain gateway error details or the provider configuration. */
export function assertProviderPreflightResult(result,expectedModel){
  assert.equal(result?.ok,true,'The configured real-model provider did not pass its connection preflight.');
  assert.equal(result?.model,expectedModel,'The configured real-model provider returned a different model during preflight.');
  const latencyMs=Number(result?.latency_ms);
  assert.ok(Number.isFinite(latencyMs)&&latencyMs>=0,'The real-model provider preflight did not return a valid latency.');
  return {ok:true,model:expectedModel,latency_ms:latencyMs};
}

function artifactRevision(artifact){return Number.isInteger(artifact?.content_json?.revision)?artifact.content_json.revision:0;}
function newestArtifact(left,right){
  if(!left)return right;
  const revision=artifactRevision(right)-artifactRevision(left);
  return revision>0||(revision===0&&String(right.created_at||'')>String(left.created_at||''))?right:left;
}
function latestNormalFlows(technical){
  const latest=new Map();
  for(const artifact of technical?.artifacts||[]){
    if(artifact.artifact_type!=='business_flow')continue;
    const flowId=String(artifact.content_json?.id||artifact.source_ref||'');if(!flowId)continue;
    latest.set(flowId,newestArtifact(latest.get(flowId),artifact));
  }
  return [...latest.values()];
}
function productNormalFlows(productState){return (productState?.business_functions||[]).flatMap(feature=>Array.isArray(feature.normal_flows)?feature.normal_flows:[]);}

/** Selection evidence intentionally uses only opaque event references.  The
 * acceptance verdict must not need to reopen a private capture artifact. */
function nonemptyEventIds(value){
  return Array.isArray(value)&&value.length>0&&value.every(eventId=>typeof eventId==='string'&&eventId.length>0)&&
    new Set(value).size===value.length;
}
function sameEventIds(left,right){
  return left.length===right.length&&left.every((eventId,index)=>eventId===right[index]);
}

/** The public snapshot carries only immutable objective IDs/labels and opaque
 * receipts. It never reopens provider text, captured traffic, or credentials. */
function requiredObjectiveManifest(technical){
  const plans=(technical?.tasks||[]).filter(task=>task?.execution_plan?.strict_normal_objectives===true&&
    Array.isArray(task?.execution_plan?.normal_objective_manifest));
  if(!plans.length)return [];
  assert.equal(plans.length,1,'Strict normal-only acceptance requires exactly one persisted objective manifest.');
  const seen=new Set();
  const manifest=[];
  for(const item of plans[0].execution_plan.normal_objective_manifest){
    const id=typeof item?.id==='string'?item.id:'';
    assert.match(id,/^objective:[a-f0-9]{24}$/,'Objective manifest contains an invalid opaque objective ID.');
    assert.ok(!seen.has(id),'Objective manifest contains a duplicate objective ID.');
    const requiredResponsePaths=[...new Set((Array.isArray(item?.completion?.required_response_paths)?item.completion.required_response_paths:[])
      .flatMap(path=>typeof path==='string'&&/^body\.[^\s]{1,280}$/.test(path)?[path]:[]))];
    if(item?.completion!==undefined)assert.ok(requiredResponsePaths.length,
      `Objective ${id} has an invalid value-free completion contract.`);
    const operation=item?.operation&&typeof item.operation==='object'&&/^operation:[a-f0-9]{24}$/.test(String(item.operation.operation_id||''))&&/^(POST|PUT|PATCH|DELETE)$/.test(String(item.operation.method||''))&&['authentication','update','add','create','transaction','write'].includes(String(item.operation.side_effect_class||''))
      ? {operation_id:item.operation.operation_id,method:item.operation.method,side_effect_class:item.operation.side_effect_class}:undefined;
    seen.add(id);manifest.push({id,label:typeof item?.label==='string'?item.label:'',
      ...(requiredResponsePaths.length?{completion:{required_response_paths:requiredResponsePaths}}:{}),
      ...(operation?{operation}:{}),
      ...(item?.requires_prepared_identity===true?{requires_prepared_identity:true}:{})});
  }
  assert.ok(manifest.length>0,'Strict normal-only acceptance requires at least one immutable objective.');
  return manifest;
}

function assertVerifiedNormalFlowEvidence({technical,productState,provider,requireHttps=false}){
  assert.ok(technical&&Array.isArray(technical.artifacts),'Acceptance requires the safe technical snapshot.');
  assert.ok(provider?.model,'Acceptance requires the configured real model identity.');
  const flows=latestNormalFlows(technical),artifacts=technical.artifacts||[],tasks=technical.tasks||[];
  const productFlows=productNormalFlows(productState);
  const objectiveManifest=requiredObjectiveManifest(technical);
  assert.ok(flows.length>0,'A normal-only acceptance needs at least one persisted normal Flow.');
  if(objectiveManifest.length){
    assert.equal(flows.length,objectiveManifest.length,'Every immutable normal-business objective must have exactly one current Flow.');
    const expected=new Set(objectiveManifest.map(objective=>objective.id));
    const flowObjectives=flows.map(artifact=>String(artifact.content_json?.objective_id||''));
    assert.ok(flowObjectives.every(objectiveId=>expected.has(objectiveId))&&new Set(flowObjectives).size===expected.size,
      'Current normal Flows must map one-to-one to the immutable objective manifest.');
    const productObjectives=productFlows.map(flow=>String(flow?.objective_id||''));
    assert.deepEqual([...new Set(productObjectives)].sort(),[...expected].sort(),
      'Product normal-flow state must expose exactly the verified immutable objective set.');
  }
  assert.equal(productFlows.length,flows.length,'Every product normal Flow must retain persisted native workflow/run evidence.');
  const technicalFlowIds=[...new Set(flows.map(artifact=>String(artifact.content_json?.id||artifact.source_ref||'')).filter(Boolean))].sort();
  const productFlowIds=productFlows.map(flow=>String(flow?.id||''));
  assert.ok(productFlowIds.every(Boolean)&&new Set(productFlowIds).size===productFlowIds.length,
    'Product normal Flows must expose each persisted Flow exactly once.');
  assert.deepEqual([...productFlowIds].sort(),technicalFlowIds,
    'Product normal Flow IDs must exactly match persisted normal Flow evidence.');
  assert.ok(productFlows.every(flow=>flow.status==='verified'),'Blocked, failed, learning, or unverified normal Flows cannot satisfy acceptance.');
  const totals=productState?.totals||{};
  for(const [name,expected] of Object.entries({normal_flows:flows.length,verified_flows:flows.length,learning_flows:0,blocked_flows:0})){
    assert.equal(totals[name],expected,`Product normal-Flow totals must report ${name}=${expected} for a verified normal-only acceptance.`);
  }
  const decisions=artifacts.filter(artifact=>artifact.artifact_type==='agent_decision').map(artifact=>({...artifact,...artifact.content_json}));
  const evidence=[];
  for(const flowArtifact of flows){
    const flow=flowArtifact.content_json||{},flowId=String(flow.id||flowArtifact.source_ref||'');
    const workflowId=String(flow.workflow_id||''),runId=String(flow.normal_run_id||'');
    const objective=objectiveManifest.find(item=>item.id===flow.objective_id);
    assert.equal(flow.status,'verified',`Normal Flow ${flowId} did not reach verified status.`);
    assert.equal(flow.assertions_verified,true,`Normal Flow ${flowId} has no verified semantic assertions.`);
    if(requireHttps)assert.equal(flow.captured_transport_verified_https,true,
      `Normal Flow ${flowId} lacks certificate-verified HTTPS capture provenance.`);
    assert.ok(workflowId&&runId,`Normal Flow ${flowId} has no native Workflow/Test Run provenance.`);
    const validation=artifacts.find(artifact=>artifact.artifact_type==='business_workflow_validation'&&
      artifact.task_id===flowArtifact.task_id&&artifact.source_ref===runId&&artifact.content_json?.flow_id===flowId&&
      artifact.content_json?.workflow_id===workflowId&&artifact.content_json?.test_run_id===runId&&artifact.content_json?.assertions_verified===true);
    assert.ok(validation,`Normal Flow ${flowId} lacks matching native workflow validation evidence.`);
    if(requireHttps)assert.equal(validation.content_json?.transport_verified_https,true,
      `Normal Flow ${flowId} lacks certificate-verified HTTPS native replay provenance.`);
    if(objective?.requires_prepared_identity){
      assert.equal(flow.requires_prepared_identity,true,
        `Normal Flow ${flowId} does not retain its server-owned prepared-identity prerequisite.`);
      assert.notEqual(flow.role,'anonymous',
        `Normal Flow ${flowId} used anonymous despite its server-owned prepared-identity prerequisite.`);
    }
    if(objective?.operation){
      assert.deepEqual(flow.objective_operation,objective.operation,`Normal Flow ${flowId} does not retain its sealed state-changing operation contract.`);
      const operationBinding=flow.objective_operation_binding||{};
      assert.equal(operationBinding.operation_id,objective.operation.operation_id,`Normal Flow ${flowId} operation proof does not bind its declared operation.`);
      assert.equal(operationBinding.side_effect_class,objective.operation.side_effect_class,`Normal Flow ${flowId} operation proof does not bind its declared effect class.`);
      assert.equal(operationBinding.validated,true,`Normal Flow ${flowId} did not natively validate its required state-changing operation.`);
      assert.ok(nonemptyEventIds(operationBinding.source_event_ids)&&nonemptyEventIds(operationBinding.action_ids),`Normal Flow ${flowId} operation proof lacks action-bound capture provenance.`);
      assert.ok(Array.isArray(operationBinding.source_step_orders)&&operationBinding.source_step_orders.length&&operationBinding.source_step_orders.every(order=>Number.isInteger(order)&&order>0),`Normal Flow ${flowId} operation proof lacks source step provenance.`);
      assert.equal(operationBinding.normal_workflow_id,workflowId,`Normal Flow ${flowId} operation proof points to a different native Workflow.`);
      assert.equal(operationBinding.normal_run_id,runId,`Normal Flow ${flowId} operation proof points to a different native Test Run.`);
      assert.ok(nonemptyEventIds(operationBinding.validation_assertion_ids),`Normal Flow ${flowId} operation proof lacks a passing native semantic assertion.`);
      const validationOperation=validation.content_json?.objective_operation_binding||{};
      assert.equal(validationOperation.operation_id,objective.operation.operation_id,`Normal Flow ${flowId} validation receipt does not retain the operation contract.`);
      assert.equal(validationOperation.validated,true,`Normal Flow ${flowId} validation receipt did not seal the state-changing operation proof.`);
    }
    if(objective?.completion){
      assert.deepEqual(flow.objective_completion,objective.completion,
        `Normal Flow ${flowId} does not retain its server-owned completion contract.`);
      const completionBinding=flow.objective_completion_binding||{};
      assert.deepEqual(completionBinding.required_response_paths,objective.completion.required_response_paths,
        `Normal Flow ${flowId} completion proof does not bind every required response field.`);
      assert.equal(completionBinding.validated,true,
        `Normal Flow ${flowId} did not validate the final-objective completion proof.`);
      assert.ok(nonemptyEventIds(completionBinding.source_event_ids),
        `Normal Flow ${flowId} completion proof has no opaque capture-event provenance.`);
      assert.ok(nonemptyEventIds(completionBinding.action_ids),
        `Normal Flow ${flowId} completion proof has no browser-action provenance.`);
      assert.ok(typeof completionBinding.source_workflow_id==='string'&&completionBinding.source_workflow_id,
        `Normal Flow ${flowId} completion proof has no source Workflow provenance.`);
      assert.ok(Array.isArray(completionBinding.source_step_orders)&&completionBinding.source_step_orders.every(order=>Number.isInteger(order)&&order>0)&&completionBinding.source_step_orders.length,
        `Normal Flow ${flowId} completion proof has no source step provenance.`);
      assert.equal(completionBinding.normal_workflow_id,workflowId,
        `Normal Flow ${flowId} completion proof does not point to its native normal Workflow.`);
      assert.equal(completionBinding.normal_run_id,runId,
        `Normal Flow ${flowId} completion proof does not point to its native normal Test Run.`);
      assert.ok(nonemptyEventIds(completionBinding.validation_assertion_ids),
        `Normal Flow ${flowId} completion proof has no passing native semantic assertion.`);
      const validationCompletion=validation.content_json?.objective_completion_binding||{};
      assert.deepEqual(validationCompletion.required_response_paths,objective.completion.required_response_paths,
        `Normal Flow ${flowId} validation receipt does not retain the completion contract.`);
      assert.equal(validationCompletion.validated,true,
        `Normal Flow ${flowId} validation receipt did not seal the completion proof.`);
      assert.equal(validationCompletion.normal_workflow_id,workflowId,
        `Normal Flow ${flowId} validation receipt points to a different normal Workflow.`);
      assert.equal(validationCompletion.normal_run_id,runId,
        `Normal Flow ${flowId} validation receipt points to a different normal Test Run.`);
    }
    const retainedEvidence=new Set(Array.isArray(flow.evidence_artifact_ids)?flow.evidence_artifact_ids:[]);
    assert.ok(retainedEvidence.has(validation.id),`Normal Flow ${flowId} does not retain its native workflow validation evidence.`);
    const task=tasks.find(candidate=>candidate.id===validation.task_id);
    assert.equal(task?.task_type,'learn_business_flow',`Normal Flow ${flowId} validation must belong to its normal-learning task.`);
    assert.equal(task?.status,'completed',`Normal Flow ${flowId} normal-learning task did not complete.`);
    const productFlow=productFlows.find(candidate=>candidate.id===flowId);
    assert.equal(productFlow?.status,'verified',`Product state does not mark Normal Flow ${flowId} as verified.`);
    if(objectiveManifest.length)assert.equal(productFlow?.objective_id,flow.objective_id,
      `Product state does not retain Normal Flow ${flowId}'s immutable objective ID.`);
    const checks=Array.isArray(productFlow?.checks)?productFlow.checks:[];
    assert.ok(checks.length>0&&checks.every(check=>check.passed===true),`Normal Flow ${flowId} needs passing semantic assertion checks.`);
    const nativeExecution=(productFlow.references||[]).find(reference=>reference.kind==='execution'&&reference.id===runId);
    assert.ok(nativeExecution,
      `Normal Flow ${flowId} must expose its matching native execution reference.`);
    // Workflow learning describes the captured source Workflow. Native normal
    // validation executes an immutable snapshot of that source, and the
    // validation receipt is the only trustworthy bridge between the two. Do
    // not require learning to pretend it was produced for the later snapshot.
    const sourceWorkflowId=String(validation.content_json?.source_workflow_id||'');
    assert.ok(sourceWorkflowId,`Normal Flow ${flowId} validation has no source Workflow provenance.`);
    const learning=artifacts.find(artifact=>artifact.artifact_type==='business_workflow_learning'&&
      artifact.task_id===validation.task_id&&artifact.source_ref===sourceWorkflowId&&artifact.content_json?.flow_id===flowId&&
      artifact.content_json?.workflow_id===sourceWorkflowId);
    assert.ok(learning,`Normal Flow ${flowId} lacks matching business workflow learning evidence.`);
    const selection=learning.content_json||{};
    assert.equal(selection.selection_origin,'explicit_observed_event_ids',
      `Normal Flow ${flowId} was not compiled from an explicit model-owned event selection.`);
    assert.ok(nonemptyEventIds(selection.requested_event_ids),
      `Normal Flow ${flowId} has no nonempty requested capture-event selection.`);
    assert.ok(nonemptyEventIds(selection.effective_event_ids),
      `Normal Flow ${flowId} has no nonempty effective capture-event selection.`);
    assert.ok(selection.requested_event_ids.every(eventId=>selection.effective_event_ids.includes(eventId)),
      `Normal Flow ${flowId} effective capture-event selection omitted a requested event.`);
    if(requireHttps)assert.equal(selection.captured_transport_verified_https,true,
      `Normal Flow ${flowId} selection lacks certificate-verified HTTPS capture provenance.`);
    const selectionToolName=['bstg.business.workflow.prepare','bstg.business.workflow.revise'].includes(selection.selection_tool_name)
      ? selection.selection_tool_name : 'bstg.business.workflow.prepare';
    const accepted=decisions.filter(decision=>decision.task_id===validation.task_id&&decision.source==='ai_provider'&&
      decision.validation_status==='accepted'&&decision.model===provider.model&&
      decision.provider_reference===providerReference(provider.id)&&
      typeof decision.provider_response_id==='string'&&decision.provider_response_id.length>0);
    assert.ok(accepted.length>0,`Normal Flow ${flowId} has no accepted decision from the configured real model.`);
    const selectionDecisions=accepted.filter(decision=>decision.tool_name===selectionToolName&&
      sameEventIds(decision.selected_event_ids||[],selection.requested_event_ids));
    assert.ok(selectionDecisions.length>0,
      `Normal Flow ${flowId} has no accepted configured-model ${selectionToolName} decision matching its explicit capture-event selection.`);
    if(objectiveManifest.length){
      const definition=artifacts.find(artifact=>artifact.artifact_type==='business_flow'&&artifact.task_id!==validation.task_id&&
        String(artifact.content_json?.id||artifact.source_ref||'')===flowId&&artifact.content_json?.objective_id===flow.objective_id);
      assert.ok(definition,`Normal Flow ${flowId} lacks its immutable planning-objective definition receipt.`);
      const planningDecisions=decisions.filter(decision=>decision.task_id===definition.task_id&&decision.source==='ai_provider'&&
        decision.validation_status==='accepted'&&decision.model===provider.model&&decision.provider_reference===providerReference(provider.id)&&
        typeof decision.provider_response_id==='string'&&decision.provider_response_id.length>0&&
        decision.tool_name==='bstg.business.flow.define'&&decision.selected_objective_id===flow.objective_id);
      assert.ok(planningDecisions.length>0,
        `Normal Flow ${flowId} has no configured-model objective-selection decision matching its immutable objective ID.`);
    }
    evidence.push({flow_id:flowId,workflow_id:workflowId,normal_run_id:runId,validation_artifact_id:validation.id,
      workflow_learning_artifact_id:learning.id,selected_event_count:selection.effective_event_ids.length,
      accepted_model_decisions:accepted.length,accepted_selection_decisions:selectionDecisions.length});
  }
  return evidence;
}

export function assertBusinessLearningOracle({fixtureState,productState,technical,provider,requirePositive=false,requireHttps=false}){
  const {metrics}=fixtureState;
  for(const metric of ['logins','profile_updates','cart_additions','tickets_created','normal_orders','notes_created']){
    assert.ok(metrics[metric]>0,`The Agent must execute the normal business operation: ${metric}`);
  }
  assert.equal(fixtureState.unresolved_values,0,'Symbolic values cannot masquerade as executed requests');
  assert.ok(fixtureState.csrf_values.length>=3,'Normal actions must use actual changing state');
  if(requireHttps)assert.equal(fixtureState.transport,'https','The strict acceptance fixture must run over HTTPS.');
  const confirmed=Number(productState?.totals?.confirmed_risks||0);
  if(['secure','misleading-response'].includes(fixtureState.mode)){
    assert.equal(metrics.unauthorized_reads,0);assert.equal(metrics.unauthorized_updates,0);assert.equal(metrics.invalid_orders,0);
    assert.equal(confirmed,0,'A secure/misleading-success site must not produce a confirmed risk');
  }else if(requirePositive){
    const actualViolation=fixtureState.mode==='object-boundary'?metrics.unauthorized_reads+metrics.unauthorized_updates:metrics.invalid_orders;
    assert.ok(actualViolation>0,'A positive result requires an actual server-side boundary violation');
    assert.ok(confirmed>0,'A reproduced fault must be backed by a product finding');
  }
  const normalFlows=assertVerifiedNormalFlowEvidence({technical,productState,provider,requireHttps});
  return {normal_flows_verified:true,verified_normal_flows:normalFlows.length,normal_flow_evidence:normalFlows,
    transport_verified_https:requireHttps,confirmed_risks:confirmed,
    actual_violations:{reads:metrics.unauthorized_reads,writes:metrics.unauthorized_updates,orders:metrics.invalid_orders}};
}

export async function createBusinessLearningAcceptance({mode='secure',outputDirectory,api:existingAPI,provider:providedProvider,transport='https',
  postWriteReadbacks=false}={}){
  const provider=providedProvider||await loadAcceptanceProvider();
  assert.equal(provider?.model,REQUIRED_ACCEPTANCE_MODEL,'Business-learning real-model acceptance is pinned to gpt-5.6-terra.');
  if(existingAPI)throw Error('Real-model business-learning acceptance requires an isolated managed backend so a deadline cannot leave a shared scan worker running.');
  if(!['http','https'].includes(transport))throw Error('Business-learning acceptance transport must be http or https.');
  const out=path.resolve(outputDirectory||process.env.BSTG_BUSINESS_LEARNING_OUT||path.join(root,'artifacts',`business-learning-${mode}-${Date.now()}`));
  await mkdir(out,{recursive:true,mode:0o700});
  let tlsRuntime,fixture;
  try {
    tlsRuntime=transport==='https'?await startStrictTlsRuntime(out):undefined;
    fixture=await createBusinessLearningFixture({mode,postWriteReadbacks,...(tlsRuntime?{tls:tlsRuntime.fixtureTls}:{})});
  } catch(error) {
    await tlsRuntime?.close();
    throw error;
  }
  const report={started_at:new Date().toISOString(),mode,transport,scope:'Actual model, scoped normal-business Agent stage, BSTG backend/native execution, real Chromium, and independent fixture state',ok:false,observations:[]};
  let backend,logs='',browser,page,closed=false;
  const redact=value=>{
    let safe=redactWorkerCapability(String(value));
    const secrets=[provider.api_key,...Object.values(fixture.credentials||{}).flatMap(identity=>Object.values(identity||{})),
      ...(fixture.snapshot().csrf_values||[])].filter(item=>typeof item==='string'&&item.length>=4).sort((left,right)=>right.length-left.length);
    for(const secret of secrets)safe=safe.split(secret).join('[credential redacted]');
    return safe;
  };
  try{
    const api=existingAPI||`http://127.0.0.1:${await freePort()}`;
    if(!existingAPI){
      await buildManagedAcceptanceBackend(output=>logs+=output);
      backend=spawn(process.execPath,['scripts/start-server.mjs'],{cwd:root,env:{...process.env,...(tlsRuntime?.backendEnv||{}),PORT:new URL(api).port,
        BSTG_DATA_DIR:path.join(out,'data'),BSTG_BROWSER_MODE:process.env.BSTG_BUSINESS_BROWSER_MODE||'headless',BUILT_IN_FORGE_API_KEY:'',OPENAI_API_KEY:'',SERVE_FRONTEND:'true'},stdio:['ignore','pipe','pipe']});
      backend.stdout.on('data',chunk=>logs+=chunk);backend.stderr.on('data',chunk=>logs+=chunk);
      const until=Date.now()+45000;
      for(;;){
        if(backend.exitCode!==null)throw Error('Backend exited: '+redact(logs.slice(-2000)));
        try{if((await fetchWithDeadline(api+'/health',undefined,Math.min(until,Date.now()+2000),'Backend health check')).ok)break;}catch{}
        if(Date.now()>until)throw Error('Backend health timeout');await sleep(100);
      }
    }
    const {response:providerResponse,json:providerBody}=await fetchJsonWithDeadline(`${api}/api/ai/providers`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(provider)},Date.now()+30000,'Configure real-model provider');
    assert.equal(providerResponse.status,201,'Actual model provider must be configured before creating a scan');
    const providerId=providerBody.id;
    assert.ok(providerId,'Configured real-model provider must return its identity.');
    const configuredProvider={...provider,id:providerId};
    const preflightDeadline=Date.now()+PROVIDER_PREFLIGHT_TIMEOUT_MS;
    const {response:preflightResponse,json:preflightBody}=await fetchJsonWithDeadline(`${api}/api/ai/providers/${encodeURIComponent(providerId)}/test`,{method:'POST'},preflightDeadline,
      'Verify configured real-model provider',PROVIDER_PREFLIGHT_TIMEOUT_MS);
    assert.equal(preflightResponse.status,200,'The configured real-model provider preflight did not return successfully.');
    report.provider_preflight=assertProviderPreflightResult(preflightBody,configuredProvider.model);
    const {chromium}=require('playwright');browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1080}});
    const browserErrors=[];page.on('pageerror',error=>browserErrors.push(error.message));await page.goto(api+'?lang=zh',{waitUntil:'domcontentloaded'});
    const context={api,provider:configuredProvider,out,fixture,browser,page,report,browserErrors,redact,
      async createScan({userPrompt=DEFAULT_GOAL,scanConfig={},selectedVulnTypes=[],maxSteps=boundedAcceptanceMaxSteps()}={}){
        const requestedBusinessLearning=scanConfig.business_learning&&typeof scanConfig.business_learning==='object'?scanConfig.business_learning:{};
        const requestedBudgets=scanConfig.agent_task_budgets&&typeof scanConfig.agent_task_budgets==='object'?scanConfig.agent_task_budgets:{};
        const {response,json:body}=await fetchJsonWithDeadline(api+'/api/ai-scans?view=product',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          name:'Business learning real-model acceptance',base_url:fixture.baseUrl,user_prompt:userPrompt,language:'en',selected_vuln_types:selectedVulnTypes,
          scan_config:{surface:'web',driving_mode:'autopilot',authorization_acknowledged:true,account_mode:'manual',accounts:fixture.credentials,max_pages:12,request_evidence_required:true,
            ...scanConfig,auto_start:false,business_learning:{...requestedBusinessLearning,mode:'normal_only',require_verified_https:transport==='https',
              normal_objectives:Array.isArray(requestedBusinessLearning.normal_objectives)&&requestedBusinessLearning.normal_objectives.length
                ? requestedBusinessLearning.normal_objectives : DEFAULT_NORMAL_OBJECTIVES},
            agent_task_budgets:{default:20,discover_target:80,plan_business_flows:40,review_business_flows:30,learn_business_flow:80,...requestedBudgets}},
        })},Date.now()+30000,'Create real-model business-learning scan');
        assert.equal(response.status,201,'Create the scan through the actual product API: '+JSON.stringify(body.error||null));
        const run=body.data?.run||body.data;assert.ok(run?.id,'Created run must have an ID');report.run_id=run.id;
        const {response:started,json:startBody}=await fetchJsonWithDeadline(`${api}/api/ai-scans/${run.id}/run-async?view=product`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({max_steps:maxSteps})},
          Date.now()+30000,'Start real-model business-learning scan');
        assert.equal(started.status,202,'Start the normal-only scan through the managed product API: '+JSON.stringify(startBody.error||null));
        report.run_decision_limit=maxSteps;return run;
      },
      async waitForRun(runId,{timeoutMs=DEFAULT_ACCEPTANCE_TIMEOUT_MS,intervalMs=DEFAULT_PROGRESS_POLL_INTERVAL_MS,onObservation}={}){
        const until=Date.now()+timeoutMs;let state;
        while(Date.now()<until){
          const {response,json:stateBody}=await fetchJsonWithProgressRetry(`${api}/api/ai-scans/${runId}/product-state`,undefined,until,'Read business-learning product state');assert.equal(response.status,200);state=stateBody.data;
          assertNormalOnlyRunProgress(state);
          const {response:technicalResponse,json:technicalBody}=await fetchJsonWithProgressRetry(`${api}/api/ai-scans/${runId}`,undefined,until,'Read business-learning technical progress');assert.equal(technicalResponse.status,200);
          const technical=technicalBody.data;
          const observation=safeProgressObservation({state,technical,fixtureState:fixture.snapshot()});
          const last=report.observations.at(-1);if(!last||JSON.stringify({...last,at:undefined})!==JSON.stringify({...observation,at:undefined}))report.observations.push(observation);
          if(onObservation)await onObservation({state,technical,fixture,context});
          if(['completed','failed','cancelled'].includes(state.run.status))return state;
          await sleep(Math.max(0,Math.min(intervalMs,until-Date.now())));
        }
        throw Error(`Real-model business-learning run did not reach a terminal status within ${timeoutMs}ms (last: ${state?.run?.status})`);
      },
      async collect(runId){
        const deadline=Date.now()+30000;
        const {response:technicalResponse,json:technicalBody}=await fetchJsonWithProgressRetry(`${api}/api/ai-scans/${runId}`,undefined,deadline,'Collect business-learning technical state');assert.equal(technicalResponse.status,200);const technical=technicalBody.data;
        const {response:stateResponse,json:stateBody}=await fetchJsonWithProgressRetry(`${api}/api/ai-scans/${runId}/product-state`,undefined,deadline,'Collect business-learning product state');assert.equal(stateResponse.status,200);const productState=stateBody.data;
        const fixtureState=fixture.snapshot(),safeFixtureState=safeFixtureStateForReport(fixtureState);
        await writeFile(path.join(out,'technical-state.json'),JSON.stringify(technical,null,2),{mode:0o600});
        await writeFile(path.join(out,'product-state.json'),JSON.stringify(productState,null,2),{mode:0o600});
        await writeFile(path.join(out,'fixture-state.json'),JSON.stringify(safeFixtureState,null,2),{mode:0o600});
        await page.screenshot({path:path.join(out,'workspace.png'),fullPage:true}).catch(()=>{});
        report.model_evidence=verifyModelDecisions(technical,provider);report.metrics=safeFixtureState.metrics;report.target_requests=safeFixtureState.request_count;
        return {technical,productState,fixtureState};
      },
      async close(error){
        if(closed)return;closed=true;if(error){report.error=redact(error.stack||error);report.ok=false;await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}
        await browser?.close();
        if(backend){backend.kill('SIGTERM');await Promise.race([once(backend,'exit'),sleep(5000)]);if(backend.exitCode===null){backend.kill('SIGKILL');await Promise.race([once(backend,'exit'),sleep(1000)]);}}
        // The isolated backend database includes the temporary provider
        // credential supplied to this real-model run. Preserve only the safe
        // report/state projections and remove that execution-only store.
        await rm(path.join(out,'data'),{recursive:true,force:true});
        await tlsRuntime?.close();await fixture?.close();report.completed_at=new Date().toISOString();await writeFile(path.join(out,'backend.log'),redact(logs),{mode:0o600});await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2),{mode:0o600});
      },
    };
    return context;
  }catch(error){
    await browser?.close();if(backend)backend.kill('SIGKILL');await rm(path.join(out,'data'),{recursive:true,force:true});await tlsRuntime?.close();await fixture?.close();const safeError=redact(error.stack||error);report.error=safeError;report.completed_at=new Date().toISOString();await writeFile(path.join(out,'backend.log'),redact(logs),{mode:0o600});await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2),{mode:0o600});throw Error(safeError);
  }
}

export async function runBusinessLearningAcceptance(options={}){
  const context=await createBusinessLearningAcceptance(options);
  try{
    const run=options.createRun?await options.createRun(context):await context.createScan(options);
    await context.waitForRun(run.id,options);const result=await context.collect(run.id);
    assert.equal(result.productState.run.status,'completed','Acceptance requires a completed product run');
    const verify=options.verify||assertBusinessLearningOracle;
    context.report.verification=await verify({...result,context,provider:context.provider,requirePositive:options.requirePositive===true,
      requireHttps:context.report.transport==='https'});
    assert.deepEqual(context.browserErrors,[]);context.report.ok=true;await context.close();return {report:context.report,out:context.out,...result};
  }catch(error){await context.close(error);throw Error(context.redact(error.stack||error));}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await runBusinessLearningAcceptance({mode:process.env.BSTG_BUSINESS_FIXTURE_MODE||'secure',transport:process.env.BSTG_BUSINESS_ACCEPTANCE_TRANSPORT||'https',requirePositive:process.env.BSTG_BUSINESS_REQUIRE_POSITIVE==='1',
    timeoutMs:Number(process.env.BSTG_BUSINESS_ACCEPTANCE_TIMEOUT_MS||DEFAULT_ACCEPTANCE_TIMEOUT_MS),scanConfig:JSON.parse(process.env.BSTG_BUSINESS_SCAN_CONFIG||'{}')});console.log(JSON.stringify({ok:true,output:result.out,model_evidence:result.report.model_evidence,verification:result.report.verification},null,2));}
  catch(error){console.error(error.stack||error);process.exitCode=1;}
}
