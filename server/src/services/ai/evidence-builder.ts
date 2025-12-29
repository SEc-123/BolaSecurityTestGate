import crypto from 'crypto';

export interface EvidenceBuilderOptions {
  redaction_enabled?: boolean;
  include_all_steps?: boolean;
  key_steps_only?: boolean;
  key_steps_limit?: number;
  max_steps?: number;
  max_body_chars?: number;
  max_headers_chars?: number;
  prompt_max_body_chars_test_run?: number;
  prompt_max_body_chars_workflow_step?: number;
  prompt_max_headers_chars_test_run?: number;
  prompt_max_headers_chars_workflow_step?: number;
}

export interface RequestData {
  method: string;
  url: string;
  headers: Record<string, any>;
  body?: string;
}

export interface ResponseData {
  status: number;
  headers: Record<string, any>;
  body: string;
}

export interface RequestResponsePair {
  request: RequestData;
  response: ResponseData;
}

export interface WorkflowStep {
  step_index: number;
  baseline?: RequestResponsePair | null;
  finding?: RequestResponsePair | null;
}

export interface MutationInfo {
  variables_changed: Array<{
    name: string;
    from: string;
    to: string;
    source_account?: string;
  }>;
  assertion_strategy?: string;
  diff_summary?: string;
}

export interface AIAnalysisInput {
  meta: {
    run_id: string;
    finding_id: string;
    source_type: 'test_run' | 'workflow';
    template_id?: string;
    template_name?: string;
    workflow_id?: string;
    workflow_name?: string;
    created_at?: string;
  };
  baseline?: RequestResponsePair | null;
  finding?: RequestResponsePair | null;
  workflow_steps?: WorkflowStep[];
  mutation?: MutationInfo;
  notes: {
    what_is_baseline: string;
    what_is_finding: string;
  };
  config: {
    prompt_max_body_chars_test_run: number;
    prompt_max_body_chars_workflow_step: number;
    prompt_max_headers_chars_test_run: number;
    prompt_max_headers_chars_workflow_step: number;
  };
}

const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
  'apikey'
];

const SENSITIVE_FIELDS = [
  'token',
  'access_token',
  'refresh_token',
  'session',
  'sessionid',
  'session_id',
  'password',
  'secret',
  'api_key',
  'apikey'
];

export class EvidenceBuilder {
  private options: Required<EvidenceBuilderOptions>;

  constructor(options: EvidenceBuilderOptions = {}) {
    this.options = {
      redaction_enabled: options.redaction_enabled ?? false,
      include_all_steps: options.include_all_steps ?? true,
      key_steps_only: options.key_steps_only ?? false,
      key_steps_limit: options.key_steps_limit ?? 5,
      max_steps: options.max_steps ?? 0,
      max_body_chars: options.max_body_chars ?? 2000000,
      max_headers_chars: options.max_headers_chars ?? 200000,
      prompt_max_body_chars_test_run: options.prompt_max_body_chars_test_run ?? 50000,
      prompt_max_body_chars_workflow_step: options.prompt_max_body_chars_workflow_step ?? 10000,
      prompt_max_headers_chars_test_run: options.prompt_max_headers_chars_test_run ?? 50000,
      prompt_max_headers_chars_workflow_step: options.prompt_max_headers_chars_workflow_step ?? 20000,
    };
  }

  build(finding: any): AIAnalysisInput {
    const input: AIAnalysisInput = {
      meta: {
        run_id: finding.test_run_id || finding.security_run_id || 'unknown',
        finding_id: finding.id,
        source_type: finding.workflow_id ? 'workflow' : 'test_run',
        template_id: finding.template_id || finding.api_template_id,
        template_name: finding.template_name,
        workflow_id: finding.workflow_id,
        workflow_name: finding.workflow_name || (finding.workflow_id ? finding.template_name : undefined),
        created_at: finding.created_at,
      },
      notes: {
        what_is_baseline: 'Baseline is expected normal behavior using original parameters.',
        what_is_finding: 'Finding/Mutated is behavior after parameter tampering for logic/authorization testing.',
      },
      config: {
        prompt_max_body_chars_test_run: this.options.prompt_max_body_chars_test_run,
        prompt_max_body_chars_workflow_step: this.options.prompt_max_body_chars_workflow_step,
        prompt_max_headers_chars_test_run: this.options.prompt_max_headers_chars_test_run,
        prompt_max_headers_chars_workflow_step: this.options.prompt_max_headers_chars_workflow_step,
      },
    };

    if (finding.workflow_id) {
      return this.buildWorkflowEvidence(finding, input);
    } else {
      return this.buildTestRunEvidence(finding, input);
    }
  }

