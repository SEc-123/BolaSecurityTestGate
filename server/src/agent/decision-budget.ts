import type { AIScanTask } from '../services/ai-scan/types.js';

export const DEFAULT_TASK_DECISIONS = 20;
export const DEFAULT_DISCOVERY_DECISIONS = 80;
export const MAX_TASK_DECISIONS = 200;
export const MAX_RUN_DECISIONS = 10000;

function boundedTaskLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_TASK_DECISIONS, Math.floor(value)))
    : fallback;
}

/** Operator scan configuration owns budgets; model-authored task plans cannot raise them. */
export function taskDecisionLimit(task: AIScanTask, scanConfig: Record<string, any> = {}): number {
  const configured = scanConfig.agent_task_budgets;
  const discovery = task.execution_plan?.intent === 'discover_target' || task.task_type === 'discover_target';
  if (task.execution_plan?.intent === 'learn_business_flow') return boundedTaskLimit(configured?.learn_business_flow ?? configured?.default, 80);
  if (task.execution_plan?.intent === 'model_business_experiment') return boundedTaskLimit(configured?.model_business_experiment ?? configured?.default, 100);
  return discovery
    ? boundedTaskLimit(configured?.discover_target, DEFAULT_DISCOVERY_DECISIONS)
    : boundedTaskLimit(configured?.default, DEFAULT_TASK_DECISIONS);
}

/** Synchronous reservation keeps all parallel workers inside one invocation's ceiling. */
export class RunDecisionBudget {
  readonly limit: number;
  private reserved = 0;

  constructor(maxSteps?: number) {
    if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_RUN_DECISIONS)) {
      throw new Error(`max_steps must be an integer between 1 and ${MAX_RUN_DECISIONS}.`);
    }
    this.limit = maxSteps ?? MAX_RUN_DECISIONS;
  }

  get used(): number { return this.reserved; }
  get remaining(): number { return this.limit - this.reserved; }

  take(): boolean {
    if (this.remaining === 0) return false;
    this.reserved += 1;
    return true;
  }
}
