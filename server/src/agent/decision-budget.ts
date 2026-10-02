import type { AIScanTask } from '../services/ai-scan/types.js';

export const DEFAULT_TASK_DECISIONS = 20;
export const DEFAULT_DISCOVERY_DECISIONS = 80;
// Planning a complete normal-business graph and reviewing its native evidence
// are both multi-step model tasks.  They need their own allowance rather than
// silently inheriting the small generic-task ceiling.
export const DEFAULT_BUSINESS_PLANNING_DECISIONS = 40;
export const DEFAULT_BUSINESS_REVIEW_DECISIONS = 30;
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
  const intent = task.execution_plan?.intent;
  const discovery = intent === 'discover_target' || task.task_type === 'discover_target';
  const businessPlanning = intent === 'plan_business_flows' || task.task_type === 'plan_business_flows';
  const businessReview = intent === 'review_business_flows' || task.task_type === 'review_business_flows';
  if (intent === 'learn_business_flow') return boundedTaskLimit(configured?.learn_business_flow ?? configured?.default, 80);
  if (businessPlanning) {
    return boundedTaskLimit(
      configured?.plan_business_flows ?? configured?.normal_business_planning ?? configured?.default,
      DEFAULT_BUSINESS_PLANNING_DECISIONS,
    );
  }
  if (businessReview) {
    return boundedTaskLimit(
      configured?.review_business_flows ?? configured?.normal_business_review ?? configured?.default,
      DEFAULT_BUSINESS_REVIEW_DECISIONS,
    );
  }
  if (intent === 'model_business_experiment') return boundedTaskLimit(configured?.model_business_experiment ?? configured?.default, 100);
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

  /** Return a reservation only when the planner failed before it produced a
   * decision. No tool call may have started on that path. This keeps a
   * transient provider outage from becoming a phantom run decision, including
   * when several task workers share one run budget. */
  release(): void {
    if (this.reserved <= 0) throw new Error('Run decision budget cannot release an unreserved decision.');
    this.reserved -= 1;
  }
}
