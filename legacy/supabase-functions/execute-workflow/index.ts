import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const HEADERS_TO_REMOVE = ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding', 'proxy-connection', 'upgrade', 'te'];

type AccountBindingStrategy = 'independent' | 'per_account' | 'anchor_attacker';
type VariableRole = 'attacker' | 'target' | 'neutral';
type WorkflowAssertionStrategy = 'any_step_pass' | 'all_steps_pass' | 'last_step_pass' | 'specific_steps';
type PathReplacementMode = 'placeholder' | 'segment_index' | 'regex';
type ExtractorSource = 'response_body_jsonpath' | 'response_body_regex' | 'response_header' | 'response_status';
type TestRunStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';
type AssertionOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'regex';
type AssertionsMode = 'all' | 'any';

interface FindingSuppressionRule { id: string; name: string; is_enabled: boolean; applies_to: 'test_run' | 'workflow' | 'both'; match_method: string; match_type: 'exact' | 'prefix' | 'regex' | 'contains'; match_path?: string; match_service_id?: string; match_workflow_id?: string; match_environment_id?: string; }
interface WorkflowRequest { test_run_id: string; workflow_id: string; account_ids?: string[]; environment_id?: string; security_run_id?: string; }
interface StepVariableMapping { step_order: number; json_path: string; original_value: string; }
interface WorkflowVariableConfig { id: string; name: string; step_variable_mappings: StepVariableMapping[]; data_source: 'checklist' | 'account_field' | 'security_rule' | 'workflow_context'; checklist_id?: string; security_rule_id?: string; account_field_name?: string; is_attacker_field?: boolean; role?: VariableRole; binding_strategy?: AccountBindingStrategy; attacker_account_id?: string; advanced_config?: { path_replacement_mode?: PathReplacementMode; path_segment_index?: number; path_regex_pattern?: string; body_content_type?: 'json' | 'form_urlencoded' | 'multipart' | 'text'; }; }
interface ExtractorTransform { type: 'trim' | 'lower' | 'upper' | 'prefix' | 'suffix'; value?: string; }
interface WorkflowExtractor { id: string; workflow_id: string; step_order: number; name: string; source: ExtractorSource; expression: string; transform?: ExtractorTransform; required: boolean; }
interface SessionJarConfig { body_json_paths?: string[]; header_keys?: string[]; cookie_mode?: boolean; }
interface FailurePattern { type: 'response_code' | 'response_message' | 'http_status' | 'response_header'; path?: string; operator: 'equals' | 'contains' | 'regex' | 'not_equals' | 'not_contains'; value: string; }
interface BaselineConfig { comparison_mode?: 'status_and_body' | 'status_only' | 'body_only' | 'custom'; rules?: { compare_status?: boolean; compare_body_structure?: boolean; compare_business_code?: boolean; business_code_path?: string; ignore_fields?: string[]; critical_fields?: string[]; }; ignore_paths?: string[]; critical_paths?: string[]; diff_threshold?: number; }
interface HttpResponse { status: number; headers: Record<string, string>; body: string; }
interface StepAssertionLeft { type: 'response'; path: string; }
interface StepAssertionRight { type: 'literal' | 'workflow_variable' | 'workflow_context'; value?: string; key?: string; }
interface StepAssertion { op: AssertionOperator; left: StepAssertionLeft; right: StepAssertionRight; missing_behavior?: 'fail' | 'skip'; }
interface AssertionResult { assertion: StepAssertion; passed: boolean; left_value: string; right_value: string; }
interface StepExecution { step_order: number; template_name: string; url: string; method: string; headers: Record<string, string>; body?: string; response: HttpResponse; matchedFailurePattern: boolean; assertionsPassed: boolean; assertionsMode?: AssertionsMode; assertionResults?: AssertionResult[]; executed: boolean; isExecutionError?: boolean; errorMessage?: string; }
interface ResponseDiff { status_changed: boolean; business_code_changed: boolean; body_diff: { added: Record<string, any>; removed: Record<string, any>; modified: Record<string, any>; critical_changes: Record<string, any>; }; }
interface ValueCombination { values: Record<string, string>; accountMap: Record<string, string>; attackerId?: string; victimIds: string[]; }
interface WorkflowContext { extractedValues: Record<string, string>; cookies: Record<string, string>; sessionFields: Record<string, string>; }

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADERS_TO_REMOVE.includes(key.toLowerCase())) sanitized[key] = value;
  }
  return sanitized;
}

function validateUrl(url: string): boolean { try { new URL(url); return true; } catch { return false; } }

function checkSuppressionRulesForWorkflow(rules: FindingSuppressionRule[], workflowId: string, workflowName: string, stepExecutions: StepExecution[], environmentId?: string): { suppressed: boolean; ruleId?: string; ruleName?: string } {
  for (const rule of rules) {
    if (rule.applies_to !== 'workflow' && rule.applies_to !== 'both') continue;
    if (rule.match_workflow_id && rule.match_workflow_id !== workflowId) continue;
    if (rule.match_environment_id && environmentId && rule.match_environment_id !== environmentId) continue;
    let matchFound = false;
    for (const step of stepExecutions) {
      let methodMatches = !rule.match_method || rule.match_method === 'ANY' || rule.match_method === step.method;
      if (!methodMatches) continue;
      let pathMatches = true;
      if (rule.match_path) {
        switch (rule.match_type) {
          case 'exact': case 'prefix': case 'contains': pathMatches = step.url.includes(rule.match_path); break;
          case 'regex': try { pathMatches = new RegExp(rule.match_path).test(step.url); } catch { pathMatches = false; } break;
        }
      }
      let serviceIdMatches = !rule.match_service_id || step.url.includes(rule.match_service_id) || JSON.stringify(step.headers).includes(rule.match_service_id);
      if (methodMatches && pathMatches && serviceIdMatches) { matchFound = true; break; }
    }
    if (matchFound) return { suppressed: true, ruleId: rule.id, ruleName: rule.name };
  }
  return { suppressed: false };
}

