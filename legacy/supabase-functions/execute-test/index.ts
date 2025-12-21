import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const HEADERS_TO_REMOVE = ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding', 'proxy-connection', 'upgrade', 'te'];

type AccountBindingStrategy = 'independent' | 'per_account' | 'anchor_attacker';
type PathReplacementMode = 'placeholder' | 'segment_index' | 'regex';
type TestRunStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

interface FindingSuppressionRule {
  id: string;
  name: string;
  is_enabled: boolean;
  applies_to: 'test_run' | 'workflow' | 'both';
  match_method: string;
  match_type: 'exact' | 'prefix' | 'regex' | 'contains';
  match_path?: string;
  match_service_id?: string;
  match_template_id?: string;
  match_environment_id?: string;
}

interface VariableConfig {
  id: string;
  name: string;
  json_path: string;
  operation_type: 'replace' | 'append';
  original_value: string;
  data_source?: 'checklist' | 'account_field' | 'security_rule';
  checklist_id?: string;
  security_rule_id?: string;
  account_field_name?: string;
  is_attacker_field?: boolean;
  path_replacement_mode?: PathReplacementMode;
  path_segment_index?: number;
  path_regex_pattern?: string;
  body_content_type?: 'json' | 'form_urlencoded' | 'multipart' | 'text';
}

interface FailurePattern {
  type: 'response_code' | 'response_message' | 'http_status' | 'response_header';
  path?: string;
  operator: 'equals' | 'contains' | 'regex' | 'not_equals' | 'not_contains';
  value: string;
}

interface BaselineConfig {
  comparison_mode?: 'status_and_body' | 'status_only' | 'body_only' | 'custom';
  rules?: {
    compare_status?: boolean;
    compare_body_structure?: boolean;
    compare_business_code?: boolean;
    business_code_path?: string;
    ignore_fields?: string[];
    critical_fields?: string[];
  };
}

interface TestRequest {
  test_run_id: string;
  template_ids: string[];
  account_ids?: string[];
  environment_id?: string;
  security_run_id?: string;
}

interface ParsedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  isExecutionError?: boolean;
  errorMessage?: string;
}

interface ResponseDiff {
  status_changed: boolean;
  business_code_changed: boolean;
  body_diff: {
    added: Record<string, any>;
    removed: Record<string, any>;
    modified: Record<string, any>;
    critical_changes: Record<string, any>;
  };
}

interface ValueCombination {
  values: Record<string, string>;
  accountMap: Record<string, string>;
  attackerId?: string;
  victimIds: string[];
  varConfigs: Record<string, VariableConfig>;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADERS_TO_REMOVE.includes(key.toLowerCase())) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function matchSuppressionRule(
  rule: FindingSuppressionRule,
  method: string,
  path: string,
  requestRaw: string,
  templateId: string,
  environmentId?: string
): boolean {
  if (rule.applies_to !== 'test_run' && rule.applies_to !== 'both') return false;
  if (rule.match_method && rule.match_method !== 'ANY' && rule.match_method !== method) return false;
  if (rule.match_template_id && rule.match_template_id !== templateId) return false;
  if (rule.match_environment_id && environmentId && rule.match_environment_id !== environmentId) return false;
  if (rule.match_service_id && !requestRaw.includes(rule.match_service_id)) return false;
  if (rule.match_path) {
    switch (rule.match_type) {
      case 'exact': if (path !== rule.match_path) return false; break;
      case 'prefix': if (!path.startsWith(rule.match_path)) return false; break;
      case 'contains': if (!path.includes(rule.match_path)) return false; break;
      case 'regex': try { if (!new RegExp(rule.match_path).test(path)) return false; } catch { return false; } break;
    }
  }
  return true;
}

function checkSuppressionRules(
  rules: FindingSuppressionRule[],
  method: string,
  path: string,
  requestRaw: string,
  templateId: string,
  environmentId?: string
): { suppressed: boolean; ruleId?: string; ruleName?: string } {
  for (const rule of rules) {
    if (matchSuppressionRule(rule, method, path, requestRaw, templateId, environmentId)) {
      return { suppressed: true, ruleId: rule.id, ruleName: rule.name };
    }
  }
  return { suppressed: false };
}

