// Native model-plan compilation/execution integration. It intentionally uses
// a local authorized HTTP fixture and direct plan objects; the separate
// browser capture suite proves the normal-flow recorder. This suite proves a
// model's selected field change survives compilation and that a rejected
// change cannot become a confirmed finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { SqliteProvider } from '../../server/src/db/sqlite-provider.ts';
import { dbManager } from '../../server/src/db/db-manager.ts';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { executeWorkflowRun } from '../../server/src/services/workflow-runner.ts';
import { getTraceByRunId } from '../../server/src/services/debug-trace.ts';
import { newBusinessFlow, saveBusinessFlow, getBusinessFlow } from '../../server/src/services/ai-scan/agent-business-contract.ts';
import { createBusinessObjectHandles, listBusinessObjectHandles, publicBusinessObjectHandle, resolveBusinessObjectHandle } from '../../server/src/services/ai-scan/business-object-handles.ts';
import { assessBusinessExperiment, compileBusinessExperiment, executeBusinessExperiment, planBusinessExperiment } from '../../server/src/services/ai-scan/agent-business-experiment.ts';

const sha = value => createHash('sha256').update(String(value ?? '')).digest('hex');

async function target(mode) {
  let serial = 0;
  let latest = null;
  let appliedCount = 0;
  const tickets = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const json = body ? JSON.parse(body) : {};
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/seed') {
      const ticket = `ticket-${++serial}-${randomUUID()}`;
      tickets.add(ticket);
      return send(200, { ticket, issued: serial, actor: String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || 'anonymous' });
    }
    if (url.pathname === '/apply') {
      const validTicket = mode === 'concurrent' ? tickets.has(json.ticket) : tickets.delete(json.ticket);
      if (!validTicket) return send(409, { accepted: false, reason: 'stale_ticket' });
      if (mode === 'secure' && Number(json.amount) <= 0) return send(422, { accepted: false, reason: 'amount_rejected' });
      latest = { amount: Number(json.amount), order: `order-${serial}` };
      appliedCount += 1;
      return send(200, { accepted: true, ...latest, applied_count: appliedCount });
    }
    if (url.pathname === '/state') return send(200, { orders: latest ? [latest] : [], applied_count: appliedCount });
    send(404, { error: 'unknown route' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, latest: () => latest,
    appliedCount: () => appliedCount,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

async function bolaTarget(mode='vulnerable') {
  const object={id:'victim-object',owner_id:'victim',amount:1};
  const received=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture.invalid'),chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks).toString();
    const data=body?JSON.parse(body):{};
    const actor=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'')||'anonymous';
    received.push({path:url.pathname,method:req.method,actor,cookie:String(req.headers.cookie||'')});
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(url.pathname==='/objects/current')return send(200,{object:{...object},actor,access_token:'fixture-secret-not-a-model-handle',accessToken:'fixture-camel-access',refreshToken:'fixture-camel-refresh',idToken:'fixture-camel-id'});
    if(url.pathname===`/objects/${object.id}`&&req.method==='GET')return send(200,{object:{...object},actor});
    if(url.pathname===`/objects/${object.id}`&&req.method==='PATCH'){
      if(actor!=='victim'&&mode==='secure')return send(403,{accepted:false,reason:'owner_required',object:{...object},actor});
      if(actor!=='victim'&&mode==='misleading')return send(200,{accepted:true,notice:'queued',object:{...object},actor});
      object.amount=Number(data.amount);return send(200,{accepted:true,object:{...object},actor});
    }
    return send(404,{error:'unknown'});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {baseUrl:`http://127.0.0.1:${server.address().port}`,state:()=>({...object}),requests:()=>received.map(item=>({...item})),close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}

function raw(method, path, body, headers={}) {
  return [`${method} ${path} HTTP/1.1`, 'Content-Type: application/json', ...Object.entries(headers).map(([name,value])=>`${name}: ${value}`), '', body || ''].join('\r\n');
}

async function setup(t, mode) {
  const service = await target(mode);
  const db = new SqliteProvider(`model-experiment-${mode}`, { file: ':memory:' });
  await db.connect(); await db.migrate();
  const previous = dbManager.getActive; dbManager.getActive = () => db;
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({ base_url: service.baseUrl, name: 'Model plan native fixture' });
  const task = await repo.createTask({ scan_run_id: run.id, title: 'Native model experiment', task_type: 'model_business_experiment', execution_plan:{intent:'model_business_experiment',flow_id:'pending'} });
  const workflow = await db.repos.workflows.create({ name: 'Observed purchase normal flow', is_active: true, assertion_strategy: 'all_steps_pass',
    account_binding_strategy: 'anchor_attacker', enable_baseline: false, baseline_config: { capture_replay_only: true }, enable_extractor: false,
    enable_session_jar: false, session_jar_config: { cookie_mode: true }, workflow_type: 'baseline', learning_status: 'learned',
    learning_version: 1, template_mode: 'snapshot' });
  const templates = [];
  for (const [name, request] of [
    ['issue fresh ticket', raw('GET', '/seed')],
    ['apply normal purchase', raw('POST', '/apply', JSON.stringify({ ticket: 'captured-ticket', amount: 1 }))],
    ['read authoritative state', raw('GET', '/state')],
  ]) {
    templates.push(await db.repos.apiTemplates.create({ name, raw_request: request, parsed_structure: {}, variables: [], failure_patterns: [], failure_logic: 'OR', is_active: true }));
  }
  const steps = [];
  for (const [index, template] of templates.entries()) {
    steps.push(await db.repos.workflowSteps.create({ workflow_id: workflow.id, api_template_id: template.id, step_order: index + 1,
      request_snapshot_raw: template.raw_request, snapshot_template_id: template.id, snapshot_template_name: template.name, snapshot_created_at: new Date().toISOString(),
      step_assertions: [], assertions_mode: 'all', failure_patterns_override: [] }));
  }
  await db.runRawQuery(`INSERT INTO workflow_variables (id, workflow_id, name, type, source, write_policy, is_locked, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), workflow.id, 'fresh_ticket', 'FLOW_TICKET', 'extracted', 'overwrite', 0, 'Observed normal ticket dependency']);
  await db.runRawQuery(`INSERT INTO workflow_mappings (id, workflow_id, from_step_order, from_location, from_path, to_step_order, to_location, to_path, variable_name, confidence, reason, is_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), workflow.id, 1, 'response.body', 'ticket', 2, 'request.body', 'ticket', 'fresh_ticket', 1, 'manual', 1]);
  const environment = await db.repos.environments.create({ name: 'Native experiment fixture', base_url: service.baseUrl, is_active: true });
  const normalRun = await db.repos.testRuns.create({ name: 'Actual normal baseline', status: 'pending', execution_type: 'workflow', trigger_type: 'fixture', workflow_id: workflow.id,
    account_ids: [], environment_id: environment.id, rule_ids: [], progress_percent: 0 });
  const normal = await executeWorkflowRun({ test_run_id: normalRun.id, workflow_id: workflow.id, environment_id: environment.id, evidence_only: true });
  assert.equal(normal.success, true, normal.error);
  assert.equal(service.latest()?.amount, 1, 'A real normal native run must establish the baseline state first');
  const flow = newBusinessFlow({ name: 'Purchase a permitted quantity', goal: 'A normal order has amount one in authoritative state', role: 'anonymous' }, task.id);
  Object.assign(flow, { status: 'verified', workflow_id: workflow.id, normal_run_id: normalRun.id, assertions_verified: true, evidence_artifact_ids: ['normal-fixture-proof'] });
  await saveBusinessFlow(repo, run.id, task.id, flow);
  await repo.updateTask(task.id,{execution_plan:{intent:'model_business_experiment',flow_id:flow.id}});
  t.after(async () => { dbManager.getActive = previous; await db.disconnect(); await service.close(); });
  return { service, db, repo, run, task, workflow, steps, flow, environment, context: { db, repo, scanRunId: run.id, taskId: task.id } };
}

async function setupBola(t,mode='vulnerable'){
  const service=await bolaTarget(mode),db=new SqliteProvider(`model-bola-${mode}`,{file:':memory:'});
  await db.connect();await db.migrate();const previous=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:service.baseUrl,name:'Cross-account native proof fixture'});
  const task=await repo.createTask({scan_run_id:run.id,title:'Cross-account object experiment',task_type:'model_business_experiment',execution_plan:{intent:'model_business_experiment',flow_id:'pending'}});
  const [victim,attacker]=await Promise.all([
    db.repos.accounts.create({name:'Victim',username:'victim',status:'active',tags:['ai_scan',`scan:${run.id}`,'role:victim'],fields:{token:'victim'},variables:{},auth_profile:{headers:{Authorization:'Bearer victim'},cookies:{sid:'victim'},identity_probe:{source_step_order:1,subject_path:'body.actor',expected_subject:'victim'}}}),
    db.repos.accounts.create({name:'Attacker',username:'attacker',status:'active',tags:['ai_scan',`scan:${run.id}`,'role:attacker'],fields:{token:'attacker'},variables:{},auth_profile:{headers:{Authorization:'Bearer attacker'},cookies:{sid:'attacker'},identity_probe:{source_step_order:1,subject_path:'body.actor',expected_subject:'attacker'}}}),
  ]);
  const workflow=await db.repos.workflows.create({name:'Victim normal object flow',is_active:true,assertion_strategy:'all_steps_pass',account_binding_strategy:'anchor_attacker',attacker_account_id:victim.id,
    enable_baseline:false,baseline_config:{capture_replay_only:true},enable_extractor:false,enable_session_jar:false,session_jar_config:{cookie_mode:true},workflow_type:'baseline',learning_status:'learned',learning_version:1,template_mode:'snapshot'});
  const templates=[];
  for(const [name,request] of [
    ['victim object baseline',raw('GET','/objects/current',undefined,{Authorization:'Bearer captured-victim',Cookie:'sid=captured-victim'})],
    ['victim object write',raw('PATCH','/objects/victim-object',JSON.stringify({amount:1}),{Authorization:'Bearer captured-victim',Cookie:'sid=captured-victim'})],
    ['victim object readback',raw('GET','/objects/victim-object',undefined,{Authorization:'Bearer captured-victim',Cookie:'sid=captured-victim'})],
  ])templates.push(await db.repos.apiTemplates.create({name,raw_request:request,parsed_structure:{},variables:[],failure_patterns:[],failure_logic:'OR',is_active:true}));
  const steps=[];
  for(const [index,template] of templates.entries())steps.push(await db.repos.workflowSteps.create({workflow_id:workflow.id,api_template_id:template.id,step_order:index+1,
    request_snapshot_raw:template.raw_request,snapshot_template_id:template.id,snapshot_template_name:template.name,snapshot_created_at:new Date().toISOString(),step_assertions:[],assertions_mode:'all',failure_patterns_override:[]}));
  const environment=await db.repos.environments.create({name:'BOLA proof fixture',base_url:service.baseUrl,is_active:true});
  const normalRun=await db.repos.testRuns.create({name:'Victim verified normal flow',status:'pending',execution_type:'workflow',trigger_type:'fixture',workflow_id:workflow.id,
    account_ids:[victim.id],environment_id:environment.id,rule_ids:[],progress_percent:0});
  const normal=await executeWorkflowRun({test_run_id:normalRun.id,workflow_id:workflow.id,account_ids:[victim.id],environment_id:environment.id,evidence_only:true});
  assert.equal(normal.success,true,normal.error);const normalTrace=getTraceByRunId('workflow',normalRun.id);
  const flow=newBusinessFlow({name:'Victim object read and update',goal:'Victim can read the object and preserve its allowed amount',role:'victim'},task.id);
  const traceArtifact=await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'business_native_trace',source_ref:normalRun.id,title:'Victim normal trace',content_json:{flow_id:flow.id,test_run_id:normalRun.id,workflow_id:workflow.id,trace:normalTrace,private:true}});
  const validationArtifact=await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'business_workflow_validation',source_ref:normalRun.id,title:'Victim normal validation',content_json:{flow_id:flow.id,test_run_id:normalRun.id,workflow_id:workflow.id,assertions_verified:true}});
  const verifiedFlow={...flow,status:'verified',workflow_id:workflow.id,normal_run_id:normalRun.id,assertions_verified:true,evidence_artifact_ids:[traceArtifact.id,validationArtifact.id]};
  const savedBaseline=(await saveBusinessFlow(repo,run.id,task.id,verifiedFlow)).content_json;
  const handlesArtifact=await createBusinessObjectHandles({repo,scanRunId:run.id,taskId:task.id,flow:savedBaseline,normalRunId:normalRun.id,normalWorkflowId:workflow.id,
    traceArtifactId:traceArtifact.id,trace:normalTrace,ownerRole:'victim',flowRevision:Number(savedBaseline.revision)+1,ownerAccountId:victim.id,ownerSubjectHash:sha('victim')});
  await saveBusinessFlow(repo,run.id,task.id,{...savedBaseline,evidence_artifact_ids:[...savedBaseline.evidence_artifact_ids,...(handlesArtifact?[handlesArtifact.id]:[])]});
  await repo.updateTask(task.id,{execution_plan:{intent:'model_business_experiment',flow_id:flow.id}});
  t.after(async()=>{dbManager.getActive=previous;await db.disconnect();await service.close();});
  return {service,db,repo,run,task,workflow,steps,flow:await getBusinessFlow(repo,run.id,flow.id),victim,attacker,context:{db,repo,scanRunId:run.id,taskId:task.id}};
}

