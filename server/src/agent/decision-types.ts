export type AutonomousDecisionAction =
  | 'tool_call'
  | 'complete_task'
  | 'fail_task'
  | 'wait_for_user_selection'
  | 'create_child_tasks';

export interface AutonomousChildTaskDecision {
  title: string;
  task_type: string;
  vuln_type?: string;
  feature_id?: string;
  endpoint_ids?: string[];
  priority?: number;
  agent_goal?: string;
  execution_plan?: Record<string, any>;
  dependencies?: string[];
}

export interface AutonomousAgentDecision {
  action: AutonomousDecisionAction;
  tool_name?: string;
  arguments?: Record<string, any>;
  tasks?: AutonomousChildTaskDecision[];
  summary?: string;
  reason?: string;
  rationale?: string;
  confidence?: number;
  source?: 'ai_provider' | 'local_policy' | 'fallback';
  stop_after_tool_call?: boolean;
}

export interface AutonomousPlannerResult extends AutonomousAgentDecision {
  raw_response?: unknown;
  provider_id?: string;
  model?: string;
}

export const AUTONOMOUS_DECISION_SCHEMA = {
  type: 'object',
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['tool_call', 'complete_task', 'fail_task', 'wait_for_user_selection', 'create_child_tasks'],
    },
    tool_name: { type: 'string' },
    arguments: { type: 'object' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'task_type'],
        properties: {
          title: { type: 'string' },
          task_type: { type: 'string' },
          vuln_type: { type: 'string' },
          feature_id: { type: 'string' },
          endpoint_ids: { type: 'array', items: { type: 'string' } },
          priority: { type: 'number' },
          agent_goal: { type: 'string' },
          execution_plan: { type: 'object' },
          dependencies: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    summary: { type: 'string' },
    reason: { type: 'string' },
    rationale: { type: 'string' },
    confidence: { type: 'number' },
    stop_after_tool_call: { type: 'boolean' },
  },
};