  private buildTestRunEvidence(finding: any, input: AIAnalysisInput): AIAnalysisInput {
    const baselineData = this.parseJSON(finding.baseline_response);
    const findingData = this.parseJSON(finding.mutated_response);

    if (baselineData) {
      input.baseline = this.extractRequestResponse(baselineData);
    }

    if (findingData) {
      input.finding = this.extractRequestResponse(findingData);
    }

    const variableValues = this.parseJSON(finding.variable_values) || {};
    input.mutation = {
      variables_changed: Object.entries(variableValues).map(([name, value]) => ({
        name,
        from: 'baseline_value',
        to: String(value),
      })),
      assertion_strategy: finding.assertion_strategy,
      diff_summary: finding.response_diff ? 'Response differs from baseline' : undefined,
    };

    return input;
  }

  private buildWorkflowEvidence(finding: any, input: AIAnalysisInput): AIAnalysisInput {
    const baselineData = this.parseJSON(finding.baseline_response);
    const findingData = this.parseJSON(finding.mutated_response);

    const baselineSteps = baselineData?.steps || [];
    const findingSteps = findingData?.steps || [];

    const maxSteps = Math.max(baselineSteps.length, findingSteps.length);
    const workflowSteps: WorkflowStep[] = [];

    for (let i = 0; i < maxSteps; i++) {
      const baselineStep = baselineSteps[i];
      const findingStep = findingSteps[i];

      const step: WorkflowStep = {
        step_index: i + 1,
        baseline: baselineStep ? this.extractRequestResponse(baselineStep) : null,
        finding: findingStep ? this.extractRequestResponse(findingStep) : null,
      };

      workflowSteps.push(step);
    }

    if (this.options.key_steps_only && !this.options.include_all_steps) {
      const limit = this.options.key_steps_limit;
      const keySteps = workflowSteps.slice(0, limit);
      if (workflowSteps.length > limit) {
        keySteps.push(workflowSteps[workflowSteps.length - 1]);
      }
      input.workflow_steps = keySteps;
    } else {
      input.workflow_steps = workflowSteps;
    }

    if (typeof this.options.max_steps === 'number' && this.options.max_steps > 0) {
      input.workflow_steps = input.workflow_steps.slice(0, this.options.max_steps);
    }

    const variableValues = this.parseJSON(finding.variable_values) || {};
    input.mutation = {
      variables_changed: Object.entries(variableValues).map(([name, value]) => ({
        name,
        from: 'baseline_value',
        to: String(value),
      })),
      assertion_strategy: finding.assertion_strategy,
      diff_summary: finding.response_diff ? 'Workflow execution differs from baseline' : undefined,
    };

    return input;
  }

  private extractRequestResponse(data: any): RequestResponsePair | null {
    if (!data) return null;

    const request: RequestData = {
      method: data.request?.method || 'UNKNOWN',
      url: data.request?.url || '',
      headers: this.sanitizeHeaders(data.request?.headers || {}),
      body: this.sanitizeBody(data.request?.body, this.options.max_body_chars),
    };

    const response: ResponseData = {
      status: data.response?.status || 0,
      headers: this.sanitizeHeaders(data.response?.headers || {}),
      body: this.sanitizeBody(data.response?.body, this.options.max_body_chars),
    };

    return { request, response };
  }

  private sanitizeHeaders(headers: any): Record<string, any> {
    if (!headers || typeof headers !== 'object') return {};

    const sanitized: Record<string, any> = {};
    const headersStr = JSON.stringify(headers);

    if (headersStr.length > this.options.max_headers_chars) {
      return { _truncated: true, _original_size: headersStr.length };
    }

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (this.options.redaction_enabled && SENSITIVE_HEADERS.includes(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private sanitizeBody(body: any, maxChars: number): string {
    if (!body) return '';

    let bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

    if (bodyStr.length > maxChars) {
      bodyStr = bodyStr.substring(0, maxChars) + '\n... [truncated]';
    }

    if (this.options.redaction_enabled) {
      bodyStr = this.redactSensitiveData(bodyStr);
    }

    return bodyStr;
  }

  private redactSensitiveData(str: string): string {
    let sanitized = str;

    const tokenPatterns = [
      /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi,
      /token["\s:=]+[A-Za-z0-9\-._~+\/]+=*/gi,
      /session["\s:=]+[A-Za-z0-9\-._~+\/]+=*/gi
    ];

    for (const pattern of tokenPatterns) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }

    for (const field of SENSITIVE_FIELDS) {
      const fieldPattern = new RegExp(`"${field}"\\s*:\\s*"[^"]*"`, 'gi');
      sanitized = sanitized.replace(fieldPattern, `"${field}":"[REDACTED]"`);
    }

    return sanitized;
  }

  private parseJSON(value: any): any {
    if (!value) return undefined;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return value;

    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}
