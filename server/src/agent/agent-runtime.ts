import { mobileDiscoveryReport } from '../services/mobile/mobile-explorer.js';
import { getLatestMobileSessionForScan } from '../services/mobile/mobile-session-service.js';
import { stopMobileLab, getMobileTestReport } from '../services/mobile/mobile-lab-service.js';
import type { DbProvider } from '../types/index.js';
import { AIScanRepository } from '../services/ai-scan/repository.js';
import { createAgentToolRegistry } from './index.js';
import type { AIScanRun, AIScanSnapshot, AIScanTask } from '../services/ai-scan/types.js';
import { buildAutonomousAgentContext } from './context-builder.js';
import { AutonomousAgentPlanner } from './autonomous-planner.js';
import type { AutonomousPlannerResult } from './decision-types.js';
import { closePersistentBrowserContextsForScan, closeTaskBrowserContexts } from '../services/ai-scan/browser/persistent-browser-runtime.js';
import { rememberAgentObservation } from '../services/ai-scan/agent-memory.js';
import { agentEventBus } from '../observability/agent-event-bus.js';
import { assertScanActive, scanPolicyDenial, withScanControl, POLICY_DENIAL_MESSAGE } from '../services/ai-scan/run-control.js';

export interface AgentRunResult {
  scan_run_id: string;
  steps_executed: number;
  completed: boolean;
  blocked_waiting_selection: boolean;
  last_task?: AIScanTask;
  snapshot: AIScanSnapshot;
  parallel_agents?: number;
  batches_executed?: number;
}

export interface AgentRunOptions {
  max_steps?: number;
  max_parallel_agents?: number;
}

function now(): string {
  return new Date().toISOString();
}

function selectedVulnTypes(run: AIScanRun): string[] {
  return Array.isArray(run.selected_vuln_types) ? run.selected_vuln_types : [];
}

function decisionSummary(decision: AutonomousPlannerResult): string {
  if (decision.action === 'tool_call') return `tool_call:${decision.tool_name}`;
  return decision.action;
}


function decisionSignature(decision: AutonomousPlannerResult): string {
  const payload = JSON.stringify({ action: decision.action, tool_name: decision.tool_name, arguments: decision.arguments || {}, tasks: decision.tasks || [] });
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function textSummary(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return fallback || String(value);
  }
}

export class AIScanAgentRuntime {
  private readonly registry = createAgentToolRegistry();
  private readonly repo: AIScanRepository;
  private readonly planner: AutonomousAgentPlanner;

  constructor(private readonly db: DbProvider) {
    this.repo = new AIScanRepository(db);
    this.planner = new AutonomousAgentPlanner(db);
  }

  getRepository(): AIScanRepository {
    return this.repo;
  }

  listTools(query = '') {
    return query.trim() ? this.registry.search(query) : this.registry.list();
  }

  async bootstrapRun(run: AIScanRun): Promise<void> {
    const tasks = await this.repo.listTasks(run.id);
    if (tasks.length > 0) return;
    const inventory = await this.repo.createTask({
      scan_run_id: run.id,
      title: '梳理 BSTG 原生能力并装载 Agent 驾驶层',
      task_type: 'autonomous_agent_task',
      priority: 5,
      agent_goal: '梳理模板、API test run、工作流、变量池、映射、提取器、学习、session、账号绑定、payload 字典、变异和校验能力，作为后续任务的原生执行底座。Agent 必须自己选择并调用合适工具。',
      execution_plan: { intent: 'inventory_bstg_capabilities' },
    });
    const isAndroidSurface = run.scan_config?.surface === 'android' || run.scan_config?.surface_type === 'android' || run.scan_config?.mobile?.platform === 'android' || run.scan_config?.android?.platform === 'android';
    const discover = await this.repo.createTask({
      scan_run_id: run.id,
      title: isAndroidSurface ? '自动连接 Android App 并导入移动端业务流量' : '自动理解目标并发现功能/接口',
      task_type: 'autonomous_agent_task',
      priority: 10,
      dependencies: [inventory.id],
      agent_goal: isAndroidSurface
        ? '连接预配置 Mobile Lab，启动 Android App，像 Playwright 一样通过 UIAutomator/ADB 观察和操作界面；确认 Burp HTTPS 明文抓包，导入 recording_events，生成 API/Workflow draft。'
        : '自动访问目标 URL，收集页面、表单、上传控件和接口观察，替代人工录制。Agent 需要自行决定先导航还是直接发现。',
      execution_plan: { intent: 'discover_target', surface: isAndroidSurface ? 'android' : 'web' },
    });
    await this.repo.createTask({
      scan_run_id: run.id,
      title: '生成功能树和漏洞候选',
      task_type: 'autonomous_agent_task',
      priority: 20,
      dependencies: [discover.id],
      agent_goal: '基于自动发现的 endpoint 和页面语义，归纳功能/子功能，并生成用户可选择的大类漏洞列表。若用户已选择漏洞类型，继续展开持久化测试任务；否则等待用户选择。',
      execution_plan: { intent: 'model_features_and_candidates' },
    });
  }

