import { dbManager } from '../db/db-manager.js';
import { executeTemplateRun } from './template-runner.js';
import { executeWorkflowRun } from './workflow-runner.js';

type GateAction = 'PASS' | 'WARN' | 'BLOCK';
type ExitCode = 0 | 1 | 3 | 4;
type CombineOperator = 'OR' | 'AND';
type ThresholdOperator = '>=' | '>' | '<=' | '<' | '==' | '!=';

interface ThresholdRule {
  operator: ThresholdOperator;
  threshold: number;
  action: GateAction;
}

interface GatePolicy {
  id: string;
  name: string;
  is_enabled: boolean;
  weight_test: number;
  weight_workflow: number;
  combine_operator: CombineOperator;
  rules_test: ThresholdRule[];
  rules_workflow: ThresholdRule[];
}

interface GateCalculationResult {
  gate_result: GateAction;
  exit_code: ExitCode;
  details: {
    test_findings_count: number;
    workflow_findings_count: number;
    test_weighted_score: number;
    workflow_weighted_score: number;
    test_action: GateAction;
    workflow_action: GateAction;
    combine_operator: CombineOperator;
    final_action: GateAction;
  };
}

interface GateRunRequest {
  policy_id?: string;
  template_ids?: string[];
  workflow_ids?: string[];
  account_ids?: string[];
  environment_id?: string;
  metadata?: Record<string, any>;
}

const ACTION_PRIORITY: Record<GateAction, number> = {
  'PASS': 0,
  'WARN': 1,
  'BLOCK': 2,
};

function evaluateOperator(score: number, operator: ThresholdOperator, threshold: number): boolean {
  switch (operator) {
    case '>=': return score >= threshold;
    case '>': return score > threshold;
    case '<=': return score <= threshold;
    case '<': return score < threshold;
    case '==': return score === threshold;
    case '!=': return score !== threshold;
    default: return false;
  }
}

function evaluateRules(score: number, rules: ThresholdRule[]): GateAction {
  for (const rule of rules) {
    if (evaluateOperator(score, rule.operator, rule.threshold)) {
      return rule.action;
    }
  }
  return 'PASS';
}

function combineActions(testAction: GateAction, workflowAction: GateAction, operator: CombineOperator): GateAction {
  const testPriority = ACTION_PRIORITY[testAction];
  const workflowPriority = ACTION_PRIORITY[workflowAction];

  if (operator === 'OR') {
    const maxPriority = Math.max(testPriority, workflowPriority);
    return Object.entries(ACTION_PRIORITY).find(([, p]) => p === maxPriority)?.[0] as GateAction || 'PASS';
  } else {
    const minPriority = Math.min(testPriority, workflowPriority);
    return Object.entries(ACTION_PRIORITY).find(([, p]) => p === minPriority)?.[0] as GateAction || 'PASS';
  }
}

function actionToExitCode(action: GateAction): ExitCode {
  switch (action) {
    case 'BLOCK': return 1;
    case 'WARN': return 0;
    case 'PASS': return 0;
    default: return 0;
  }
}

function calculateGateResult(
  testFindingsCount: number,
  workflowFindingsCount: number,
  policy: GatePolicy,
  hasErrors: boolean
): GateCalculationResult {
  let testAction: GateAction = 'PASS';
  let workflowAction: GateAction = 'PASS';

  if (policy.weight_test > 0) {
    const testWeightedScore = Math.ceil((testFindingsCount * policy.weight_test) / 100);
    testAction = evaluateRules(testWeightedScore, policy.rules_test || []);
  }

  if (policy.weight_workflow > 0) {
    const workflowWeightedScore = Math.ceil((workflowFindingsCount * policy.weight_workflow) / 100);
    workflowAction = evaluateRules(workflowWeightedScore, policy.rules_workflow || []);
  }

  const testWeightedScore = Math.ceil((testFindingsCount * policy.weight_test) / 100);
  const workflowWeightedScore = Math.ceil((workflowFindingsCount * policy.weight_workflow) / 100);

  let finalAction = combineActions(testAction, workflowAction, policy.combine_operator);

  if (hasErrors && finalAction !== 'BLOCK') {
    finalAction = 'BLOCK';
  }

  const exitCode = actionToExitCode(finalAction);

  return {
    gate_result: finalAction,
    exit_code: exitCode,
    details: {
      test_findings_count: testFindingsCount,
      workflow_findings_count: workflowFindingsCount,
      test_weighted_score: testWeightedScore,
      workflow_weighted_score: workflowWeightedScore,
      test_action: testAction,
      workflow_action: workflowAction,
      combine_operator: policy.combine_operator,
      final_action: finalAction,
    },
  };
}

