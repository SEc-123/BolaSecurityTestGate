import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type GateAction = 'PASS' | 'WARN' | 'BLOCK';
type ExitCode = 0 | 2 | 3 | 4;
type CombineOperator = 'OR' | 'AND';
type ThresholdOperator = '>=' | '>' | '<=' | '<' | '==' | '!=';

interface ThresholdRule {
  operator: ThresholdOperator;
  threshold: number;
  action: GateAction;
}

interface SecurityRunRequest {
  policy_id?: string;
  template_ids?: string[];
  workflow_ids?: string[];
  account_ids?: string[];
  environment_id?: string;
  metadata?: Record<string, any>;
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
    case 'BLOCK': return 2;
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

async function executeTests(
  supabase: any,
  securityRunId: string,
  templateIds: string[],
  accountIds: string[],
  environmentId?: string
): Promise<{ success: boolean; findingsCount: number; hasExecutionError: boolean; error?: string }> {
  try {
    const { data: testRun, error: createError } = await supabase
      .from('test_runs')
      .insert({
        status: 'pending',
        trigger_type: 'ci_gate',
        progress: { total: 0, completed: 0, findings: 0 },
      })
      .select()
      .single();

    if (createError) {
      return { success: false, findingsCount: 0, hasExecutionError: true, error: createError.message };
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const response = await fetch(`${supabaseUrl}/functions/v1/execute-test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({
        test_run_id: testRun.id,
        template_ids: templateIds,
        account_ids: accountIds,
        environment_id: environmentId,
        security_run_id: securityRunId,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      return { success: false, findingsCount: 0, hasExecutionError: true, error: result.error || 'Test execution failed' };
    }

    const { data: finalTestRun, error: finalError } = await supabase
      .from('test_runs')
      .select('has_execution_error, errors_count')
      .eq('id', testRun.id)
      .maybeSingle();

    if (finalError || !finalTestRun) {
      return { success: false, findingsCount: result.findings_count || 0, hasExecutionError: true, error: finalError?.message || 'Failed to verify test_run status (fail-closed)' };
    }

    const hasExecError = finalTestRun.has_execution_error || false;
    const findingsCount = result.findings_count || 0;

    return { success: !hasExecError, findingsCount, hasExecutionError: hasExecError };
  } catch (error: any) {
    return { success: false, findingsCount: 0, hasExecutionError: true, error: error.message };
  }
}

async function executeWorkflows(
  supabase: any,
  securityRunId: string,
  workflowIds: string[],
  accountIds: string[],
  environmentId?: string
): Promise<{ success: boolean; findingsCount: number; hasExecutionError: boolean; error?: string }> {
  let totalFindings = 0;
  let hasAnyError = false;
  const errors: string[] = [];

  for (const workflowId of workflowIds) {
    try {
      const { data: testRun, error: createError } = await supabase
        .from('test_runs')
        .insert({
          status: 'pending',
          trigger_type: 'ci_gate',
          progress: { total: 0, completed: 0, findings: 0 },
        })
        .select()
        .single();

      if (createError) {
        errors.push(`Workflow ${workflowId}: ${createError.message}`);
        hasAnyError = true;
        continue;
      }

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const response = await fetch(`${supabaseUrl}/functions/v1/execute-workflow`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
        body: JSON.stringify({
          test_run_id: testRun.id,
          workflow_id: workflowId,
          account_ids: accountIds,
          environment_id: environmentId,
          security_run_id: securityRunId,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        errors.push(`Workflow ${workflowId}: ${result.error || 'Execution failed'}`);
        hasAnyError = true;
        continue;
      }

      totalFindings += result.findings_count || 0;

      const { data: finalTestRun, error: finalError } = await supabase
        .from('test_runs')
        .select('has_execution_error')
        .eq('id', testRun.id)
        .maybeSingle();

      if (finalError || !finalTestRun) {
        errors.push(`Workflow ${workflowId}: Failed to verify test_run status (fail-closed)`);
        hasAnyError = true;
      } else if (finalTestRun.has_execution_error) {
        hasAnyError = true;
      }
    } catch (error: any) {
      errors.push(`Workflow ${workflowId}: ${error.message}`);
      hasAnyError = true;
    }
  }

  return {
    success: errors.length === 0,
    findingsCount: totalFindings,
    hasExecutionError: hasAnyError,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  let securityRunId: string | null = null;

  try {
    const requestBody: SecurityRunRequest = await req.json();
    const {
      policy_id,
      template_ids = [],
      workflow_ids = [],
      account_ids = [],
      environment_id,
      metadata = {},
    } = requestBody;

    if (template_ids.length === 0 && workflow_ids.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          exit_code: 4,
          error: 'At least one template_id or workflow_id is required',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let policy: GatePolicy;
    if (policy_id) {
      const { data: policyData, error: policyError } = await supabase
        .from('cicd_gate_policies')
        .select('*')
        .eq('id', policy_id)
        .eq('is_enabled', true)
        .maybeSingle();

      if (policyError) {
        return new Response(
          JSON.stringify({
            success: false,
            exit_code: 4,
            error: `Failed to fetch policy: ${policyError.message}`,
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (!policyData) {
        return new Response(
          JSON.stringify({
            success: false,
            exit_code: 4,
            error: `Policy not found or disabled: ${policy_id}`,
          }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      policy = policyData as GatePolicy;
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

    const { data: securityRun, error: createError } = await supabase
      .from('security_runs')
      .insert({
        status: 'running',
        policy_id: policy_id || null,
        metadata: {
          ...metadata,
          template_ids,
          workflow_ids,
          account_ids,
          environment_id,
          started_at: new Date().toISOString(),
        },
      })
      .select()
      .single();

    if (createError) {
      return new Response(
        JSON.stringify({
          success: false,
          exit_code: 3,
          error: `Failed to create security run: ${createError.message}`,
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    securityRunId = securityRun.id;
    let testFindingsCount = 0;
    let workflowFindingsCount = 0;
    const errors: string[] = [];
    let hasExecutionError = false;

    if (template_ids.length > 0) {
      const testResult = await executeTests(
        supabase,
        securityRunId,
        template_ids,
        account_ids,
        environment_id
      );

      testFindingsCount = testResult.findingsCount;
      if (testResult.hasExecutionError) {
        hasExecutionError = true;
      }
      if (!testResult.success && testResult.error) {
        errors.push(`Tests: ${testResult.error}`);
      }
    }

    if (workflow_ids.length > 0) {
      const workflowResult = await executeWorkflows(
        supabase,
        securityRunId,
        workflow_ids,
        account_ids,
        environment_id
      );

      workflowFindingsCount = workflowResult.findingsCount;
      if (workflowResult.hasExecutionError) {
        hasExecutionError = true;
      }
      if (!workflowResult.success && workflowResult.error) {
        errors.push(`Workflows: ${workflowResult.error}`);
      }
    }

    const gateCalculation = calculateGateResult(testFindingsCount, workflowFindingsCount, policy, hasExecutionError);

    const finalStatus = hasExecutionError ? 'completed_with_errors' : 'completed';

    await supabase
      .from('security_runs')
      .update({
        status: finalStatus,
        exit_code: gateCalculation.exit_code,
        gate_result: gateCalculation.gate_result,
        test_findings_count: testFindingsCount,
        workflow_findings_count: workflowFindingsCount,
        gate_score: gateCalculation.details.test_weighted_score + gateCalculation.details.workflow_weighted_score,
        error_message: errors.length > 0 ? errors.join('; ') : null,
        metadata: {
          ...securityRun.metadata,
          completed_at: new Date().toISOString(),
          gate_details: gateCalculation.details,
        },
      })
      .eq('id', securityRunId);

    return new Response(
      JSON.stringify({
        success: !hasExecutionError,
        security_run_id: securityRunId,
        gate_result: gateCalculation.gate_result,
        exit_code: gateCalculation.exit_code,
        test_findings_count: testFindingsCount,
        workflow_findings_count: workflowFindingsCount,
        details: gateCalculation.details,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Security run error:', error);

    if (securityRunId) {
      await supabase
        .from('security_runs')
        .update({
          status: 'failed',
          exit_code: 3,
          gate_result: 'BLOCK',
          error_message: error.message || 'Unknown error occurred',
        })
        .eq('id', securityRunId);
    }

    return new Response(
      JSON.stringify({
        success: false,
        exit_code: 3,
        gate_result: 'BLOCK',
        error: error.message || 'Unknown error',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
