import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { SCHEMA_VERSION } from '../../server/dist/db/schema.js';
import { SqliteProvider } from '../../server/dist/db/sqlite-provider.js';
import { AIScanRepository } from '../../server/dist/services/ai-scan/repository.js';
import {
  memoryViewForModel,
  rememberAgentObservation,
  retrieveRelevantAgentMemories,
  sharedResourceMemoryPolicy,
} from '../../server/dist/services/ai-scan/agent-memory.js';
import {
  decisionSignature,
  normalizePlannerAutonomyConfig,
  validatePlannerProposal,
} from '../../server/dist/agent/bounded-autonomy.js';
import { browserContextKey, isRecoverableBrowserContextRecord } from '../../server/dist/services/ai-scan/browser/persistent-browser-runtime.js';

function plannerContext(overrides = {}) {
  return {
    scan: { id: 'scan-p2', base_url: 'http://target.test', status: 'running', scan_config: { planner_autonomy: { mode: 'bounded_ai' } } },
    task: {
      id: 'task-p2', title: 'Test BOLA', task_type: 'test_bola_idor', vuln_type: 'bola_idor', endpoint_ids: ['ep-1'],
      execution_plan: {}, created_assets_json: {}, status: 'running', priority: 1, dependencies: [],
    },
    selected_vuln_types: ['bola_idor'],
    available_tools: [
      { name: 'agent.memory.query' },
      { name: 'agent.memory.remember' },
      { name: 'bstg.generic_vuln.run_test' },
      { name: 'browser.navigate' },
    ],
    task_tool_invocations: [],
    planner_state: { ai_provider_decisions: 0, scan_ai_provider_decisions: 0, signature_counts: {} },
    ...overrides,
  };
}

async function testBoundedPlannerAutonomy() {
  const defaults = normalizePlannerAutonomyConfig({});
  assert.equal(defaults.mode, 'local_only', 'existing/manual scans must remain deterministic unless bounded autonomy is explicitly enabled');
  const config = normalizePlannerAutonomyConfig({ planner_autonomy: { mode: 'bounded_ai', max_supporting_tool_calls_before_mandatory: 2 } });
  assert.equal(config.mode, 'bounded_ai');

  const context = plannerContext();
  const policy = { action: 'tool_call', tool_name: 'bstg.generic_vuln.run_test', arguments: { endpoint_id: 'ep-1' }, source: 'local_policy' };

  const earlyComplete = validatePlannerProposal({ context, proposal: { action: 'complete_task', summary: 'done' }, policyDecision: policy, config });
  assert.equal(earlyComplete.validation_status, 'rejected');
  assert.equal(earlyComplete.decision.tool_name, 'bstg.generic_vuln.run_test');

  const memoryProposal = { action: 'tool_call', tool_name: 'agent.memory.query', arguments: { query: 'victim object' } };
  const supporting = validatePlannerProposal({ context, proposal: memoryProposal, policyDecision: policy, config });
  assert.equal(supporting.validation_status, 'accepted', 'one supporting memory lookup should be allowed before the mandatory native test');

  const deferredContext = plannerContext({
    task_tool_invocations: [
      { tool_name: 'agent.memory.query', status: 'completed' },
      { tool_name: 'browser.navigate', status: 'completed' },
    ],
  });
  const tooDeferred = validatePlannerProposal({ context: deferredContext, proposal: memoryProposal, policyDecision: policy, config });
  assert.equal(tooDeferred.validation_status, 'rejected');
  assert.match(tooDeferred.rejection_reason || '', /cannot be deferred/i);

  const tokenBlocked = validatePlannerProposal({ context: plannerContext({ planner_state: { ai_provider_decisions: 1, scan_ai_provider_decisions: 1, ai_tokens_total: config.max_ai_tokens_per_task, scan_ai_tokens_total: 100, signature_counts: {} } }), proposal: memoryProposal, policyDecision: policy, config });
  assert.equal(tokenBlocked.validation_status, 'rejected');
  assert.match(tokenBlocked.rejection_reason || '', /token budget reached/i);

  const sig = decisionSignature(memoryProposal);
  const loopContext = plannerContext({ planner_state: { ai_provider_decisions: 1, scan_ai_provider_decisions: 1, ai_tokens_total: 100, scan_ai_tokens_total: 100, signature_counts: { [sig]: 2 } } });
  const loop = validatePlannerProposal({ context: loopContext, proposal: memoryProposal, policyDecision: policy, config });
  assert.equal(loop.validation_status, 'rejected');
  assert.match(loop.rejection_reason || '', /loop detected/i);

  const outOfStage = validatePlannerProposal({ context, proposal: { action: 'tool_call', tool_name: 'feature.extract_tree', arguments: {} }, policyDecision: policy, config });
  assert.equal(outOfStage.validation_status, 'rejected');
}

