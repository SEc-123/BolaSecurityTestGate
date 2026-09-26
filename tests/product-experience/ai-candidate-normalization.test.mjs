import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../mobile-closure/fixtures.mjs';
import { AIClient } from '../../server/src/services/ai/ai-client.ts';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { enhanceFeatureAndVulnModelWithAI } from '../../server/src/services/ai-scan/ai-planner.ts';
import { buildAIScanToolSpecs } from '../../server/src/agent/tools/ai-scan-tools.ts';

// Provider responses are synthetic; persistence uses the real in-memory repository.
// No saved configuration, browser, target transport or external AI service is used.
async function fixture(t, language = 'en') {
  const db = await database();
  t.after(() => db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
    ['planner-contract', 'Planner fixture', 'openai_compat', 'http://127.0.0.1:9', 'fixture-key', 'fixture-model', 1, 1]);
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({ base_url: 'https://planner.example.test', language });
  const otherRun = await repo.createRun({ base_url: 'https://planner.example.test', language });
  const endpoint = (scanId, path, method = 'GET') => repo.upsertEndpoint({ scan_run_id: scanId, method, path });
  const a = await endpoint(run.id, '/alpha');
  const b = await endpoint(run.id, '/beta');
  const foreign = await endpoint(otherRun.id, '/alpha');
  let response;
  t.mock.method(AIClient.prototype, 'chat', async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] }));
  return {
    db, repo, run, a, b, foreign, endpoint,
    setOutput: value => { response = value; },
    enhance: async value => {
      response = value;
      return enhanceFeatureAndVulnModelWithAI({ db, repo, scanRunId: run.id });
    },
  };
}

for (const typeField of ['vuln_type', 'type', 'vulnerability_type']) {
  test(`provider ${typeField} and valid endpoint IDs create a linked candidate`, async t => {
    const f = await fixture(t);
    const result = await f.enhance({ vulnerability_candidates: [{ [typeField]: 'xss', title: 'Input review', endpoint_ids: [f.a.id] }] });
    const candidates = await f.repo.listCandidates(f.run.id);
    assert.equal(result.applied, true);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].vuln_type, 'xss');
    assert.deepEqual(candidates[0].endpoint_ids, [f.a.id]);
    assert.equal(candidates[0].reason, '', 'Reason remains optional for existing providers.');
    assert.match(result.summary, /added 0 features and 1 vulnerability candidates/);
    assert.equal(result.output.vulnerability_candidates[0].vuln_type, 'xss');
    assert.deepEqual(result.output.vulnerability_candidates[0].endpoint_ids, [f.a.id]);
  });
}

test('exact paths map only to this scan and associate the new feature', async t => {
  const f = await fixture(t);
  const result = await f.enhance({
    features: [{ name: 'Input feature', endpoint_paths: ['/alpha'] }],
    vulnerability_candidates: [{ vuln_type: 'xss', title: 'Input review', reason: 'Synthetic reason', endpoint_paths: ['/alpha'], feature_name: 'Input feature' }],
  });
  const [candidate] = await f.repo.listCandidates(f.run.id);
  const [feature] = await f.repo.listFeatures(f.run.id);
  assert.equal(result.applied, true);
  assert.deepEqual(candidate.endpoint_ids, [f.a.id]);
  assert.deepEqual(feature.endpoint_ids, [f.a.id]);
  assert.equal(candidate.feature_id, feature.id);
  assert.equal(candidate.reason, 'Synthetic reason');
  assert.match(result.summary, /added 1 features and 1 vulnerability candidates/);
});

for (const [name, change] of [
  ['unknown ID', f => ({ endpoint_ids: ['not-discovered'] })],
  ['foreign scan ID', f => ({ endpoint_ids: [f.foreign.id] })],
  ['mixed valid and foreign IDs', f => ({ endpoint_ids: [f.a.id, f.foreign.id] })],
  ['unknown ID alongside a valid path', f => ({ endpoint_ids: ['not-discovered'], endpoint_paths: ['/alpha'] })],
  ['unknown path', f => ({ endpoint_paths: ['/absent'] })],
  ['mixed known and unknown paths', f => ({ endpoint_paths: ['/alpha', '/absent'] })],
  ['non-exact path', f => ({ endpoint_paths: ['/alpha?x=1'] })],
  ['missing endpoint references', f => ({})],
  ['empty endpoint references', f => ({ endpoint_ids: [], endpoint_paths: [] })],
  ['non-array endpoint references', f => ({ endpoint_ids: f.a.id })],
  ['non-string endpoint references', f => ({ endpoint_ids: [f.a.id, 42] })],
  ['unknown type', f => ({ vuln_type: 'unsupported', endpoint_ids: [f.a.id] })],
  ['unknown canonical type with a known alias', f => ({ vuln_type: 'unsupported', type: 'xss', endpoint_ids: [f.a.id] })],
  ['conflicting type aliases', f => ({ type: 'bola_idor', endpoint_ids: [f.a.id] })],
  ['missing type', f => ({ vuln_type: undefined, endpoint_ids: [f.a.id] })],
  ['missing title', f => ({ title: undefined, endpoint_ids: [f.a.id] })],
  ['blank title', f => ({ title: '  ', endpoint_ids: [f.a.id] })],
]) {
  test(`${name} is rejected without persisting an orphan or reporting an addition`, async t => {
    const f = await fixture(t);
    const result = await f.enhance({ vulnerability_candidates: [{ vuln_type: 'xss', title: 'Input review', ...change(f) }] });
    assert.equal(result.applied, false);
    assert.deepEqual(await f.repo.listCandidates(f.run.id), []);
    assert.match(result.summary, /added 0 features and 0 vulnerability candidates/);
    assert.deepEqual(result.output.vulnerability_candidates, []);
  });
}

