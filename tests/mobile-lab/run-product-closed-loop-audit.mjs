import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = (...parts) => path.join(root, ...parts);

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function text(file) {
  return readFile(src(file), 'utf8');
}

async function main() {
  const app = await text('src/App.tsx');
  const layout = await text('src/components/Layout.tsx');
  const assessment = await text('src/pages/AIScans.tsx');
  const findings = await text('src/pages/Findings.tsx');
  const reports = await text('src/pages/AIReports.tsx');
  const mobileTools = await text('server/src/agent/tools/mobile-scan-tools.ts');
  const planner = await text('server/src/agent/autonomous-planner.ts');
  const mobileRoutes = await text('server/src/routes/mobile.ts');
  const aiScanRoutes = await text('server/src/routes/ai-scans.ts');
  const productState = await text('server/src/services/ai-scan/product-state-service.ts');
  const e2e = await text('tests/mobile-lab/run-mobile-offline-e2e.mjs');

  const workspace = await text('src/components/assessment/AssessmentWorkspace.tsx');
  const results = await text('src/components/assessment/AssessmentResults.tsx');
  const visibleSources = [app, layout, assessment, findings, reports, workspace, results].join('\n');
  const bannedVisibleLabels = [
    'Developer workbench',
    'Request Library',
    'Variable Pool',
    'Workflow Builder',
    'Recorder',
    'Field Memory',
    'Debug Trace',
    'Model Providers',
    'Checklists',
    'Rule Engine',
    'Run History',
    'Shared memory',
    'Agent 内部候选队列',
    'raw candidates',
    'Burp flow export',
    'Android flow steps JSON',
    'App package',
    'Launch activity',
    'Lab profile',
    'tool calls',
    'shared resources',
  ];
  for (const label of bannedVisibleLabels) {
    assert(!visibleSources.includes(label), `User-facing UI still exposes internal label: ${label}`);
  }

  const pageFiles = await readdir(src('src/pages'));
  assert(JSON.stringify(pageFiles.sort()) === JSON.stringify(['AIReports.tsx', 'AIScans.tsx', 'Findings.tsx'].sort()), `Unexpected user-facing pages remain: ${pageFiles.join(', ')}`);

  const archived = await readdir(src('archive/frontend-internal-pages'));
  for (const file of ['ApiTemplates.tsx', 'Workflows.tsx', 'Recordings.tsx', 'TemplateVariableManager.tsx', 'DictionaryManager.tsx', 'DebugPanel.tsx']) {
    assert(archived.includes(file), `Internal page was not removed from src/pages and archived: ${file}`);
  }

  for (const nav of ['assessment', 'findings', 'reports']) {
    assert(app.includes(`'${nav}'`), `App route missing: ${nav}`);
  }
  for (const removedRoute of ['templates', 'workflows', 'recordings', 'dictionary', 'debug', 'ai-providers', 'runs']) {
    assert(!app.includes(`'${removedRoute}'`), `Internal route still exists in App.tsx: ${removedRoute}`);
  }

  for (const phrase of ['业务测试清单', '实际测试过程', '授权测试安装包', '已确认的问题', '完成后自动划线']) {
    assert(visibleSources.includes(phrase), `Assessment UX missing phrase: ${phrase}`);
  }

  for (const tool of ['mobile.lab.prepare', 'mobile.app.launch', 'mobile.observe', 'mobile.flow.run', 'mobile.capture.import']) {
    assert(mobileTools.includes(tool), `Mobile Agent tool not implemented: ${tool}`);
    assert(e2e.includes(tool), `Offline E2E does not verify tool: ${tool}`);
  }

  for (const endpoint of ['/apps/import', '/api/mobile/profiles', '/api/mobile/sessions', '/observe', '/import-capture']) {
    assert(mobileRoutes.includes(endpoint) || e2e.includes(endpoint), `Mobile API loop missing endpoint evidence: ${endpoint}`);
  }

  assert(planner.includes("surface === 'android'") || planner.includes('mobile.lab.prepare'), 'Planner does not branch into Android surface');
  assert(aiScanRoutes.includes('/product-state'), 'Product-state API is missing');
  assert(productState.includes('business_functions') && productState.includes('live_surface') && productState.includes('risk_evidence'), 'Product-state service does not expose the user-facing assessment contract');
  assert(e2e.includes('recording_session_id') && e2e.includes('workflow_draft_count') && e2e.includes('snapshot.endpoints.length'), 'Offline E2E does not assert capture -> recording -> endpoint loop');

  assert(await exists('mobile-lab/offline-kit/scripts/start-offline-lab.sh'), 'Offline Mobile Lab start script missing');
  assert(await exists('mobile-lab/offline-kit/simulator/adb'), 'Offline ADB shim missing');

  console.log(JSON.stringify({
    ok: true,
  evidence_level: 'static_source_contract_not_execution',
    product_ux: {
      user_pages: pageFiles.sort(),
      archived_internal_pages: archived.length,
      banned_labels_removed: bannedVisibleLabels.length,
      product_state_endpoint: true,
      apk_import_endpoint: true,
    },
    e2e_contract: {
      android_agent_tools_verified: ['mobile.lab.prepare', 'mobile.app.launch', 'mobile.observe', 'mobile.flow.run', 'mobile.capture.import'],
      asserted_loop: 'android-ui -> appium-actions -> burp-https-flow -> recording -> endpoint discovery -> agent artifacts',
    },
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