  async expandSelectedVulnerabilities(scanRunId: string, selectedVulnTypes: string[]): Promise<void> {
    return withScanControl(scanRunId, async () => {
      await this.expandSelectedVulnerabilitiesActive(scanRunId, selectedVulnTypes);
      if (scanPolicyDenial()) {
        await this.persistPolicyDenial(scanRunId);
        assertScanActive();
      }
    });
  }

  private async expandSelectedVulnerabilitiesActive(scanRunId: string, selectedVulnTypes: string[]): Promise<void> {
    const run = await this.repo.getRun(scanRunId);
    if (!run) throw new Error(`AI scan run not found: ${scanRunId}`);
    if (['failed', 'completed'].includes(run.status)) throw new Error('本轮已经结束，请新建重试记录。');
    await this.repo.updateRun(scanRunId, {
      selected_vuln_types: selectedVulnTypes,
      status: 'planning',
      current_phase: 'expanding_selected_vulnerabilities',
    });
    const task = await this.repo.createTask({
      scan_run_id: scanRunId,
      title: '根据用户选择的漏洞类型自主展开可执行任务',
      task_type: 'autonomous_agent_task',
      priority: 25,
      agent_goal: '根据 selected_vuln_types、候选漏洞、功能树和 endpoint 上下文，自主调用任务展开工具，生成持久化漏洞测试任务。',
      execution_plan: { intent: 'expand_selected_vulnerabilities', selected_vuln_types: selectedVulnTypes },
    });
    await this.executeTask(task);
  }

  async run(scanRunId: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    return withScanControl(scanRunId, () => this.runActive(scanRunId, options));
  }

  private async runActive(scanRunId: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const run = await this.repo.getRun(scanRunId);
    if (!run) throw new Error(`AI scan run not found: ${scanRunId}`);
    if (['failed', 'completed'].includes(run.status)) throw new Error('本轮已经结束，请新建重试记录。');
    await this.bootstrapRun(run);

    const configuredParallel = Number(options.max_parallel_agents ?? run.scan_config?.max_parallel_agents ?? 1);
    const maxParallelAgents = Math.max(1, Math.min(32, Number.isFinite(configuredParallel) ? configuredParallel : 1));
    if (maxParallelAgents > 1) {
      return this.runParallel(scanRunId, { ...options, max_parallel_agents: maxParallelAgents });
    }

    let stepsExecuted = 0;
    const maxSteps = options.max_steps !== undefined ? Math.max(1, Number(options.max_steps)) : Number.POSITIVE_INFINITY;
    let lastTask: AIScanTask | undefined;

    await this.repo.updateRun(scanRunId, { status: 'running', current_phase: 'autonomous_agent_loop' });

    while (stepsExecuted < maxSteps) {
      if (scanPolicyDenial()) break;
      const task = await this.repo.findNextPendingTask(scanRunId);
      if (!task) break;
      lastTask = task;
      await this.repo.createArtifact({
        scan_run_id: scanRunId,
        task_id: task.id,
        artifact_type: 'subagent_spawned',
        title: `Single Agent worker executing ${task.title}`,
        content_json: { mode: 'single', task_id: task.id, worker_id: 'agent-1' },
      });
      const used = await this.executeTask(task, Math.max(1, Math.min(20, maxSteps - stepsExecuted)));
      stepsExecuted += used;
      if (used <= 0) break;
    }

    return this.finishRun(scanRunId, stepsExecuted, lastTask, 1, 0);
  }