async function bolaPlanInput(fixture){
  const handles=await listBusinessObjectHandles(fixture.repo,fixture.run.id,fixture.flow.id);
  const objectHandle=handles.find(handle=>handle.producer_step_order===1&&handle.response_path==='body.object.id');
  assert.ok(objectHandle,'verified normal response must create an opaque object ID handle');
  const input={flow_id:fixture.flow.id,name:'Attacker writes victim object through opaque handle',category:'bola_write',
    hypothesis:'An attacker may use the victim-owned object handle to change the victim object.',
    rationale:'Use the verified victim baseline as the control, swap only the write/read steps to attacker, and require a post-write authoritative readback.',control_role:'victim',
    steps:[{id:fixture.steps[0].id,source_step_order:1,role:'victim'},{id:fixture.steps[1].id,source_step_order:2,role:'attacker'},{id:fixture.steps[2].id,source_step_order:3,role:'attacker'}],
    patches:[{step_id:fixture.steps[1].id,location:'path',operation:'set',path:'segment.2',value_ref:{handle_id:objectHandle.id}},
      {step_id:fixture.steps[2].id,location:'path',operation:'set',path:'segment.2',value_ref:{handle_id:objectHandle.id}},
      {step_id:fixture.steps[1].id,location:'json_body',operation:'set',path:'amount',value:0}],
    assertions:[{id:'attacker-impact',step_order:3,description:'Attacker readback reports the impermissible victim-object change',purpose:'impact',left:{type:'response',path:'body.object.amount'},op:'equals',right:{type:'literal',value:'0'}},
      {id:'attacker-object-identity',step_order:3,description:'Attacker readback names the same opaque victim object selector',purpose:'state',left:{type:'response',path:'body.object.id'},op:'equals',right:{type:'value_ref',handle_id:objectHandle.id}},
      {id:'attacker-subject',step_order:3,description:'Readback is executed under the attacker subject',purpose:'identity',left:{type:'response',path:'body.actor'},op:'equals',right:{type:'literal',value:'attacker'}}],
    control_assertions:[{id:'victim-control',step_order:3,description:'Victim control retains the allowed amount',purpose:'control',left:{type:'response',path:'body.object.amount'},op:'equals',right:{type:'literal',value:'1'}},
      {id:'victim-object-identity',step_order:3,description:'Victim control reads the same opaque object selector',purpose:'state',left:{type:'response',path:'body.object.id'},op:'equals',right:{type:'value_ref',handle_id:objectHandle.id}},
      {id:'victim-subject',step_order:3,description:'Control readback is executed under the owner subject',purpose:'identity',left:{type:'response',path:'body.actor'},op:'equals',right:{type:'literal',value:'victim'}}],
  };
  return {input,objectHandle};
}

