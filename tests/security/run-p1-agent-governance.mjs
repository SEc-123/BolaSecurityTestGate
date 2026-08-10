import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  acquireScanTrafficPermit,
  getScanTrafficSnapshot,
  hydrateScanTrafficState,
  resetScanTrafficState,
  runWithScanTrafficContext,
} from '../../server/dist/services/ai-scan/scan-traffic-governor.js';
import { evidenceContractForVulnerability, listEvidenceContracts } from '../../server/dist/services/ai-scan/evidence-contracts.js';
import { evaluateNativeEvidence } from '../../server/dist/services/ai-scan/native-evidence-gate.js';
import { validateAgentToolInput, AgentToolContractError } from '../../server/dist/agent/tool-contract.js';
import { AgentToolRegistry } from '../../server/dist/agent/tool-registry.js';
import { SqliteProvider } from '../../server/dist/db/sqlite-provider.js';
import { SCHEMA_VERSION } from '../../server/dist/db/schema.js';
import { AIScanRepository } from '../../server/dist/services/ai-scan/repository.js';
import { nativeAssetRefs } from '../../server/dist/services/ai-scan/asset-lifecycle.js';

function okRun(id) {
  return { success: true, test_run_id: id, has_execution_error: false };
}

function nativeEvidence(overrides = {}) {
  return {
    assets: {
      template_ids: [],
      api_mode_template_ids: [],
      workflow_variable_ids: [],
      workflow_mapping_ids: [],
      workflow_extractor_ids: [],
      workflow_variable_config_ids: [],
      security_rule_ids: [],
      checklist_ids: [],
      account_ids: [],
      ...overrides.assets,
    },
    api_mode: overrides.api_mode,
    template_run: overrides.template_run,
    baseline_workflow_run: overrides.baseline_workflow_run,
    mutation_workflow_run: overrides.mutation_workflow_run,
    advanced_mutation: overrides.advanced_mutation,
    native_counts: {},
  };
}

async function testEvidenceContracts() {
  const contracts = new Map(listEvidenceContracts().map(item => [item.id, item]));
  for (const id of ['stateless_input_v1', 'file_upload_v1', 'authorization_stateful_v1', 'business_stateful_v1', 'race_v1', 'strict_generic_v1']) {
    assert.ok(contracts.has(id), `missing evidence contract ${id}`);
  }
  assert.equal(evidenceContractForVulnerability('xss').id, 'stateless_input_v1');
  assert.equal(evidenceContractForVulnerability('bola_idor').id, 'authorization_stateful_v1');
  assert.equal(evidenceContractForVulnerability('business_logic').id, 'business_stateful_v1');
  assert.equal(evidenceContractForVulnerability('replay_race').id, 'race_v1');

  const nativeRefs = nativeAssetRefs({ environment_id: 'manual-environment', template_ids: ['generated-template'] });
  assert.equal(nativeRefs.some(item => item.asset_type === 'environment'), false, 'native execution must not claim a caller-provided environment as generated');
  assert.equal(nativeRefs.some(item => item.asset_type === 'api_template' && item.asset_id === 'generated-template'), true);

  const stateless = nativeEvidence({
    assets: { api_mode_template_ids: ['baseline-template', 'mutation-template'] },
    api_mode: { baseline_run: okRun('api-base'), mutation_run: okRun('api-mut') },
  });
  assert.equal(evaluateNativeEvidence(stateless, 'en', 'xss').verdict, 'confirmed');
  assert.equal(evaluateNativeEvidence(stateless, 'en', 'bola_idor').verdict, 'insufficient_native_evidence');

  const stateful = nativeEvidence({
    assets: {
      template_ids: ['workflow-template'],
      baseline_workflow_id: 'baseline-wf',
      mutation_workflow_id: 'mutation-wf',
    },
    baseline_workflow_run: okRun('wf-base'),
    mutation_workflow_run: okRun('wf-mut'),
  });
  assert.equal(evaluateNativeEvidence(stateful, 'en', 'bola_idor').verdict, 'confirmed');
  assert.equal(evaluateNativeEvidence(stateful, 'en', 'replay_race').verdict, 'insufficient_native_evidence');
  assert.equal(evaluateNativeEvidence({
    ...stateful,
    advanced_mutation: { plan: { dimensions: ['same_packet_concurrent'] }, profile: {} },
  }, 'en', 'replay_race').verdict, 'confirmed');
}