test('a path shared by multiple methods is ambiguous; explicit IDs remain usable', async t => {
  const f = await fixture(t);
  const post = await f.endpoint(f.run.id, '/alpha', 'POST');
  const rejected = await f.enhance({ vulnerability_candidates: [{ type: 'xss', title: 'Ambiguous', endpoint_paths: ['/alpha'] }] });
  assert.equal(rejected.applied, false);
  assert.deepEqual(await f.repo.listCandidates(f.run.id), []);
  const accepted = await f.enhance({ vulnerability_candidates: [{ type: 'xss', title: 'Specific', endpoint_ids: [post.id] }] });
  assert.equal(accepted.applied, true);
  assert.deepEqual((await f.repo.listCandidates(f.run.id))[0].endpoint_ids, [post.id]);
});

test('counts reflect actual inserts and retained rows despite rejected and duplicate proposals', async t => {
  const f = await fixture(t);
  const feature = await f.repo.createFeature({ scan_run_id: f.run.id, name: 'Existing', node_type: 'feature', endpoint_ids: [f.a.id] });
  const existing = await f.repo.createCandidate({ scan_run_id: f.run.id, vuln_type: 'xss', title: 'Existing review', endpoint_ids: [f.b.id, f.a.id] });
  const repeated = { type: 'xss', title: 'Added review', endpoint_ids: [f.a.id, f.a.id] };
  const result = await f.enhance({
    features: [{ name: 'Existing' }, { name: 'Added' }, { name: 'Added' }, {}],
    vulnerability_candidates: [
      { type: 'xss', title: 'Existing review', endpoint_ids: [f.a.id, f.b.id, f.a.id] },
      repeated, repeated, { type: 'unknown', title: 'Invalid', endpoint_ids: [f.a.id] },
    ],
  });
  assert.match(result.summary, /added 1 features and 1 vulnerability candidates/);
  assert.match(result.summary, /Retained 1 existing features and 1 existing vulnerability candidates/);
  const candidates = await f.repo.listCandidates(f.run.id);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.find(c => c.id === existing.id), existing);
  assert.deepEqual((await f.repo.listFeatures(f.run.id)).find(item => item.id === feature.id), feature);
  assert.equal((await f.repo.listFeatures(f.run.id)).length, 2);
  const duplicateOnly = await f.enhance({ vulnerability_candidates: [repeated] });
  assert.equal(duplicateOnly.applied, false);
  assert.match(duplicateOnly.summary, /added 0 features and 0 vulnerability candidates/);
  assert.match(duplicateOnly.summary, /Retained 2 existing features and 2 existing vulnerability candidates/);
});

test('empty AI output preserves heuristic candidates and reports zero additions in Chinese', async t => {
  const f = await fixture(t, 'zh');
  const existing = await f.repo.createCandidate({ scan_run_id: f.run.id, vuln_type: 'xss', title: 'Existing', endpoint_ids: [f.a.id] });
  const result = await f.enhance({ features: [], vulnerability_candidates: [] });
  assert.equal(result.applied, false);
  assert.match(result.summary, /新增 0 个功能和 0 个漏洞候选项/);
  assert.match(result.summary, /保留 0 个已有功能和 1 个已有漏洞候选项/);
  assert.deepEqual(await f.repo.listCandidates(f.run.id), [existing]);
});

test('malformed candidate entries do not discard a later valid candidate', async t => {
  const f = await fixture(t);
  const result = await f.enhance({ vulnerability_candidates: [null, 7, [], { type: 'xss', title: 'Valid', endpoint_ids: [f.a.id] }] });
  assert.equal(result.applied, true);
  assert.equal((await f.repo.listCandidates(f.run.id)).length, 1);
  assert.match(result.summary, /added 0 features and 1 vulnerability candidates/);
});

test('candidate generation tool reports the actual stored count for aliases and empty output', async t => {
  const f = await fixture(t);
  const tool = buildAIScanToolSpecs().find(item => item.name === 'vuln.generate_candidates');
  f.setOutput({ vulnerability_candidates: ['xss', 'bola_idor', 'bfla', 'business_logic'].map(type => ({
    type, title: `Provider ${type} candidate`, endpoint_ids: [f.a.id],
  })) });
  const result = await tool.handler({}, { db: f.db, repo: f.repo, scanRunId: f.run.id });
  assert.equal(result.ok, true);
  assert.equal(result.data.candidates_count, 4);
  assert.equal(result.data.ai_enhancement.applied, true);
  assert.match(result.data.ai_enhancement.summary, /added 0 features and 4 vulnerability candidates/);
  assert.deepEqual(result.data.candidates, await f.repo.listCandidates(f.run.id));
  f.setOutput({ vulnerability_candidates: [] });
  const empty = await tool.handler({}, { db: f.db, repo: f.repo, scanRunId: f.run.id });
  assert.equal(empty.data.candidates_count, 0);
  assert.equal(empty.data.ai_enhancement.applied, false);
  assert.deepEqual(await f.repo.listCandidates(f.run.id), []);
});
