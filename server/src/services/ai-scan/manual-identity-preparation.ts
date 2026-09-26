import type { AIScanRun, AIScanTask } from './types.js';
import type { AIScanRepository } from './repository.js';
import type { DbProvider } from '../../types/index.js';
import type { AgentToolContext, AgentToolResult } from '../../agent/tool-types.js';
import { configuredIdentityAccounts, identityMaterial } from './identity-material.js';

export const MANUAL_IDENTITY_INTENT = 'prepare_manual_identity';
const TEST_TOOLS = new Set(['bstg.api_test.run', 'bstg.generic_vuln.run_test', 'bstg.file_upload.run_test']);

export function needsManualIdentityPreparation(run: AIScanRun | null): boolean {
  const config = run?.scan_config || {};
  return config.account_mode === 'manual' && Object.keys(configuredIdentityAccounts(config)).length > 0 &&
    ![config.surface, config.surface_type, config.mobile?.platform, config.android?.platform].includes('android');
}

export function requiredIdentityRoles(task: AIScanTask, vulnType = ''): string[] {
  const plan = task.execution_plan || {}, workflow = plan.workflow_execution_plan || {};
  const type = vulnType || task.vuln_type || plan.vuln_type;
  if (type === 'bola_idor') return ['attacker', 'victim'];
  if (type === 'bfla') return ['attacker', 'admin'];
  if (plan.requires_identity_context || workflow.access_phase === 'post_auth' || plan.precondition_policy?.access_phase === 'post_auth' ||
      ['business_logic', 'passcode_bypass', 'replay_race', 'state_machine_race'].includes(type)) return ['attacker'];
  return [];
}

/** This is a persisted prerequisite, not an optional suggestion to the model.
 * A completed task means preparation was attempted; its artifact still records
 * partial/blocked identities. Test dispatch separately verifies required roles. */
export async function ensureManualIdentityPreparation(repo: AIScanRepository, run: AIScanRun): Promise<AIScanTask | undefined> {
  if (!needsManualIdentityPreparation(run)) return;
  const tasks = await repo.listTasks(run.id);
  let preparation = tasks.find(task => task.execution_plan?.intent === MANUAL_IDENTITY_INTENT);
  if (!preparation) preparation = await repo.createTask({
    scan_run_id: run.id, task_type: 'prepare_identity', title: '建立测试账号登录状态', priority: 15,
    dependencies: tasks.filter(task => task.execution_plan?.intent === 'discover_target').map(task => task.id),
    agent_goal: '使用已提供的测试账号建立并保存独立登录会话；记录验证码、多因素认证、登录入口和范围阻断。',
    execution_plan: { intent: MANUAL_IDENTITY_INTENT },
  });
  for (const task of tasks) {
    if (task.status !== 'pending' || task.id === preparation.id) continue;
    const intent = task.execution_plan?.intent;
    if (intent === 'model_features_and_candidates' || intent === 'expand_selected_vulnerabilities' || task.task_type.startsWith('test_') ||
        (!['summarize_vulnerability_campaign', 'vulnerability_campaign'].includes(task.task_type) &&
          intent !== 'summarize_vulnerability_campaign' && (task.execution_plan?.requires_identity_context || task.execution_plan?.workflow_execution_plan || task.execution_plan?.vuln_type))) {
      if (!task.dependencies.includes(preparation.id) || task.execution_plan?.identity_preparation_task_id !== preparation.id) await repo.updateTask(task.id, {
        dependencies: [...new Set([...task.dependencies, preparation.id])],
        execution_plan: {...task.execution_plan, identity_preparation_task_id: preparation.id},
      });
    }
  }
  return preparation;
}

export async function scanIdentityRoles(db: DbProvider, scanRunId: string): Promise<string[]> {
  const accounts = await db.repos.accounts.findAll();
  return [...new Set(accounts.flatMap(account => {
    if (!account.tags?.includes(`scan:${scanRunId}`)) return [];
    const material = identityMaterial(account.fields || {});
    if (!material.auth_token && !material.cookie_header) return [];
    return ['attacker', 'victim', 'admin'].filter(role => account.tags?.includes(`role:${role}`));
  }))];
}

/** Defence in depth for model-created children and direct tool calls. Never
 * dispatch an authenticated mutation using only a stored username/password. */
export async function manualIdentityToolBlocker(name: string, input: Record<string, any>, context: AgentToolContext): Promise<AgentToolResult | undefined> {
  if (!TEST_TOOLS.has(name)) return;
  const run = await context.repo.getRun(context.scanRunId);
  if (!needsManualIdentityPreparation(run)) return;
  const task = context.taskId ? await context.repo.getTask(context.taskId) : null;
  if (!task) return { ok: false, error: '身份测试缺少持久化任务。', data: { error_code: 'identity_preparation_required', blocked: true } };
  const roles = [...new Set([...requiredIdentityRoles(task), ...requiredIdentityRoles(task, String(input.vuln_type || ''))])];
  const endpointIds = new Set([...(task.endpoint_ids || []), ...(Array.isArray(input.endpoint_ids) ? input.endpoint_ids : []), input.endpoint_id].filter(Boolean));
  const endpoints = await context.repo.listEndpoints(context.scanRunId);
  if (!roles.length && endpoints.some(endpoint => endpointIds.has(endpoint.id) && endpoint.auth_required)) roles.push('attacker');
  if (!roles.length) return;
  const preparation = (await context.repo.listTasks(context.scanRunId)).find(item => item.execution_plan?.intent === MANUAL_IDENTITY_INTENT);
  const artifacts = preparation ? await context.repo.listArtifacts(context.scanRunId, preparation.id) : [];
  const result = artifacts.find(item => item.artifact_type === 'account_auto_bootstrap_result');
  const ready = await scanIdentityRoles(context.db, context.scanRunId);
  const missing = roles.filter(role => !ready.includes(role));
  if (preparation?.status === 'completed' && result && !missing.length) return;
  const errorCode = preparation?.status === 'completed' && result ? 'identity_session_required' : 'identity_preparation_required';
  const data = { error_code: errorCode, blocked: true, preparation_task_id: preparation?.id,
    preparation_artifact_id: result?.id, required_roles: roles, missing_roles: missing,
    closure_state: result?.content_json?.closure_state || 'not_prepared',
    blockers: (result?.content_json?.blockers || []).map((item: any) => ({ role: item.role, reason: item.reason })) };
  const summary = '本项测试所需账号尚未完成登录准备，请处理账号准备记录中的阻断后新建重试。';
  await context.repo.createArtifact({ scan_run_id: context.scanRunId, task_id: task.id,
    artifact_type: 'identity_precondition_blocked', title: '测试等待账号登录状态', content_json: data });
  return { ok: false, error: summary, summary, data };
}