async function testTrafficGovernor() {
  resetScanTrafficState();
  const baseLimits = {
    max_concurrency: 4,
    requests_per_second: 500,
    burst: 20,
    max_total_requests: 3,
    max_endpoint_requests: 1,
    max_mutation_requests: 2,
    max_upload_requests: 1,
    max_account_creation_requests: 1,
  };
  await runWithScanTrafficContext({ scan_run_id: 'traffic-endpoint', limits: baseLimits }, async () => {
    const first = await acquireScanTrafficPermit({ url: 'http://target.test/a', method: 'GET' });
    await first.release();
    await assert.rejects(
      () => acquireScanTrafficPermit({ url: 'http://target.test/a', method: 'GET' }),
      error => error?.code === 'SCAN_TRAFFIC_BUDGET_EXCEEDED' && error?.reason === 'max_endpoint_requests',
    );
  });

  await runWithScanTrafficContext({ scan_run_id: 'traffic-class', limits: { ...baseLimits, max_endpoint_requests: 20, max_total_requests: 20 } }, async () => {
    const upload = await acquireScanTrafficPermit({ url: 'http://target.test/upload', method: 'POST', traffic_class: 'upload' });
    await upload.release();
    await assert.rejects(
      () => acquireScanTrafficPermit({ url: 'http://target.test/upload-2', method: 'POST', traffic_class: 'upload' }),
      error => error?.reason === 'max_upload_requests',
    );
    const account = await acquireScanTrafficPermit({ url: 'http://target.test/register', method: 'POST', traffic_class: 'account_creation' });
    await account.release();
    await assert.rejects(
      () => acquireScanTrafficPermit({ url: 'http://target.test/register-2', method: 'POST', traffic_class: 'account_creation' }),
      error => error?.reason === 'max_account_creation_requests',
    );
  });

  resetScanTrafficState('traffic-resume');
  hydrateScanTrafficState('traffic-resume', {
    scan_run_id: 'traffic-resume',
    in_flight: 9,
    total_requests: 2,
    class_counts: { read: 2, mutation: 0, upload: 0, account_creation: 0, browser: 0 },
    endpoint_counts: { 'GET http://target.test/a': 1, 'GET http://target.test/b': 1 },
    limits: { ...baseLimits, max_total_requests: 2, max_endpoint_requests: 20 },
  });
  const resumed = getScanTrafficSnapshot('traffic-resume');
  assert.equal(resumed?.in_flight, 0, 'in-flight requests must never be restored after process restart');
  assert.equal(resumed?.total_requests, 2);
  await runWithScanTrafficContext({ scan_run_id: 'traffic-resume', limits: { ...baseLimits, max_total_requests: 2, max_endpoint_requests: 20 } }, async () => {
    await assert.rejects(
      () => acquireScanTrafficPermit({ url: 'http://target.test/c', method: 'GET' }),
      error => error?.reason === 'max_total_requests',
    );
  });

  resetScanTrafficState('traffic-abort');
  const controller = new AbortController();
  await runWithScanTrafficContext({
    scan_run_id: 'traffic-abort',
    limits: { ...baseLimits, max_concurrency: 1, max_endpoint_requests: 20, max_total_requests: 20 },
    signal: controller.signal,
  }, async () => {
    const held = await acquireScanTrafficPermit({ url: 'http://target.test/held', method: 'GET' });
    const queued = acquireScanTrafficPermit({ url: 'http://target.test/queued', method: 'GET' });
    controller.abort();
    await assert.rejects(() => queued, error => error?.code === 'SCAN_TRAFFIC_ABORTED');
    await held.release();
    assert.equal(getScanTrafficSnapshot('traffic-abort')?.total_requests, 1, 'aborted queued requests must not consume the traffic budget');
  });
}