async function testMemorySafetyAndRetrieval() {
  const secretPolicy = sharedResourceMemoryPolicy({
    id: 'sr-1', scan_run_id: 'scan-memory', resource_type: 'identity_pool', resource_key: 'default', title: 'Identity pool',
    content_json: { attacker: { password: 'NeverLeak123', token: 'attacker-token' }, roles: ['attacker', 'victim'] }, usage_count: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  assert.equal(secretPolicy.llm_visibility, 'reference_only');
  assert.equal(secretPolicy.sensitivity, 'secret_ref');
  assert.equal(JSON.stringify(secretPolicy).includes('NeverLeak123'), false);
  assert.equal(JSON.stringify(secretPolicy).includes('attacker-token'), false);

  let persistedInput;
  const fakeRepo = {
    upsertAgentMemory: async input => {
      persistedInput = input;
      return {
        id: 'mem-safe', scan_run_id: input.scan_run_id, owner_task_id: input.owner_task_id, memory_type: input.memory_type,
        memory_key: input.memory_key, scope_type: input.scope_type, scope_ref: input.scope_ref || '', title: input.title, summary: input.summary,
        content_json: input.content_json, sensitivity: input.sensitivity, llm_visibility: input.llm_visibility, confidence: input.confidence,
        version: 1, status: 'active', ttl_seconds: input.ttl_seconds, expires_at: input.expires_at,
        provenance_json: input.provenance_json || {}, depends_on_json: input.depends_on_json || [], usage_count: 0,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
    },
  };
  const safeMemory = await rememberAgentObservation({
    repo: fakeRepo,
    scanRunId: 'scan-memory', taskId: 'task-memory', memoryType: 'observation', memoryKey: 'login',
    summary: 'Authorization: Bearer secret-bearer and password=SecretPass',
    content: { username: 'alice', password: 'SecretPass', access_token: 'secret-token', note: 'usable login flow' },
    provenance: { source: 'test', cookie: 'sid=secret' }, confidence: 0.8, ttlSeconds: 3600,
  });
  const serialized = JSON.stringify(persistedInput);
  for (const forbidden of ['secret-bearer', 'SecretPass', 'secret-token', 'sid=secret']) assert.equal(serialized.includes(forbidden), false, `memory persisted secret ${forbidden}`);
  assert.equal(serialized.includes('alice'), true);
  assert.equal(memoryViewForModel(safeMemory)?.content?.username, 'alice');

  const now = new Date().toISOString();
  let touched = [];
  const memoryRepo = {
    listAgentMemories: async () => [
      { ...safeMemory, id: 'scan-memory-1', scope_type: 'scan', scope_ref: '', memory_type: 'object_inventory', memory_key: 'orders', summary: 'Order object id 42 belongs to victim', confidence: 0.8, updated_at: now, usage_count: 0 },
      { ...safeMemory, id: 'task-memory-1', scope_type: 'task', scope_ref: 'task-42', memory_type: 'task_outcome', memory_key: 'bola', summary: 'Victim order object boundary confirmed for candidate', confidence: 0.7, updated_at: now, usage_count: 0 },
      { ...safeMemory, id: 'unrelated', scope_type: 'task', scope_ref: 'other-task', summary: 'Unrelated upload observation', confidence: 1, updated_at: now, usage_count: 0 },
    ],
    touchAgentMemories: async ids => { touched = ids; },
  };
  const relevant = await retrieveRelevantAgentMemories({
    repo: memoryRepo, scanRunId: 'scan-memory', task: { id: 'task-42', title: 'BOLA order', task_type: 'test_bola', endpoint_ids: [], dependencies: [], priority: 1, status: 'running', scan_run_id: 'scan-memory', execution_plan: {}, created_assets_json: {} }, query: 'victim order object', limit: 2,
  });
  assert.equal(relevant[0].id, 'task-memory-1', 'task-scoped memory should outrank unrelated high-confidence memory for the current task');
  assert.equal(touched.length, 2);

  const cjkRepo = {
    listAgentMemories: async () => [
      { ...safeMemory, id: 'cjk-hit', scope_type: 'scan', scope_ref: '', summary: '订单退款状态机和支付流程', confidence: 0.7, updated_at: now, usage_count: 0 },
      { ...safeMemory, id: 'cjk-miss', scope_type: 'scan', scope_ref: '', summary: '文件上传内容类型校验', confidence: 0.7, updated_at: now, usage_count: 0 },
    ],
    touchAgentMemories: async () => undefined,
  };
  const cjkRelevant = await retrieveRelevantAgentMemories({ repo: cjkRepo, scanRunId: 'scan-memory', query: '退款状态', limit: 1 });
  assert.equal(cjkRelevant[0].id, 'cjk-hit', 'CJK n-gram retrieval should match Chinese business-function memory');
}

async function testPersistentMemoryBrowserAndSchema() {
  assert.equal(SCHEMA_VERSION, '1.5.0-ai-agent-p2');
  const db = new SqliteProvider(`p2-${randomUUID()}`, { file: ':memory:' });
  await db.connect();
  try {
    await db.migrate();
    for (const table of ['ai_agent_memories', 'ai_agent_memory_revisions', 'ai_browser_contexts', 'ai_planner_decisions']) {
      const rows = await db.runRawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]);
      assert.equal(rows.length, 1, `missing P2 table ${table}`);
    }
    const repo = new AIScanRepository(db);
    const run = await repo.createRun({ base_url: 'http://target.test', scan_config: { planner_autonomy: { mode: 'bounded_ai' } } });
    const task = await repo.createTask({ scan_run_id: run.id, title: 'Memory task', task_type: 'test_bola_idor', vuln_type: 'bola_idor', endpoint_ids: [], execution_plan: {} });

    const first = await rememberAgentObservation({ repo, scanRunId: run.id, taskId: task.id, memoryType: 'task_fact', memoryKey: 'order-owner', summary: 'Victim owns order 42', content: { order_id: 42 }, confidence: 0.7, ttlSeconds: 3600 });
    const second = await rememberAgentObservation({ repo, scanRunId: run.id, taskId: task.id, memoryType: 'task_fact', memoryKey: 'order-owner', summary: 'Victim owns order 42; attacker does not', content: { order_id: 42, access: 'victim_only' }, confidence: 0.9, ttlSeconds: 3600 });
    assert.equal(first.id, second.id);
    assert.equal(second.version, 2);
    const revisions = await repo.listAgentMemoryRevisions(first.id);
    assert.deepEqual(revisions.map(item => item.version), [2, 1], 'memory revisions must be append-only and ordered newest first');
    assert.equal(revisions[0].summary, 'Victim owns order 42; attacker does not');

    const concurrent = await Promise.all([
      repo.upsertAgentMemory({ scan_run_id: run.id, owner_task_id: task.id, memory_type: 'task_fact', memory_key: 'order-owner', summary: 'Concurrent update A', confidence: 0.91 }),
      repo.upsertAgentMemory({ scan_run_id: run.id, owner_task_id: task.id, memory_type: 'task_fact', memory_key: 'order-owner', summary: 'Concurrent update B', confidence: 0.92 }),
    ]);
    assert.deepEqual(concurrent.map(item => item.version).sort((a, b) => a - b), [3, 4], 'parallel memory writes must receive distinct atomic versions');
    const concurrentRevisions = await repo.listAgentMemoryRevisions(first.id);
    assert.deepEqual(concurrentRevisions.map(item => item.version), [4, 3, 2, 1], 'parallel memory writes must preserve every revision exactly once');

    await repo.upsertAgentMemory({ scan_run_id: run.id, owner_task_id: task.id, memory_type: 'expired_fact', memory_key: 'expired', summary: 'old', expires_at: new Date(Date.now() - 5000).toISOString() });
    const active = await repo.listAgentMemories(run.id);
    assert.equal(active.some(item => item.memory_type === 'expired_fact'), false, 'expired memories must be excluded from active retrieval');
    const all = await repo.listAgentMemories(run.id, { include_expired: true });
    assert.equal(all.find(item => item.memory_type === 'expired_fact')?.status, 'expired');

    const state = { cookies: [{ name: 'sid', value: 'top-secret-cookie', domain: 'target.test', path: '/' }], origins: [{ origin: 'http://target.test', localStorage: [{ name: 'token', value: 'secret-local-storage' }] }] };
    await repo.upsertBrowserContext({ scan_run_id: run.id, task_id: task.id, context_key: `task:${task.id}`, scope_type: 'task', status: 'active', storage_state_json: state, current_url: 'http://target.test/app', ttl_seconds: 3600, expires_at: new Date(Date.now() + 3600000).toISOString() });
    const internal = await repo.getBrowserContext(run.id, `task:${task.id}`);
    assert.equal(internal?.storage_state_json?.cookies?.[0]?.value, 'top-secret-cookie', 'runtime must be able to restore the persisted browser identity state');
    const publicList = await repo.listBrowserContexts(run.id);
    assert.deepEqual(publicList[0].storage_state_json, {}, 'public browser-context listing must not expose raw storage state');
    assert.equal(publicList[0].storage_state_present, true);
    assert.equal(publicList[0].storage_cookie_count, 1);
    assert.equal(publicList[0].storage_origin_count, 1);
    await assert.rejects(
      () => repo.upsertBrowserContext({ scan_run_id: run.id, task_id: task.id, context_key: `task:${task.id}`, scope_type: 'identity', identity_key: 'victim', status: 'active' }),
      /browser context binding mismatch/i,
      'persisted browser identity state must never be rebound through a reused context key',
    );

    await repo.upsertBrowserContext({ scan_run_id: run.id, context_key: 'scan:expired', scope_type: 'scan', status: 'active', storage_state_json: {}, expires_at: new Date(Date.now() - 1000).toISOString() });
    const contexts = await repo.listBrowserContexts(run.id);
    assert.equal(contexts.find(item => item.context_key === 'scan:expired')?.status, 'expired');

    await repo.createPlannerDecision({ scan_run_id: run.id, task_id: task.id, iteration: 1, source: 'ai_provider', proposal_json: { action: 'complete_task' }, decision_json: { action: 'tool_call', tool_name: 'bstg.generic_vuln.run_test' }, policy_json: { action: 'tool_call', tool_name: 'bstg.generic_vuln.run_test' }, validation_status: 'rejected', rejection_reason: 'mandatory native test', decision_signature: 'sig-1' });
    const decisions = await repo.listPlannerDecisions(run.id, task.id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].validation_status, 'rejected');
  } finally {
    await db.disconnect();
  }
}