function planInput(fixture, amount = 0) {
  return {
    flow_id: fixture.flow.id, name: 'Change observed purchase amount', category: 'model_chosen_business_experiment',
    hypothesis: 'Changing the observed amount field to zero may create an impermissible order.',
    rationale: 'The normal workflow records a server-issued ticket and an authoritative state read; test the selected field while retaining the dynamic ticket binding.',
    steps: fixture.steps.map(step => ({ id: step.id, source_step_order: step.step_order, role: 'normal' })),
    patches: [{ step_id: fixture.steps[1].id, location: 'json_body', operation: 'set', path: 'amount', value: amount }],
    bindings: [{ from_step_id: fixture.steps[0].id, from_location: 'response.body', from_path: 'ticket', to_step_id: fixture.steps[1].id,
      to_location: 'json_body', to_path: 'ticket', variable_name: 'fresh_ticket' }],
    assertions: [{ id: 'impact', step_order: 3, description: 'Authoritative state exposes the changed amount', purpose: 'impact',
      left: { type: 'response', path: 'body.orders.0.amount' }, op: 'equals', right: { type: 'literal', value: String(amount) } }],
    control_assertions: [{ id: 'control', step_order: 3, description: 'Fresh control keeps normal amount', purpose: 'control',
      left: { type: 'response', path: 'body.orders.0.amount' }, op: 'equals', right: { type: 'literal', value: '1' } }],
  };
}

