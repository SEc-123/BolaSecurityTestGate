import type { AIScanRepository } from './repository.js';
import type { AIScanTask } from './types.js';
import { hydrateRequests } from './captured-request.js';
import { buildWorkflowExecutionPlan, type WorkflowExecutionPlan } from './workflow-context.js';
import { assertUrlInTargetScope } from './target-scope.js';

/** Safe metadata only: the caller can inspect the rejected contract without
 * exposing captured requests, account material, or target URLs. */
export class TaskEndpointPlanError extends Error {
  readonly data: Record<string, any>;

  constructor(reason: string, task?: AIScanTask, targetId?: string) {
    super('测试接口与已保存的任务计划不一致。请使用任务计划中的接口；新发现的接口需要建立独立子任务。');
    this.name = 'TaskEndpointPlanError';
    const target = targetId || task?.execution_plan?.workflow_execution_plan?.target_endpoint_id;
    this.data = {
      error_code: 'task_endpoint_plan_mismatch',
      reason_code: reason,
      failure_phase: 'pre_action',
      action_performed: false,
      allowed_endpoint_ids: task?.endpoint_ids || [],
      ...(typeof target === 'string' ? { target_endpoint_id: target } : {}),
    };
  }
}

function ids(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) return undefined;
  return [...new Set(value as string[])];
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id));
}

function uniqueIds(value: unknown): string[] | undefined {
  const parsed = ids(value);
  return parsed && parsed.length === (value as unknown[]).length ? parsed : undefined;
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Resolve from persisted task/run state, never from caller-supplied endpoint
 * objects. Validation must finish before persisting a legacy plan or doing any
 * execution work. A child owns its explicit scope, independent of its parent. */
export async function resolveTaskEndpointPlan(input: {
  repo: AIScanRepository;
  scanRunId: string;
  taskId: string;
  endpointId?: unknown;
  endpointIds?: unknown;
  vulnType?: unknown;
}) {
  const task = await input.repo.getTask(input.taskId);
  if (!task || task.scan_run_id !== input.scanRunId) throw new TaskEndpointPlanError('task_run_mismatch');
  const scope = uniqueIds(task.endpoint_ids);
  const reject = (reason: string, targetId?: string): never => { throw new TaskEndpointPlanError(reason, task, targetId); };
  if (!scope?.length) reject('empty_or_invalid_task_scope');
  const scopeIds = scope!;
  const vulnType = task.vuln_type || (task.task_type === 'test_file_upload' ? 'file_upload' : undefined);
  if (input.vulnType !== undefined && input.vulnType !== vulnType) reject('vulnerability_type_mismatch');
  if (input.endpointId !== undefined && (typeof input.endpointId !== 'string' || !scopeIds.includes(input.endpointId))) reject('target_outside_task_scope');
  const proposedIds = input.endpointIds === undefined ? undefined : ids(input.endpointIds);
  if (input.endpointIds !== undefined && (!proposedIds || !sameIds(proposedIds, scopeIds))) reject('endpoint_scope_mismatch');

  const run = await input.repo.getRun(input.scanRunId);
  if (!run) reject('run_not_found');
  const allEndpoints = await input.repo.listEndpoints(input.scanRunId);
  const scopedEndpoints = scopeIds.map(id => allEndpoints.find(endpoint => endpoint.id === id && endpoint.scan_run_id === input.scanRunId));
  if (scopedEndpoints.some(endpoint => !endpoint)) reject('endpoint_not_in_run');
  const endpoints = await hydrateRequests(input.repo, scopedEndpoints.filter(endpoint => !!endpoint));
  for (const endpoint of endpoints) {
    try {
      assertUrlInTargetScope(endpoint.url || endpoint.path, run!.base_url);
      if (endpoint.captured_request) assertUrlInTargetScope(endpoint.captured_request.url, run!.base_url);
    } catch { reject('endpoint_origin_outside_run_scope'); }
  }

  const embedded = task.execution_plan?.workflow_execution_plan;
  let plan: WorkflowExecutionPlan;
  const needsPlan = embedded === undefined;
  if (needsPlan) {
    // Older explicit child tasks persist scope but no workflow plan. Build once
    // using only that scope; newly observed scan endpoints cannot be pulled in.
    plan = buildWorkflowExecutionPlan({
      allEndpoints: endpoints,
      selectedEndpointIds: scopeIds,
      targetEndpointId: input.endpointId as string | undefined,
      vulnType: vulnType || 'generic',
      hasConfiguredIdentity: Object.keys(run!.scan_config?.accounts || run!.scan_config?.identities || {}).length > 0,
    });
  } else {
    if (!embedded || typeof embedded !== 'object') reject('invalid_persisted_plan');
    plan = embedded as WorkflowExecutionPlan;
  }
  const planIds = uniqueIds(plan.endpoint_ids);
  const targetId = plan.target_endpoint_id;
  if (!planIds || !sameIds(planIds, scopeIds) || typeof targetId !== 'string' || !planIds.includes(targetId)) reject('invalid_persisted_plan');
  if (!Array.isArray(plan.nodes) || !sameOrder(uniqueIds(plan.nodes.map(node => node?.endpoint_id)) || [], planIds!) ||
      !Array.isArray(plan.schedule) || plan.schedule.some(stage => !uniqueIds(stage?.endpoint_ids)?.every(id => planIds!.includes(id))) ||
      !sameOrder(uniqueIds(plan.schedule.flatMap(stage => stage.endpoint_ids)) || [], planIds!)) reject('invalid_persisted_plan', targetId);
  if (input.endpointId !== undefined && input.endpointId !== targetId) reject('target_plan_mismatch', targetId);
  const ordered = planIds!.map(id => endpoints.find(endpoint => endpoint.id === id)!);
  const endpoint = ordered.find(item => item.id === targetId)!;

  if (needsPlan || vulnType !== task.vuln_type) {
    task.execution_plan = { ...task.execution_plan, workflow_execution_plan: plan };
    task.vuln_type = vulnType;
    await input.repo.updateTask(task.id, { execution_plan: task.execution_plan, ...(vulnType ? { vuln_type: vulnType } : {}) });
  }
  return { task, run: run!, plan, endpoint, endpoints: ordered };
}