async function testBrowserContextKeys() {
  assert.deepEqual(browserContextKey({}), { key: 'scan:default', scope: 'scan', identity: '' });
  assert.deepEqual(browserContextKey({ scope_type: 'task', task_id: 'task-1' }), { key: 'task:task-1', scope: 'task', identity: '' });
  assert.deepEqual(browserContextKey({ scope_type: 'identity', identity_key: 'attacker' }), { key: 'identity:attacker', scope: 'identity', identity: 'attacker' });
  assert.throws(() => browserContextKey({ scope_type: 'identity' }), /identity_key is required/i);
  assert.throws(() => browserContextKey({ scope_type: 'task' }), /task_id is required/i);
  assert.equal(isRecoverableBrowserContextRecord({ status: 'active', expires_at: new Date(Date.now() + 5000).toISOString() }), true);
  assert.equal(isRecoverableBrowserContextRecord({ status: 'closed', expires_at: new Date(Date.now() + 5000).toISOString() }), false, 'explicitly closed browser state must not be resurrected');
  assert.equal(isRecoverableBrowserContextRecord({ status: 'active', expires_at: new Date(Date.now() - 5000).toISOString() }), false, 'expired browser state must not be recovered');
}

const tests = [
  ['bounded planner autonomy', testBoundedPlannerAutonomy],
  ['memory safety and retrieval', testMemorySafetyAndRetrieval],
  ['persistent memory/browser/schema', testPersistentMemoryBrowserAndSchema],
  ['browser context keys', testBrowserContextKeys],
];

for (const [name, fn] of tests) {
  await fn();
  console.log(`PASS ${name}`);
}
console.log(`PASS P2 agent runtime (${tests.length} suites)`);