test('normal business evidence replays fresh dependencies without strict capture equality or automatic findings', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  // The observed source is intentionally strict and contains a stale dynamic
  // response assertion. The normal adapter must use a fresh dependency and
  // evaluate its own selected semantic checks after native execution.
  await f.db.repos.workflows.update(f.workflow.id, {
    assertion_strategy: 'any_step_pass',
    baseline_config: { capture_replay_only: true, exact_captured_baseline: true, agent_business_normal_validation: true },
  });
  await f.db.repos.workflowSteps.update(f.steps[0].id, {
    step_assertions: [{
      left: { type: 'response', path: 'body.ticket' }, op: 'equals',
      right: { type: 'literal', value: 'prior-capture-placeholder' }, missing_behavior: 'fail',
    }],
    assertions_mode: 'all',
  });

  const strictRun = await f.db.repos.testRuns.create({
    name: 'Strict capture comparison', status: 'pending', execution_type: 'workflow', trigger_type: 'fixture',
    workflow_id: f.workflow.id, account_ids: [], environment_id: f.environment.id, rule_ids: [], progress_percent: 0,
  });
  const strict = await executeWorkflowRun({
    test_run_id: strictRun.id, workflow_id: f.workflow.id, environment_id: f.environment.id, evidence_only: true,
  });
  assert.equal(strict.success, false, 'The fixture must prove the literal capture-replay branch is active.');
  assert.match(String(strict.error), /Captured request replay did not satisfy every recorded response assertion/);

  const writesBeforeNormalEvidence = f.service.appliedCount();
  const normalRun = await f.db.repos.testRuns.create({
    name: 'Fresh normal business evidence', status: 'pending', execution_type: 'workflow', trigger_type: 'fixture',
    workflow_id: f.workflow.id, account_ids: [], environment_id: f.environment.id, rule_ids: [], progress_percent: 0,
    execution_params: { business_normal_run: true },
  });
  const normal = await executeWorkflowRun({
    test_run_id: normalRun.id, workflow_id: f.workflow.id, environment_id: f.environment.id,
    evidence_only: true, normal_business_evidence: true,
  });
  assert.equal(normal.success, true, normal.error);
  assert.equal(normal.errors_count, 0);
  assert.equal(normal.has_execution_error, false);
  assert.ok(normal.normal_business_assertion_results?.some(result => result.step_order === 1 && result.passed === false),
    'The stale capture assertion is reported as a value-free semantic result, not an execution failure.');
  assert.equal(f.service.appliedCount(), writesBeforeNormalEvidence + 1,
    'A fresh native run must apply the server-issued dependency rather than the captured request value.');
  assert.equal(normal.findings_count, 0);
  assert.equal((await f.db.repos.findings.findAll()).length, 0,
    'Normal evidence must not create an automatic finding even when ordinary workflow assertions would classify a result.');
  const persisted = await f.db.repos.testRuns.findById(normalRun.id);
  assert.equal(persisted?.progress?.evidence_mode, 'normal_business_evidence');
});

