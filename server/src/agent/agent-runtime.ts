import type { DbProvider } from '../types/index.js';
import { AIScanRepository } from '../services/ai-scan/repository.js';
import { createAgentToolRegistry } from './index.js';
import type { AIScanRun, AIScanSnapshot, AIScanTask } from '../services/ai-scan/types.js';
import { buildAutonomousAgentContext } from './context-builder.js';
import { AutonomousAgentPlanner } from './autonomous-planner.js';
import type { AutonomousPlannerResult } from './decision-types.js';

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
    const discover = await this.repo.createTask({
      scan_run_id: run.id,
      title: '自动理解目标并发现功能/接口',
      task_type: 'autonomous_agent_task',
      priority: 10,
      dependencies: [inventory.id],
      agent_goal: '自动访问目标 URL，收集页面、表单、上传控件和接口观察，替代人工录制。Agent 需要自行决定先导航还是直接发现。',
      execution_plan: { intent: 'discover_target' },
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
    const run = await this.repo.getRun(scanRunId);
    if (!run) throw new Error(`AI scan run not found: ${scanRunId}`);
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
    const run = await this.repo.getRun(scanRunId);
    if (!run) throw new Error(`AI scan run not found: ${scanRunId}`);
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
    const freshRun = await this.repo.getRun(scanRunId);
    const tasks = await this.repo.listTasks(scanRunId);
    const pending = tasks.filter(task => task.status === 'pending');
    const running = tasks.filter(task => task.status === 'running');
    const blockedWaitingSelection = tasks.some(task => task.status === 'waiting_selection') || freshRun?.status === 'awaiting_selection';
    const runnableRemaining = pending.length > 0 || running.length > 0;
    const failed = tasks.some(task => task.status === 'failed');

    if (!runnableRemaining && !blockedWaitingSelection) {
      await this.repo.updateRun(scanRunId, {
        status: failed ? 'failed' : 'completed',
        current_phase: failed ? 'failed' : 'completed',
        summary: {
          ...(freshRun?.summary || {}),
          tasks_total: tasks.length,
          tasks_completed: tasks.filter(task => task.status === 'completed').length,
          tasks_failed: tasks.filter(task => task.status === 'failed').length,
          tasks_blocked: tasks.filter(task => task.status === 'blocked').length,
          parallel_agents: parallelAgents,
          parallel_batches: batchesExecuted,
        },
      });
    }

    return {
      scan_run_id: scanRunId,
      steps_executed: stepsExecuted,
      completed: !runnableRemaining && !blockedWaitingSelection,
      blocked_waiting_selection: blockedWaitingSelection,
      last_task: lastTask,
      parallel_agents: parallelAgents,
      batches_executed: batchesExecuted,
      snapshot: await this.repo.getSnapshot(scanRunId),
    };
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
        model: decision.model,
        raw_response: decision.raw_response,
      },
    });
  }

  private async executeTask(task: AIScanTask, maxIterations = 20): Promise<number> {
    await this.repo.updateTask(task.id, { status: 'running', started_at: now(), phase: 'autonomous_running' });
    let iterations = 0;
    try {
      while (iterations < maxIterations) {
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
        await this.recordDecision(current, decision);

        if (decision.action === 'tool_call') {
          if (!decision.tool_name) throw new Error('Agent decision missing tool_name');
          const result = await this.registry.call(decision.tool_name, decision.arguments || {}, {
            db: this.db,
            repo: this.repo,
            scanRunId: current.scan_run_id,
            taskId: current.id,
          });
          if (!result.ok) {
            await this.repo.updateTask(current.id, {
              status: 'failed',
              phase: 'failed',
              result_summary: result.summary,
              error_message: result.error || `Tool ${decision.tool_name} failed`,
              completed_at: now(),
            });
            return iterations;
          }
          await this.repo.updateTask(current.id, {
            phase: `tool_completed:${decision.tool_name}`,
            result_summary: result.summary,
            created_assets_json: { ...(current.created_assets_json || {}), ...(result.data?.assets || {}) },
          });
          continue;
        }

        if (decision.action === 'create_child_tasks') {
          const children = Array.isArray(decision.tasks) ? decision.tasks : [];
          for (const child of children) {
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
            result_summary: decision.summary || `Created ${children.length} child tasks.`,
            completed_at: now(),
          });
          return iterations;
        }

        if (decision.action === 'wait_for_user_selection') {
          await this.repo.updateRun(current.scan_run_id, { status: 'awaiting_selection', current_phase: 'awaiting_vulnerability_selection' });
          await this.repo.updateTask(current.id, {
            status: 'waiting_selection',
            phase: 'awaiting_selection',
            result_summary: decision.summary || decision.reason || 'Waiting for user vulnerability selection.',
            completed_at: now(),
          });
          return iterations;
        }

        if (decision.action === 'fail_task') {
          await this.repo.updateTask(current.id, {
            status: 'failed',
            phase: 'failed',
            result_summary: decision.summary || decision.reason || 'Agent failed task.',
            error_message: decision.reason || decision.summary,
            completed_at: now(),
          });
          return iterations;
        }

        await this.repo.updateTask(current.id, {
          status: 'completed',
          phase: 'completed',
          result_summary: decision.summary || 'Agent completed task.',
          completed_at: now(),
        });
        return iterations;
      }
      await this.repo.updateTask(task.id, {
        status: 'failed',
        phase: 'iteration_limit_exceeded',
        error_message: `Autonomous Agent exceeded ${maxIterations} iterations for task`,
        completed_at: now(),
      });
      return iterations;
    } catch (error: any) {
      await this.repo.updateTask(task.id, {
        status: 'failed',
        phase: 'failed',
        error_message: error.message || String(error),
        result_summary: error.message || String(error),
        completed_at: now(),
      });
      return iterations || 1;
    }
  }
}
