import type { AgentToolContext, AgentToolResult, AgentToolSpec } from './tool-types.js';
import { assertScanActive, scanAbortSignal } from '../services/ai-scan/run-control.js';

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
      const result = await tool.handler(input, { ...context, signal: scanAbortSignal(context.signal) });
      assertScanActive();
      await context.repo.createToolInvocation({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        tool_name: name,
        input_json: redactMobileInvocationInput(name, input),
        output_json: result.data || {},
        status: result.ok ? 'completed' : 'failed',
        error_message: result.error,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      return result;
    } catch (error: any) {
      await context.repo.createToolInvocation({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        tool_name: name,
        input_json: redactMobileInvocationInput(name, input),
        output_json: {},
        status: 'failed',
        error_message: error.message || String(error),
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      throw error;
    }
  }
}