test('model-selected request patch is compiled, dynamically rebound, executed and evidence-gated', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  const planned = await planBusinessExperiment(f.context, planInput(f));
  assert.equal(planned.request_patch_count, 1);
  const compiled = await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(compiled.status, 'compiled');
  assert.equal(compiled.native_assets.request_patch_count, 1);
  const artifacts = await f.repo.listArtifacts(f.run.id);
  const compilation = artifacts.find(item => item.artifact_type === 'agent_experiment_compilation');
  const mutation = await f.db.repos.workflows.findById(compilation.content_json.experiment_workflow_id);
  const base = await f.db.repos.workflows.findById(mutation.base_workflow_id);
  const patched = (await f.db.repos.workflowSteps.findAll({ where: { workflow_id: base.id } })).find(step => step.step_order === 2);
  assert.match(patched.request_snapshot_raw, /"amount":0/, 'The immutable native snapshot contains the exact model-selected mutation');
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(executed.status, 'executed');
  assert.equal(executed.execution_verified, true, JSON.stringify(executed));
  assert.equal(executed.control_verified, true, JSON.stringify(executed));
  assert.equal(executed.evidence_ready, true, JSON.stringify(executed));
  assert.equal(f.service.latest()?.amount, 0, 'The actual HTTP target received and stored the model-selected value');
  const assessment = await assessBusinessExperiment(f.context, { plan_id: planned.plan_id, result_revision: executed.result_revision, verdict: 'vulnerable',
    title: 'Model-selected amount invariant break', severity: 'high', reason: 'The exact changed request produced the asserted authoritative state after a successful normal control.',
    business_impact: 'The target accepted an order amount outside the normal invariant.' });
  assert.equal(assessment.confirmed, true, JSON.stringify(assessment));
  const judgement = (await f.repo.listArtifacts(f.run.id)).find(item => item.artifact_type === 'ai_judgement');
  assert.equal(judgement.content_json.verdict, 'vulnerable');
  assert.equal(judgement.content_json.native_evidence_gate.verdict, 'confirmed');
  assert.equal((await f.db.repos.findings.findAll()).length, 0, 'Evidence-only model experiments do not create a speculative native finding');
});

