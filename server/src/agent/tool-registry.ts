import { manualIdentityToolBlocker } from '../services/ai-scan/manual-identity-preparation.js';
import type { AgentToolContext, AgentToolResult, AgentToolSpec } from './tool-types.js';
import { assertScanActive, scanAbortSignal } from '../services/ai-scan/run-control.js';
import { TaskEndpointPlanError } from '../services/ai-scan/task-endpoint-plan.js';
import { TargetScopeError } from '../services/ai-scan/target-scope.js';
import { CaptureRequiredError } from '../services/ai-scan/captured-request.js';
import { isBrowserObservationTool, projectBrowserToolInput, projectBrowserToolResult } from '../services/ai-scan/browser/model-observation-projection.js';

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
    // Coverage and flow identifiers are server-owned graph references, not
    // captured values. Persisting them in the safe model projection lets a
    // later decision bind the exact inspected target without exposing any
    // request or response scalar.
    if (/^(?:flow_id|workflow_id|source_workflow_id|recording_session_id|recording_context_key|recording_context_scope|recording_identity_key|context_key|context_scope|identity_key|test_run_id|event_id|event_ids|candidate_event_ids|operation_candidate_event_ids|completion_candidate_event_ids|requested_event_ids|auto_included_event_ids|effective_event_ids|action_id|step_id|template_id|plan_id|plan_task_id|target_id|target_type|feature_id|feature_name|endpoint_id|operation_id|coverage_key|disposition|id|fromPath|toPath|from_path|to_path|sourcePath|sourceLocation|fromLocation|toLocation|variableName|variable_name|targetVariableName|predictedType|data_source|writePolicySuggestion|transformHint|path|method|status|purpose|op|type|role|name|reason|origin|description|summary|error_kind|selection_origin|selection_tool_name|intent|observed_control_intent)$/i.test(key)) return value.slice(0, 500);
    return { type: 'string', length: value.length, omitted: true };
  }
  if (Array.isArray(value)) return value.slice(0, 120).map(item => redactBusinessInvocationValue(item, key, depth + 1));
  if (typeof value === 'object') {
    if (key === 'right') {
      const capturedBaseline=value?.captured_baseline===true||value?.type==='captured_baseline';
      return { type: capturedBaseline?'captured_baseline':value.type,
        key: capturedBaseline||value.type === 'literal' ? undefined : value.key,
        value_present: !capturedBaseline&&value.type === 'literal' && value.value !== undefined };
    }
    return Object.fromEntries(Object.entries(value).slice(0, 120).map(([name, item]) => [name, redactBusinessInvocationValue(item, name, depth + 1)]));
  }
  return '[business value omitted]';
}

function redactAgentInvocationInput(name: string, input: Record<string, any>): Record<string, any> {
  if (isBrowserObservationTool(name)) return projectBrowserToolInput(input);
  if (isBusinessEvidenceTool(name)) return redactBusinessInvocationValue(input);
  return redactMobileInvocationInput(name, input);
}

function redactAgentInvocationOutput(name: string, output: Record<string, any>): Record<string, any> {
  if (isBrowserObservationTool(name)) return projectBrowserToolResult(output);
  return isBusinessEvidenceTool(name) ? redactBusinessInvocationValue(output) : output;
}

/** Browser errors can include renderer text, a selector, or a target URL.
 * Invocation rows feed model history and operational projections, so persist
 * only a fixed browser error code rather than the provider/runtime message. */
function redactAgentInvocationError(name: string, error: unknown, output?: Record<string, any>): string | undefined {
  if (!isBrowserObservationTool(name)) return error ? String(error) : undefined;
  const code = typeof output?.error_code === 'string' && /^[a-z_]{1,96}$/.test(output.error_code)
    ? output.error_code : 'browser_operation_failed';
  return `browser_error:${code}`;
}

/**
 * Agent tool calls are the provider-facing execution boundary.  A raw
 * Playwright selector here would let a model manufacture DOM knowledge that
 * was never exposed through the safe observation projection.  The persistent
 * browser runtime deliberately retains selector support for trusted server
 * callers (recording, fixtures, and local recovery), so enforce the stronger
 * rule at this model-dispatch boundary rather than removing that runtime
 * capability.
 */
function modelBrowserInteractionBoundaryResult(name: string, input: Record<string, any>): AgentToolResult | undefined {
  if (name !== 'browser.interact') return undefined;
  const operation = input?.operation;
  if (!operation || typeof operation !== 'object' || !Object.hasOwn(operation, 'selector')) return undefined;
  return {
    ok: false,
    error: 'browser_error:opaque_reference_required',
    data: {
      ok: false,
      error_code: 'opaque_reference_required',
      failure_phase: 'pre_action',
      action_performed: false,
      retryable: true,
    },
  };
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
      if (context.allowed_tool_names && !context.allowed_tool_names.includes(name)) {
        throw new Error(`Tool ${name} is not available in the current task stage.`);
      }
      const result = modelBrowserInteractionBoundaryResult(name, input)
        || await manualIdentityToolBlocker(name, input, context)
        || await tool.handler(input, { ...context, signal: scanAbortSignal(context.signal) });
      assertScanActive();
      await context.repo.createToolInvocation({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        tool_name: name,
        input_json: redactAgentInvocationInput(name, input),
        output_json: redactAgentInvocationOutput(name, result.data || {}),
        status: result.ok ? 'completed' : 'failed',
        error_message: redactAgentInvocationError(name, result.error, result.data),
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
        error_message: redactAgentInvocationError(name, error.message || String(error)),
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      if (error instanceof TaskEndpointPlanError) return { ok: false, error: error.message, data: error.data };
      throw error;
    }
  }
}