function parseRawRequest(rawRequest: string): ParsedRequest | null {
  try {
    const lines = rawRequest.split('\n');
    if (lines.length === 0) return null;
    const firstLine = lines[0].trim();
    const parts = firstLine.split(' ');
    if (parts.length < 2) return null;
    const method = parts[0].toUpperCase();
    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    if (!validMethods.includes(method)) return null;
    const path = parts[1] || '/';
    let headers: Record<string, string> = {};
    let bodyStartIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') { bodyStartIndex = i + 1; break; }
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        if (key && value) headers[key] = value;
      }
    }
    headers = sanitizeHeaders(headers);
    let body: string | undefined;
    if (bodyStartIndex > 0 && bodyStartIndex < lines.length) {
      body = lines.slice(bodyStartIndex).join('\n').trim();
      if (body === '') body = undefined;
    }
    return { method, path, headers, body };
  } catch (e) {
    console.error('Parse error:', e);
    return null;
  }
}

function applyPathReplacement(path: string, varName: string, value: string, mode: PathReplacementMode = 'placeholder', segmentIndex?: number, regexPattern?: string): string {
  switch (mode) {
    case 'placeholder': return path.replace(new RegExp(`{${varName}}`.replace(/[{}]/g, '\\$&'), 'g'), value);
    case 'segment_index': { if (segmentIndex === undefined) return path; const segments = path.split('/'); if (segmentIndex >= 0 && segmentIndex < segments.length) segments[segmentIndex] = value; return segments.join('/'); }
    case 'regex': { if (!regexPattern) return path; try { return path.replace(new RegExp(regexPattern), value); } catch { return path; } }
    default: return path;
  }
}

function detectContentType(headers: Record<string, string>, body?: string): string {
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  if (contentType.includes('application/json')) return 'json';
  if (contentType.includes('application/x-www-form-urlencoded')) return 'form_urlencoded';
  if (contentType.includes('multipart/form-data')) return 'multipart';
  if (body) { try { JSON.parse(body); return 'json'; } catch { if (body.includes('=') && (body.includes('&') || !body.includes('\n'))) return 'form_urlencoded'; } }
  return 'text';
}

function applyJsonBodyReplacement(body: string, jsonPath: string, value: string, operationType: 'replace' | 'append', originalValue: string): string {
  try {
    const bodyObj = JSON.parse(body);
    const pathParts = jsonPath.replace(/^body\./, '').split('.');
    let current: any = bodyObj;
    for (let i = 0; i < pathParts.length - 1; i++) { if (current[pathParts[i]] === undefined) current[pathParts[i]] = {}; current = current[pathParts[i]]; }
    const lastKey = pathParts[pathParts.length - 1];
    if (operationType === 'replace') current[lastKey] = value; else current[lastKey] = String(current[lastKey] || originalValue) + value;
    return JSON.stringify(bodyObj);
  } catch { return body; }
}

function applyFormUrlencodedReplacement(body: string, jsonPath: string, value: string, operationType: 'replace' | 'append', originalValue: string): string {
  const fieldName = jsonPath.replace(/^body\./, '');
  const params = new URLSearchParams(body);
  if (operationType === 'replace') params.set(fieldName, value); else params.set(fieldName, (params.get(fieldName) || originalValue) + value);
  return params.toString();
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=([^;]+)/);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

function applyMultipartReplacement(body: string, headers: Record<string, string>, jsonPath: string, value: string): string {
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  const boundary = extractBoundary(contentType);
  if (!boundary) return body;
  const fieldName = jsonPath.replace(/^body\./, '');
  const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const updatedParts = parts.map(part => {
    if (part.includes(`name="${fieldName}"`) || part.includes(`name=${fieldName}`)) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd !== -1) return part.substring(0, headerEnd) + '\r\n\r\n' + value;
    }
    return part;
  });
  return updatedParts.join(`--${boundary}`);
}