test('opaque victim object handle drives a real cross-account write proof without exposing its raw value', { timeout: 60000 }, async t => {
  const f=await setupBola(t,'vulnerable');const {input,objectHandle}=await bolaPlanInput(f);
  const allHandles=await listBusinessObjectHandles(f.repo,f.run.id,f.flow.id);
  assert.equal(allHandles.some(handle=>/token/i.test(handle.response_path)),false,'Credentials and transient auth material cannot become opaque model handles');
  const publicHandle=publicBusinessObjectHandle(objectHandle);
  assert.equal(JSON.stringify(publicHandle).includes('victim-object'),false,'Model-facing handle metadata never contains the object value');
  const planned=await planBusinessExperiment(f.context,input);const compiled=await compileBusinessExperiment(f.context,{plan_id:planned.plan_id});
  assert.equal(compiled.native_assets.object_handle_count,1);
  const artifacts=await f.repo.listArtifacts(f.run.id);
  const compilation=artifacts.find(item=>item.artifact_type==='agent_experiment_compilation');
  assert.equal(JSON.stringify(compilation.content_json).includes('victim-object'),false,'Private compilation provenance records the handle, not its raw object value');
  const mutation=await f.db.repos.workflows.findById(compilation.content_json.experiment_workflow_id);
  const experimentBase=await f.db.repos.workflows.findById(mutation.base_workflow_id);
  const compiledWrite=(await f.db.repos.workflowSteps.findAll({where:{workflow_id:experimentBase.id}})).find(step=>step.step_order===2);
  assert.match(compiledWrite.request_snapshot_raw,/__BSTG_OBJECT_HANDLE_[0-9a-f-]+__/i,'Persisted mutation snapshots retain only an opaque selector placeholder');
  assert.equal(compiledWrite.request_snapshot_raw.includes('victim-object'),false,'The normal-flow object scalar is resolved only immediately before dispatch');
  const executed=await executeBusinessExperiment(f.context,{plan_id:planned.plan_id});
  assert.equal(executed.execution_verified,true,JSON.stringify(executed));
  assert.equal(executed.business_proof.authentication.verified,true,JSON.stringify(executed.business_proof));
  assert.equal(executed.business_proof.object_authorization.verified,true,JSON.stringify(executed.business_proof));
  assert.equal(executed.business_proof.write_postcondition.verified,true,JSON.stringify(executed.business_proof));
  assert.equal(executed.evidence_ready,true,JSON.stringify(executed));
  assert.deepEqual(f.service.state(),{id:'victim-object',owner_id:'victim',amount:0},'Attacker native request changed the victim-owned object and read it back');
  const attackerWrite=f.service.requests().find(request=>request.path==='/objects/victim-object'&&request.method==='PATCH'&&request.actor==='attacker');
  assert.ok(attackerWrite,'The actual write must carry the selected attacker identity, not the captured victim header');
  assert.match(attackerWrite.cookie,/sid=attacker/,'The selected auth_profile cookie replaces the captured browser cookie');
  assert.equal(attackerWrite.cookie.includes('captured-victim'),false,'A captured source cookie cannot survive a cross-account overlay');
  const assessment=await assessBusinessExperiment(f.context,{plan_id:planned.plan_id,verdict:'vulnerable',title:'Cross-account victim object write',severity:'high',
    reason:'A victim control and attacker readback proved the owner object changed through the opaque handle.',business_impact:'An attacker can change a victim-owned object.'});
  assert.equal(assessment.confirmed,true,JSON.stringify(assessment));
});

test('opaque object handles resolve the matching verified response when a native step repeats', { timeout: 60000 }, async t => {
  const f=await setupBola(t,'vulnerable');
  const repeatedTrace={records:[
    {meta:{step_order:1},response:{body:JSON.stringify({object:{id:'first-object'}})}},
    {meta:{step_order:1},response:{body:JSON.stringify({object:{id:'second-object'}})}},
  ]};
  const traceArtifact=await f.repo.createArtifact({scan_run_id:f.run.id,task_id:f.task.id,artifact_type:'business_native_trace',source_ref:f.flow.normal_run_id,
    title:'Repeated private native trace',content_json:{flow_id:f.flow.id,test_run_id:f.flow.normal_run_id,workflow_id:f.workflow.id,trace:repeatedTrace,private:true}});
  const catalog=await createBusinessObjectHandles({repo:f.repo,scanRunId:f.run.id,taskId:f.task.id,flow:f.flow,normalRunId:f.flow.normal_run_id,
    normalWorkflowId:f.workflow.id,traceArtifactId:traceArtifact.id,trace:repeatedTrace,ownerRole:'victim'});
  const ids=(catalog?.content_json?.handles||[]).filter(handle=>handle.response_path==='body.object.id');
  assert.equal(ids.length,2);
  const resolved=await resolveBusinessObjectHandle(f.repo,f.run.id,ids[1].id);
  assert.equal(resolved.value,'second-object');
});

test('camelCase credential fields and handles from an older verified flow revision cannot be used as object selectors', { timeout: 60000 }, async t => {
  const f=await setupBola(t,'vulnerable');
  const handles=await listBusinessObjectHandles(f.repo,f.run.id,f.flow.id);
  assert.equal(handles.some(handle=>/token/i.test(handle.response_path)),false,'CamelCase access, refresh, and ID tokens are never turned into model-selectable handles');
  const objectHandle=handles.find(handle=>handle.response_path==='body.object.id');
  assert.ok(objectHandle);
  await assert.rejects(resolveBusinessObjectHandle(f.repo,f.run.id,objectHandle.id,{flow_id:f.flow.id,flow_revision:f.flow.revision+1,normal_run_id:f.flow.normal_run_id,normal_workflow_id:f.flow.workflow_id}),/outdated or different verified business baseline/);
});

