import type { DbProvider } from '../types/index.js';
import type { AIScanRepository } from '../services/ai-scan/repository.js';

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
  handler: (input: Record<string, any>, context: AgentToolContext) => Promise<AgentToolResult>;
}
