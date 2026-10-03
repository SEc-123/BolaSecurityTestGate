import { createHash } from 'node:crypto';
import type { AIScanTask } from '../services/ai-scan/types.js';

/** A server-sealed normal outcome. IDs are deterministic from the configured
 * label, so retries retain the same manifest without letting a model rename,
 * add, or replace an objective. Labels are declarative only; execution still
 * requires model-selected browser actions and native Test Run evidence. */
export interface NormalBusinessObjective {
  id: string;
  label: string;
  /**
   * Optional server-sealed observable completion contract.  A natural-language
   * objective tells the model what business result to reach; these paths make
   * the final result mechanically auditable without exposing any response
   * value.  They are deliberately response *shapes*, never literals,
   * selectors, credentials, or transport data.
   */
  completion?: NormalBusinessObjectiveCompletion;
  /** This objective must be executed with one scan-bound prepared identity. */
  requires_prepared_identity?: boolean;
  /** Server-sealed state-changing operation evidence required for this outcome. */
  operation?: NormalBusinessObjectiveOperation;
}

export interface NormalBusinessObjectiveCompletion {
  required_response_paths: string[];
}

/**
 * A strict objective can name the kind of state-changing operation that must
 * be observed. The matcher is sealed server-side; the opaque operation ID and
 * side-effect class are the only parts intended for model-facing receipts.
 * Route shape contains no request/response values and is never projected into
 * the normal-learning model context.
 */
export interface NormalBusinessObjectiveOperation {
  operation_id: string;
  method: string;
  route_shape: string;
  side_effect_class: 'authentication' | 'update' | 'add' | 'create' | 'transaction' | 'write';
}

function normalizedObjectiveLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360);
  return label || undefined;
}

function normalizedCompletion(value: unknown): NormalBusinessObjectiveCompletion | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, any>).required_response_paths;
  if (!Array.isArray(raw)) return undefined;
  const paths = [...new Set(raw.flatMap(item => {
    const path = typeof item === 'string' ? item.trim() : '';
    return /^body\.[^\s]{1,280}$/.test(path) ? [path] : [];
  }))].slice(0, 20);
  return paths.length ? { required_response_paths: paths } : undefined;
}

const OPERATION_METHOD = /^(POST|PUT|PATCH|DELETE)$/;
const OPERATION_ROUTE = /^\/[A-Za-z0-9._~:/{}-]{1,280}$/;
const SIDE_EFFECT_CLASSES = new Set<NormalBusinessObjectiveOperation['side_effect_class']>(['authentication','update','add','create','transaction','write']);

function normalizedOperation(value: unknown, label: string): NormalBusinessObjectiveOperation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method.trim().toUpperCase() : '';
  const route_shape = typeof record.route_shape === 'string' ? record.route_shape.trim() : '';
  const side_effect_class = typeof record.side_effect_class === 'string' ? record.side_effect_class.trim() : '';
  if (!OPERATION_METHOD.test(method) || !OPERATION_ROUTE.test(route_shape) || !SIDE_EFFECT_CLASSES.has(side_effect_class as NormalBusinessObjectiveOperation['side_effect_class'])) return undefined;
  return {
    operation_id: `operation:${createHash('sha256').update(`${label}\u0000${method}\u0000${route_shape}\u0000${side_effect_class}`).digest('hex').slice(0, 24)}`,
    method, route_shape, side_effect_class: side_effect_class as NormalBusinessObjectiveOperation['side_effect_class'],
  };
}

