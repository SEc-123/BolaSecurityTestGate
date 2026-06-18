import type { AgentToolContext, AgentToolResult, AgentToolSpec } from './tool-types.js';

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
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown agent tool: ${name}`);
    }

    const startedAt = new Date().toISOString();
    try {
      const result = await tool.handler(input, context);
      await context.repo.createToolInvocation({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        tool_name: name,
        input_json: input,
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
        input_json: input,
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
