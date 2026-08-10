import type { AIScanRepository } from './repository.js';
import type { AIAgentMemory, AIScanSharedResource, AIScanTask } from './types.js';
import { sanitizeForAIModel } from '../../agent/model-context-sanitizer.js';

const SECRET_RESOURCE_TYPES = new Set([
  'identity_pool',
  'identity_acquisition_plan',
  'session_strategy',
  'human_input_request',
]);

function tokens(value: unknown): Set<string> {
  const text = String(value || '').toLowerCase();
  const out = new Set<string>();
  const parts = text.split(/[^\p{L}\p{N}_:/.-]+/u).filter(Boolean);
  for (const part of parts) {
    if (part.length >= 2) out.add(part);
    // Chinese/Japanese/Korean business labels often contain no spaces. Small n-grams
    // let memory retrieval match sub-feature names without requiring embeddings.
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(part)) {
      const chars = Array.from(part);
      for (let size = 2; size <= Math.min(4, chars.length); size += 1) {
        for (let i = 0; i <= chars.length - size && out.size < 500; i += 1) out.add(chars.slice(i, i + size).join(''));
      }
    }
    if (out.size >= 500) break;
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

function expiresAt(ttlSeconds?: number): string | undefined {
  if (!ttlSeconds || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return undefined;
  return new Date(Date.now() + Math.floor(ttlSeconds * 1000)).toISOString();
}

export function sharedResourceMemoryPolicy(resource: AIScanSharedResource): {
  sensitivity: 'internal' | 'secret_ref';
  llm_visibility: 'summary' | 'reference_only';
  summary: string;
  content_json: Record<string, any>;
} {
  const secret = SECRET_RESOURCE_TYPES.has(resource.resource_type);
  const content = resource.content_json || {};
  const safeHints: Record<string, any> = {};
  for (const key of ['purpose', 'roles', 'endpoint_ids', 'recommended_bstg_capabilities', 'reuse_policy', 'function_key', 'vuln_type']) {
    if (content[key] !== undefined) safeHints[key] = sanitizeForAIModel(content[key]);
  }
  return {
    sensitivity: secret ? 'secret_ref' : 'internal',
    llm_visibility: secret ? 'reference_only' : 'summary',
    summary: resource.title || `${resource.resource_type}:${resource.resource_key}`,
    content_json: {
      shared_resource_id: resource.id,
      resource_type: resource.resource_type,
      resource_key: resource.resource_key,
      safe_hints: safeHints,
      raw_content_available_to_native_runtime: true,
      raw_content_exposed_to_llm: false,
    },
  };
}

export async function mirrorSharedResourceAsMemory(repo: AIScanRepository, resource: AIScanSharedResource): Promise<AIAgentMemory> {
  const policy = sharedResourceMemoryPolicy(resource);
  return repo.upsertAgentMemory({
    scan_run_id: resource.scan_run_id,
    owner_task_id: resource.owner_task_id,
    memory_type: `shared_resource:${resource.resource_type}`,
    memory_key: resource.resource_key,
    scope_type: 'scan',
    scope_ref: '',
    title: resource.title,
    summary: policy.summary,
    content_json: policy.content_json,
    sensitivity: policy.sensitivity,
    llm_visibility: policy.llm_visibility,
    confidence: 0.9,
    provenance_json: {
      source: 'ai_scan_shared_resources',
      source_id: resource.id,
      source_type: resource.resource_type,
      source_key: resource.resource_key,
    },
  });
}

export async function rememberAgentObservation(input: {
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  memoryType: string;
  memoryKey: string;
  scopeType?: 'scan' | 'task' | 'identity' | 'feature' | 'endpoint';
  scopeRef?: string;
  title?: string;
  summary: string;
  content?: Record<string, any>;
  confidence?: number;
  ttlSeconds?: number;
  dependsOn?: string[];
  provenance?: Record<string, any>;
}): Promise<AIAgentMemory> {
  const sanitizedContent = sanitizeForAIModel(input.content || {});
  const sanitizedSummary = String(sanitizeForAIModel(input.summary)).slice(0, 4000);
  const scopeType = input.scopeType || (input.taskId ? 'task' : 'scan');
  const scopeRef = input.scopeRef || (scopeType === 'task' ? String(input.taskId || '') : '');
  if (scopeType !== 'scan' && !scopeRef) throw new Error(`scope_ref is required for ${scopeType}-scoped Agent memory`);
  return input.repo.upsertAgentMemory({
    scan_run_id: input.scanRunId,
    owner_task_id: input.taskId,
    memory_type: input.memoryType,
    memory_key: input.memoryKey,
    scope_type: scopeType,
    scope_ref: scopeRef,
    title: input.title ? String(sanitizeForAIModel(input.title)).slice(0, 512) : undefined,
    summary: sanitizedSummary,
    content_json: sanitizedContent as Record<string, any>,
    sensitivity: 'internal',
    llm_visibility: 'full',
    confidence: input.confidence ?? 0.7,
    ttl_seconds: input.ttlSeconds,
    expires_at: expiresAt(input.ttlSeconds),
    provenance_json: sanitizeForAIModel(input.provenance || {}) as Record<string, any>,
    depends_on_json: input.dependsOn || [],
  });
}

export function memoryViewForModel(memory: AIAgentMemory): Record<string, any> | null {
  if (memory.status !== 'active' || memory.llm_visibility === 'hidden') return null;
  const base = {
    id: memory.id,
    type: memory.memory_type,
    key: memory.memory_key,
    scope_type: memory.scope_type,
    scope_ref: memory.scope_ref,
    title: memory.title,
    summary: memory.summary,
    confidence: memory.confidence,
    version: memory.version,
    sensitivity: memory.sensitivity,
    visibility: memory.llm_visibility,
    provenance: sanitizeForAIModel(memory.provenance_json),
    depends_on: memory.depends_on_json,
    updated_at: memory.updated_at,
  };
  if (memory.llm_visibility === 'reference_only') return { ...base, content: '[REFERENCE_ONLY]' };
  if (memory.llm_visibility === 'summary') return base;
  return { ...base, content: sanitizeForAIModel(memory.content_json) };
}

export async function retrieveRelevantAgentMemories(input: {
  repo: AIScanRepository;
  scanRunId: string;
  task?: AIScanTask;
  query?: string;
  identityKey?: string;
  limit?: number;
}): Promise<Record<string, any>[]> {
  const memories = await input.repo.listAgentMemories(input.scanRunId);
  const task = input.task;
  const queryText = [
    input.query || '',
    task?.title || '',
    task?.agent_goal || '',
    task?.task_type || '',
    task?.vuln_type || '',
    task?.feature_id || '',
    ...(task?.endpoint_ids || []),
    input.identityKey || '',
  ].join(' ');
  const queryTokens = tokens(queryText);
  const now = Date.now();
  const scored = memories
    .filter(memory => memory.llm_visibility !== 'hidden')
    .map(memory => {
      let score = Math.max(0, Math.min(1, Number(memory.confidence || 0.5))) * 4;
      if (memory.scope_type === 'scan') score += 0.5;
      if (memory.scope_type === 'task' && memory.scope_ref === task?.id) score += 5;
      if (memory.scope_type === 'feature' && memory.scope_ref === task?.feature_id) score += 4;
      if (memory.scope_type === 'endpoint' && (task?.endpoint_ids || []).includes(memory.scope_ref)) score += 4;
      if (memory.scope_type === 'identity' && input.identityKey && memory.scope_ref === input.identityKey) score += 4;
      const memoryTokens = tokens(`${memory.memory_type} ${memory.memory_key} ${memory.title || ''} ${memory.summary || ''} ${JSON.stringify(memory.content_json || {})}`);
      score += Math.min(8, overlap(queryTokens, memoryTokens) * 1.25);
      score += Math.min(2, Math.log2(Number(memory.usage_count || 0) + 1) * 0.25);
      const ageHours = Math.max(0, now - new Date(memory.updated_at).getTime()) / 3_600_000;
      score += Math.max(0, 1.5 - ageHours / 48);
      return { memory, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(50, Number(input.limit || 20))));
  await input.repo.touchAgentMemories(scored.map(item => item.memory.id));
  return scored.map(({ memory, score }) => ({ ...memoryViewForModel(memory), retrieval_score: Number(score.toFixed(3)) })).filter(Boolean) as Record<string, any>[];
}