async function testToolRuntimeContracts() {
  assert.throws(
    () => validateAgentToolInput({}, { type: 'object', required: ['url'], properties: { url: { type: 'string', minLength: 1 } }, additionalProperties: false }),
    AgentToolContractError,
  );
  assert.throws(
    () => validateAgentToolInput({ url: 'http://target.test', extra: true }, { type: 'object', required: ['url'], properties: { url: { type: 'string' } }, additionalProperties: false }),
    /not allowed/,
  );

  let scanConfig = {
    allowed_tool_capabilities: ['read', 'control_plane', 'active_test'],
    allowed_tool_side_effect_levels: ['none', 'metadata', 'target_read', 'target_mutation', 'target_destructive'],
    traffic_budget: { requests_per_second: 500, burst: 20 },
  };
  const invocations = [];
  const artifacts = [];
  const fakeRepo = {
    getRun: async () => ({ id: 'scan-tool', base_url: 'http://target.test', scan_config: scanConfig }),
    getLatestTrafficSnapshot: async () => null,
    createToolInvocation: async input => { invocations.push(input); return input; },
    createArtifact: async input => { artifacts.push(input); return input; },
  };
  const registry = new AgentToolRegistry();
  registry.register({
    name: 'test.active',
    description: 'contract test',
    input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } }, additionalProperties: false },
    side_effects: ['performs active target mutation'],
    runtime: { capability_class: 'active_test', side_effect_level: 'target_mutation', timeout_ms: 1000, target_input_keys: ['url'] },
    handler: async input => ({ ok: true, data: { url: input.url } }),
  });

  await assert.rejects(() => registry.call('test.active', { url: 'http://other.test/path' }, { db: {}, repo: fakeRepo, scanRunId: 'scan-tool' }), /out-of-scope target url blocked/i);

  scanConfig = { ...scanConfig, allowed_tool_capabilities: ['read', 'control_plane'] };
  await assert.rejects(() => registry.call('test.active', { url: 'http://target.test/path' }, { db: {}, repo: fakeRepo, scanRunId: 'scan-tool' }), /capability active_test is disabled/i);

  scanConfig = { ...scanConfig, allowed_tool_capabilities: ['active_test'], allowed_tool_side_effect_levels: ['target_read'] };
  await assert.rejects(() => registry.call('test.active', { url: 'http://target.test/path' }, { db: {}, repo: fakeRepo, scanRunId: 'scan-tool' }), /side-effect level target_mutation is disabled/i);

  scanConfig = { ...scanConfig, allowed_tool_side_effect_levels: ['target_mutation'] };
  const success = await registry.call('test.active', { url: 'http://target.test/path' }, { db: {}, repo: fakeRepo, scanRunId: 'scan-tool' });
  assert.equal(success.ok, true);
  assert.equal(invocations.at(-1)?.contract_json?.capability_class, 'active_test');
  assert.equal(invocations.at(-1)?.contract_json?.side_effect_level, 'target_mutation');

  registry.register({
    name: 'test.timeout',
    description: 'timeout contract test',
    input_schema: { type: 'object', properties: {} },
    side_effects: ['writes metadata'],
    runtime: { capability_class: 'control_plane', side_effect_level: 'metadata', timeout_ms: 15 },
    handler: async (_input, context) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, data: {} }), 100);
      context.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    }),
  });
  scanConfig = { ...scanConfig, allowed_tool_capabilities: ['control_plane'], allowed_tool_side_effect_levels: ['metadata'] };
  await assert.rejects(() => registry.call('test.timeout', {}, { db: {}, repo: fakeRepo, scanRunId: 'scan-tool' }), /timed out/i);
  assert.equal(invocations.at(-1)?.status, 'failed');
  assert.equal(artifacts.length, 0);
}

