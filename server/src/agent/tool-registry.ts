import { manualIdentityToolBlocker } from '../services/ai-scan/manual-identity-preparation.js';
import type { AgentToolContext, AgentToolResult, AgentToolSpec } from './tool-types.js';
import { assertScanActive, scanAbortSignal } from '../services/ai-scan/run-control.js';
import { TaskEndpointPlanError } from '../services/ai-scan/task-endpoint-plan.js';
import { TargetScopeError } from '../services/ai-scan/target-scope.js';
import { CaptureRequiredError } from '../services/ai-scan/captured-request.js';

/** Invocation logs must not duplicate clear-text mobile keyboard input. The
 * executable scan configuration and captured HTTP evidence remain restricted
 * data and require the normal database/artifact access controls. */
export function redactMobileInvocationInput(name: string, input: Record<string, any>): Record<string, any> {
  if (!name.startsWith('mobile.')) return input;
  const redact = (value: any): any => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = ['value', 'password', 'token', 'secret', 'base64'].includes(key.toLowerCase()) ? '[redacted]' : redact(item);
    }
    return out;
  };
  return redact(input);
}

function isBusinessEvidenceTool(name: string): boolean {
  return /^(?:bstg\.business\.|bstg\.workflow\.|bstg\.native\.|bstg\.test_plan\.)/.test(name);
}

/** Invocation persistence is part of the model-facing scan snapshot. Preserve
 * references and field wiring for the next decision, but never persist a raw
 * business request/response/assertion literal into that generic projection. */
function redactBusinessInvocationValue(value: any, key = '', depth = 0): any {
  if (depth > 18) return '[business value omitted]';
  if (/^(?:value|value_preview|valuepreview|current_value|original_value|operand|payload|body|headers|request|response|error|errors|url)$/i.test(key)) return '[business value omitted]';
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(?:flow_id|workflow_id|source_workflow_id|recording_session_id|test_run_id|event_id|action_id|step_id|template_id|plan_id|id|fromPath|toPath|from_path|to_path|sourcePath|sourceLocation|fromLocation|toLocation|variableName|variable_name|targetVariableName|predictedType|data_source|writePolicySuggestion|transformHint|path|method|status|purpose|op|type|role|name|reason|origin|description|summary)$/i.test(key)) return value.slice(0, 500);
    return { type: 'string', length: value.length, omitted: true };
  }
  if (Array.isArray(value)) return value.slice(0, 120).map(item => redactBusinessInvocationValue(item, key, depth + 1));
  if (typeof value === 'object') {
    if (key === 'right') return { type: value.type, key: value.type === 'literal' ? undefined : value.key, value_present: value.type === 'literal' && value.value !== undefined };
    return Object.fromEntries(Object.entries(value).slice(0, 120).map(([name, item]) => [name, redactBusinessInvocationValue(item, name, depth + 1)]));
  }
  return '[business value omitted]';
}

function redactAgentInvocationInput(name: string, input: Record<string, any>): Record<string, any> {
  if (isBusinessEvidenceTool(name)) return redactBusinessInvocationValue(input);
  return redactMobileInvocationInput(name, input);
}

function redactAgentInvocationOutput(name: string, output: Record<string, any>): Record<string, any> {
  return isBusinessEvidenceTool(name) ? redactBusinessInvocationValue(output) : output;
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolSpec>();

  register(tool: AgentToolSpec): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Agent tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): AgentToolSpec[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  search(query: string): AgentToolSpec[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter(tool =>
      tool.name.toLowerCase().includes(q) ||
      tool.description.toLowerCase().includes(q)
    );
  }

  async call(name: string, input: Record<string, any>, context: AgentToolContext): Promise<AgentToolResult> {
    assertScanActive();
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown agent tool: ${name}`);
    }

    const startedAt = new Date().toISOString();
    try {
      const result = await manualIdentityToolBlocker(name, input, context) || await tool.handler(input, { ...context, signal: scanAbortSignal(context.signal) });
      assertScanActive();
      await context.repo.createToolInvocation({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        tool_name: name,
        input_json: redactAgentInvocationInput(name, input),
        output_json: redactAgentInvocationOutput(name, result.data || {}),
        status: result.ok ? 'completed' : 'failed',
        error_message: result.error,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      return result;
    } catch (error: any) {
      const scopeBlocked = error instanceof TargetScopeError;
      const captureBlocked = error instanceof CaptureRequiredError;
      await context.repo.createToolInvocation({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        tool_name: name,
        input_json: redactAgentInvocationInput(name, input),
        output_json: captureBlocked ? { blocked: true, error_code: error.code, reason_code: error.reason, failure_phase: 'pre_action', action_performed: false }
          : scopeBlocked ? { blocked: true, error_code: error.code } : error instanceof TaskEndpointPlanError ? error.data : {},
        status: scopeBlocked || captureBlocked ? 'blocked' : 'failed',
        error_message: error.message || String(error),
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      if (error instanceof TaskEndpointPlanError) return { ok: false, error: error.message, data: error.data };
      throw error;
    }
  }
}
