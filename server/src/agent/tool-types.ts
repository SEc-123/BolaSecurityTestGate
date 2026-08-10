import type { DbProvider } from '../types/index.js';
import type { AIScanRepository } from '../services/ai-scan/repository.js';
import type { ScanTrafficClass } from '../services/ai-scan/scan-traffic-governor.js';

export type AgentToolCapabilityClass = 'read' | 'control_plane' | 'active_test';
export type AgentToolSideEffectLevel = 'none' | 'metadata' | 'target_read' | 'target_mutation' | 'target_destructive';

export interface AgentToolRuntimePolicy {
  capability_class: AgentToolCapabilityClass;
  side_effect_level: AgentToolSideEffectLevel;
  timeout_ms?: number;
  requires_task?: boolean;
  target_input_keys?: string[];
  traffic_class?: ScanTrafficClass;
}

export interface AgentToolContext {
  db: DbProvider;
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  signal?: AbortSignal;
}

export interface AgentToolResult {
  ok: boolean;
  data?: Record<string, any>;
  summary?: string;
  error?: string;
}

export interface AgentToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  side_effects?: string[];
  runtime: AgentToolRuntimePolicy;
  handler: (input: Record<string, any>, context: AgentToolContext) => Promise<AgentToolResult>;
}
