import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const pkg = JSON.parse(read('package.json'));
assert(pkg.version === '5.0.1', 'package version should be 5.0.1');

const forbiddenFiles = [
  'server/src/services/ai-scan/scan-traffic-governor.ts',
  'server/src/agent/tool-contract.ts',
  'server/src/services/ai-scan/asset-lifecycle.ts',
  'server/src/services/ai-scan/evidence-contracts.ts',
];
for (const file of forbiddenFiles) {
  assert(!fs.existsSync(path.join(root, file)), `discovery-first release should not include governance-only file ${file}`);
}

const generic = read('server/src/services/ai-scan/generic-vuln-runner.ts');
assert(generic.includes("if (judge.verdict === 'vulnerable')"), 'generic vulnerable judgement should create a finding without native replay hard gate');
assert(!generic.includes('finding_blocked_by_native_evidence_gate'), 'generic runner should not block findings on native replay gap');
assert(!generic.includes('finding_blocked_by_workflow_preconditions'), 'generic runner should not block findings on workflow precondition gaps');
assert(generic.includes('finding_created_with_native_replay_gap'), 'generic runner should record native replay gaps after finding creation');
assert(generic.includes('finding_created_with_workflow_precondition_gap'), 'generic runner should record workflow precondition gaps after finding creation');

const upload = read('server/src/services/ai-scan/file-upload-runner.ts');
assert(upload.includes("if (judge.verdict === 'vulnerable')"), 'upload vulnerable judgement should create a finding without native replay hard gate');
assert(!upload.includes('finding_blocked_by_native_evidence_gate'), 'upload runner should not block findings on native replay gap');
assert(upload.includes('finding_created_with_native_replay_gap'), 'upload runner should record native replay gaps after finding creation');

const tools = read('server/src/agent/tools/ai-scan-tools.ts');
assert(tools.includes('return 96;'), 'business logic task expansion should be broad by default');
assert(tools.includes("fallback_tasks_per_vuln_type || 0) || 6"), 'fallback coverage should expand beyond one sampled endpoint');
assert(!tools.includes('block_finding_when_missing: true'), 'workflow precondition blocking should not be hardcoded true');

const routes = read('server/src/routes/ai-scans.ts');
assert(routes.includes("finding_creation_policy = 'judge_or_heuristic_signal'"), 'scan defaults should use discovery-first finding creation policy');
assert(routes.includes('max_tasks_per_vuln_type = 64'), 'scan defaults should raise expansion coverage');

console.log(JSON.stringify({ ok: true, release: '5.0.1-discovery-first-from-0.3.3' }));