function applyTextReplacement(body: string, jsonPath: string, value: string): string {
  if (jsonPath.startsWith('regex:')) { try { return body.replace(new RegExp(jsonPath.substring(6), 'g'), value); } catch { return body; } }
  const key = jsonPath.replace(/^body\./, '');
  return body.replace(new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^&\\n\\r]+)`, 'g'), `${key}=${value}`);
}

function applyVariableToBody(body: string, headers: Record<string, string>, varConfig: VariableConfig, value: string): string {
  const contentType = varConfig.body_content_type || detectContentType(headers, body);
  switch (contentType) {
    case 'json': return applyJsonBodyReplacement(body, varConfig.json_path, value, varConfig.operation_type, varConfig.original_value);
    case 'form_urlencoded': return applyFormUrlencodedReplacement(body, varConfig.json_path, value, varConfig.operation_type, varConfig.original_value);
    case 'multipart': return applyMultipartReplacement(body, headers, varConfig.json_path, value);
    case 'text': return applyTextReplacement(body, varConfig.json_path, value);
    default: return applyJsonBodyReplacement(body, varConfig.json_path, value, varConfig.operation_type, varConfig.original_value);
  }
}

function generateAccountCombinations(variables: VariableConfig[], accounts: any[], checklists: Map<string, any>, securityRules: Map<string, any>, strategy: AccountBindingStrategy, attackerAccountId?: string): ValueCombination[] {
  const accountVars = variables.filter(v => v.data_source === 'account_field' && v.account_field_name);
  const otherVars = variables.filter(v => v.data_source !== 'account_field');
  let otherValueSets: Array<{ values: Record<string, string>; configs: Record<string, VariableConfig> }> = [{ values: {}, configs: {} }];
  for (const variable of otherVars) {
    let values: string[] = [];
    if (variable.data_source === 'checklist' && variable.checklist_id) values = checklists.get(variable.checklist_id)?.config?.values || [];
    else if (variable.data_source === 'security_rule' && variable.security_rule_id) values = securityRules.get(variable.security_rule_id)?.payloads || [];
    if (values.length === 0) values = [variable.original_value];
    const newSets: typeof otherValueSets = [];
    for (const set of otherValueSets) for (const value of values) newSets.push({ values: { ...set.values, [variable.name]: value }, configs: { ...set.configs, [variable.name]: variable } });
    otherValueSets = newSets;
  }
  if (accountVars.length === 0) return otherValueSets.map(set => ({ values: set.values, accountMap: {}, victimIds: [], varConfigs: set.configs }));
  const combinations: ValueCombination[] = [];
  switch (strategy) {
    case 'independent': {
      let accountCombos: Array<{ values: Record<string, string>; accountMap: Record<string, string>; configs: Record<string, VariableConfig> }> = [{ values: {}, accountMap: {}, configs: {} }];
      for (const variable of accountVars) {
        const varValues: Array<{ value: string; accountId: string }> = [];
        for (const account of accounts) { const value = account.fields?.[variable.account_field_name!]; if (value !== undefined && value !== null && value !== '') varValues.push({ value: String(value), accountId: account.id }); }
        if (varValues.length === 0) varValues.push({ value: variable.original_value, accountId: '' });
        const newCombos: typeof accountCombos = [];
        for (const combo of accountCombos) for (const vv of varValues) newCombos.push({ values: { ...combo.values, [variable.name]: vv.value }, accountMap: { ...combo.accountMap, [variable.name]: vv.accountId }, configs: { ...combo.configs, [variable.name]: variable } });
        accountCombos = newCombos;
      }
      for (const otherSet of otherValueSets) for (const accountCombo of accountCombos) { const allAccountIds = new Set(Object.values(accountCombo.accountMap).filter(id => id)); combinations.push({ values: { ...otherSet.values, ...accountCombo.values }, accountMap: accountCombo.accountMap, victimIds: Array.from(allAccountIds), varConfigs: { ...otherSet.configs, ...accountCombo.configs } }); }
      break;
    }
    case 'per_account': {
      for (const account of accounts) {
        const values: Record<string, string> = {}; const accountMap: Record<string, string> = {}; const configs: Record<string, VariableConfig> = {}; let hasAllVars = true;
        for (const variable of accountVars) { const value = account.fields?.[variable.account_field_name!]; if (value === undefined || value === null || value === '') { hasAllVars = false; break; } values[variable.name] = String(value); accountMap[variable.name] = account.id; configs[variable.name] = variable; }
        if (hasAllVars) for (const otherSet of otherValueSets) combinations.push({ values: { ...otherSet.values, ...values }, accountMap, victimIds: [account.id], varConfigs: { ...otherSet.configs, ...configs } });
      }
      break;
    }
    case 'anchor_attacker': {
      if (!attackerAccountId) return generateAccountCombinations(variables, accounts, checklists, securityRules, 'independent');
      const attacker = accounts.find(a => a.id === attackerAccountId);
      if (!attacker) return generateAccountCombinations(variables, accounts, checklists, securityRules, 'independent');
      const victims = accounts.filter(a => a.id !== attackerAccountId);
      const attackerVars = accountVars.filter(v => v.is_attacker_field);
      const victimVars = accountVars.filter(v => !v.is_attacker_field);
      const attackerValues: Record<string, string> = {}; const attackerMap: Record<string, string> = {}; const attackerConfigs: Record<string, VariableConfig> = {};
      for (const variable of attackerVars) { const value = attacker.fields?.[variable.account_field_name!]; if (value !== undefined && value !== null && value !== '') { attackerValues[variable.name] = String(value); attackerMap[variable.name] = attacker.id; attackerConfigs[variable.name] = variable; } }
      if (victimVars.length === 0) { for (const otherSet of otherValueSets) combinations.push({ values: { ...otherSet.values, ...attackerValues }, accountMap: attackerMap, attackerId: attacker.id, victimIds: [], varConfigs: { ...otherSet.configs, ...attackerConfigs } }); }
      else { for (const victim of victims) { const victimValues: Record<string, string> = {}; const victimMap: Record<string, string> = {}; const victimConfigs: Record<string, VariableConfig> = {}; let hasAllVictimVars = true; for (const variable of victimVars) { const value = victim.fields?.[variable.account_field_name!]; if (value === undefined || value === null || value === '') { hasAllVictimVars = false; break; } victimValues[variable.name] = String(value); victimMap[variable.name] = victim.id; victimConfigs[variable.name] = variable; } if (hasAllVictimVars) for (const otherSet of otherValueSets) combinations.push({ values: { ...otherSet.values, ...attackerValues, ...victimValues }, accountMap: { ...attackerMap, ...victimMap }, attackerId: attacker.id, victimIds: [victim.id], varConfigs: { ...otherSet.configs, ...attackerConfigs, ...victimConfigs } }); } }
      break;
    }
  }
  return combinations.length > 0 ? combinations : [{ values: {}, accountMap: {}, victimIds: [], varConfigs: {} }];
}

function extractValueByPath(obj: any, path: string): any {
  const parts = path.split('.'); let current = obj;
  for (const part of parts) { if (current === null || current === undefined) return undefined; current = current[part]; }
  return current;
}

function deepCompare(obj1: any, obj2: any, ignoreFields: string[], criticalFields: string[], path: string = ''): ResponseDiff['body_diff'] {
  const result: ResponseDiff['body_diff'] = { added: {}, removed: {}, modified: {}, critical_changes: {} };
  if (typeof obj1 !== 'object' || typeof obj2 !== 'object' || obj1 === null || obj2 === null) {
    if (obj1 !== obj2) { result.modified[path || '_root'] = { baseline: obj1, mutated: obj2 }; if (criticalFields.some(f => path.includes(f))) result.critical_changes[path || '_root'] = { baseline: obj1, mutated: obj2 }; }
    return result;
  }
  for (const key in obj1) { const fullPath = path ? `${path}.${key}` : key; if (ignoreFields.includes(fullPath) || ignoreFields.includes(key)) continue; if (!(key in obj2)) { result.removed[fullPath] = obj1[key]; if (criticalFields.some(f => fullPath.includes(f) || f === key)) result.critical_changes[fullPath] = { removed: obj1[key] }; } else if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') { const nested = deepCompare(obj1[key], obj2[key], ignoreFields, criticalFields, fullPath); Object.assign(result.added, nested.added); Object.assign(result.removed, nested.removed); Object.assign(result.modified, nested.modified); Object.assign(result.critical_changes, nested.critical_changes); } else if (obj1[key] !== obj2[key]) { result.modified[fullPath] = { baseline: obj1[key], mutated: obj2[key] }; if (criticalFields.some(f => fullPath.includes(f) || f === key)) result.critical_changes[fullPath] = { baseline: obj1[key], mutated: obj2[key] }; } }
  for (const key in obj2) { const fullPath = path ? `${path}.${key}` : key; if (ignoreFields.includes(fullPath) || ignoreFields.includes(key)) continue; if (!(key in obj1)) { result.added[fullPath] = obj2[key]; if (criticalFields.some(f => fullPath.includes(f) || f === key)) result.critical_changes[fullPath] = { added: obj2[key] }; } }
  return result;
}

function compareResponses(baseline: HttpResponse, mutated: HttpResponse, config: BaselineConfig): ResponseDiff {
  const diff: ResponseDiff = { status_changed: false, business_code_changed: false, body_diff: { added: {}, removed: {}, modified: {}, critical_changes: {} } };
  const rules = config.rules || {};
  if (rules.compare_status !== false) diff.status_changed = baseline.status !== mutated.status;
  let baselineBody: any = null; let mutatedBody: any = null;
  try { baselineBody = JSON.parse(baseline.body); mutatedBody = JSON.parse(mutated.body); } catch { if (rules.compare_body_structure !== false && baseline.body !== mutated.body) diff.body_diff.modified['_raw'] = { baseline: baseline.body.substring(0, 500), mutated: mutated.body.substring(0, 500), different: true }; return diff; }
  if (rules.compare_business_code && rules.business_code_path) diff.business_code_changed = extractValueByPath(baselineBody, rules.business_code_path) !== extractValueByPath(mutatedBody, rules.business_code_path);
  if (rules.compare_body_structure !== false) diff.body_diff = deepCompare(baselineBody, mutatedBody, rules.ignore_fields || [], rules.critical_fields || []);
  return diff;
}

function checkFailurePatterns(patterns: FailurePattern[], logic: 'OR' | 'AND', statusCode: number, responseBody: string, responseHeaders: Record<string, string>): boolean {
  if (!patterns || patterns.length === 0) return false;
  let parsedBody: any = null; try { parsedBody = JSON.parse(responseBody); } catch {}
  const results = patterns.map(pattern => {
    let targetValue = '';
    if (pattern.type === 'http_status') targetValue = statusCode.toString();
    else if (pattern.type === 'response_header' && pattern.path) targetValue = responseHeaders[pattern.path] || responseHeaders[pattern.path.toLowerCase()] || '';
    else if ((pattern.type === 'response_code' || pattern.type === 'response_message') && parsedBody && pattern.path) { let current = parsedBody; for (const part of pattern.path.split('.')) { if (current === null || current === undefined) break; current = current[part]; } targetValue = String(current ?? ''); }
    switch (pattern.operator) {
      case 'equals': return targetValue === pattern.value;
      case 'not_equals': return targetValue !== pattern.value;
      case 'contains': return targetValue.includes(pattern.value);
      case 'not_contains': return !targetValue.includes(pattern.value);
      case 'regex': try { return new RegExp(pattern.value).test(targetValue); } catch { return false; }
    }
    return false;
  });
  return logic === 'OR' ? results.some(r => r) : results.every(r => r);
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries: number = 2): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (error: any) { lastError = error; if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); }
  }
  throw lastError || new Error('Request failed after retries');
}

async function executeRequest(baseUrl: string, parsedRequest: ParsedRequest): Promise<HttpResponse> {
  const url = baseUrl + parsedRequest.path;
  try {
    const response = await fetchWithRetry(url, { method: parsedRequest.method, headers: parsedRequest.headers, body: ['GET', 'HEAD'].includes(parsedRequest.method) ? undefined : parsedRequest.body });
    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => { responseHeaders[k] = v; });
    return { status: response.status, headers: responseHeaders, body: responseBody, isExecutionError: false };
  } catch (e: any) {
    return { status: 0, headers: {}, body: `Error: ${e.message}`, isExecutionError: true, errorMessage: e.message };
  }
}

function buildRequest(parsedRequest: ParsedRequest, combination: ValueCombination): ParsedRequest {
  let requestPath = parsedRequest.path; let requestBody = parsedRequest.body; const requestHeaders = { ...parsedRequest.headers };
  for (const [varName, value] of Object.entries(combination.values)) {
    const varConfig = combination.varConfigs[varName]; if (!varConfig) continue;
    const jsonPath = varConfig.json_path;
    if (jsonPath.startsWith('path.')) requestPath = applyPathReplacement(requestPath, jsonPath.replace('path.', ''), value, varConfig.path_replacement_mode || 'placeholder', varConfig.path_segment_index, varConfig.path_regex_pattern);
    else if (jsonPath.startsWith('body.') && requestBody) requestBody = applyVariableToBody(requestBody, requestHeaders, varConfig, value);
    else if (jsonPath.startsWith('headers.')) { const headerName = jsonPath.replace('headers.', ''); if (varConfig.operation_type === 'replace') requestHeaders[headerName] = value; else requestHeaders[headerName] = (requestHeaders[headerName] || varConfig.original_value) + value; }
    else if (jsonPath.startsWith('query.')) { const paramName = jsonPath.replace('query.', ''); const urlObj = new URL(requestPath, 'http://placeholder'); if (varConfig.operation_type === 'replace') urlObj.searchParams.set(paramName, value); else urlObj.searchParams.set(paramName, (urlObj.searchParams.get(paramName) || varConfig.original_value) + value); requestPath = urlObj.pathname + urlObj.search; }
  }
  return { method: parsedRequest.method, path: requestPath, headers: requestHeaders, body: requestBody };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);
  let testRunId: string | null = null;

  try {
    const requestBody = await req.json();
    const { test_run_id, template_ids, account_ids, environment_id, security_run_id }: TestRequest = requestBody;
    testRunId = test_run_id;

    if (!test_run_id) return new Response(JSON.stringify({ error: 'test_run_id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!template_ids || template_ids.length === 0) {
      await supabase.from('test_runs').update({ status: 'failed', error_message: 'No API templates selected', completed_at: new Date().toISOString() }).eq('id', test_run_id);
      return new Response(JSON.stringify({ error: 'template_ids required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    await supabase.from('test_runs').update({ status: 'running', started_at: new Date().toISOString(), error_message: null, progress: { total: 0, completed: 0, findings: 0, errors_count: 0, current_template: 'Initializing...' } }).eq('id', test_run_id);

    const { data: templates, error: templatesError } = await supabase.from('api_templates').select('*, account_binding_strategy, attacker_account_id, enable_baseline, baseline_config, advanced_config').in('id', template_ids);
    if (templatesError) throw new Error(`Failed to fetch templates: ${templatesError.message}`);
    if (!templates || templates.length === 0) throw new Error('No templates found with the provided IDs');

    let environment = null;
    if (environment_id) { const { data, error } = await supabase.from('environments').select('*').eq('id', environment_id).maybeSingle(); if (error) throw new Error(`Failed to fetch environment: ${error.message}`); environment = data; }

    let accounts: any[] = [];
    if (account_ids && account_ids.length > 0) { const { data, error } = await supabase.from('accounts').select('*').in('id', account_ids); if (error) throw new Error(`Failed to fetch accounts: ${error.message}`); accounts = data || []; }

    const checklistIds = new Set<string>(); const securityRuleIds = new Set<string>();
    templates.forEach(t => { const vars = t.variables as VariableConfig[] || []; vars.forEach(v => { if (v.data_source === 'checklist' && v.checklist_id) checklistIds.add(v.checklist_id); if (v.security_rule_id) securityRuleIds.add(v.security_rule_id); }); });

    let checklists: any[] = []; if (checklistIds.size > 0) { const { data } = await supabase.from('checklists').select('*').in('id', Array.from(checklistIds)); checklists = data || []; }
    let securityRules: any[] = []; if (securityRuleIds.size > 0) { const { data } = await supabase.from('security_rules').select('*').in('id', Array.from(securityRuleIds)); securityRules = data || []; }
    const { data: suppressionRules } = await supabase.from('finding_suppression_rules').select('*').eq('is_enabled', true);
    const activeSuppressionRules: FindingSuppressionRule[] = suppressionRules || [];

    const checklistMap = new Map(checklists.map(c => [c.id, c]));
    const ruleMap = new Map(securityRules.map(r => [r.id, r]));
    const baseUrl = environment?.base_url || '';
    if (baseUrl && !validateUrl(baseUrl)) throw new Error(`Invalid base URL: ${baseUrl}`);

    let findingsCount = 0; let suppressedCount = 0; let totalTests = 0; let completedTests = 0; let errorsCount = 0;
    const errors: string[] = [];

    for (const template of templates) {
      const variables = template.variables as VariableConfig[] || [];
      const failurePatterns = template.failure_patterns as FailurePattern[] || [];
      const failureLogic = (template.failure_logic || 'OR') as 'OR' | 'AND';
      const rawRequest = template.raw_request || '';
      const bindingStrategy = (template.account_binding_strategy || 'independent') as AccountBindingStrategy;
      const attackerAccountId = template.attacker_account_id;
      const enableBaseline = template.enable_baseline || false;
      const baselineConfig = (template.baseline_config || {}) as BaselineConfig;

      if (!rawRequest) { errors.push(`Template "${template.name}" has no raw request configured`); continue; }
      const parsedRequest = parseRawRequest(rawRequest);
      if (!parsedRequest) { errors.push(`Template "${template.name}" has invalid HTTP request format`); continue; }

      const valueCombinations = generateAccountCombinations(variables, accounts, checklistMap, ruleMap, bindingStrategy, attackerAccountId);
      const limitedCombinations = valueCombinations.slice(0, 1000);
      if (valueCombinations.length > 1000) errors.push(`Template "${template.name}": Limited to 1000 combinations`);
      totalTests += limitedCombinations.length;

      await supabase.from('test_runs').update({ progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount, current_template: template.name } }).eq('id', test_run_id);

      for (const combination of limitedCombinations) {
        const mutatedRequest = buildRequest(parsedRequest, combination);
        const url = baseUrl + mutatedRequest.path;
        if (!validateUrl(url)) { errors.push(`Invalid URL: ${url}`); errorsCount++; completedTests++; continue; }

        let baselineResponse: HttpResponse | null = null;
        if (enableBaseline && bindingStrategy === 'anchor_attacker' && combination.attackerId) {
          const attackerAccount = accounts.find(a => a.id === combination.attackerId);
          if (attackerAccount) {
            const baselineValues: Record<string, string> = {}; const baselineConfigs: Record<string, VariableConfig> = {};
            for (const variable of variables) {
              if (variable.data_source === 'account_field' && variable.account_field_name) { const value = attackerAccount.fields?.[variable.account_field_name]; if (value !== undefined && value !== null) { baselineValues[variable.name] = String(value); baselineConfigs[variable.name] = variable; } }
              else if (combination.values[variable.name]) { baselineValues[variable.name] = combination.values[variable.name]; baselineConfigs[variable.name] = variable; }
            }
            const baselineCombination: ValueCombination = { values: baselineValues, accountMap: {}, victimIds: [], varConfigs: baselineConfigs };
            const baselineRequest = buildRequest(parsedRequest, baselineCombination);
            baselineResponse = await executeRequest(baseUrl, baselineRequest);
            if (baselineResponse.isExecutionError || baselineResponse.status === 0) { errorsCount++; completedTests++; continue; }
            if (checkFailurePatterns(failurePatterns, failureLogic, baselineResponse.status, baselineResponse.body, baselineResponse.headers)) { completedTests++; continue; }
          }
        }

        const mutatedResponse = await executeRequest(baseUrl, mutatedRequest);
        if (mutatedResponse.isExecutionError || mutatedResponse.status === 0) { errors.push(`Request failed for ${url}: ${mutatedResponse.errorMessage || 'status=0'}`); errorsCount++; completedTests++; continue; }

        const mutatedIsFailure = checkFailurePatterns(failurePatterns, failureLogic, mutatedResponse.status, mutatedResponse.body, mutatedResponse.headers);
        let isVulnerability = false; let responseDiff: ResponseDiff | null = null;

        if (!mutatedIsFailure && mutatedResponse.status > 0) {
          if (enableBaseline && baselineResponse) {
            responseDiff = compareResponses(baselineResponse, mutatedResponse, baselineConfig);
            isVulnerability = responseDiff.status_changed || responseDiff.business_code_changed || Object.keys(responseDiff.body_diff.critical_changes).length > 0 || Object.keys(responseDiff.body_diff.modified).length > 0;
          } else { isVulnerability = true; }
        }

        completedTests++;
        const progressPercent = Math.round((completedTests / totalTests) * 100);

        if (isVulnerability) {
          const requestRaw = `${mutatedRequest.method} ${url}\n${Object.entries(mutatedRequest.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${mutatedRequest.body || ''}`;
          const suppressionCheck = checkSuppressionRules(activeSuppressionRules, mutatedRequest.method, mutatedRequest.path, requestRaw, template.id, environment_id);
          const findingData = {
            source_type: 'test_run', test_run_id, security_run_id: security_run_id || null, api_template_id: template.id, template_id: template.id, workflow_id: null,
            severity: 'medium', status: 'new', title: `Potential vulnerability: ${template.name}`,
            description: enableBaseline && responseDiff ? `Response succeeded and differs from baseline. Variable values: ${JSON.stringify(combination.values)}` : `Response did not match failure patterns. Variable values: ${JSON.stringify(combination.values)}`,
            template_name: template.name, variable_values: combination.values, request_raw: requestRaw,
            response_status: mutatedResponse.status, response_headers: mutatedResponse.headers, response_body: mutatedResponse.body.substring(0, 50000),
            account_source_map: combination.accountMap, attacker_account_id: combination.attackerId || null, victim_account_ids: combination.victimIds,
            baseline_response: baselineResponse ? { status: baselineResponse.status, headers: baselineResponse.headers, body: baselineResponse.body.substring(0, 20000) } : null,
            mutated_response: { status: mutatedResponse.status, headers: mutatedResponse.headers, body: mutatedResponse.body.substring(0, 20000) },
            response_diff: responseDiff, is_suppressed: suppressionCheck.suppressed, suppression_rule_id: suppressionCheck.ruleId || null,
          };
          await supabase.from('findings').insert(findingData);
          if (suppressionCheck.suppressed) suppressedCount++; else findingsCount++;
        }

        await supabase.from('test_runs').update({ progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount, current_template: template.name }, progress_percent: progressPercent }).eq('id', test_run_id);
      }
    }

    const hasExecutionError = errorsCount > 0;
    let finalStatus: TestRunStatus = 'completed';
    if (completedTests === 0 && errors.length > 0) finalStatus = 'failed';
    else if (hasExecutionError) finalStatus = 'completed_with_errors';

    await supabase.from('test_runs').update({
      status: finalStatus, completed_at: new Date().toISOString(), progress_percent: 100,
      error_message: errors.length > 0 ? errors.slice(0, 10).join('; ') : null,
      errors_count: errorsCount, has_execution_error: hasExecutionError,
      progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount }
    }).eq('id', test_run_id);

    return new Response(JSON.stringify({ success: true, test_run_id, total_tests: totalTests, findings_count: findingsCount, suppressed_count: suppressedCount, errors_count: errorsCount, has_execution_error: hasExecutionError, errors: errors.length > 0 ? errors : undefined }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('Test execution error:', error);
    if (testRunId) await supabase.from('test_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error_message: error.message || 'Unknown error occurred', has_execution_error: true }).eq('id', testRunId);
    return new Response(JSON.stringify({ error: error.message || 'Unknown error', has_execution_error: true }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