function normalizedObjective(value: unknown): { label: string; completion?: NormalBusinessObjectiveCompletion; requires_prepared_identity?: boolean; operation?: NormalBusinessObjectiveOperation } | undefined {
  if (typeof value === 'string') {
    const label = normalizedObjectiveLabel(value);
    return label ? { label } : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, any>;
  const label = normalizedObjectiveLabel(record.label);
  if (!label) return undefined;
  const operation = normalizedOperation(record.operation, label);
  return { label, completion: normalizedCompletion(record.completion),
    ...(operation ? { operation } : {}),
    ...(record.requires_prepared_identity === true ? { requires_prepared_identity: true } : {}) };
}

function mergeCompletion(left?: NormalBusinessObjectiveCompletion, right?: NormalBusinessObjectiveCompletion): NormalBusinessObjectiveCompletion | undefined {
  const paths = [...new Set([...(left?.required_response_paths || []), ...(right?.required_response_paths || [])])].slice(0, 20);
  return paths.length ? { required_response_paths: paths } : undefined;
}

export function normalBusinessObjectiveManifest(config: Record<string, any> = {}): NormalBusinessObjective[] {
  const configured = config?.business_learning?.normal_objectives ?? config?.normal_business_objectives;
  if (!Array.isArray(configured)) return [];
  const objectives = new Map<string, { completion?: NormalBusinessObjectiveCompletion; requires_prepared_identity?: boolean; operation?: NormalBusinessObjectiveOperation }>();
  for (const value of configured) {
    const objective = normalizedObjective(value);
    if (!objective) continue;
    const prior = objectives.get(objective.label);
    if (prior?.operation && objective.operation && (prior.operation.method !== objective.operation.method || prior.operation.route_shape !== objective.operation.route_shape || prior.operation.side_effect_class !== objective.operation.side_effect_class)) {
      throw new Error(`Duplicate normal-business objective label has conflicting sealed operation contracts: ${objective.label}`);
    }
    objectives.set(objective.label, { completion: mergeCompletion(prior?.completion, objective.completion),
      ...(prior?.operation || objective.operation ? { operation: prior?.operation || objective.operation } : {}),
      ...(prior?.requires_prepared_identity || objective.requires_prepared_identity ? { requires_prepared_identity: true } : {}) });
    if (objectives.size >= 12) break;
  }
  return [...objectives.entries()].map(([label, contract]) => ({
    id: `objective:${createHash('sha256').update(label).digest('hex').slice(0, 24)}`,
    label,
    ...(contract.completion ? { completion: contract.completion } : {}),
    ...(contract.operation ? { operation: contract.operation } : {}),
    ...(contract.requires_prepared_identity ? { requires_prepared_identity: true } : {}),
  }));
}

/** Read only the persisted task manifest. Do not regenerate it from mutable
 * scan configuration: the plan task is the immutable authority for its run. */
export function normalObjectiveManifestForTask(task: Pick<AIScanTask, 'execution_plan'> | undefined): NormalBusinessObjective[] {
  const value = task?.execution_plan?.normal_objective_manifest;
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const manifest: NormalBusinessObjective[] = [];
  for (const item of value) {
    const id = typeof item?.id === 'string' && /^objective:[a-f0-9]{24}$/.test(item.id) ? item.id : undefined;
    const label = normalizedObjectiveLabel(item?.label);
    if (!id || !label || seen.has(id)) continue;
    const completion = normalizedCompletion(item?.completion);
    const operation = normalizedOperation(item?.operation, label);
    seen.add(id); manifest.push({ id, label, ...(completion ? { completion } : {}), ...(operation ? { operation } : {}),
      ...(item?.requires_prepared_identity === true ? { requires_prepared_identity: true } : {}) });
  }
  return manifest;
}

export function requiresNormalObjectiveManifest(task: Pick<AIScanTask, 'execution_plan'> | undefined): boolean {
  return task?.execution_plan?.strict_normal_objectives === true && normalObjectiveManifestForTask(task).length > 0;
}

export function normalObjectiveForTask(task: Pick<AIScanTask, 'execution_plan'> | undefined,
  objectiveId: unknown): NormalBusinessObjective | undefined {
  return normalObjectiveManifestForTask(task).find(objective => objective.id === objectiveId);
}

/** Lifecycle fail-closed gate for strict plans. Keep this independent from the
 * mutable coverage inventory so even an internal/direct artifact write cannot
 * schedule a partial objective set. */
export function strictNormalObjectiveFlowGap(task: Pick<AIScanTask, 'execution_plan'> | undefined,
  flows: Array<{ objective_id?: unknown }>): string | undefined {
  // The full autonomous business-experiment lane is useful only after at
  // least one server-owned normal outcome has been declared.  Keep this on
  // the persisted plan task so a direct caller cannot turn an empty manifest
  // into a zero-flow success by bypassing bootstrap validation.
  if (task?.execution_plan?.normal_objectives_required === true && normalObjectiveManifestForTask(task).length === 0) {
    return 'This normal-then-model-experiment plan requires at least one immutable server-owned normal-business objective before planning can complete.';
  }
  if (!requiresNormalObjectiveManifest(task)) return undefined;
  const counts = new Map<string, number>();
  for (const flow of flows) {
    const objectiveId = typeof flow?.objective_id === 'string' ? flow.objective_id : '';
    if (objectiveId) counts.set(objectiveId, (counts.get(objectiveId) || 0) + 1);
  }
  for (const objective of normalObjectiveManifestForTask(task)) {
    if (counts.get(objective.id) !== 1) {
      return `Immutable normal-business objective ${objective.id} requires exactly one current saved Flow before planning can complete.`;
    }
  }
  return undefined;
}