test('correct rejection and misleading 200 responses cannot satisfy cross-account object proof', { timeout: 60000 }, async t => {
  for(const mode of ['secure','misleading']){
    const f=await setupBola(t,mode);const {input}=await bolaPlanInput(f);const planned=await planBusinessExperiment(f.context,input);
    await compileBusinessExperiment(f.context,{plan_id:planned.plan_id});const executed=await executeBusinessExperiment(f.context,{plan_id:planned.plan_id});
    assert.equal(executed.status,'executed',`${mode}: a semantic rejection is still a completed native observation`);
    assert.equal(executed.evidence_ready,false,`${mode}: transport success cannot replace business proof`);
    assert.equal(executed.business_proof.object_authorization.required,true,`${mode}: an opaque victim object reference must require object proof`);
    assert.equal(executed.business_proof.object_authorization.verified,false,`${mode}: no cross-account state proof`);
    const assessment=await assessBusinessExperiment(f.context,{plan_id:planned.plan_id,verdict:'vulnerable',title:`${mode} object protection`,severity:'info',
      reason:'The target did not produce the asserted cross-account postcondition.',business_impact:'No confirmed unauthorized object state change.'});
    assert.equal(assessment.verdict,'inconclusive',`${mode}: model request cannot override proof gate`);
    assert.deepEqual(f.service.state(),{id:'victim-object',owner_id:'victim',amount:1});
  }
});

test('a rejected mutation remains inconclusive until a server-owned negative proof exists', { timeout: 60000 }, async t => {
  const f = await setup(t, 'secure');
  const planned = await planBusinessExperiment(f.context, planInput(f));
  await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(executed.status, 'executed', JSON.stringify(executed));
  assert.equal(executed.control_verified, true, JSON.stringify(executed));
  assert.equal(executed.execution_verified, false, JSON.stringify(executed));
  assert.equal(executed.evidence_ready, false, JSON.stringify(executed));
  const assessment = await assessBusinessExperiment(f.context, { plan_id: planned.plan_id, verdict: 'vulnerable', title: 'Unproven amount issue', severity: 'high',
    reason: 'The model hypothesis was tested but the target rejection did not meet the impact assertion.', business_impact: 'No confirmed impact because the target rejected the changed value.' });
  assert.equal(assessment.confirmed, false);
  assert.equal(assessment.verdict, 'inconclusive');
  const judgement = (await f.repo.listArtifacts(f.run.id)).find(item => item.artifact_type === 'ai_judgement');
  assert.equal(judgement.content_json.verdict, 'inconclusive');
  assert.equal(judgement.content_json.native_evidence_gate.verdict, 'insufficient');
  const counterexample = await assessBusinessExperiment(f.context, { plan_id: planned.plan_id, verdict: 'not_vulnerable', title: 'Observed amount rejection', severity: 'info',
    reason: 'The normal control completed, while the same bounded mutation completed and was rejected by the target.',
    business_impact: 'The observed mutation did not create the asserted impermissible order.' });
  assert.equal(counterexample.verdict, 'inconclusive', JSON.stringify(counterexample));
  assert.equal(counterexample.counterexample_verified, false, JSON.stringify(counterexample));
  const counterexampleJudgement = (await f.repo.listArtifacts(f.run.id)).filter(item => item.artifact_type === 'ai_judgement').at(-1);
  assert.equal(counterexampleJudgement.content_json.native_evidence_gate.verdict, 'insufficient');
});

test('a model cannot label a successful mutation not_vulnerable without a native counterexample', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  const planned = await planBusinessExperiment(f.context, planInput(f));
  await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(executed.evidence_ready, true, JSON.stringify(executed));
  const assessment = await assessBusinessExperiment(f.context, { plan_id: planned.plan_id, verdict: 'not_vulnerable', title: 'Unsupported secure conclusion', severity: 'info',
    reason: 'The model asks for a secure conclusion even though the exact impact assertion completed.',
    business_impact: 'The target accepted the changed state, so this is not a counterexample.' });
  assert.equal(assessment.verdict, 'inconclusive', JSON.stringify(assessment));
  assert.equal(assessment.counterexample_verified, false, JSON.stringify(assessment));
});

test('the declared control role selects that exact prepared identity for the native control run', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  const victim = await f.db.repos.accounts.create({ name: 'Prepared victim control', username: 'victim-control', status: 'active',
    tags: ['ai_scan', `scan:${f.run.id}`, 'role:victim'], fields: { auth_token: 'victim' }, variables: {},
    auth_profile: { headers: { Authorization: 'Bearer victim' }, identity_probe: { source_step_order: 1, subject_path: 'body.actor', expected_subject: 'victim' } } });
  const input = planInput(f);
  input.control_role = 'victim';
  input.steps = input.steps.map(step => ({ ...step, role: 'victim' }));
  const planned = await planBusinessExperiment(f.context, input);
  const compiled = await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(compiled.native_assets.control_role, 'victim');
  const compilation = (await f.repo.listArtifacts(f.run.id)).find(item => item.artifact_type === 'agent_experiment_compilation').content_json;
  assert.equal(compilation.control_role, 'victim');
  assert.equal(compilation.control_account_id, victim.id);
  const controlWorkflow = await f.db.repos.workflows.findById(compilation.control_workflow_id);
  assert.equal(controlWorkflow.attacker_account_id, victim.id, 'Control workflow must not silently use the normal account');
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  const controlRun = await f.db.repos.testRuns.findById(executed.native_test_run_ids[0]);
  assert.deepEqual(controlRun.account_ids, [victim.id]);
  assert.equal(controlRun.execution_params.control_role, 'victim');
});