export async function executeGateRun(request: GateRunRequest): Promise<{
  success: boolean;
  security_run_id: string;
  gate_result: GateAction;
  exit_code: ExitCode;
  test_findings_count: number;
  workflow_findings_count: number;
  details: GateCalculationResult['details'];
  errors?: string[];
}> {
  const db = dbManager.getActive();
  const {
    policy_id,
    template_ids = [],
    workflow_ids = [],
    account_ids = [],
    environment_id,
    metadata = {},
  } = request;

  if (template_ids.length === 0 && workflow_ids.length === 0) {
    throw new Error('At least one template_id or workflow_id is required');
  }

  let policy: GatePolicy;

  if (policy_id) {
    const policyData = await db.repos.cicdGatePolicies.findById(policy_id);
    if (!policyData || !policyData.is_enabled) {
      throw new Error(`Policy not found or disabled: ${policy_id}`);
    }
    policy = {
      id: policyData.id,
      name: policyData.name,
      is_enabled: policyData.is_enabled,
      weight_test: policyData.weight_test,
      weight_workflow: policyData.weight_workflow,
      combine_operator: policyData.combine_operator as CombineOperator,
      rules_test: policyData.rules_test as ThresholdRule[],
      rules_workflow: policyData.rules_workflow as ThresholdRule[],
    };
  } else {
    policy = {
      id: 'default',
      name: 'Default Policy',
      is_enabled: true,
      weight_test: 100,
      weight_workflow: 0,
      combine_operator: 'OR',
      rules_test: [
        { operator: '>=', threshold: 5, action: 'BLOCK' },
        { operator: '>=', threshold: 1, action: 'WARN' },
        { operator: '<', threshold: 1, action: 'PASS' },
      ],
      rules_workflow: [
        { operator: '>=', threshold: 5, action: 'BLOCK' },
        { operator: '>=', threshold: 1, action: 'WARN' },
        { operator: '<', threshold: 1, action: 'PASS' },
      ],
    };
  }

  const securityRun = await db.repos.securityRuns.create({
    status: 'running',
    policy_id: policy_id || undefined,
    metadata: {
      ...metadata,
      template_ids,
      workflow_ids,
      account_ids,
      environment_id,
      started_at: new Date().toISOString(),
    },
    test_findings_count: 0,
    workflow_findings_count: 0,
  } as any);

  const securityRunId = securityRun.id;
  let testFindingsCount = 0;
  let workflowFindingsCount = 0;
  const errors: string[] = [];
  let hasExecutionError = false;

  try {
    if (template_ids.length > 0) {
      const testRun = await db.repos.testRuns.create({
        status: 'pending',
        trigger_type: 'ci_gate',
        progress: { total: 0, completed: 0, findings: 0 },
        progress_percent: 0,
      } as any);

      const testResult = await executeTemplateRun({
        test_run_id: testRun.id,
        template_ids,
        account_ids,
        environment_id,
        security_run_id: securityRunId,
      });

      testFindingsCount = testResult.findings_count;
      if (testResult.has_execution_error) {
        hasExecutionError = true;
      }
      if (!testResult.success && testResult.error) {
        errors.push(`Tests: ${testResult.error}`);
      }
    }

    if (workflow_ids.length > 0) {
      for (const workflowId of workflow_ids) {
        const testRun = await db.repos.testRuns.create({
          status: 'pending',
          trigger_type: 'ci_gate',
          progress: { total: 0, completed: 0, findings: 0 },
          progress_percent: 0,
        } as any);

        const workflowResult = await executeWorkflowRun({
          test_run_id: testRun.id,
          workflow_id: workflowId,
          account_ids,
          environment_id,
          security_run_id: securityRunId,
        });

        workflowFindingsCount += workflowResult.findings_count;
        if (workflowResult.has_execution_error) {
          hasExecutionError = true;
        }
        if (!workflowResult.success && workflowResult.error) {
          errors.push(`Workflow ${workflowId}: ${workflowResult.error}`);
        }
      }
    }

    const gateCalculation = calculateGateResult(testFindingsCount, workflowFindingsCount, policy, hasExecutionError);
    const finalStatus = hasExecutionError ? 'completed_with_errors' : 'completed';

    await db.repos.securityRuns.update(securityRunId, {
      status: finalStatus,
      exit_code: gateCalculation.exit_code,
      gate_result: gateCalculation.gate_result,
      test_findings_count: testFindingsCount,
      workflow_findings_count: workflowFindingsCount,
      gate_score: gateCalculation.details.test_weighted_score + gateCalculation.details.workflow_weighted_score,
      error_message: errors.length > 0 ? errors.join('; ') : undefined,
      metadata: {
        ...securityRun.metadata,
        completed_at: new Date().toISOString(),
        gate_details: gateCalculation.details,
      },
    } as any);

    return {
      success: !hasExecutionError,
      security_run_id: securityRunId,
      gate_result: gateCalculation.gate_result,
      exit_code: gateCalculation.exit_code,
      test_findings_count: testFindingsCount,
      workflow_findings_count: workflowFindingsCount,
      details: gateCalculation.details,
      errors: errors.length > 0 ? errors : undefined,
    };

  } catch (error: any) {
    await db.repos.securityRuns.update(securityRunId, {
      status: 'failed',
      exit_code: 3,
      gate_result: 'BLOCK',
      error_message: error.message || 'Unknown error occurred',
    } as any);

    throw error;
  }
}
