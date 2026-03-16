export interface BaselineConfig {
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

export interface WorkflowBaselineConfig {
  ignore_paths?: string[];
  critical_paths?: string[];
  compare_mode?: 'loose' | 'strict';
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface BodyDiff {
  added: Record<string, any>;
  removed: Record<string, any>;
  modified: Record<string, any>;
  critical_changes: Record<string, any>;
}

export interface ResponseDiff {
  status_changed: boolean;
  business_code_changed: boolean;
  body_diff: BodyDiff;
}

export interface StepExecution {
  step_order: number;
  template_name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  response: HttpResponse;
  matchedFailurePattern: boolean;
  assertionsPassed: boolean;
  executed: boolean;
  isExecutionError?: boolean;
}

export function extractValueByPath(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export function deepCompare(
  obj1: any,
  obj2: any,
  ignoreFields: string[],
  criticalFields: string[],
  path: string = ''
): BodyDiff {
  const result: BodyDiff = {
    added: {},
    removed: {},
    modified: {},
    critical_changes: {},
  };

  if (typeof obj1 !== 'object' || typeof obj2 !== 'object' || obj1 === null || obj2 === null) {
    if (obj1 !== obj2) {
      result.modified[path || '_root'] = { baseline: obj1, mutated: obj2 };
      if (criticalFields.some(f => path.includes(f))) {
        result.critical_changes[path || '_root'] = { baseline: obj1, mutated: obj2 };
      }
    }
    return result;
  }

  for (const key in obj1) {
    const fullPath = path ? `${path}.${key}` : key;
    if (ignoreFields.includes(fullPath) || ignoreFields.includes(key)) continue;

    if (!(key in obj2)) {
      result.removed[fullPath] = obj1[key];
      if (criticalFields.some(f => fullPath.includes(f) || f === key)) {
        result.critical_changes[fullPath] = { removed: obj1[key] };
      }
    } else if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') {
      const nested = deepCompare(obj1[key], obj2[key], ignoreFields, criticalFields, fullPath);
      Object.assign(result.added, nested.added);
      Object.assign(result.removed, nested.removed);
      Object.assign(result.modified, nested.modified);
      Object.assign(result.critical_changes, nested.critical_changes);
    } else if (obj1[key] !== obj2[key]) {
      result.modified[fullPath] = { baseline: obj1[key], mutated: obj2[key] };
      if (criticalFields.some(f => fullPath.includes(f) || f === key)) {
        result.critical_changes[fullPath] = { baseline: obj1[key], mutated: obj2[key] };
      }
    }
  }

  for (const key in obj2) {
    const fullPath = path ? `${path}.${key}` : key;
    if (ignoreFields.includes(fullPath) || ignoreFields.includes(key)) continue;

    if (!(key in obj1)) {
      result.added[fullPath] = obj2[key];
      if (criticalFields.some(f => fullPath.includes(f) || f === key)) {
        result.critical_changes[fullPath] = { added: obj2[key] };
      }
    }
  }

  return result;
}

export function compareResponses(
  baseline: HttpResponse,
  mutated: HttpResponse,
  config: BaselineConfig
): ResponseDiff {
  const diff: ResponseDiff = {
    status_changed: false,
    business_code_changed: false,
    body_diff: { added: {}, removed: {}, modified: {}, critical_changes: {} },
  };

  const rules = config.rules || {};

  if (rules.compare_status !== false) {
    diff.status_changed = baseline.status !== mutated.status;
  }

  let baselineBody: any = null;
  let mutatedBody: any = null;

  try {
    baselineBody = JSON.parse(baseline.body);
    mutatedBody = JSON.parse(mutated.body);
  } catch {
    if (rules.compare_body_structure !== false && baseline.body !== mutated.body) {
      diff.body_diff.modified['_raw'] = {
        baseline: baseline.body.substring(0, 500),
        mutated: mutated.body.substring(0, 500),
        different: true,
      };
    }
    return diff;
  }

  if (rules.compare_business_code && rules.business_code_path) {
    const baselineCode = extractValueByPath(baselineBody, rules.business_code_path);
    const mutatedCode = extractValueByPath(mutatedBody, rules.business_code_path);
    diff.business_code_changed = baselineCode !== mutatedCode;
  }

  if (rules.compare_body_structure !== false) {
    diff.body_diff = deepCompare(
      baselineBody,
      mutatedBody,
      rules.ignore_fields || [],
      rules.critical_fields || []
    );
  }

  return diff;
}

export function compareWorkflowResponses(
  baselineSteps: StepExecution[],
  mutatedSteps: StepExecution[],
  config: WorkflowBaselineConfig
): ResponseDiff {
  const diff: ResponseDiff = {
    status_changed: false,
    business_code_changed: false,
    body_diff: { added: {}, removed: {}, modified: {}, critical_changes: {} },
  };

  const ignorePaths = config.ignore_paths || [];
  const criticalPaths = config.critical_paths || [];

  for (let i = 0; i < Math.min(baselineSteps.length, mutatedSteps.length); i++) {
    const baselineStep = baselineSteps[i];
    const mutatedStep = mutatedSteps[i];

    if (baselineStep.response.status !== mutatedStep.response.status) {
      diff.status_changed = true;
      diff.body_diff.modified[`step_${baselineStep.step_order}_status`] = {
        baseline: baselineStep.response.status,
        mutated: mutatedStep.response.status,
      };
      if (criticalPaths.includes('status')) {
        diff.body_diff.critical_changes[`step_${baselineStep.step_order}_status`] = {
          baseline: baselineStep.response.status,
          mutated: mutatedStep.response.status,
        };
      }
    }

    try {
      const baselineBody = JSON.parse(baselineStep.response.body);
      const mutatedBody = JSON.parse(mutatedStep.response.body);

      const stepDiff = deepCompare(baselineBody, mutatedBody, ignorePaths, criticalPaths, `step_${baselineStep.step_order}`);

      Object.assign(diff.body_diff.added, stepDiff.added);
      Object.assign(diff.body_diff.removed, stepDiff.removed);
      Object.assign(diff.body_diff.modified, stepDiff.modified);
      Object.assign(diff.body_diff.critical_changes, stepDiff.critical_changes);
    } catch {
      if (baselineStep.response.body !== mutatedStep.response.body) {
        diff.body_diff.modified[`step_${baselineStep.step_order}_body`] = {
          baseline: baselineStep.response.body.substring(0, 500),
          mutated: mutatedStep.response.body.substring(0, 500),
          different: true,
        };
      }
    }
  }

  return diff;
}

export function hasSignificantDiff(diff: ResponseDiff): boolean {
  if (diff.status_changed) return true;
  if (diff.business_code_changed) return true;
  if (Object.keys(diff.body_diff.critical_changes).length > 0) return true;
  const modifiedCount = Object.keys(diff.body_diff.modified).length;
  return modifiedCount > 0;
}

export interface TruncatedHeaders {
  headers: Record<string, any>;
  _truncated: boolean;
  _truncated_reason?: string;
  _preview?: string;
}

export function truncateHeadersObject(headers: Record<string, any>, maxChars: number): TruncatedHeaders {
  const out: Record<string, any> = {};
  let used = 0;

  for (const [k, v] of Object.entries(headers ?? {})) {
    const piece = `${k}:${String(v)}`;
    if (used + piece.length > maxChars) {
      const originalStr = JSON.stringify(headers, null, 2);
      return {
        headers: out,
        _truncated: true,
        _truncated_reason: 'maxChars',
        _preview: originalStr.substring(0, Math.min(2000, originalStr.length)),
      };
    }
    out[k] = v;
    used += piece.length;
  }
  return { headers: out, _truncated: false };
}

export function truncateResponseForStorage(response: HttpResponse, maxSize: number = 2000000): Record<string, any> {
  return {
    status: response.status,
    headers: response.headers,
    body: response.body.substring(0, maxSize),
  };
}

export interface RequestData {
  method: string;
  url: string;
  headers: Record<string, any>;
  body?: string;
}

export function truncateRequestResponseForStorage(
  request: RequestData,
  response: HttpResponse,
  maxBodySize: number = 2000000,
  maxHeadersSize: number = 200000
): Record<string, any> {
  const reqHeaders = truncateHeadersObject(request.headers, maxHeadersSize);
  const resHeaders = truncateHeadersObject(response.headers, maxHeadersSize);

  return {
    request: {
      method: request.method,
      url: request.url,
      headers: reqHeaders.headers,
      _headers_truncated: reqHeaders._truncated,
      _headers_truncated_reason: reqHeaders._truncated_reason,
      _headers_preview: reqHeaders._preview,
      body: (request.body || '').substring(0, maxBodySize),
    },
    response: {
      status: response.status,
      headers: resHeaders.headers,
      _headers_truncated: resHeaders._truncated,
      _headers_truncated_reason: resHeaders._truncated_reason,
      _headers_preview: resHeaders._preview,
      body: response.body.substring(0, maxBodySize),
    },
  };
}

export function truncateStepForStorage(
  step: any,
  maxBodySize: number = 2000000,
  maxHeadersSize: number = 200000
): Record<string, any> {
  const reqHeaders = truncateHeadersObject(step.headers, maxHeadersSize);
  const resHeaders = truncateHeadersObject(step.response.headers, maxHeadersSize);

  return {
    request: {
      method: step.method,
      url: step.url,
      headers: reqHeaders.headers,
      _headers_truncated: reqHeaders._truncated,
      _headers_truncated_reason: reqHeaders._truncated_reason,
      _headers_preview: reqHeaders._preview,
      body: (step.body || '').substring(0, maxBodySize),
    },
    response: {
      status: step.response.status,
      headers: resHeaders.headers,
      _headers_truncated: resHeaders._truncated,
      _headers_truncated_reason: resHeaders._truncated_reason,
      _headers_preview: resHeaders._preview,
      body: step.response.body.substring(0, maxBodySize),
    },
  };
}