  private async runParallel(scanRunId: string, options: AgentRunOptions): Promise<AgentRunResult> {
    let stepsExecuted = 0;
    let batchesExecuted = 0;
    let lastTask: AIScanTask | undefined;
    const maxSteps = options.max_steps !== undefined ? Math.max(1, Number(options.max_steps)) : Number.POSITIVE_INFINITY;
    const maxParallelAgents = Math.max(1, Math.min(32, Number(options.max_parallel_agents || 4)));

    await this.repo.updateRun(scanRunId, {
      status: 'running',
      current_phase: 'parallel_autonomous_agent_loop',
      summary: { max_parallel_agents: maxParallelAgents },
    });

    while (stepsExecuted < maxSteps) {
      if (scanPolicyDenial()) break;
      const claimed = await this.repo.claimRunnableTasks(scanRunId, maxParallelAgents, `agent-batch-${batchesExecuted + 1}`);
      if (claimed.length === 0) break;
      batchesExecuted += 1;
      lastTask = claimed[claimed.length - 1];
      const batchId = `parallel-batch-${batchesExecuted}`;
      await this.repo.createArtifact({
        scan_run_id: scanRunId,
        artifact_type: 'parallel_agent_batch_started',
        title: `Parallel Agent batch ${batchesExecuted}`,
        content_json: {
          batch_id: batchId,
          max_parallel_agents: maxParallelAgents,
          task_ids: claimed.map(task => task.id),
          task_titles: claimed.map(task => task.title),
          vuln_types: claimed.map(task => task.vuln_type).filter(Boolean),
        },
      });
      for (const task of claimed) {
        await this.repo.createArtifact({
          scan_run_id: scanRunId,
          task_id: task.id,
          artifact_type: 'subagent_spawned',
          title: `Sub-Agent spawned for ${task.title}`,
          content_json: {
            batch_id: batchId,
            task_id: task.id,
            worker_id: task.execution_plan?.agent_worker_id || 'agent-worker',
            vuln_type: task.vuln_type,
            browser_context_id: `browser-${task.id}`,
            endpoint_ids: task.endpoint_ids,
          },
        });
      }
      const remainingBudget = Math.max(1, maxSteps - stepsExecuted);
      const perTaskBudget = Math.max(1, Math.min(20, Math.ceil(remainingBudget / claimed.length)));
      const results = await Promise.allSettled(claimed.map(task => this.executeTask(task, perTaskBudget)));
      const used = results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value : 1), 0);
      stepsExecuted += used;
      await this.repo.createArtifact({
        scan_run_id: scanRunId,
        artifact_type: 'parallel_agent_batch_completed',
        title: `Parallel Agent batch ${batchesExecuted} completed`,
        content_json: {
          batch_id: batchId,
          steps_used: used,
          results: results.map((result, index) => ({
            task_id: claimed[index]?.id,
            status: result.status,
            steps: result.status === 'fulfilled' ? result.value : undefined,
            error: result.status === 'rejected' ? String(result.reason?.message || result.reason) : undefined,
          })),
        },
      });
      const freshRun = await this.repo.getRun(scanRunId);
      if (freshRun?.status === 'awaiting_selection') break;
      if (used <= 0) break;
    }

    return this.finishRun(scanRunId, stepsExecuted, lastTask, maxParallelAgents, batchesExecuted);
  }

  private async finishRun(scanRunId: string, stepsExecuted: number, lastTask: AIScanTask | undefined, parallelAgents: number, batchesExecuted: number): Promise<AgentRunResult> {
    if (scanPolicyDenial()) await this.persistPolicyDenial(scanRunId);
    const freshRun = await this.repo.getRun(scanRunId);
    const tasks = await this.repo.listTasks(scanRunId);
    const pending = tasks.filter(task => task.status === 'pending');
    const running = tasks.filter(task => task.status === 'running');
    const blockedWaitingSelection = tasks.some(task => task.status === 'waiting_selection') || freshRun?.status === 'awaiting_selection';
    const runnablePending = pending.length > 0 ? await this.repo.findRunnablePendingTasks(scanRunId, pending.length) : [];
    const deadlockedPending = pending.length > 0 && runnablePending.length === 0 && running.length === 0;
    const runnableRemaining = pending.length > 0 || running.length > 0;
    const failed = tasks.some(task => task.status === 'failed') || deadlockedPending;

    if ((!runnableRemaining || deadlockedPending) && !blockedWaitingSelection) {
      const browserContextsClosed = await closePersistentBrowserContextsForScan(this.repo, scanRunId, 'closed').catch(() => 0);
      await this.repo.updateRun(scanRunId, {
        status: failed ? 'failed' : 'completed',
        current_phase: failed ? 'failed' : 'completed',
        summary: {
          ...(freshRun?.summary || {}),
          tasks_total: tasks.length,
          tasks_completed: tasks.filter(task => task.status === 'completed').length,
          tasks_failed: tasks.filter(task => task.status === 'failed').length,
          tasks_blocked: tasks.filter(task => task.status === 'blocked').length,
          deadlocked_pending_tasks: deadlockedPending ? pending.map(task => ({ id: task.id, title: task.title, dependencies: task.dependencies })) : [],
          parallel_agents: parallelAgents,
          parallel_batches: batchesExecuted,
          persistent_browser_contexts_closed: browserContextsClosed,
        },
      });
    }

    return {
      scan_run_id: scanRunId,
      steps_executed: stepsExecuted,
      completed: (!runnableRemaining || deadlockedPending) && !blockedWaitingSelection,
      blocked_waiting_selection: blockedWaitingSelection,
      last_task: lastTask,
      parallel_agents: parallelAgents,
      batches_executed: batchesExecuted,
      snapshot: await this.repo.getSnapshot(scanRunId),
    };
  }

  private async persistPolicyDenial(scanRunId: string): Promise<void> {
    const denial = scanPolicyDenial();
    if (!denial) return;
    const run = await this.repo.getRun(scanRunId);
    for (const task of await this.repo.listTasks(scanRunId)) {
      if (['pending', 'running', 'waiting_selection'].includes(task.status)) {
        await this.repo.updateTask(task.id, { status: 'failed', phase: 'provider_policy_denied',
          error_message: POLICY_DENIAL_MESSAGE, completed_at: now() });
      }
    }
    if (!run?.summary?.provider_policy_denial) {
      await this.repo.createArtifact({ scan_run_id: scanRunId, artifact_type: 'provider_policy_denial',
        title: 'Provider denied this run', content_json: denial });
    }
    await this.repo.updateRun(scanRunId, { status: 'failed', current_phase: 'provider_policy_denied',
      summary: { ...run?.summary, provider_policy_denial: denial, execution_error: POLICY_DENIAL_MESSAGE } });
  }

  private async recordDecision(task: AIScanTask, decision: AutonomousPlannerResult): Promise<void> {
    await this.repo.createArtifact({
      scan_run_id: task.scan_run_id,
      task_id: task.id,
      artifact_type: 'agent_decision',
      title: `Agent decision: ${decisionSummary(decision)}`,
      content_json: {
        action: decision.action,
        tool_name: decision.tool_name,
        arguments: decision.arguments || {},
        rationale: decision.rationale,
        reason: decision.reason,
        summary: decision.summary,
        confidence: decision.confidence,
        source: decision.source,
        provider_id: decision.provider_id,
        provider_response_id: decision.provider_response_id,
        model: decision.model,
        raw_response: decision.raw_response,
        proposal: decision.proposal,
        policy_decision: decision.policy_decision,
        validation_status: decision.validation_status,
        rejection_reason: decision.rejection_reason,
        decision_signature: decision.decision_signature,
        ai_usage: decision.ai_usage,
        ai_provider_attempted: decision.ai_provider_attempted,
      },
    });
  }

  private async rememberTaskOutcome(taskId: string): Promise<void> {
    const completedTask = await this.repo.getTask(taskId);
    if (!completedTask || !['completed', 'failed', 'blocked', 'waiting_selection'].includes(completedTask.status)) return;
    await rememberAgentObservation({
      repo: this.repo,
      scanRunId: completedTask.scan_run_id,
      taskId: completedTask.id,
      memoryType: 'task_outcome',
      memoryKey: completedTask.id,
      scopeType: 'task',
      scopeRef: completedTask.id,
      title: completedTask.title,
      summary: completedTask.result_summary || completedTask.error_message || `${completedTask.status}:${completedTask.phase || ''}`,
      content: { task_type: completedTask.task_type, vuln_type: completedTask.vuln_type, feature_id: completedTask.feature_id, endpoint_ids: completedTask.endpoint_ids, status: completedTask.status, phase: completedTask.phase },
      confidence: completedTask.status === 'completed' ? 0.9 : completedTask.status === 'waiting_selection' ? 0.75 : 0.65,
      provenance: { source: 'agent_runtime_task_terminal_state' },
    });
  }

  private async executeTask(task: AIScanTask, maxIterations = 20): Promise<number> {
    maxIterations = Math.max(1, maxIterations);
    await this.repo.updateTask(task.id, { status: 'running', started_at: now(), phase: 'autonomous_running' });
    let iterations = 0;
    let selectorCorrections = 0;
    try {
      while (iterations < maxIterations) {
        assertScanActive();
        iterations += 1;
        const current = await this.repo.getTask(task.id);
        if (!current) throw new Error(`AI scan task disappeared: ${task.id}`);
        const context = await buildAutonomousAgentContext({
          repo: this.repo,
          scanRunId: current.scan_run_id,
          task: current,
          tools: this.registry.list(),
        });
        const decision = await this.planner.decide(context);
        assertScanActive();
        agentEventBus.publish({
          kind: 'agent_state_changed', status: decision.source === 'ai_provider' ? 'completed' : decision.source === 'fallback' ? 'failed' : 'info',
          scan_run_id: current.scan_run_id, task_id: current.id, provider_id: decision.provider_id, model: decision.model,
          error: decision.source === 'fallback' ? decision.reason : undefined,
          summary: `真实 Agent 决策已记录：source=${decision.source || 'local_policy'}${decision.provider_id ? ` provider=${decision.provider_id}` : ''}${decision.model ? ` model=${decision.model}` : ''}；action=${decision.action}${decision.tool_name ? ` tool=${decision.tool_name}` : ''}`,
        });
        await this.recordDecision(current, decision);
        await this.repo.createPlannerDecision({
          scan_run_id: current.scan_run_id,
          task_id: current.id,
          iteration: iterations,
          source: decision.source || 'local_policy',
          proposal_json: (decision.proposal || {}) as Record<string, any>,
          decision_json: {
            action: decision.action,
            tool_name: decision.tool_name,
            arguments: decision.arguments || {},
            tasks: decision.tasks || [],
            summary: decision.summary,
            reason: decision.reason,
            rationale: decision.rationale,
            confidence: decision.confidence,
            ai_usage: decision.ai_usage,
            ai_provider_attempted: decision.ai_provider_attempted,
            provider_id: decision.provider_id,
            provider_response_id: decision.provider_response_id,
            model: decision.model,
          },
          policy_json: (decision.policy_decision || {}) as Record<string, any>,
          validation_status: decision.validation_status || (decision.source === 'ai_provider' ? 'accepted' : decision.source === 'fallback' ? 'fallback' : 'local_only'),
          rejection_reason: decision.rejection_reason,
          decision_signature: decision.decision_signature || decisionSignature(decision),
        });

        if (decision.action === 'tool_call') {
          assertScanActive();
          if (!decision.tool_name) throw new Error('Agent decision missing tool_name');
          agentEventBus.publish({
            kind: 'agent_tool_started', status: 'running', scan_run_id: current.scan_run_id, task_id: current.id,
            tool_name: decision.tool_name, summary: `Agent 开始调用真实工具：${decision.tool_name}`,
          });
          const toolStartedAt = Date.now();
          const result = await this.registry.call(decision.tool_name, decision.arguments || {}, {
            db: this.db,
            repo: this.repo,
            scanRunId: current.scan_run_id,
            taskId: current.id,
          });
          agentEventBus.publish({
            kind: result.ok ? 'agent_tool_completed' : 'agent_tool_completed', status: result.ok ? 'completed' : 'failed',
            scan_run_id: current.scan_run_id, task_id: current.id, tool_name: decision.tool_name,
            duration_ms: Date.now() - toolStartedAt, error: result.ok ? undefined : textSummary(result.error),
            summary: textSummary(result.summary, result.ok ? `工具 ${decision.tool_name} 已完成。` : `工具 ${decision.tool_name} 失败。`),
          });
          if (!result.ok) {
            // A rejected selector has performed no action. Keep its failed
            // invocation in model context so the model can choose a correction.
            // Scope/auth/provider failures and actual assertion failures remain terminal.
            if ((current.execution_plan?.intent === 'discover_target' || ['test_generic_vuln', 'test_file_upload'].includes(current.task_type)) &&
                decision.tool_name === 'browser.interact' &&
                result.data?.failure_phase === 'pre_action' && result.data?.action_performed === false &&
                ['selector_no_match', 'selector_ambiguous', 'selector_not_visible'].includes(result.data?.error_code) && selectorCorrections < 2) {
              assertScanActive();
              selectorCorrections += 1;
              await this.repo.updateTask(current.id, { phase: 'awaiting_selector_correction', result_summary: result.error });
              continue;
            }
            await this.repo.updateTask(current.id, {
              status: 'failed',
              phase: 'failed',
              result_summary: textSummary(result.summary, result.error || `Tool ${decision.tool_name} failed`),
              error_message: textSummary(result.error, `Tool ${decision.tool_name} failed`),
              completed_at: now(),
            });
            await this.rememberTaskOutcome(current.id);
            return iterations;
          }
          await this.repo.updateTask(current.id, {
            phase: `tool_completed:${decision.tool_name}`,
            result_summary: textSummary(result.summary, `${decision.tool_name} completed.`),
            created_assets_json: { ...(current.created_assets_json || {}), ...(result.data?.assets || {}) },
          });
          continue;
        }

        if (decision.action === 'create_child_tasks') {
          const children = Array.isArray(decision.tasks) ? decision.tasks : [];
          for (const child of children) {
            assertScanActive();
            await this.repo.createTask({
              scan_run_id: current.scan_run_id,
              parent_task_id: current.id,
              title: child.title,
              task_type: child.task_type,
              vuln_type: child.vuln_type,
              feature_id: child.feature_id,
              endpoint_ids: child.endpoint_ids || [],
              priority: child.priority ?? current.priority + 1,
              dependencies: child.dependencies || [],
              agent_goal: child.agent_goal || child.title,
              execution_plan: child.execution_plan || {},
            });
          }
          await this.repo.updateTask(current.id, {
            status: 'completed',
            phase: 'completed',
            result_summary: textSummary(decision.summary, `Created ${children.length} child tasks.`),
            completed_at: now(),
          });
          await this.rememberTaskOutcome(current.id);
          return iterations;
        }

        if (decision.action === 'wait_for_user_selection') {
          await this.repo.updateRun(current.scan_run_id, { status: 'awaiting_selection', current_phase: 'awaiting_vulnerability_selection' });
          await this.repo.updateTask(current.id, {
            status: 'waiting_selection',
            phase: 'awaiting_selection',
            result_summary: textSummary(decision.summary || decision.reason, 'Waiting for user vulnerability selection.'),
            completed_at: now(),
          });
          await this.rememberTaskOutcome(current.id);
          return iterations;
        }

        if (decision.action === 'fail_task') {
          await this.repo.updateTask(current.id, {
            status: 'failed',
            phase: 'failed',
            result_summary: textSummary(decision.summary || decision.reason, 'Agent failed task.'),
            error_message: textSummary(decision.reason || decision.summary, 'Agent failed task.'),
            completed_at: now(),
          });
          await this.rememberTaskOutcome(current.id);
          return iterations;
        }

        assertScanActive();
        await this.repo.updateTask(current.id, {
          status: 'completed',
          phase: 'completed',
          result_summary: textSummary(decision.summary, 'Agent completed task.'),
          completed_at: now(),
        });
        await this.rememberTaskOutcome(current.id);
        return iterations;
      }
      await this.repo.updateTask(task.id, {
        status: 'failed',
        phase: 'iteration_limit_exceeded',
        error_message: `Autonomous Agent exceeded ${maxIterations} iterations for task`,
        completed_at: now(),
      });
      await this.rememberTaskOutcome(task.id);
      return iterations;
    } catch (error: any) {
      await this.repo.updateTask(task.id, {
        status: 'failed',
        phase: 'failed',
        error_message: error.message || String(error),
        result_summary: error.message || String(error),
        completed_at: now(),
      });
      await this.rememberTaskOutcome(task.id);
      return iterations || 1;
    } finally {
      const terminal = await this.repo.getTask(task.id);
      if(terminal && ['completed','failed','waiting_selection','blocked'].includes(terminal.status)) {
        try { await closeTaskBrowserContexts(this.repo,task.scan_run_id,task.id); }
        catch(error) {
          await this.repo.createArtifact({scan_run_id:task.scan_run_id,task_id:task.id,artifact_type:'browser_cleanup',title:'Browser cleanup failed',content_json:{ok:false,error:String(error)}});
          await this.repo.updateTask(task.id,{status:'failed',phase:'browser_cleanup_failed',error_message:'Test browser cleanup did not complete.'});
        }
      }
      // Cover tool failure, exhausted iteration budget and unexpected exceptions.
      // Only the discovery owner releases the device; parallel API tasks do not.
      if (terminal && ['completed', 'failed', 'waiting_selection'].includes(terminal.status) && (task.execution_plan?.intent === 'discover_target' || task.task_type === 'discover_target')) {
        const session = await getLatestMobileSessionForScan(this.db, task.scan_run_id);
        if (session) {
          let cleanup: Record<string, any>;
          try { cleanup = await stopMobileLab(this.db, session.id); }
          catch (error) { cleanup = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
          await this.repo.createArtifact({ scan_run_id: task.scan_run_id, task_id: task.id, artifact_type: 'mobile_cleanup', title: 'Android runtime cleanup', content_json: cleanup });
          const exploring = session.health_json?.execution_profile?.config_json?.acquisition_mode === 'explore';
          const mobileReport = await (exploring ? mobileDiscoveryReport(this.db, session.id) : getMobileTestReport(this.db, session.id)).catch(error => ({ gate_result: 'BLOCK', acceptance_complete: false, evidence_level: 'appium_server_and_proxy_reported_requires_trusted_lab', error: error instanceof Error ? error.message : String(error) }));
          await this.repo.createArtifact({ scan_run_id: task.scan_run_id, task_id: task.id, artifact_type: 'mobile_appium_test_report', title: 'Appium + HTTPS final acceptance', content_json: mobileReport });
          if (terminal.status !== 'failed' && (exploring ? (mobileReport as any).acquisition_complete !== true : mobileReport.evidence_level === 'appium_server_and_proxy_reported_requires_trusted_lab' && mobileReport.acceptance_complete !== true)) await this.repo.updateTask(task.id, { status: 'failed', phase: 'mobile_appium_test_failed', error_message: 'Appium UI/HTTPS acceptance is BLOCK. Inspect mobile_appium_test_report.' });
          if (!cleanup.ok) await this.repo.updateTask(task.id, { status: 'failed', phase: 'mobile_cleanup_failed', error_message: 'Android runtime cleanup requires operator attention; inspect mobile_cleanup artifact.' });
        }
      }
    }
  }
}
