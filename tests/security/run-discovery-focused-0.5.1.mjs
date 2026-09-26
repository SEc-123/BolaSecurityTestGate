import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const files = [
  'server/src/agent/tool-registry.ts',
  'server/src/agent/autonomous-planner.ts',
  'server/src/routes/ai-scans.ts',
  'server/src/services/ai-scan/browser/persistent-browser-runtime.ts',
  'server/src/services/ai-scan/generic-vuln-runner.ts',
  'server/src/services/ai-scan/file-upload-runner.ts',
];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  assert(!/traffic_budget|scan_traffic_budget|allowed_tool_capabilities|allowed_tool_side_effect_levels|bounded autonomy|evidence contract blocked/i.test(text), `${file} still contains hard governance wording`);
}

for (const removed of [
  'server/src/services/ai-scan/scan-traffic-governor.ts',
  'server/src/agent/tool-contract.ts',
  'server/src/agent/bounded-autonomy.ts',
  'server/src/services/ai-scan/evidence-contracts.ts',
  'server/src/services/ai-scan/asset-lifecycle.ts',
]) {
  assert(!existsSync(removed), `${removed} should not exist in discovery-focused 0.5.1`);
}

const generic = readFileSync('server/src/services/ai-scan/generic-vuln-runner.ts', 'utf8');
assert(/if \(judge\.verdict === 'vulnerable'\) \{/.test(generic), 'generic runner should create findings from vulnerable AI judgement');
assert(/finding_created_with_replay_gap/.test(generic), 'generic runner should record replay gaps instead of blocking');

const browser = readFileSync('server/src/services/ai-scan/browser/persistent-browser-runtime.ts', 'utf8');
assert(/Passive page resources/.test(browser), 'browser runtime should document passive resource allowance');
console.log('Discovery-focused 0.5.1 guardrail check passed');
