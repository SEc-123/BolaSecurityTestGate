import assert from 'node:assert/strict';
import { buildAIScanToolSpecs } from '../../server/dist/agent/tools/ai-scan-tools.js';

const expectedAllVulns = [
  'file_upload',
  'file_download',
  'path_traversal',
  'bola_idor',
  'bfla',
  'business_logic',
  'xss',
  'command_injection',
  'auth_otp',
  'email_sms_bypass',
  'passcode_bypass',
  'replay_race',
  'state_machine_race',
  'known_vulnerable_component',
];

const endpoints = [
  { id: 'ep-order', scan_run_id: 'scan-full', method: 'POST', path: '/api/order/pay', url: 'http://127.0.0.1/api/order/pay', request_summary: 'order_id amount payment form', response_summary: '', feature_guess: '交易订单', source_type: 'browser_js_reference' },
  { id: 'ep-upload', scan_run_id: 'scan-full', method: 'POST', path: '/api/file/upload', url: 'http://127.0.0.1/api/file/upload', request_summary: 'multipart upload file', response_summary: '', content_type: 'multipart/form-data', feature_guess: '文件处理', source_type: 'browser_form' },
  { id: 'ep-login', scan_run_id: 'scan-full', method: 'POST', path: '/api/login', url: 'http://127.0.0.1/api/login', request_summary: 'login username password', response_summary: '', feature_guess: '认证账号', source_type: 'browser_js_reference' },
  { id: 'ep-admin', scan_run_id: 'scan-full', method: 'GET', path: '/admin/users', url: 'http://127.0.0.1/admin/users', request_summary: 'admin users role permission', response_summary: '', feature_guess: '后台管理', source_type: 'browser_page' },
  { id: 'ep-search', scan_run_id: 'scan-full', method: 'GET', path: '/search', url: 'http://127.0.0.1/search?q=hello', request_summary: 'search q comment content', response_summary: '', feature_guess: '内容社区', source_type: 'browser_page' },
  { id: 'ep-ping', scan_run_id: 'scan-full', method: 'POST', path: '/api/ping', url: 'http://127.0.0.1/api/ping', request_summary: 'host domain command ping', response_summary: '', feature_guess: '通用功能', source_type: 'browser_js_reference' },
];
const features = endpoints.map((endpoint, index) => ({ id: `feat-${index + 1}`, scan_run_id: 'scan-full', name: endpoint.feature_guess || endpoint.path, node_type: 'feature', confidence: 0.7, evidence_artifact_ids: [], endpoint_ids: [endpoint.id] }));
const candidates = [
  { id: 'cand-bola', scan_run_id: 'scan-full', feature_id: 'feat-1', vuln_type: 'bola_idor', title: 'order bola', confidence: 0.9, endpoint_ids: ['ep-order'], required_accounts: [] },
];
const fingerprints = [
  { id: 'fp-express', scan_run_id: 'scan-full', component_name: 'express', component_type: 'framework', version: '4.17.1', confidence: 0.95, evidence_source: 'test_fixture', evidence_detail: {}, cpe_candidates: [], purl_candidates: ['pkg:npm/express@4.17.1'], first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString() },
];
const historicalVulns = [
  { id: 'hv-express', scan_run_id: 'scan-full', fingerprint_id: 'fp-express', component_name: 'express', component_version: '4.17.1', source: 'mock', source_id: 'CVE-2099-0001', cve_id: 'CVE-2099-0001', title: 'Mock Express historical vulnerability', severity: 'medium', cvss: 6.5, cisa_kev: false, affected_versions: ['>=4.0.0 <4.18.3'], fixed_versions: ['4.18.3'], references: [], match_confidence: 0.95, match_reason: 'test fixture exact version match', poc_template: { risk_level: 'low', requires_lab_mode: false, request_sequence: [{ method: 'GET', path: '/' }], success_signals: [{ type: 'status', value: '200' }], failure_signals: [] }, raw: {}, created_at: new Date().toISOString() },
];
const pocExecutions = [];
const tasks = [];
const artifacts = [];
const resources = [];

const fakeRepo = {
  async getRun() { return { id: 'scan-full', scan_config: { driving_mode: 'autopilot', fallback_tasks_per_vuln_type: 1 }, selected_vuln_types: expectedAllVulns }; },
  async listEndpoints() { return endpoints; },
  async listFeatures() { return features; },
  async listCandidates() { return candidates; },
  async listTasks() { return tasks; },
  async listTechFingerprints() { return fingerprints; },
  async listHistoricalVulns() { return historicalVulns; },
  async listPocExecutions() { return pocExecutions; },
  async createPocExecution(input) {
    const execution = { id: `poc-${pocExecutions.length + 1}`, scan_run_id: 'scan-full', status: 'planned', evidence: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...input };
    pocExecutions.push(execution);
    return execution;
  },
  async createTask(input) {
    const task = { id: `task-${tasks.length + 1}`, dependencies: [], endpoint_ids: [], execution_plan: {}, priority: 100, status: 'pending', ...input };
    tasks.push(task);
    return task;
  },
  async createArtifact(input) {
    const artifact = { id: `artifact-${artifacts.length + 1}`, ...input };
    artifacts.push(artifact);
    return artifact;
  },
  async upsertSharedResource(input) {
    const resource = { id: `resource-${resources.length + 1}`, usage_count: 0, ...input };
    resources.push(resource);
    return resource;
  },
  async listSharedResources() { return resources; },
  async getSharedResource(_scanRunId, type, key) { return resources.find(resource => resource.resource_type === type && resource.resource_key === key) || null; },
};
const fakeDb = { runRawQuery: async () => [], repos: { accounts: { findAll: async () => [] } } };

const tool = buildAIScanToolSpecs().find(item => item.name === 'task.expand_selected_vulnerabilities');
assert.ok(tool, 'expand tool exists');
const result = await tool.handler({ selected_vuln_types: expectedAllVulns }, { db: fakeDb, repo: fakeRepo, scanRunId: 'scan-full', taskId: 'task-model' });
assert.equal(result.ok, true);
assert.equal(result.data.coverage.all_selected_types_covered, true);
assert.deepEqual(new Set(result.data.coverage.child_task_vuln_types), new Set(expectedAllVulns));
assert.equal(tasks.filter(task => task.task_type === 'summarize_vulnerability_campaign').length, expectedAllVulns.length);
assert.ok(result.data.coverage.fallback_vuln_types.length > 0, 'fallback coverage should fill missing candidate types');
assert.ok(artifacts.some(artifact => artifact.artifact_type === 'autopilot_vulnerability_coverage_matrix'));
console.log('autopilot full coverage regression passed');