test('an unobserved patch field is rejected during native compilation instead of falling back to a preset experiment', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  const input = planInput(f);
  input.patches = [{ step_id: f.steps[1].id, location: 'json_body', operation: 'set', path: 'not_observed', value: '1' }];
  const planned = await planBusinessExperiment(f.context, input);
  await assert.rejects(compileBusinessExperiment(f.context, { plan_id: planned.plan_id }), /not observed/);
  assert.equal((await f.db.repos.testRuns.findAll()).length, 1, 'No experiment run is created after a rejected compiler operation');
});

test('model-selected skipped and repeated steps execute as the compiled sequence instead of failing baseline-sized completeness checks', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  const input = planInput(f);
  input.steps = f.steps.slice(0, 2).map(step => ({ id: step.id, source_step_order: step.step_order, role: 'normal' }));
  input.repeats = [{ step_id: f.steps[0].id, count: 1 }];
  input.assertions = [{ id: 'impact-at-action', step_order: 2, description: 'The action response contains the changed amount', purpose: 'impact',
    left: { type: 'response', path: 'body.amount' }, op: 'equals', right: { type: 'literal', value: '0' } }];
  input.control_assertions = [{ id: 'control-at-action', step_order: 2, description: 'The control response contains the normal amount', purpose: 'control',
    left: { type: 'response', path: 'body.amount' }, op: 'equals', right: { type: 'literal', value: '1' } }];
  const planned = await planBusinessExperiment(f.context, input);
  await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  const compilation = (await f.repo.listArtifacts(f.run.id)).find(item => item.artifact_type === 'agent_experiment_compilation').content_json;
  assert.deepEqual(compilation.mutation_profile.skip_steps, [3]);
  assert.equal(compilation.mutation_profile.repeat_steps[1], 1);
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(executed.status, 'executed', JSON.stringify(executed));
  assert.equal(executed.execution_verified, true, JSON.stringify(executed));
  assert.equal(executed.control_verified, true, JSON.stringify(executed));
  assert.equal(f.service.latest()?.amount, 0);
  assert.equal(f.service.appliedCount(), 3, 'The normal baseline, control, and compiled repeated-seed experiment each executed one real action');
});

test('model-selected concurrency preserves source-step attribution and proves simultaneous native requests through the authoritative state', { timeout: 60000 }, async t => {
  const f = await setup(t, 'concurrent');
  const input = planInput(f, 1);
  input.patches = [];
  input.concurrency = { step_id: f.steps[1].id, count: 2 };
  input.hypothesis = 'The observed purchase action may be applied twice when the same fresh ticket is released concurrently.';
  input.rationale = 'Keep the recorded fresh-ticket binding and use the native concurrent replay profile for the observed state-changing action.';
  input.assertions = [{ id: 'concurrent-impact', step_order: 3, description: 'Authoritative state shows both concurrent applications in addition to normal control runs', purpose: 'impact',
    left: { type: 'response', path: 'body.applied_count' }, op: 'equals', right: { type: 'literal', value: '4' } }];
  input.control_assertions = [{ id: 'concurrent-control', step_order: 3, description: 'Control applies exactly one fresh normal action after the baseline', purpose: 'control',
    left: { type: 'response', path: 'body.applied_count' }, op: 'equals', right: { type: 'literal', value: '2' } }];
  const planned = await planBusinessExperiment(f.context, input);
  await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(executed.status, 'executed', JSON.stringify(executed));
  assert.equal(executed.concurrency_success_count, 2, JSON.stringify(executed));
  assert.equal(executed.execution_verified, true, JSON.stringify(executed));
  assert.equal(executed.evidence_ready, true, JSON.stringify(executed));
  assert.equal(f.service.appliedCount(), 4, 'The fixture recorded two actual concurrent state-changing requests');
  const traces = (await f.repo.listArtifacts(f.run.id)).filter(item => item.artifact_type === 'agent_experiment_native_trace' && item.content_json.kind === 'experiment');
  const concurrent = traces.flatMap(trace => trace.content_json.trace.records).filter(record => record.meta?.label === 'concurrent');
  assert.equal(concurrent.length, 2);
  assert.ok(concurrent.every(record => record.meta?.step_order === 2 && record.meta?.template_id === f.steps[1].api_template_id));
});