function parseRawRequest(rawRequest: string): any | null {
  try {
    const lines = rawRequest.split('\n'); if (lines.length === 0) return null;
    const firstLine = lines[0].trim(); const parts = firstLine.split(' ');
    if (parts.length < 2) return null;
    const method = parts[0].toUpperCase(); const path = parts[1] || '/';
    let headers: Record<string, string> = {}; let bodyStartIndex = -1;
    for (let i = 1; i < lines.length; i++) { const line = lines[i].trim(); if (line === '') { bodyStartIndex = i + 1; break; } const colonIndex = line.indexOf(':'); if (colonIndex > 0) { const key = line.substring(0, colonIndex).trim(); const value = line.substring(colonIndex + 1).trim(); if (key && value) headers[key] = value; } }
    headers = sanitizeHeaders(headers);
    let body: string | undefined;
    if (bodyStartIndex > 0 && bodyStartIndex < lines.length) { body = lines.slice(bodyStartIndex).join('\n').trim(); if (body === '') body = undefined; }
    return { method, path, headers, body };
  } catch { return null; }
}

function applyPathReplacement(path: string, varName: string, value: string, mode: PathReplacementMode = 'placeholder', segmentIndex?: number, regexPattern?: string): string {
  switch (mode) {
    case 'placeholder': return path.replace(new RegExp(`{${varName}}`.replace(/[{}]/g, '\\$&'), 'g'), value);
    case 'segment_index': if (segmentIndex === undefined) return path; const segments = path.split('/'); if (segmentIndex >= 0 && segmentIndex < segments.length) segments[segmentIndex] = value; return segments.join('/');
    case 'regex': if (!regexPattern) return path; try { return path.replace(new RegExp(regexPattern), value); } catch { return path; }
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

function applyJsonBodyReplacement(body: string, jsonPath: string, value: string): string {
  try { const bodyObj = JSON.parse(body); const pathParts = jsonPath.replace(/^body\./, '').split('.'); let current: any = bodyObj; for (let i = 0; i < pathParts.length - 1; i++) { if (current[pathParts[i]] === undefined) current[pathParts[i]] = {}; current = current[pathParts[i]]; } current[pathParts[pathParts.length - 1]] = value; return JSON.stringify(bodyObj); } catch { return body; }
}

function applyFormUrlencodedReplacement(body: string, jsonPath: string, value: string): string { const fieldName = jsonPath.replace(/^body\./, ''); const params = new URLSearchParams(body); params.set(fieldName, value); return params.toString(); }

function extractBoundary(contentType: string): string | null { const match = contentType.match(/boundary=([^;]+)/); return match ? match[1].trim().replace(/^["']|["']$/g, '') : null; }

function applyMultipartReplacement(body: string, headers: Record<string, string>, jsonPath: string, value: string): string {
  const contentType = headers['content-type'] || headers['Content-Type'] || ''; const boundary = extractBoundary(contentType); if (!boundary) return body;
  const fieldName = jsonPath.replace(/^body\./, ''); const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const updatedParts = parts.map(part => { if (part.includes(`name="${fieldName}"`) || part.includes(`name=${fieldName}`)) { const headerEnd = part.indexOf('\r\n\r\n'); if (headerEnd !== -1) return part.substring(0, headerEnd) + '\r\n\r\n' + value; } return part; });
  return updatedParts.join(`--${boundary}`);
}

function applyTextReplacement(body: string, jsonPath: string, value: string): string {
  if (jsonPath.startsWith('regex:')) { try { return body.replace(new RegExp(jsonPath.substring(6), 'g'), value); } catch { return body; } }
  const key = jsonPath.replace(/^body\./, ''); return body.replace(new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^&\\n\\r]+)`, 'g'), `${key}=${value}`);
}

function applyVariableToRequest(parsedRequest: any, jsonPath: string, value: string, originalValue: string, advancedConfig?: WorkflowVariableConfig['advanced_config']): any {
  const result = { ...parsedRequest, headers: { ...parsedRequest.headers }, body: parsedRequest.body, path: parsedRequest.path };
  if (jsonPath.startsWith('body.') && result.body) {
    const contentType = advancedConfig?.body_content_type || detectContentType(result.headers, result.body);
    switch (contentType) {
      case 'json': result.body = applyJsonBodyReplacement(result.body, jsonPath, value); break;
      case 'form_urlencoded': result.body = applyFormUrlencodedReplacement(result.body, jsonPath, value); break;
      case 'multipart': result.body = applyMultipartReplacement(result.body, result.headers, jsonPath, value); break;
      case 'text': result.body = applyTextReplacement(result.body, jsonPath, value); break;
      default: result.body = applyJsonBodyReplacement(result.body, jsonPath, value);
    }
  } else if (jsonPath.startsWith('path.')) { result.path = applyPathReplacement(result.path, jsonPath.replace('path.', ''), value, advancedConfig?.path_replacement_mode || 'placeholder', advancedConfig?.path_segment_index, advancedConfig?.path_regex_pattern); }
  else if (jsonPath.startsWith('headers.')) { result.headers[jsonPath.replace('headers.', '')] = value; }
  else if (jsonPath.startsWith('query.')) { const urlObj = new URL(result.path, 'http://placeholder'); urlObj.searchParams.set(jsonPath.replace('query.', ''), value); result.path = urlObj.pathname + urlObj.search; }
  return result;
}

function getAssertionLeftValue(left: StepAssertionLeft, response: HttpResponse): { value: string; isMissing: boolean } {
  if (left.type !== 'response') return { value: '', isMissing: true };
  const path = left.path;
  if (path.startsWith('body.')) {
    try {
      const bodyObj = JSON.parse(response.body);
      const pathParts = path.replace('body.', '').split('.');
      let current: any = bodyObj;
      for (const part of pathParts) {
        if (current === null || current === undefined) return { value: '', isMissing: true };
        current = current[part];
      }
      if (current === undefined || current === null) return { value: '', isMissing: true };
      return { value: String(current), isMissing: false };
    } catch { return { value: '', isMissing: true }; }
  } else if (path.startsWith('headers.')) {
    const headerKey = path.replace('headers.', '');
    const headerValue = response.headers[headerKey] || response.headers[headerKey.toLowerCase()];
    if (!headerValue) return { value: '', isMissing: true };
    return { value: headerValue, isMissing: false };
  } else if (path === 'status') {
    return { value: String(response.status), isMissing: false };
  }
  return { value: '', isMissing: true };
}

function getAssertionRightValue(right: StepAssertionRight, variableValues: Record<string, string>, context: WorkflowContext): string {
  switch (right.type) {
    case 'literal':
      return right.value || '';
    case 'workflow_variable':
      return variableValues[right.key || ''] || '';
    case 'workflow_context':
      return context.extractedValues[right.key || ''] || '';
    default:
      return '';
  }
}

function evaluateAssertionOp(leftValue: string, op: AssertionOperator, rightValue: string): boolean {
  switch (op) {
    case 'equals': return leftValue === rightValue;
    case 'not_equals': return leftValue !== rightValue;
    case 'contains': return leftValue.includes(rightValue);
    case 'not_contains': return !leftValue.includes(rightValue);
    case 'regex': try { return new RegExp(rightValue).test(leftValue); } catch { return false; }
    default: return false;
  }
}

function evaluateStepAssertions(
  assertions: StepAssertion[],
  mode: AssertionsMode,
  response: HttpResponse,
  variableValues: Record<string, string>,
  context: WorkflowContext
): { passed: boolean; results: AssertionResult[] } {
  if (!assertions || assertions.length === 0) {
    return { passed: true, results: [] };
  }
  const results: AssertionResult[] = [];
  const evaluatedResults: AssertionResult[] = [];

  for (const assertion of assertions) {
    const leftResult = getAssertionLeftValue(assertion.left, response);
    const rightValue = getAssertionRightValue(assertion.right, variableValues, context);
    const missingBehavior = assertion.missing_behavior || 'fail';

    if (leftResult.isMissing && missingBehavior === 'skip') {
      results.push({ assertion, passed: true, left_value: leftResult.value, right_value: rightValue });
      continue;
    }

    const passed = evaluateAssertionOp(leftResult.value, assertion.op, rightValue);
    results.push({ assertion, passed, left_value: leftResult.value, right_value: rightValue });
    evaluatedResults.push({ assertion, passed, left_value: leftResult.value, right_value: rightValue });
  }

  if (evaluatedResults.length === 0) {
    return { passed: true, results };
  }

  const overallPassed = mode === 'all'
    ? evaluatedResults.every(r => r.passed)
    : evaluatedResults.some(r => r.passed);
  return { passed: overallPassed, results };
}

function checkFailurePatterns(patterns: FailurePattern[], logic: 'OR' | 'AND', statusCode: number, responseBody: string, responseHeaders: Record<string, string>): boolean {
  if (!patterns || patterns.length === 0) return false;
  let parsedBody: any = null; try { parsedBody = JSON.parse(responseBody); } catch {}
  const results = patterns.map(pattern => {
    let targetValue = '';
    if (pattern.type === 'http_status') targetValue = statusCode.toString();
    else if (pattern.type === 'response_header' && pattern.path) targetValue = responseHeaders[pattern.path] || responseHeaders[pattern.path.toLowerCase()] || '';
    else if ((pattern.type === 'response_code' || pattern.type === 'response_message') && parsedBody && pattern.path) { let current = parsedBody; for (const part of pattern.path.split('.')) { if (current === null || current === undefined) break; current = current[part]; } targetValue = String(current ?? ''); }
    switch (pattern.operator) { case 'equals': return targetValue === pattern.value; case 'not_equals': return targetValue !== pattern.value; case 'contains': return targetValue.includes(pattern.value); case 'not_contains': return !targetValue.includes(pattern.value); case 'regex': try { return new RegExp(pattern.value).test(targetValue); } catch { return false; } }
    return false;
  });
  return logic === 'OR' ? results.some(r => r) : results.every(r => r);
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries: number = 2): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { const controller = new AbortController(); const timeoutId = setTimeout(() => controller.abort(), 30000); const response = await fetch(url, { ...options, signal: controller.signal }); clearTimeout(timeoutId); return response; }
    catch (error: any) { lastError = error; if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); }
  }
  throw lastError || new Error('Request failed after retries');
}

function extractValueByJsonPath(obj: any, jsonPath: string): any {
  const path = jsonPath.replace(/^\$\.?/, ''); if (!path) return obj; let current = obj;
  for (const part of path.split('.')) { if (current === null || current === undefined) return undefined; const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/); if (arrayMatch) { current = current[arrayMatch[1]]; if (Array.isArray(current)) current = current[parseInt(arrayMatch[2])]; else return undefined; } else { current = current[part]; } }
  return current;
}

function extractValueByRegex(text: string, pattern: string): string | null { try { const match = text.match(new RegExp(pattern)); if (match) return match[1] || match[0]; return null; } catch { return null; } }

function applyTransform(value: string, transform?: ExtractorTransform): string {
  if (!transform) return value;
  switch (transform.type) { case 'trim': return value.trim(); case 'lower': return value.toLowerCase(); case 'upper': return value.toUpperCase(); case 'prefix': return (transform.value || '') + value; case 'suffix': return value + (transform.value || ''); default: return value; }
}

function executeExtractors(extractors: WorkflowExtractor[], stepOrder: number, response: HttpResponse, context: WorkflowContext): { success: boolean; errors: string[] } {
  const stepExtractors = extractors.filter(e => e.step_order === stepOrder); const errors: string[] = [];
  for (const extractor of stepExtractors) {
    let extractedValue: string | null = null;
    switch (extractor.source) {
      case 'response_body_jsonpath': try { const bodyObj = JSON.parse(response.body); const value = extractValueByJsonPath(bodyObj, extractor.expression); if (value !== undefined && value !== null) extractedValue = typeof value === 'object' ? JSON.stringify(value) : String(value); } catch {} break;
      case 'response_body_regex': extractedValue = extractValueByRegex(response.body, extractor.expression); break;
      case 'response_header': { const headerValue = response.headers[extractor.expression] || response.headers[extractor.expression.toLowerCase()] || response.headers[extractor.expression.toUpperCase()]; if (headerValue) extractedValue = headerValue; break; }
      case 'response_status': extractedValue = String(response.status); break;
    }
    if (extractedValue !== null) { extractedValue = applyTransform(extractedValue, extractor.transform as ExtractorTransform | undefined); context.extractedValues[extractor.name] = extractedValue; }
    else if (extractor.required) { errors.push(`Required extractor "${extractor.name}" failed to extract value from step ${stepOrder}`); }
  }
  return { success: errors.length === 0, errors };
}

function parseCookies(setCookieHeader: string): Record<string, string> { const cookies: Record<string, string> = {}; for (const part of setCookieHeader.split(',')) { const cookiePart = part.split(';')[0].trim(); const eqIndex = cookiePart.indexOf('='); if (eqIndex > 0) { cookies[cookiePart.substring(0, eqIndex).trim()] = cookiePart.substring(eqIndex + 1).trim(); } } return cookies; }

function updateSessionJar(response: HttpResponse, context: WorkflowContext, config: SessionJarConfig): void {
  if (config.cookie_mode !== false) { const setCookie = response.headers['set-cookie'] || response.headers['Set-Cookie']; if (setCookie) Object.assign(context.cookies, parseCookies(setCookie)); }
  if (config.header_keys && config.header_keys.length > 0) { for (const key of config.header_keys) { const value = response.headers[key] || response.headers[key.toLowerCase()]; if (value) context.sessionFields[`header.${key}`] = value; } }
  if (config.body_json_paths && config.body_json_paths.length > 0) { try { const bodyObj = JSON.parse(response.body); for (const path of config.body_json_paths) { const value = extractValueByJsonPath(bodyObj, path); if (value !== undefined && value !== null) context.sessionFields[`body.${path}`] = typeof value === 'object' ? JSON.stringify(value) : String(value); } } catch {} }
}

function applySessionJarToRequest(parsedRequest: any, context: WorkflowContext, sessionJarConfig: SessionJarConfig): any {
  const result = { ...parsedRequest, headers: { ...parsedRequest.headers }, body: parsedRequest.body };
  if (sessionJarConfig.cookie_mode !== false && Object.keys(context.cookies).length > 0) { const cookieString = Object.entries(context.cookies).map(([n, v]) => `${n}=${v}`).join('; '); const existing = result.headers['Cookie'] || result.headers['cookie'] || ''; result.headers['Cookie'] = existing ? `${existing}; ${cookieString}` : cookieString; }
  if (sessionJarConfig.body_json_paths && sessionJarConfig.body_json_paths.length > 0 && result.body) { try { const bodyObj = JSON.parse(result.body); for (const path of sessionJarConfig.body_json_paths) { const sessionValue = context.sessionFields[`body.${path}`] || context.extractedValues[path.replace(/^\$\.?/, '').split('.').pop() || '']; if (sessionValue) { const pathParts = path.replace(/^\$\.?/, '').split('.'); let current: any = bodyObj; for (let i = 0; i < pathParts.length - 1; i++) { if (current[pathParts[i]] === undefined) current[pathParts[i]] = {}; current = current[pathParts[i]]; } const lastPart = pathParts[pathParts.length - 1]; if (current[lastPart] !== undefined) current[lastPart] = sessionValue; } } result.body = JSON.stringify(bodyObj); } catch {} }
  return result;
}

function applyContextVariables(parsedRequest: any, context: WorkflowContext, configs: WorkflowVariableConfig[], stepOrder: number): any {
  let result = { ...parsedRequest, headers: { ...parsedRequest.headers }, body: parsedRequest.body, path: parsedRequest.path };
  const contextConfigs = configs.filter(c => c.data_source === 'workflow_context');
  for (const config of contextConfigs) { const contextValue = context.extractedValues[config.name]; if (!contextValue) continue; const stepMapping = config.step_variable_mappings.find(m => m.step_order === stepOrder); if (stepMapping) result = applyVariableToRequest(result, stepMapping.json_path, contextValue, stepMapping.original_value, config.advanced_config); }
  return result;
}

function generateAccountCombinations(configs: WorkflowVariableConfig[], accounts: any[], checklists: Map<string, any>, securityRules: Map<string, any>, globalBindingStrategy?: AccountBindingStrategy, globalAttackerAccountId?: string): ValueCombination[] {
  const accountVars = configs.filter(c => c.data_source === 'account_field' && c.account_field_name);
  const otherVars = configs.filter(c => c.data_source !== 'account_field' && c.data_source !== 'workflow_context');
  let otherValueSets: Array<{ values: Record<string, string> }> = [{ values: {} }];
  for (const config of otherVars) {
    let values: string[] = [];
    if (config.data_source === 'checklist' && config.checklist_id) values = checklists.get(config.checklist_id)?.config?.values || [];
    else if (config.data_source === 'security_rule' && config.security_rule_id) values = securityRules.get(config.security_rule_id)?.payloads || [];
    if (values.length === 0) continue;
    const newSets: typeof otherValueSets = [];
    for (const set of otherValueSets) for (const value of values) newSets.push({ values: { ...set.values, [config.name]: value } });
    otherValueSets = newSets;
  }
  if (accountVars.length === 0) return otherValueSets.map(set => ({ values: set.values, accountMap: {}, victimIds: [] }));
  const strategy = globalBindingStrategy || accountVars.find(v => v.binding_strategy)?.binding_strategy || 'per_account';
  const attackerAccountId = globalAttackerAccountId || accountVars.find(v => v.attacker_account_id)?.attacker_account_id;
  const combinations: ValueCombination[] = [];
  switch (strategy) {
    case 'independent': {
      let accountCombos: Array<{ values: Record<string, string>; accountMap: Record<string, string> }> = [{ values: {}, accountMap: {} }];
      for (const config of accountVars) { const varValues: Array<{ value: string; accountId: string }> = []; for (const account of accounts) { const value = account.fields?.[config.account_field_name!]; if (value !== undefined && value !== null && value !== '') varValues.push({ value: String(value), accountId: account.id }); } if (varValues.length === 0) continue; const newCombos: typeof accountCombos = []; for (const combo of accountCombos) for (const vv of varValues) newCombos.push({ values: { ...combo.values, [config.name]: vv.value }, accountMap: { ...combo.accountMap, [config.name]: vv.accountId } }); accountCombos = newCombos; }
      for (const otherSet of otherValueSets) for (const accountCombo of accountCombos) combinations.push({ values: { ...otherSet.values, ...accountCombo.values }, accountMap: accountCombo.accountMap, victimIds: Array.from(new Set(Object.values(accountCombo.accountMap).filter(id => id))) });
      break;
    }
    case 'per_account': {
      for (const account of accounts) { const values: Record<string, string> = {}; const accountMap: Record<string, string> = {}; let hasAllVars = true; for (const config of accountVars) { const value = account.fields?.[config.account_field_name!]; if (value === undefined || value === null || value === '') { hasAllVars = false; break; } values[config.name] = String(value); accountMap[config.name] = account.id; } if (hasAllVars) for (const otherSet of otherValueSets) combinations.push({ values: { ...otherSet.values, ...values }, accountMap, victimIds: [account.id] }); }
      break;
    }
    case 'anchor_attacker': {
      if (!attackerAccountId) return generateAccountCombinations(configs, accounts, checklists, securityRules, 'per_account');
      const attacker = accounts.find(a => a.id === attackerAccountId); if (!attacker) return generateAccountCombinations(configs, accounts, checklists, securityRules, 'per_account');
      const victims = accounts.filter(a => a.id !== attackerAccountId);
      const attackerVars = accountVars.filter(v => v.is_attacker_field || v.role === 'attacker');
      const victimVars = accountVars.filter(v => !v.is_attacker_field && v.role !== 'attacker');
      const attackerValues: Record<string, string> = {}; const attackerMap: Record<string, string> = {};
      for (const config of attackerVars) { const value = attacker.fields?.[config.account_field_name!]; if (value !== undefined && value !== null && value !== '') { attackerValues[config.name] = String(value); attackerMap[config.name] = attacker.id; } }
      if (victimVars.length === 0) { for (const otherSet of otherValueSets) combinations.push({ values: { ...otherSet.values, ...attackerValues }, accountMap: attackerMap, attackerId: attacker.id, victimIds: [] }); }
      else { for (const victim of victims) { const victimValues: Record<string, string> = {}; const victimMap: Record<string, string> = {}; let hasAllVictimVars = true; for (const config of victimVars) { const value = victim.fields?.[config.account_field_name!]; if (value === undefined || value === null || value === '') { hasAllVictimVars = false; break; } victimValues[config.name] = String(value); victimMap[config.name] = victim.id; } if (hasAllVictimVars) for (const otherSet of otherValueSets) combinations.push({ values: { ...otherSet.values, ...attackerValues, ...victimValues }, accountMap: { ...attackerMap, ...victimMap }, attackerId: attacker.id, victimIds: [victim.id] }); } }
      break;
    }
  }
  return combinations.length > 0 ? combinations : [{ values: {}, accountMap: {}, victimIds: [] }];
}

function isStepPass(step: StepExecution): boolean {
  return step.executed && step.response.status > 0 && !step.matchedFailurePattern && step.assertionsPassed;
}

function evaluateWorkflowAssertion(stepExecutions: StepExecution[], strategy: WorkflowAssertionStrategy, criticalStepOrders: number[]): boolean {
  switch (strategy) {
    case 'any_step_pass': return stepExecutions.some(step => isStepPass(step));
    case 'all_steps_pass': return stepExecutions.every(step => isStepPass(step));
    case 'last_step_pass': { if (stepExecutions.length === 0) return false; const lastStep = stepExecutions[stepExecutions.length - 1]; return isStepPass(lastStep); }
    case 'specific_steps': { if (criticalStepOrders.length === 0) return stepExecutions.some(step => isStepPass(step)); const criticalSteps = stepExecutions.filter(step => criticalStepOrders.includes(step.step_order)); return criticalSteps.length > 0 && criticalSteps.every(step => isStepPass(step)); }
    default: return stepExecutions.some(step => isStepPass(step));
  }
}

function validateStepCompleteness(stepExecutions: StepExecution[], expectedStepCount: number): { valid: boolean; reason?: string; hasExecutionError: boolean } {
  if (stepExecutions.length !== expectedStepCount) return { valid: false, reason: `Expected ${expectedStepCount} steps but only ${stepExecutions.length} were attempted`, hasExecutionError: true };
  const unexecutedSteps = stepExecutions.filter(s => !s.executed);
  if (unexecutedSteps.length > 0) return { valid: false, reason: `Steps ${unexecutedSteps.map(s => s.step_order).join(', ')} were not executed`, hasExecutionError: true };
  const zeroStatusSteps = stepExecutions.filter(s => s.response.status === 0);
  if (zeroStatusSteps.length > 0) return { valid: false, reason: `Steps ${zeroStatusSteps.map(s => s.step_order).join(', ')} received no response (status=0)`, hasExecutionError: true };
  return { valid: true, hasExecutionError: false };
}

function deepCompare(obj1: any, obj2: any, ignoreFields: string[], criticalFields: string[], path: string = ''): ResponseDiff['body_diff'] {
  const result: ResponseDiff['body_diff'] = { added: {}, removed: {}, modified: {}, critical_changes: {} };
  if (typeof obj1 !== 'object' || typeof obj2 !== 'object' || obj1 === null || obj2 === null) { if (obj1 !== obj2) { result.modified[path || '_root'] = { baseline: obj1, mutated: obj2 }; if (criticalFields.some(f => path.includes(f))) result.critical_changes[path || '_root'] = { baseline: obj1, mutated: obj2 }; } return result; }
  for (const key in obj1) { const fullPath = path ? `${path}.${key}` : key; if (ignoreFields.includes(fullPath) || ignoreFields.includes(key)) continue; if (!(key in obj2)) { result.removed[fullPath] = obj1[key]; if (criticalFields.some(f => fullPath.includes(f) || f === key)) result.critical_changes[fullPath] = { removed: obj1[key] }; } else if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') { const nested = deepCompare(obj1[key], obj2[key], ignoreFields, criticalFields, fullPath); Object.assign(result.added, nested.added); Object.assign(result.removed, nested.removed); Object.assign(result.modified, nested.modified); Object.assign(result.critical_changes, nested.critical_changes); } else if (obj1[key] !== obj2[key]) { result.modified[fullPath] = { baseline: obj1[key], mutated: obj2[key] }; if (criticalFields.some(f => fullPath.includes(f) || f === key)) result.critical_changes[fullPath] = { baseline: obj1[key], mutated: obj2[key] }; } }
  for (const key in obj2) { const fullPath = path ? `${path}.${key}` : key; if (ignoreFields.includes(fullPath) || ignoreFields.includes(key)) continue; if (!(key in obj1)) { result.added[fullPath] = obj2[key]; if (criticalFields.some(f => fullPath.includes(f) || f === key)) result.critical_changes[fullPath] = { added: obj2[key] }; } }
  return result;
}

function compareWorkflowResponses(baselineSteps: StepExecution[], mutatedSteps: StepExecution[], config: BaselineConfig): ResponseDiff {
  const diff: ResponseDiff = { status_changed: false, business_code_changed: false, body_diff: { added: {}, removed: {}, modified: {}, critical_changes: {} } };
  const rules = config.rules || {};
  const ignorePaths = config.ignore_paths || rules.ignore_fields || [];
  const criticalPaths = config.critical_paths || rules.critical_fields || [];
  for (let i = 0; i < Math.min(baselineSteps.length, mutatedSteps.length); i++) {
    const baselineStep = baselineSteps[i]; const mutatedStep = mutatedSteps[i];
    if (rules.compare_status !== false && baselineStep.response.status !== mutatedStep.response.status) { diff.status_changed = true; diff.body_diff.modified[`step_${baselineStep.step_order}_status`] = { baseline: baselineStep.response.status, mutated: mutatedStep.response.status }; if (criticalPaths.includes('status')) diff.body_diff.critical_changes[`step_${baselineStep.step_order}_status`] = { baseline: baselineStep.response.status, mutated: mutatedStep.response.status }; }
    try { const baselineBody = JSON.parse(baselineStep.response.body); const mutatedBody = JSON.parse(mutatedStep.response.body); if (rules.compare_business_code && rules.business_code_path && extractValueByJsonPath(baselineBody, rules.business_code_path) !== extractValueByJsonPath(mutatedBody, rules.business_code_path)) diff.business_code_changed = true; if (rules.compare_body_structure !== false) { const stepDiff = deepCompare(baselineBody, mutatedBody, ignorePaths, criticalPaths); for (const [key, value] of Object.entries(stepDiff.added)) diff.body_diff.added[`step_${baselineStep.step_order}.${key}`] = value; for (const [key, value] of Object.entries(stepDiff.removed)) diff.body_diff.removed[`step_${baselineStep.step_order}.${key}`] = value; for (const [key, value] of Object.entries(stepDiff.modified)) diff.body_diff.modified[`step_${baselineStep.step_order}.${key}`] = value; for (const [key, value] of Object.entries(stepDiff.critical_changes)) diff.body_diff.critical_changes[`step_${baselineStep.step_order}.${key}`] = value; } } catch {}
  }
  return diff;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);
  let testRunId: string | null = null;

  try {
    const requestBody = await req.json();
    const { test_run_id, workflow_id, account_ids, environment_id, security_run_id }: WorkflowRequest = requestBody;
    testRunId = test_run_id;

    if (!test_run_id || !workflow_id) return new Response(JSON.stringify({ error: 'test_run_id and workflow_id are required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    await supabase.from('test_runs').update({ status: 'running', started_at: new Date().toISOString(), error_message: null, progress: { total: 0, completed: 0, findings: 0, errors_count: 0, current_template: 'Loading workflow...' } }).eq('id', test_run_id);

    const { data: workflow, error: workflowError } = await supabase.from('workflows').select('*, assertion_strategy, critical_step_orders, enable_baseline, baseline_config, enable_extractor, enable_session_jar, session_jar_config, account_binding_strategy, attacker_account_id').eq('id', workflow_id).single();
    if (workflowError || !workflow) throw new Error(`Failed to fetch workflow: ${workflowError?.message || 'Not found'}`);

    const assertionStrategy = (workflow.assertion_strategy || 'any_step_pass') as WorkflowAssertionStrategy;
    const criticalStepOrders = (workflow.critical_step_orders || []) as number[];
    const enableBaseline = workflow.enable_baseline || false;
    const baselineConfig = (workflow.baseline_config || {}) as BaselineConfig;
    const enableExtractor = workflow.enable_extractor || false;
    const enableSessionJar = workflow.enable_session_jar || false;
    const sessionJarConfig = (workflow.session_jar_config || { cookie_mode: true }) as SessionJarConfig;
    const globalBindingStrategy = workflow.account_binding_strategy as AccountBindingStrategy | undefined;
    const globalAttackerAccountId = workflow.attacker_account_id;

    const { data: steps, error: stepsError } = await supabase.from('workflow_steps').select('*, step_assertions, assertions_mode, api_template:api_templates(*)').eq('workflow_id', workflow_id).order('step_order', { ascending: true });
    if (stepsError) throw new Error(`Failed to fetch workflow steps: ${stepsError.message}`);
    if (!steps || steps.length === 0) throw new Error('Workflow has no steps configured');
    const expectedStepCount = steps.length;

    let extractors: WorkflowExtractor[] = [];
    if (enableExtractor) { const { data: extractorData } = await supabase.from('workflow_extractors').select('*').eq('workflow_id', workflow_id).order('step_order', { ascending: true }); extractors = (extractorData || []) as WorkflowExtractor[]; }

    const { data: variableConfigs } = await supabase.from('workflow_variable_configs').select('*, binding_strategy, attacker_account_id, advanced_config, role').eq('workflow_id', workflow_id);
    const configs: WorkflowVariableConfig[] = variableConfigs || [];

    let environment = null;
    if (environment_id) { const { data } = await supabase.from('environments').select('*').eq('id', environment_id).maybeSingle(); environment = data; }

    let accounts: any[] = [];
    if (account_ids && account_ids.length > 0) { const { data } = await supabase.from('accounts').select('*').in('id', account_ids); accounts = data || []; }

    const checklistIds = new Set<string>(); const securityRuleIds = new Set<string>();
    configs.forEach(c => { if (c.data_source === 'checklist' && c.checklist_id) checklistIds.add(c.checklist_id); if (c.data_source === 'security_rule' && c.security_rule_id) securityRuleIds.add(c.security_rule_id); });

    let checklists: any[] = []; if (checklistIds.size > 0) { const { data } = await supabase.from('checklists').select('*').in('id', Array.from(checklistIds)); checklists = data || []; }
    let securityRules: any[] = []; if (securityRuleIds.size > 0) { const { data } = await supabase.from('security_rules').select('*').in('id', Array.from(securityRuleIds)); securityRules = data || []; }
    const { data: suppressionRules } = await supabase.from('finding_suppression_rules').select('*').eq('is_enabled', true);
    const activeSuppressionRules: FindingSuppressionRule[] = suppressionRules || [];

    const checklistMap = new Map(checklists.map(c => [c.id, c]));
    const ruleMap = new Map(securityRules.map(r => [r.id, r]));
    const baseUrl = environment?.base_url || '';
    if (baseUrl && !validateUrl(baseUrl)) throw new Error(`Invalid base URL: ${baseUrl}`);

    const valueCombinations = generateAccountCombinations(configs, accounts, checklistMap, ruleMap, globalBindingStrategy, globalAttackerAccountId);
    const limitedCombinations = valueCombinations.slice(0, 500);
    const totalTests = limitedCombinations.length;
    let completedTests = 0; let findingsCount = 0; let suppressedCount = 0; let errorsCount = 0;
    const errors: string[] = [];

    await supabase.from('test_runs').update({ progress: { total: totalTests, completed: 0, findings: 0, errors_count: 0, current_template: workflow.name } }).eq('id', test_run_id);

    for (const combination of limitedCombinations) {
      const context: WorkflowContext = { extractedValues: {}, cookies: {}, sessionFields: {} };
      const stepExecutions: StepExecution[] = [];
      const variableValues: Record<string, string> = { ...combination.values };
      let baselineStepExecutions: StepExecution[] | null = null;
      let extractorFailed = false; let extractorErrors: string[] = [];
      let combinationHasError = false;

      if (enableBaseline && (globalBindingStrategy === 'anchor_attacker') && combination.attackerId) {
        const attackerAccount = accounts.find(a => a.id === combination.attackerId);
        if (attackerAccount) {
          baselineStepExecutions = [];
          const baselineContext: WorkflowContext = { extractedValues: {}, cookies: {}, sessionFields: {} };
          const baselineValues: Record<string, string> = {};
          for (const config of configs) { if (config.data_source === 'account_field' && config.account_field_name) { const value = attackerAccount.fields?.[config.account_field_name]; if (value !== undefined && value !== null) baselineValues[config.name] = String(value); } else if (combination.values[config.name]) { baselineValues[config.name] = combination.values[config.name]; } }
          for (const step of steps) {
            const template = step.api_template;
            const stepAssertions = (step.step_assertions || []) as StepAssertion[];
            const assertionsMode = (step.assertions_mode || 'all') as AssertionsMode;
            if (!template) { baselineStepExecutions.push({ step_order: step.step_order, template_name: 'Unknown', url: '', method: 'GET', headers: {}, response: { status: 0, headers: {}, body: 'Template missing' }, matchedFailurePattern: false, assertionsPassed: true, executed: false, isExecutionError: true }); continue; }
            let parsedRequest = parseRawRequest(template.raw_request || '');
            if (!parsedRequest) { baselineStepExecutions.push({ step_order: step.step_order, template_name: template.name, url: '', method: 'GET', headers: {}, response: { status: 0, headers: {}, body: 'Invalid request format' }, matchedFailurePattern: false, assertionsPassed: true, executed: false, isExecutionError: true }); continue; }
            for (const config of configs) { const value = baselineValues[config.name]; if (!value) continue; const stepMapping = config.step_variable_mappings.find(m => m.step_order === step.step_order); if (stepMapping) parsedRequest = applyVariableToRequest(parsedRequest, stepMapping.json_path, value, stepMapping.original_value, config.advanced_config); }
            if (enableExtractor) parsedRequest = applyContextVariables(parsedRequest, baselineContext, configs, step.step_order);
            if (enableSessionJar) parsedRequest = applySessionJarToRequest(parsedRequest, baselineContext, sessionJarConfig);
            const url = baseUrl + parsedRequest.path;
            if (!validateUrl(url)) { baselineStepExecutions.push({ step_order: step.step_order, template_name: template.name, url, method: parsedRequest.method, headers: parsedRequest.headers, body: parsedRequest.body, response: { status: 0, headers: {}, body: 'Invalid URL' }, matchedFailurePattern: false, assertionsPassed: true, executed: false, isExecutionError: true }); continue; }
            let response: HttpResponse; let fetchSucceeded = true;
            try { const fetchResponse = await fetchWithRetry(url, { method: parsedRequest.method, headers: parsedRequest.headers, body: ['GET', 'HEAD'].includes(parsedRequest.method) ? undefined : parsedRequest.body }); const responseBody = await fetchResponse.text(); const responseHeaders: Record<string, string> = {}; fetchResponse.headers.forEach((v, k) => { responseHeaders[k] = v; }); response = { status: fetchResponse.status, headers: responseHeaders, body: responseBody }; }
            catch (e: any) { response = { status: 0, headers: {}, body: `Fetch error: ${e.message}` }; fetchSucceeded = false; }
            if (fetchSucceeded && enableExtractor) executeExtractors(extractors, step.step_order, response, baselineContext);
            if (fetchSucceeded && enableSessionJar) updateSessionJar(response, baselineContext, sessionJarConfig);
            const matchedFailure = fetchSucceeded ? checkFailurePatterns(template.failure_patterns as FailurePattern[] || [], (template.failure_logic || 'OR') as 'OR' | 'AND', response.status, response.body, response.headers) : false;
            const assertionEval = fetchSucceeded ? evaluateStepAssertions(stepAssertions, assertionsMode, response, baselineValues, baselineContext) : { passed: true, results: [] };
            baselineStepExecutions.push({ step_order: step.step_order, template_name: template.name, url, method: parsedRequest.method, headers: parsedRequest.headers, body: parsedRequest.body, response, matchedFailurePattern: matchedFailure, assertionsPassed: assertionEval.passed, assertionsMode, assertionResults: assertionEval.results, executed: fetchSucceeded, isExecutionError: !fetchSucceeded });
          }
          const baselineCompleteness = validateStepCompleteness(baselineStepExecutions, expectedStepCount);
          if (!baselineCompleteness.valid) { if (baselineCompleteness.hasExecutionError) { errorsCount++; combinationHasError = true; } errors.push(`Baseline execution incomplete: ${baselineCompleteness.reason}`); completedTests++; await supabase.from('test_runs').update({ progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount }, progress_percent: Math.round((completedTests / totalTests) * 100) }).eq('id', test_run_id); continue; }
          if (!evaluateWorkflowAssertion(baselineStepExecutions, assertionStrategy, criticalStepOrders)) { completedTests++; continue; }
        }
      }

      for (const step of steps) {
        const template = step.api_template;
        const stepAssertions = (step.step_assertions || []) as StepAssertion[];
        const assertionsMode = (step.assertions_mode || 'all') as AssertionsMode;
        if (!template) { errors.push(`Step ${step.step_order} has no template`); stepExecutions.push({ step_order: step.step_order, template_name: 'Unknown', url: '', method: 'GET', headers: {}, response: { status: 0, headers: {}, body: '' }, matchedFailurePattern: false, assertionsPassed: true, executed: false, isExecutionError: true }); continue; }
        let parsedRequest = parseRawRequest(template.raw_request || '');
        if (!parsedRequest) { errors.push(`Template "${template.name}" has invalid request format`); stepExecutions.push({ step_order: step.step_order, template_name: template.name, url: '', method: 'GET', headers: {}, response: { status: 0, headers: {}, body: '' }, matchedFailurePattern: false, assertionsPassed: true, executed: false, isExecutionError: true }); continue; }
        for (const config of configs) { if (config.data_source === 'workflow_context') continue; const value = combination.values[config.name]; if (!value) continue; const stepMapping = config.step_variable_mappings.find(m => m.step_order === step.step_order); if (stepMapping) parsedRequest = applyVariableToRequest(parsedRequest, stepMapping.json_path, value, stepMapping.original_value, config.advanced_config); }
        if (enableExtractor) parsedRequest = applyContextVariables(parsedRequest, context, configs, step.step_order);
        if (enableSessionJar) parsedRequest = applySessionJarToRequest(parsedRequest, context, sessionJarConfig);
        const url = baseUrl + parsedRequest.path;
        if (!validateUrl(url)) { errors.push(`Invalid URL: ${url}`); stepExecutions.push({ step_order: step.step_order, template_name: template.name, url, method: parsedRequest.method, headers: parsedRequest.headers, body: parsedRequest.body, response: { status: 0, headers: {}, body: '' }, matchedFailurePattern: false, assertionsPassed: true, executed: false, isExecutionError: true }); continue; }
        let response: HttpResponse; let isExecError = false;
        try { const fetchResponse = await fetchWithRetry(url, { method: parsedRequest.method, headers: parsedRequest.headers, body: ['GET', 'HEAD'].includes(parsedRequest.method) ? undefined : parsedRequest.body }); const responseBody = await fetchResponse.text(); const responseHeaders: Record<string, string> = {}; fetchResponse.headers.forEach((v, k) => { responseHeaders[k] = v; }); response = { status: fetchResponse.status, headers: responseHeaders, body: responseBody }; }
        catch (e: any) { response = { status: 0, headers: {}, body: `Error: ${e.message}` }; isExecError = true; }
        if (!isExecError && enableExtractor) { const extractResult = executeExtractors(extractors, step.step_order, response, context); if (!extractResult.success) { extractorFailed = true; extractorErrors = extractResult.errors; } }
        if (!isExecError && enableSessionJar) updateSessionJar(response, context, sessionJarConfig);
        const matchedFailure = checkFailurePatterns(template.failure_patterns as FailurePattern[] || [], (template.failure_logic || 'OR') as 'OR' | 'AND', response.status, response.body, response.headers);
        const assertionEval = !isExecError ? evaluateStepAssertions(stepAssertions, assertionsMode, response, variableValues, context) : { passed: true, results: [] };
        stepExecutions.push({ step_order: step.step_order, template_name: template.name, url, method: parsedRequest.method, headers: parsedRequest.headers, body: parsedRequest.body, response, matchedFailurePattern: matchedFailure, assertionsPassed: assertionEval.passed, assertionsMode, assertionResults: assertionEval.results, executed: !isExecError, isExecutionError: isExecError });
        Object.entries(context.extractedValues).forEach(([key, value]) => { variableValues[`extracted.${key}`] = value; });
      }

      completedTests++;
      const progressPercent = Math.round((completedTests / totalTests) * 100);

      if (extractorFailed) { errors.push(...extractorErrors); await supabase.from('test_runs').update({ progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount }, progress_percent: progressPercent }).eq('id', test_run_id); continue; }

      const completenessCheck = validateStepCompleteness(stepExecutions, expectedStepCount);
      if (!completenessCheck.valid) {
        if (completenessCheck.hasExecutionError) { errorsCount++; combinationHasError = true; }
        errors.push(`Workflow combination skipped: ${completenessCheck.reason}`);
        await supabase.from('test_runs').update({ progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount }, progress_percent: progressPercent }).eq('id', test_run_id);
        continue;
      }

      const isVulnerability = evaluateWorkflowAssertion(stepExecutions, assertionStrategy, criticalStepOrders);
      let shouldCreateFinding = isVulnerability; let responseDiff: ResponseDiff | null = null;

      if (isVulnerability && enableBaseline && baselineStepExecutions) {
        responseDiff = compareWorkflowResponses(baselineStepExecutions, stepExecutions, baselineConfig);
        shouldCreateFinding = responseDiff.status_changed || responseDiff.business_code_changed || Object.keys(responseDiff.body_diff.critical_changes).length > 0 || Object.keys(responseDiff.body_diff.modified).length > 0;
      }

      if (shouldCreateFinding) {
        const requestSummary = stepExecutions.map(r => `Step ${r.step_order} (${r.template_name}): ${r.method} ${r.url} -> ${r.response.status}`).join('\n');
        const suppressionCheck = checkSuppressionRulesForWorkflow(activeSuppressionRules, workflow_id, workflow.name, stepExecutions, environment_id);
        const findingData = {
          source_type: 'workflow', test_run_id, security_run_id: security_run_id || null, template_id: null, workflow_id: workflow_id,
          severity: 'medium', status: 'new', title: `Workflow vulnerability: ${workflow.name}`,
          description: `Workflow execution with assertion strategy "${assertionStrategy}". Values: ${JSON.stringify(combination.values)}\n\nSteps:\n${requestSummary}`,
          template_name: workflow.name, variable_values: variableValues,
          request_raw: stepExecutions.map(r => `${r.method} ${r.url}\n${JSON.stringify(r.headers)}\n\n${r.body || ''}`).join('\n---\n'),
          response_status: stepExecutions[stepExecutions.length - 1]?.response.status,
          response_body: stepExecutions.map(r => `Step ${r.step_order}: ${r.response.body?.substring(0, 2000)}`).join('\n---\n'),
          account_source_map: combination.accountMap, attacker_account_id: combination.attackerId || null, victim_account_ids: combination.victimIds,
          baseline_response: baselineStepExecutions ? { steps: baselineStepExecutions.map(s => ({ step_order: s.step_order, status: s.response.status, body: s.response.body.substring(0, 5000) })) } : null,
          mutated_response: { steps: stepExecutions.map(s => ({ step_order: s.step_order, status: s.response.status, body: s.response.body.substring(0, 5000) })) },
          response_diff: responseDiff, is_suppressed: suppressionCheck.suppressed, suppression_rule_id: suppressionCheck.ruleId || null,
        };
        await supabase.from('findings').insert(findingData);
        if (suppressionCheck.suppressed) suppressedCount++; else findingsCount++;
      }

      await supabase.from('test_runs').update({ progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount }, progress_percent: progressPercent }).eq('id', test_run_id);
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
    console.error('Workflow execution error:', error);
    if (testRunId) await supabase.from('test_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error_message: error.message || 'Unknown error occurred', has_execution_error: true }).eq('id', testRunId);
    return new Response(JSON.stringify({ error: error.message || 'Unknown error', has_execution_error: true }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
