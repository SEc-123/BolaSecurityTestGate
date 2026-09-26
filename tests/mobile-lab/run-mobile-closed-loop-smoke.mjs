import fs from 'fs';
import path from 'path';

const root = process.cwd();
const requiredFiles = [
  'server/src/routes/mobile.ts',
  'server/src/services/mobile/mobile-lab-service.ts',
  'server/src/services/mobile/android-device-manager.ts',
  'server/src/services/mobile/burp-capture-service.ts',
  'server/src/services/mobile/mobile-traffic-importer.ts',
  'server/src/agent/tools/mobile-scan-tools.ts',
  'src/pages/AIScans.tsx',
  'server/src/services/mobile/mobile-app-service.ts',
  'server/src/services/ai-scan/product-state-service.ts',
  'mobile-lab/flows/example-burp-flow.jsonl',
];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const file of requiredFiles) {
  assert(fs.existsSync(path.join(root, file)), `missing required file: ${file}`);
}

const index = read('server/src/index.ts');
assert(index.includes("./routes/mobile.js"), 'server index does not import mobile routes');
assert(index.includes("app.use('/api/mobile'"), 'server index does not mount /api/mobile');

const agentIndex = read('server/src/agent/index.ts');
assert(agentIndex.includes('buildMobileScanToolSpecs'), 'agent registry does not register mobile tools');

const planner = read('server/src/agent/autonomous-planner.ts');
for (const tool of ['mobile.lab.prepare', 'mobile.app.install', 'mobile.app.launch', 'mobile.observe', 'mobile.flow.run', 'mobile.capture.import']) {
  assert(planner.includes(tool), `planner missing Android discovery tool ${tool}`);
}

const routes = read('server/src/routes/ai-scans.ts');
assert(routes.includes("/:id/run-async"), 'AI scan async run endpoint missing');
assert(routes.includes('/product-state'), 'AI scan product-state endpoint missing');
const mobileRoutes = read('server/src/routes/mobile.ts');
assert(mobileRoutes.includes('/apps/import'), 'Mobile APK import endpoint missing');

const ui = read('src/pages/AIScans.tsx');
for (const needle of ['Android App', '授权测试安装包', '要执行的 App 业务测试', 'AssessmentWorkspace', 'assessmentApi']) {
  assert(ui.includes(needle), `AIScans UI missing ${needle}`);
}

assert(read('src/components/assessment/AssessmentWorkspace.tsx').includes('业务测试清单'), 'Business todo UI missing');
assert(read('src/lib/assessment-api.ts').includes('product-events'), 'Product SSE subscription missing');
const schema = read('server/src/db/schema.ts');
for (const table of ['mobile_lab_profiles', 'mobile_sessions', 'mobile_actions']) {
  assert(schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `schema missing ${table}`);
}

const importer = read('server/src/services/mobile/mobile-traffic-importer.ts');
for (const fn of ['createRecordingSession', 'ingestRecordingEventsBatch', 'regenerateRecordingSessionArtifacts', 'upsertEndpoint']) {
  assert(importer.includes(fn), `mobile importer missing ${fn}`);
}

const jsonlPath = path.join(root, 'mobile-lab/flows/example-burp-flow.jsonl');
const flows = fs.readFileSync(jsonlPath, 'utf8')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => ({ sequence: index + 1, ...JSON.parse(line) }));
assert(flows.length >= 3, 'example Burp flow should include login/create/read sequence');
assert(flows.every(flow => /^https:\/\//.test(flow.url)), 'all example flows should be HTTPS');
assert(flows.some(flow => flow.tls_decrypted === true && flow.response_body_text), 'example flows must show decrypted HTTPS response bodies');
assert(flows.some(flow => /order_id/.test(String(flow.response_body_text))), 'example flow should contain an object id for BOLA/Workflow learning');

const recordingEvents = flows.map(flow => ({
  sequence: flow.sequence,
  source_tool: flow.source_tool || 'internal_burp_mobile',
  method: String(flow.method || 'GET').toUpperCase(),
  url: flow.url,
  request_headers: flow.request_headers || {},
  request_body_text: flow.request_body_text,
  response_status: flow.response_status,
  response_headers: flow.response_headers || {},
  response_body_text: flow.response_body_text,
}));
assert(recordingEvents.every(event => event.method && event.url && event.response_status), 'flow to recording event mapping is incomplete');

const discoveredKeys = new Set(recordingEvents.map(event => `${event.method} ${new URL(event.url).pathname}`));
assert(discoveredKeys.has('POST /login'), 'expected discovered login endpoint');
assert(discoveredKeys.has('POST /orders'), 'expected discovered create order endpoint');
assert(discoveredKeys.has('GET /orders/10086'), 'expected discovered object-read endpoint');

console.log(JSON.stringify({
  ok: true,
  evidence_level: 'static_source_contract_not_execution',
  checks: {
    files: requiredFiles.length,
    productStateEndpoint: true,
    apkImportEndpoint: true,
    mobileToolsRegistered: true,
    asyncRunEndpoint: true,
    controlledAndroidPanel: true,
    mobileTables: 3,
    exampleFlows: flows.length,
    recordingEvents: recordingEvents.length,
    discoveredEndpoints: [...discoveredKeys].sort(),
  },
}, null, 2));
