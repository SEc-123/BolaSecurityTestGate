import crypto from 'crypto';
import type { StandardizedFindingInput } from './types.js';

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

const MAX_BODY_LENGTH = 4096;

export class InputStandardizer {
  standardize(finding: any): StandardizedFindingInput {
    const input: StandardizedFindingInput = {
      finding_id: finding.id,
      source_type: finding.workflow_id ? 'workflow' : 'test_run',
      template_or_workflow: finding.workflow_id || finding.template_name || 'unknown',
      evidence_signals: []
    };

    if (finding.workflow_id) {
      const baselineSteps = this.extractSteps(finding.baseline_response, 'baseline');
      const mutatedSteps = this.extractSteps(finding.mutated_response, 'mutated');

      input.workflow_steps = [...baselineSteps, ...mutatedSteps];
      input.extractors = this.sanitizeExtractors(finding.context || {});

      const workflowSignals = this.extractWorkflowSignals(baselineSteps, mutatedSteps);
      input.evidence_signals.push(...workflowSignals);
    } else {
      if (finding.template_name) {
        input.method = finding.method || 'GET';
        input.path = finding.path || '/';
        input.host = finding.host;
      }

      if (finding.baseline_response) {
        input.baseline = this.sanitizeResponse(this.parseJSON(finding.baseline_response));
      }

      if (finding.mutated_response) {
        input.mutated = this.sanitizeResponse(this.parseJSON(finding.mutated_response));
      }

      if (finding.mutation_info) {
        const mutationInfo = this.parseJSON(finding.mutation_info);
        input.mutation = {
          variable_name: mutationInfo?.variable_name || 'unknown',
          original_value: this.sanitizeValue(mutationInfo?.original_value),
          mutated_value: this.sanitizeValue(mutationInfo?.mutated_value)
        };
      }

      if (finding.assertion_failures) {
        const failures = Array.isArray(finding.assertion_failures)
          ? finding.assertion_failures
          : this.parseJSON(finding.assertion_failures);
        if (Array.isArray(failures) && failures.length > 0) {
          input.assertion_result = failures.join('; ');
        }
      }
    }

    const extraSignals = this.extractSignals(finding);
    const merged = [...(input.evidence_signals || []), ...(extraSignals || [])];
    input.evidence_signals = Array.from(new Set(merged));

    return input;
  }

  computeInputHash(input: StandardizedFindingInput): string {
    const normalized = JSON.stringify(input, Object.keys(input).sort());
    return crypto.createHash('sha256').update(normalized).digest('hex');
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

  private sanitizeResponse(response: any): any {
    if (!response) return undefined;

    const sanitized: any = {};

    if (response.status || response.statusCode) {
      sanitized.status = response.status || response.statusCode;
    }

    if (response.headers) {
      const headers = this.parseJSON(response.headers);
      sanitized.key_fields = this.sanitizeHeaders(headers);
    }

    if (response.body) {
      sanitized.body_excerpt = this.truncateBody(
        this.sanitizeBody(response.body)
      );
    }

    return sanitized;
  }

  private sanitizeHeaders(headers: any): Record<string, any> {
    if (!headers || typeof headers !== 'object') return {};

    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_HEADERS.includes(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private sanitizeBody(body: any): string {
    if (typeof body === 'string') {
      return this.sanitizeString(body);
    }

    if (typeof body === 'object' && body !== null) {
      const sanitized = this.sanitizeObject(body);
      return JSON.stringify(sanitized, null, 2);
    }

    return String(body);
  }

  private sanitizeObject(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item));
    }

    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object') {
        sanitized[key] = this.sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private sanitizeString(str: string): string {
    let sanitized = str;

    const tokenPatterns = [
      /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi,
      /token["\s:=]+[A-Za-z0-9\-._~+\/]+=*/gi,
      /session["\s:=]+[A-Za-z0-9\-._~+\/]+=*/gi
    ];

    for (const pattern of tokenPatterns) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }

    return sanitized;
  }

  private sanitizeValue(value: any): any {
    if (typeof value === 'string') {
      if (value.length > 100) {
        return value.substring(0, 100) + '...';
      }
      return this.sanitizeString(value);
    }
    return value;
  }

  private truncateBody(body: string): string {
    if (body.length <= MAX_BODY_LENGTH) {
      return body;
    }

    return body.substring(0, MAX_BODY_LENGTH) + '\n... [truncated]';
  }

  private extractWorkflowSteps(finding: any): any[] {
    if (!finding.workflow_steps) return [];

    const steps = this.parseJSON(finding.workflow_steps);
    if (!Array.isArray(steps)) return [];

    return steps.map((step: any) => ({
      step_name: step.name || step.step_name || 'unnamed',
      method: step.method || 'GET',
      path: step.path || '/',
      status: step.status || step.response?.status || 0
    }));
  }

  private sanitizeExtractors(context: any): Record<string, any> {
    const ctx = this.parseJSON(context);
    if (!ctx || typeof ctx !== 'object') return {};

    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(ctx)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = this.sanitizeValue(value);
      }
    }

    return sanitized;
  }

  private extractSignals(finding: any): string[] {
    const signals: string[] = [];

    if (finding.severity) {
      signals.push(`Severity: ${finding.severity}`);
    }

    if (finding.is_suppressed === 0 || finding.is_suppressed === false) {
      signals.push('Status: Unsuppressed');
    }

    const assertionFailures = this.parseJSON(finding.assertion_failures);
    if (Array.isArray(assertionFailures) && assertionFailures.length > 0) {
      signals.push(`Assertions failed: ${assertionFailures.length}`);
    }

    const baseline = this.parseJSON(finding.baseline_response);
    const mutated = this.parseJSON(finding.mutated_response);

    if (baseline && mutated) {
      const baseStatus = baseline.status || baseline.statusCode;
      const mutStatus = mutated.status || mutated.statusCode;

      if (baseStatus && mutStatus && baseStatus !== mutStatus) {
        signals.push(`Status changed: ${baseStatus} -> ${mutStatus}`);
      }
    }

    return signals;
  }

  private safeExcerpt(text: string, maxLen: number = 300): string {
    if (!text || typeof text !== 'string') return '';
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '...';
  }

  private extractSteps(resp: any, variant: string = 'baseline'): Array<{ step_index: number; status?: number; body_excerpt?: string; variant?: string }> {
    const obj = this.parseJSON(resp);
    const steps = obj?.steps;
    if (!Array.isArray(steps)) return [];

    return steps.map((s: any, idx: number) => ({
      step_index: idx + 1,
      status: s?.status ?? s?.response?.status ?? undefined,
      body_excerpt: this.safeExcerpt(
        typeof s?.body === 'string' ? s.body : (typeof s?.response?.body === 'string' ? s.response.body : ''),
        300
      ),
      variant
    }));
  }

  private extractWorkflowSignals(baselineSteps: any[], mutatedSteps: any[]): string[] {
    const signals: string[] = [];

    if (baselineSteps.length > 0 && mutatedSteps.length > 0) {
      const baselineLast = baselineSteps[baselineSteps.length - 1];
      const mutatedLast = mutatedSteps[mutatedSteps.length - 1];

      if (baselineLast.status && mutatedLast.status && baselineLast.status !== mutatedLast.status) {
        signals.push(`Workflow final step status changed: ${baselineLast.status} -> ${mutatedLast.status}`);
      }

      if (baselineSteps.length !== mutatedSteps.length) {
        signals.push(`Workflow step count changed: ${baselineSteps.length} -> ${mutatedSteps.length}`);
      }
    }

    return signals;
  }
}
