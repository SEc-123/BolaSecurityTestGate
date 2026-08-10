import type { AgentToolContext, AgentToolCapabilityClass, AgentToolResult, AgentToolSideEffectLevel, AgentToolSpec } from './tool-types.js';
import { validateAgentToolInput, readInputPath, AgentToolContractError } from './tool-contract.js';
import { assertUrlInTargetScope } from '../services/ai-scan/target-scope.js';
import { getScanTrafficSnapshot, hydrateScanTrafficState, runWithScanTrafficContext } from '../services/ai-scan/scan-traffic-governor.js';

const DEFAULT_TOOL_CAPABILITIES: AgentToolCapabilityClass[] = ['read', 'control_plane', 'active_test'];

const ALL_SIDE_EFFECT_LEVELS: AgentToolSideEffectLevel[] = ['none', 'metadata', 'target_read', 'target_mutation', 'target_destructive'];

function allowedSideEffects(scanConfig: Record<string, any> | undefined): Set<AgentToolSideEffectLevel> {
  const configured = scanConfig?.allowed_tool_side_effect_levels;
  if (!Array.isArray(configured) || configured.length === 0) return new Set(ALL_SIDE_EFFECT_LEVELS);
  return new Set(configured.filter((value: unknown): value is AgentToolSideEffectLevel => ALL_SIDE_EFFECT_LEVELS.includes(value as AgentToolSideEffectLevel)));
}

function allowedCapabilities(scanConfig: Record<string, any> | undefined): Set<AgentToolCapabilityClass> {
  const configured = scanConfig?.allowed_tool_capabilities;
  if (!Array.isArray(configured) || configured.length === 0) return new Set(DEFAULT_TOOL_CAPABILITIES);
  return new Set(configured.filter((value: unknown): value is AgentToolCapabilityClass => DEFAULT_TOOL_CAPABILITIES.includes(value as AgentToolCapabilityClass)));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new AgentToolContractError(`Agent tool timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolSpec>();

  register(tool: AgentToolSpec): void {
    if (this.tools.has(tool.name)) throw new Error(`Agent tool already registered: ${tool.name}`);
    if (!tool.runtime) throw new Error(`Agent tool runtime policy is required: ${tool.name}`);
    if (tool.runtime.side_effect_level !== 'none' && (!Array.isArray(tool.side_effects) || tool.side_effects.length === 0)) {
      throw new Error(`Agent tool ${tool.name} declares side effects but does not describe them`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): AgentToolSpec[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  search(query: string): AgentToolSpec[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter(tool => tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q));
  }

  async call(name: string, input: Record<string, any>, context: AgentToolContext): Promise<AgentToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown agent tool: ${name}`);
    const startedAt = new Date().toISOString();
    let contractSnapshot: Record<string, any> = {};
    try {
      validateAgentToolInput(input, tool.input_schema);
      const run = await context.repo.getRun(context.scanRunId);
      if (!run) throw new AgentToolContractError(`AI scan run not found: ${context.scanRunId}`);
      if (tool.runtime.requires_task && !context.taskId) throw new AgentToolContractError(`${name} requires an active AI scan task`);
      const capabilities = allowedCapabilities(run.scan_config);
      if (!capabilities.has(tool.runtime.capability_class)) throw new AgentToolContractError(`Tool capability ${tool.runtime.capability_class} is disabled for this scan`);
      const sideEffects = allowedSideEffects(run.scan_config);
      if (!sideEffects.has(tool.runtime.side_effect_level)) throw new AgentToolContractError(`Tool side-effect level ${tool.runtime.side_effect_level} is disabled for this scan`);
      for (const key of tool.runtime.target_input_keys || []) {
        const raw = readInputPath(input, key);
        if (raw === undefined || raw === null || raw === '') continue;
        if (Array.isArray(raw)) raw.forEach(value => assertUrlInTargetScope(String(value), run.base_url));
        else assertUrlInTargetScope(String(raw), run.base_url);
      }

      contractSnapshot = {
        capability_class: tool.runtime.capability_class,
        side_effect_level: tool.runtime.side_effect_level,
        timeout_ms: tool.runtime.timeout_ms || 120000,
        target_input_keys: tool.runtime.target_input_keys || [],
        traffic_class: tool.runtime.traffic_class,
      };
      const persistedTraffic = await context.repo.getLatestTrafficSnapshot(context.scanRunId);
      if (persistedTraffic) hydrateScanTrafficState(context.scanRunId, persistedTraffic, run.scan_config?.traffic_budget);
      const controller = new AbortController();
      const result = await runWithScanTrafficContext({
        scan_run_id: context.scanRunId,
        limits: run.scan_config?.traffic_budget,
        default_class: tool.runtime.traffic_class,
        signal: controller.signal,
        on_event: async event => {
          if (event.type !== 'blocked') return;
          await context.repo.createArtifact({
            scan_run_id: context.scanRunId,
            task_id: context.taskId,
            artifact_type: 'scan_traffic_budget_blocked',
            title: `Traffic budget blocked ${event.method} ${event.url}`,
            content_json: event as unknown as Record<string, any>,
            source_ref: event.url,
          });
        },
      }, () => withTimeout(tool.handler(input, { ...context, signal: controller.signal }), Number(tool.runtime.timeout_ms || 120000), controller));
      const traffic = getScanTrafficSnapshot(context.scanRunId);
      await context.repo.createToolInvocation({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        tool_name: name,
        input_json: input,
        output_json: result.data || {},
        contract_json: contractSnapshot,
        traffic_json: traffic || {},
        status: result.ok ? 'completed' : 'failed',
        error_message: result.error,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      return result;
    } catch (error: any) {
      const traffic = getScanTrafficSnapshot(context.scanRunId);
      await context.repo.createToolInvocation({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        tool_name: name,
        input_json: input,
        output_json: {},
        contract_json: contractSnapshot,
        traffic_json: traffic || {},
        status: 'failed',
        error_message: error.message || String(error),
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      throw error;
    }
  }
}