async function testPersistentLifecycleAndProvenance() {
  assert.equal(SCHEMA_VERSION, '1.4.0-ai-agent-p1');
  const db = new SqliteProvider(`p1-${randomUUID()}`, { file: ':memory:' });
  await db.connect();
  try {
    await db.migrate();
    const findingColumns = await db.runRawQuery('PRAGMA table_info(findings)');
    for (const column of ['ai_scan_run_id', 'ai_scan_task_id', 'ai_campaign_task_id', 'ai_candidate_id', 'ai_feature_id', 'ai_endpoint_id', 'ai_evidence_contract']) {
      assert.ok(findingColumns.some(item => item.name === column), `findings.${column} migration missing`);
    }
    const invocationColumns = await db.runRawQuery('PRAGMA table_info(ai_tool_invocations)');
    assert.ok(invocationColumns.some(item => item.name === 'contract_json'));
    assert.ok(invocationColumns.some(item => item.name === 'traffic_json'));
    const provenanceTable = await db.runRawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_finding_provenance'");
    const assetTable = await db.runRawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_generated_assets'");
    assert.equal(provenanceTable.length, 1);
    assert.equal(assetTable.length, 1);

    const repo = new AIScanRepository(db);
    const run = await repo.createRun({ base_url: 'http://target.test', scan_config: {} });
    const endpoint = await repo.upsertEndpoint({ scan_run_id: run.id, method: 'GET', path: '/api/orders/1', url: 'http://target.test/api/orders/1' });
    const feature = await repo.createFeature({ scan_run_id: run.id, name: 'Orders', node_type: 'feature', endpoint_ids: [endpoint.id] });
    const candidate = await repo.createCandidate({ scan_run_id: run.id, feature_id: feature.id, vuln_type: 'bola_idor', title: 'Order ownership boundary', endpoint_ids: [endpoint.id] });
    const campaign = await repo.createTask({ scan_run_id: run.id, title: 'BOLA campaign', task_type: 'vulnerability_campaign', vuln_type: 'bola_idor', execution_plan: { intent: 'vulnerability_campaign' } });
    const child = await repo.createTask({
      scan_run_id: run.id,
      parent_task_id: campaign.id,
      title: 'Order BOLA test',
      task_type: 'test_bola_idor',
      vuln_type: 'bola_idor',
      feature_id: feature.id,
      endpoint_ids: [endpoint.id],
      execution_plan: { candidate_id: candidate.id },
    });
    const provenance = await repo.resolveFindingProvenance(child, endpoint.id);
    assert.equal(provenance.ai_campaign_task_id, campaign.id);
    assert.equal(provenance.ai_candidate_id, candidate.id);
    assert.equal(provenance.ai_feature_id, feature.id);
    assert.equal(provenance.ai_endpoint_id, endpoint.id);

    const findingId = randomUUID();
    await db.runRawQuery('INSERT INTO findings (id, source_type, title) VALUES (?, ?, ?)', [findingId, 'ai_scan', 'Order BOLA finding']);
    await repo.recordFindingProvenance(findingId, provenance, 'authorization_stateful_v1');
    const persistedProvenance = await repo.getFindingProvenance(findingId);
    assert.equal(persistedProvenance?.scan_run_id, run.id);
    assert.equal(persistedProvenance?.task_id, child.id);
    assert.equal(persistedProvenance?.campaign_task_id, campaign.id);
    assert.equal(persistedProvenance?.candidate_id, candidate.id);
    assert.equal(persistedProvenance?.evidence_contract_id, 'authorization_stateful_v1');

    const duplicateTask = await repo.createTask({
      scan_run_id: run.id,
      title: 'Duplicate BOLA observation',
      task_type: 'test_bola_idor',
      vuln_type: 'bola_idor',
      feature_id: feature.id,
      endpoint_ids: [endpoint.id],
      execution_plan: {},
    });
    await repo.recordFindingProvenance(findingId, {
      ai_scan_run_id: run.id,
      ai_scan_task_id: duplicateTask.id,
      ai_campaign_task_id: duplicateTask.id,
      ai_feature_id: feature.id,
      ai_endpoint_id: endpoint.id,
    }, 'authorization_stateful_v1');
    const canonicalAfterDuplicate = await repo.getFindingProvenance(findingId);
    assert.equal(canonicalAfterDuplicate?.task_id, child.id, 'deduplication must preserve the first canonical task origin');
    assert.equal(canonicalAfterDuplicate?.campaign_task_id, campaign.id, 'deduplication must preserve the first canonical campaign origin');

    for (const [id, name] of [['rule-ephemeral', 'Ephemeral'], ['rule-promoted', 'Promoted'], ['rule-reusable', 'Reusable']]) {
      await db.runRawQuery('INSERT INTO security_rules (id, name, payloads, description) VALUES (?, ?, ?, ?)', [id, name, '[]', 'p1 test']);
      await repo.registerGeneratedAsset({ scan_run_id: run.id, task_id: child.id, asset_type: 'security_rule', asset_id: id });
    }
    const promoted = (await repo.listGeneratedAssets(run.id)).find(item => item.asset_id === 'rule-promoted');
    assert.ok(promoted);
    await repo.promoteGeneratedAsset(run.id, promoted.id);
    await repo.retainGeneratedAssetsForReplay(run.id, ['rule-reusable']);
    const cleanup = await repo.cleanupEphemeralGeneratedAssets(run.id);
    assert.equal(cleanup.failed.length, 0);
    assert.equal(cleanup.cleaned, 1);
    assert.equal((await db.runRawQuery('SELECT id FROM security_rules WHERE id = ?', ['rule-ephemeral'])).length, 0);
    assert.equal((await db.runRawQuery('SELECT id FROM security_rules WHERE id = ?', ['rule-promoted'])).length, 1);
    assert.equal((await db.runRawQuery('SELECT id FROM security_rules WHERE id = ?', ['rule-reusable'])).length, 1);
    let assets = await repo.listGeneratedAssets(run.id);
    assert.equal(assets.find(item => item.asset_id === 'rule-ephemeral')?.lifecycle_status, 'cleaned');
    assert.equal(assets.find(item => item.asset_id === 'rule-promoted')?.lifecycle_status, 'promoted');
    assert.equal(assets.find(item => item.asset_id === 'rule-reusable')?.lifecycle_status, 'reusable');
    const cleanedRegistry = assets.find(item => item.asset_id === 'rule-ephemeral');
    assert.ok(cleanedRegistry);
    await assert.rejects(() => repo.promoteGeneratedAsset(run.id, cleanedRegistry.id), /already been cleaned/i);

    // Re-registering an existing retained asset must never downgrade its lifecycle or steal generation ownership.
    const otherRun = await repo.createRun({ base_url: 'http://target.test', scan_config: { asset_lifecycle: { default_status: 'ephemeral' } } });
    await repo.registerGeneratedAsset({ scan_run_id: otherRun.id, asset_type: 'security_rule', asset_id: 'rule-promoted', metadata_json: { reused_by_scan: otherRun.id } });
    await repo.registerGeneratedAsset({ scan_run_id: otherRun.id, asset_type: 'security_rule', asset_id: 'rule-reusable' });
    assets = await repo.listGeneratedAssets(run.id);
    assert.equal(assets.find(item => item.asset_id === 'rule-promoted')?.lifecycle_status, 'promoted');
    assert.equal(assets.find(item => item.asset_id === 'rule-reusable')?.lifecycle_status, 'reusable');
    assert.equal((await repo.listGeneratedAssets(otherRun.id)).length, 0, 'reusing an existing generated asset must not rewrite generation ownership');
  } finally {
    await db.disconnect();
  }
}

const tests = [
  ['evidence contracts', testEvidenceContracts],
  ['traffic governor', testTrafficGovernor],
  ['tool runtime contracts', testToolRuntimeContracts],
  ['persistent lifecycle and provenance', testPersistentLifecycleAndProvenance],
];

for (const [name, fn] of tests) {
  await fn();
  console.log(`PASS ${name}`);
}
console.log(`PASS P1 agent governance (${tests.length} suites)`);
