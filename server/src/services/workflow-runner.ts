import { dbManager } from '../db/db-manager.js';
import {
  parseRawRequest,
  validateUrl,
  applyVariableToRequest,
  checkFailurePatterns,
  fetchWithRetry,
  extractValueByJsonPath,
  FailurePattern,
} from './execution-utils.js';
import { startDebugTrace, finishDebugTrace } from './debug-trace.js';
import {
  compareWorkflowResponses,
  hasSignificantDiff,
  truncateResponseForStorage,
  truncateStepForStorage,
  WorkflowBaselineConfig,
  ResponseDiff,
  StepExecution as BaselineStepExecution,
} from './baseline-utils.js';
import {
  checkSuppressionRulesForWorkflow,
  SuppressionRule,
  StepExecutionForSuppression,
} from './suppression.js';
import {
  checkDropRules,
  DropCheckContext,
} from './drop-filter.js';
import {
  validateAndPrepareAccountPoolsForWorkflowRun,
  VariableConfig as ValidationVariableConfig,
  Account as ValidationAccount,
  ValidationReport,
} from './variable-validation.js';
import {
  VariablePoolManager,
  WorkflowVariable,
  WorkflowMapping,
} from './variable-pool.js';

interface ConcurrentReplay {
  step_order: number;
  concurrency: number;
  barrier?: boolean;
  timeout_ms?: number;
  pick_primary?: 'first_success' | 'first' | 'majority_success';
}

interface ConcurrentResultItem {
  ok: boolean;
  status?: number;
  error?: string;
  duration_ms?: number;
  response_preview?: string;
}

interface ConcurrentResults {
  step_order: number;
  concurrency: number;
  success_count: number;
  failure_count: number;
  items: ConcurrentResultItem[];
  primary_index: number | null;
}

interface ParallelExtraRequest {
  kind: 'extra';
  name: string;
  snapshot_template_id: string;
  snapshot_template_name: string;
  request_snapshot_raw: string;
  repeat?: number;
  injection_overrides?: any[];
}

interface ParallelGroup {
  anchor_step_order: number;
  barrier?: boolean;
  timeout_ms?: number;
  extras: ParallelExtraRequest[];
  pick_primary?: 'anchor_first_success' | 'anchor_first';
  writeback_policy?: 'primary_only' | 'none';
}

interface MutationProfile {
  skip_steps?: number[];
  swap_account_at_steps?: Record<number, 'attacker' | 'victim' | string>;
  lock_variables?: string[];
  reuse_tickets?: boolean;
  repeat_steps?: Record<number, number>;
  concurrent_replay?: ConcurrentReplay;
  parallel_groups?: ParallelGroup[];
}

interface WorkflowRunRequest {
  test_run_id: string;
  workflow_id: string;
  account_ids?: string[];
  environment_id?: string;
  security_run_id?: string;
}

interface StepAssertion {
  op: string;
  left: { type: string; path: string };
  right: { type: string; value?: string; key?: string };
  missing_behavior?: 'fail' | 'skip';
}

interface WorkflowContext {
  extractedValues: Record<string, string>;
  cookies: Record<string, string>;
  sessionFields: Record<string, string>;
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface StepExecution {
  step_order: number;
  template_name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  response: HttpResponse;
  matchedFailurePattern: boolean;
  assertionsPassed: boolean;
  executed: boolean;
  isExecutionError?: boolean;
  concurrent_results?: ConcurrentResults;
  parallel_results?: {
    anchor_step_order: number;
    extras: Array<{
      name: string;
      template_id: string;
      ok: boolean;
      status?: number;
      error?: string;
      duration_ms?: number;
      response_preview?: string;
    }>;
  };
}

export async function executeWorkflowRun(request: WorkflowRunRequest): Promise<{
  success: boolean;
  test_run_id: string;
  findings_count: number;
  errors_count: number;
  has_execution_error: boolean;
  error?: string;
  warnings?: string[];
}> {
  const db = dbManager.getActive();
  const { test_run_id, workflow_id, account_ids = [], environment_id, security_run_id } = request;

  startDebugTrace('workflow', test_run_id, {
    test_run_id,
    workflow_id,
    security_run_id,
  });

  try {
    await db.repos.testRuns.update(test_run_id, {
      status: 'running',
      started_at: new Date().toISOString(),
      error_message: undefined,
      progress: { total: 0, completed: 0, findings: 0, errors_count: 0, current_template: 'Loading workflow...' },
    } as any);

    let workflow = await db.repos.workflows.findById(workflow_id);
    if (!workflow) {
      throw new Error('Workflow not found');
    }

    const isMutation = workflow.workflow_type === 'mutation';
    let baselineWorkflow = workflow;
    let mutationProfile: MutationProfile = {};
    let effectiveWorkflowId = workflow_id;

    if (isMutation && workflow.base_workflow_id) {
      const foundBaselineWorkflow = await db.repos.workflows.findById(workflow.base_workflow_id);
      if (!foundBaselineWorkflow) {
        throw new Error('Baseline workflow not found for mutation');
      }
      baselineWorkflow = foundBaselineWorkflow;
      effectiveWorkflowId = workflow.base_workflow_id;
      try {
        mutationProfile = workflow.mutation_profile
          ? (typeof workflow.mutation_profile === 'string' ? JSON.parse(workflow.mutation_profile) : workflow.mutation_profile)
          : {};
      } catch {
        mutationProfile = {};
      }
    }

    const assertionStrategy = baselineWorkflow.assertion_strategy || 'any_step_pass';
    const criticalStepOrders = baselineWorkflow.critical_step_orders || [];
    const enableExtractor = baselineWorkflow.enable_extractor || false;
    const enableSessionJar = baselineWorkflow.enable_session_jar || false;
    const sessionJarConfig = baselineWorkflow.session_jar_config || { cookie_mode: true };
    const globalBindingStrategy = baselineWorkflow.account_binding_strategy;
    const globalAttackerAccountId = baselineWorkflow.attacker_account_id;
    const enableBaseline = baselineWorkflow.enable_baseline || false;
    const baselineConfig = (baselineWorkflow.baseline_config || {}) as WorkflowBaselineConfig;

    const baselineVariablePool = new VariablePoolManager(db);
    await baselineVariablePool.loadForWorkflow(effectiveWorkflowId);

    const mutationVariablePool = new VariablePoolManager(db);
    await mutationVariablePool.loadForWorkflow(effectiveWorkflowId);

    if (mutationProfile.lock_variables) {
      for (const varName of mutationProfile.lock_variables) {
        mutationVariablePool.lockVariable(varName);
      }
    }

    const steps = await db.repos.workflowSteps.findAll({ where: { workflow_id: effectiveWorkflowId } as any });
    if (!steps || steps.length === 0) {
      throw new Error('Workflow has no steps configured');
    }

    const sortedSteps = steps.sort((a, b) => a.step_order - b.step_order);
    const expectedStepCount = sortedSteps.length;

    if (isMutation && mutationProfile.concurrent_replay) {
      const cr = mutationProfile.concurrent_replay;
      const stepExists = sortedSteps.some((s) => s.step_order === cr.step_order);
      if (!stepExists) {
        throw new Error(`concurrent_replay.step_order ${cr.step_order} does not exist in workflow steps`);
      }
    }

    if (isMutation && mutationProfile.parallel_groups) {
      for (const pg of mutationProfile.parallel_groups) {
        const stepExists = sortedSteps.some((s) => s.step_order === pg.anchor_step_order);
        if (!stepExists) {
          throw new Error(`parallel_groups.anchor_step_order ${pg.anchor_step_order} does not exist in workflow steps`);
        }
      }
    }

    const allStepsWithTemplates = await Promise.all(
      sortedSteps.map(async (step) => {
        const template = await db.repos.apiTemplates.findById(step.api_template_id);
        return { ...step, api_template: template };
      })
    );

    let stepsWithTemplates = allStepsWithTemplates;
    const baselineStepsWithTemplates = allStepsWithTemplates;

    if (mutationProfile.skip_steps && mutationProfile.skip_steps.length > 0) {
      stepsWithTemplates = allStepsWithTemplates.filter(
        step => !mutationProfile.skip_steps!.includes(step.step_order)
      );
    }

    if ((workflow.workflow_type === 'baseline' || workflow.workflow_type === 'mutation')
        && workflow.template_mode === 'snapshot') {
      const missing = allStepsWithTemplates.filter(s => !s.request_snapshot_raw || s.request_snapshot_raw.trim() === '');
      if (missing.length > 0) {
        throw new Error(
          `Snapshot required: workflow=${workflow.id}. Missing request_snapshot_raw for steps: ${missing.map(s => s.step_order).join(', ')}`
        );
      }
    }

    const runWarnings: string[] = [];
    if (workflow.workflow_type === 'mutation' && baselineWorkflow) {
      const bwv = baselineWorkflow.learning_version ?? 0;
      const mwv = workflow.learning_version ?? 0;
      if (bwv !== mwv) {
        runWarnings.push(`Baseline learning_version changed: baseline=${bwv}, mutation=${mwv}. Consider re-sync mutation.`);
      }
    }

    if (mutationProfile.repeat_steps && Object.keys(mutationProfile.repeat_steps).length > 0) {
      const expandedSteps: any[] = [];
      for (const step of stepsWithTemplates) {
        expandedSteps.push(step);
        const repeatCount = mutationProfile.repeat_steps[step.step_order];
        if (repeatCount && repeatCount > 0) {
          for (let i = 0; i < repeatCount; i++) {
            expandedSteps.push({ ...step });
          }
        }
      }
      stepsWithTemplates = expandedSteps;
    }

    let extractors: any[] = [];
    if (enableExtractor) {
      extractors = await db.repos.workflowExtractors.findAll({ where: { workflow_id: effectiveWorkflowId } as any });
    }

    const variableConfigs = await db.repos.workflowVariableConfigs.findAll({ where: { workflow_id: effectiveWorkflowId } as any });

    let environment = null;
    if (environment_id) {
      environment = await db.repos.environments.findById(environment_id);
    }

    const accounts: any[] = [];
    for (const id of account_ids) {
      const account = await db.repos.accounts.findById(id);
      if (account) accounts.push(account);
    }

    const checklistIds = new Set<string>();
    const securityRuleIds = new Set<string>();
    for (const config of variableConfigs) {
      if (config.data_source === 'checklist' && config.checklist_id) {
        checklistIds.add(config.checklist_id);
      }
      if (config.data_source === 'security_rule' && config.security_rule_id) {
        securityRuleIds.add(config.security_rule_id);
      }
    }

    const checklists = new Map<string, any>();
    for (const id of checklistIds) {
      const checklist = await db.repos.checklists.findById(id);
      if (checklist) checklists.set(id, checklist);
    }

    const securityRules = new Map<string, any>();
    for (const id of securityRuleIds) {
      const rule = await db.repos.securityRules.findById(id);
      if (rule) securityRules.set(id, rule);
    }

    const suppressionRules = await db.repos.findingSuppressionRules.findAll({ where: { is_enabled: true } as any });
    const dropRules = await db.repos.findingDropRules.findAll({ where: { is_enabled: true } as any });
    const baseUrl = environment?.base_url || '';

    let droppedCount = 0;
    let suppressedRuleCount = 0;

    const validationResult = validateAndPrepareAccountPoolsForWorkflowRun(
      accounts as ValidationAccount[],
      variableConfigs as ValidationVariableConfig[],
      globalBindingStrategy || 'independent',
      globalAttackerAccountId
    );

    await db.repos.testRuns.update(test_run_id, {
      validation_report: validationResult.report,
    } as any);

    if (!validationResult.valid) {
      const errorSummary = validationResult.report.fatal_errors.join('; ');
      await db.repos.testRuns.update(test_run_id, {
        status: 'validation_failed',
        completed_at: new Date().toISOString(),
        error_message: `Variable validation failed: ${errorSummary}`,
        errors_count: 1,
        has_execution_error: true,
      } as any);

      return {
        success: false,
        test_run_id,
        findings_count: 0,
        errors_count: 1,
        has_execution_error: true,
        error: `Variable validation failed: ${errorSummary}`,
      };
    }

    const valueCombinations = generateAccountCombinations(
      variableConfigs,
      validationResult.filteredAccounts,
      checklists,
      securityRules,
      globalBindingStrategy,
      globalAttackerAccountId,
      validationResult.variablePools
    );

    const limitedCombinations = valueCombinations.slice(0, 500);
    const totalTests = limitedCombinations.length;
    let completedTests = 0;
    let findingsCount = 0;
    let suppressedCount = 0;
    let errorsCount = 0;
    const errors: string[] = [];

    await db.repos.testRuns.update(test_run_id, {
      progress: { total: totalTests, completed: 0, findings: 0, errors_count: 0, current_template: workflow.name },
    } as any);

    const attacker = globalAttackerAccountId ? accounts.find(a => a.id === globalAttackerAccountId) : null;

    for (const combination of limitedCombinations) {
      baselineVariablePool.reset();
      mutationVariablePool.reset();

      const context: WorkflowContext = { extractedValues: {}, cookies: {}, sessionFields: {} };
      const stepExecutions: StepExecution[] = [];
      const variableValues: Record<string, string> = { ...combination.values };

      let baselineStepExecutions: BaselineStepExecution[] | null = null;
      if (enableBaseline && globalBindingStrategy === 'anchor_attacker' && attacker && combination.attackerId) {
        const baselineResult = await runWorkflowWithValues(
          baselineStepsWithTemplates,
          variableConfigs,
          buildBaselineValues(variableConfigs, attacker, combination),
          baseUrl,
          enableExtractor,
          enableSessionJar,
          sessionJarConfig,
          extractors,
          assertionStrategy,
          criticalStepOrders,
          baselineVariablePool,
          accounts,
          globalAttackerAccountId,
          mutationProfile,
          globalBindingStrategy,
          true
        );

        if (baselineResult.valid) {
          baselineStepExecutions = baselineResult.stepExecutions.map(s => ({
            step_order: s.step_order,
            template_name: s.template_name,
            url: s.url,
            method: s.method,
            headers: s.headers,
            body: s.body,
            response: s.response,
            matchedFailurePattern: s.matchedFailurePattern,
            assertionsPassed: s.assertionsPassed,
            executed: s.executed,
            isExecutionError: s.isExecutionError,
          }));

          if (mutationProfile?.reuse_tickets) {
            mutationVariablePool.copyVariablesFrom(baselineVariablePool, ['FLOW_TICKET']);
          }
        } else {
          completedTests++;
          const baselineReason = baselineResult.reason || 'Baseline execution failed';
          errors.push(`Baseline skipped: ${baselineReason}`);
          const progressPercent = Math.round((completedTests / totalTests) * 100);
          await db.repos.testRuns.update(test_run_id, {
            progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount, skipped_baselines: 1 },
            progress_percent: progressPercent,
          } as any);
          continue;
        }
      }

      for (const step of stepsWithTemplates) {
        const template = step.api_template;
        const stepAssertions = (step.step_assertions || []) as StepAssertion[];
        const assertionsMode = step.assertions_mode || 'all';

        if (!template) {
          errors.push(`Step ${step.step_order} has no template`);
          stepExecutions.push({
            step_order: step.step_order,
            template_name: 'Unknown',
            url: '',
            method: 'GET',
            headers: {},
            response: { status: 0, headers: {}, body: '' },
            matchedFailurePattern: false,
            assertionsPassed: true,
            executed: false,
            isExecutionError: true,
          });
          continue;
        }

        const rawRequest = step.request_snapshot_raw || template.raw_request || '';
        let parsedRequest = parseRawRequest(rawRequest);
        if (!parsedRequest) {
          errors.push(`Template "${template.name}" has invalid request format`);
          stepExecutions.push({
            step_order: step.step_order,
            template_name: template.name,
            url: '',
            method: 'GET',
            headers: {},
            response: { status: 0, headers: {}, body: '' },
            matchedFailurePattern: false,
            assertionsPassed: true,
            executed: false,
            isExecutionError: true,
          });
          continue;
        }

        for (const config of variableConfigs) {
          if (config.data_source === 'workflow_context') continue;
          const value = combination.values[config.name];
          if (!value) continue;

          const stepMapping = config.step_variable_mappings?.find((m: any) => m.step_order === step.step_order);
          if (stepMapping) {
            parsedRequest = applyVariableToRequest(
              parsedRequest,
              stepMapping.json_path,
              value,
              {
                ...config.advanced_config,
                original_value: stepMapping.original_value,
              }
            );
          }
        }

        if (enableExtractor) {
          parsedRequest = applyContextVariables(parsedRequest, context, variableConfigs, step.step_order);
        }

        if (enableSessionJar) {
          parsedRequest = applySessionJarToRequest(parsedRequest, context, sessionJarConfig);
        }

        if (!parsedRequest) continue;

        const accountIdentity = buildAccountIdentity(combination, accounts, globalAttackerAccountId, mutationProfile, step.step_order, globalBindingStrategy);
        const requestForPool = buildRequestForPool(parsedRequest);
        mutationVariablePool.injectIntoRequest(step.step_order, requestForPool, accountIdentity);

        if (mutationProfile?.swap_account_at_steps && mutationProfile.swap_account_at_steps[step.step_order]) {
          applyIdentityOverlay(requestForPool, accountIdentity);
        }

        parsedRequest.headers = { ...parsedRequest.headers, ...requestForPool.headers };

        if (Object.keys(requestForPool.cookies).length > 0) {
          const cookieHeader = Object.entries(requestForPool.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
          parsedRequest.headers['Cookie'] = cookieHeader;
        }

        let pathWithQuery = requestForPool.url;
        if (Object.keys(requestForPool.query).length > 0) {
          const queryString = Object.entries(requestForPool.query)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join('&');
          pathWithQuery = requestForPool.url.includes('?')
            ? `${requestForPool.url}&${queryString}`
            : `${requestForPool.url}?${queryString}`;
        }
        parsedRequest.path = pathWithQuery;

        if (requestForPool.body && typeof requestForPool.body === 'object') {
          parsedRequest.body = JSON.stringify(requestForPool.body);
        }

        const url = baseUrl + parsedRequest.path;
        if (!validateUrl(url)) {
          errors.push(`Invalid URL: ${url}`);
          stepExecutions.push({
            step_order: step.step_order,
            template_name: template.name,
            url,
            method: parsedRequest.method,
            headers: parsedRequest.headers,
            body: parsedRequest.body,
            response: { status: 0, headers: {}, body: '' },
            matchedFailurePattern: false,
            assertionsPassed: true,
            executed: false,
            isExecutionError: true,
          });
          continue;
        }

        let response: HttpResponse;
        let isExecError = false;
        let concurrentResults: ConcurrentResults | undefined;
        let parallelResults: { anchor_step_order: number; extras: any[] } | undefined;

        const isConcurrentReplayStep = mutationProfile?.concurrent_replay?.step_order === step.step_order;
        const matchedParallelGroup = mutationProfile?.parallel_groups?.find((g: any) => g.anchor_step_order === step.step_order);

        if (matchedParallelGroup) {
          try {
            const result = await executeParallelGroup(
              baseUrl,
              parsedRequest,
              matchedParallelGroup,
              step.step_order,
              mutationVariablePool,
              accountIdentity,
              enableSessionJar,
              sessionJarConfig,
              context
            );

            response = result.anchorResponse;
            isExecError = !result.anchorOk;

            parallelResults = {
              anchor_step_order: step.step_order,
              extras: result.parallelResults,
            };
          } catch (e: any) {
            response = { status: 0, headers: {}, body: `Parallel group error: ${e.message}` };
            isExecError = true;
          }
        } else if (isConcurrentReplayStep && mutationProfile?.concurrent_replay) {
          const cr = mutationProfile.concurrent_replay;
          const concurrency = cr.concurrency;
          const barrier = cr.barrier !== false;
          const timeout_ms = cr.timeout_ms || 5000;
          const pick_primary = cr.pick_primary || 'first_success';

          try {
            const results = await executeConcurrentReplays(url, parsedRequest, concurrency, barrier, timeout_ms);

            const success_count = results.filter((r) => r.ok && r.status && r.status >= 200 && r.status < 300).length;
            const failure_count = results.length - success_count;

            const items: ConcurrentResultItem[] = results.map((r) => ({
              ok: r.ok,
              status: r.status,
              error: r.error,
              duration_ms: r.duration_ms,
              response_preview: r.response?.body ? String(r.response.body).substring(0, 200) : undefined,
            }));

            const { index: primaryIndex, response: primaryResponse } = pickPrimaryResponse(results, pick_primary);

            concurrentResults = {
              step_order: step.step_order,
              concurrency,
              success_count,
              failure_count,
              items,
              primary_index: primaryIndex,
            };

            response = primaryResponse;
            isExecError = primaryIndex === null;
          } catch (e: any) {
            response = { status: 0, headers: {}, body: `Concurrent replay error: ${e.message}` };
            isExecError = true;
          }
        } else {
          try {
            const fetchResponse = await fetchWithRetry(url, {
              method: parsedRequest.method,
              headers: parsedRequest.headers,
              body: ['GET', 'HEAD'].includes(parsedRequest.method) ? undefined : parsedRequest.body,
            }, 2, {
              step_order: step.step_order,
              step_id: step.id,
              template_id: template.id,
              template_name: template.name,
            });

            const responseBody = await fetchResponse.text();
            const responseHeaders: Record<string, string> = {};
            fetchResponse.headers.forEach((v, k) => {
              responseHeaders[k] = v;
            });

            response = { status: fetchResponse.status, headers: responseHeaders, body: responseBody };
          } catch (e: any) {
            response = { status: 0, headers: {}, body: `Error: ${e.message}` };
            isExecError = true;
          }
        }

        if (!isExecError && enableExtractor) {
          executeExtractors(extractors, step.step_order, response, context);
        }

        if (!isExecError && enableSessionJar) {
          updateSessionJar(response, context, sessionJarConfig);
        }

        const stepFailurePatternsOverride = step.failure_patterns_override as FailurePattern[] | null;
        const failurePatternsForCheck = stepFailurePatternsOverride || (template.failure_patterns as FailurePattern[]) || [];
        const failureLogicForCheck = (template.failure_logic || 'OR') as 'OR' | 'AND';
        const matchedFailureForExtract = checkFailurePatterns(failurePatternsForCheck, failureLogicForCheck, response.status, response.body, response.headers);
        const wasSuccessful = !isExecError && response.status >= 200 && response.status < 300 && !matchedFailureForExtract;

        if (!isConcurrentReplayStep && !matchedParallelGroup) {
          const responseForPool = {
            status: response.status,
            headers: response.headers,
            cookies: parseCookiesFromSetCookie(response.headers['set-cookie'] || response.headers['Set-Cookie']),
            body: tryParseJson(response.body),
          };
          mutationVariablePool.extractFromResponse(step.step_order, responseForPool, wasSuccessful);
        }

        if (matchedParallelGroup) {
          const writebackPolicy = matchedParallelGroup.writeback_policy || 'primary_only';
          if (writebackPolicy === 'primary_only') {
            const responseForPool = {
              status: response.status,
              headers: response.headers,
              cookies: parseCookiesFromSetCookie(response.headers['set-cookie'] || response.headers['Set-Cookie']),
              body: tryParseJson(response.body),
            };
            mutationVariablePool.extractFromResponse(step.step_order, responseForPool, wasSuccessful);
          }
        }

        const matchedFailure = matchedFailureForExtract;

        const assertionEval = !isExecError
          ? evaluateStepAssertions(stepAssertions, assertionsMode as 'all' | 'any', response, variableValues, context)
          : { passed: true, results: [] };

        const stepExecution: StepExecution = {
          step_order: step.step_order,
          template_name: template.name,
          url,
          method: parsedRequest.method,
          headers: parsedRequest.headers,
          body: parsedRequest.body,
          response,
          matchedFailurePattern: matchedFailure,
          assertionsPassed: assertionEval.passed,
          executed: !isExecError,
          isExecutionError: isExecError,
        };

        if (concurrentResults) {
          stepExecution.concurrent_results = concurrentResults;
        }

        if (parallelResults) {
          stepExecution.parallel_results = parallelResults;
        }

        stepExecutions.push(stepExecution);

        Object.entries(context.extractedValues).forEach(([key, value]) => {
          variableValues[`extracted.${key}`] = value;
        });
      }

      completedTests++;
      const progressPercent = Math.round((completedTests / totalTests) * 100);

      const completenessCheck = validateStepCompleteness(stepExecutions, expectedStepCount);
      if (!completenessCheck.valid) {
        if (completenessCheck.hasExecutionError) {
          errorsCount++;
        }
        errors.push(`Workflow combination skipped: ${completenessCheck.reason}`);
        await db.repos.testRuns.update(test_run_id, {
          progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount },
          progress_percent: progressPercent,
        } as any);
        continue;
      }

      const isVulnerability = evaluateWorkflowAssertion(stepExecutions, assertionStrategy, criticalStepOrders);

      if (isVulnerability) {
        let shouldCreateFinding = true;
        let responseDiff: ResponseDiff | null = null;

        if (enableBaseline && baselineStepExecutions) {
          responseDiff = compareWorkflowResponses(baselineStepExecutions, stepExecutions as BaselineStepExecution[], baselineConfig);
          shouldCreateFinding = hasSignificantDiff(responseDiff);
        }

        if (shouldCreateFinding) {
          const requestSummary = stepExecutions.map(r =>
            `Step ${r.step_order} (${r.template_name}): ${r.method} ${r.url} -> ${r.response.status}`
          ).join('\n');

          const dropContext: DropCheckContext = {
            method: stepExecutions[0]?.method || 'GET',
            path: stepExecutions[0]?.url ? new URL(stepExecutions[0].url).pathname : '/',
            requestRaw: stepExecutions.map(r => `${r.method} ${r.url}`).join('\n'),
            workflowId: workflow_id,
            sourceType: 'workflow',
          };
          const dropResult = checkDropRules(dropRules as any, dropContext);

          if (dropResult.dropped) {
            droppedCount++;
          } else {
            const suppressionCheck = checkSuppressionRulesForWorkflow(
              suppressionRules as SuppressionRule[],
              workflow_id,
              workflow.name,
              stepExecutions as StepExecutionForSuppression[],
              environment_id
            );

            let isSuppressed = suppressionCheck.suppressed;
            let suppressionRuleId = suppressionCheck.ruleId;
            let suppressedReason: 'rule' | undefined = undefined;

            if (suppressionCheck.suppressed) {
              suppressedReason = 'rule';
              suppressedRuleCount++;
            } else {
              findingsCount++;
            }

            const findingData = {
              source_type: 'workflow',
              test_run_id,
              security_run_id: security_run_id || undefined,
              workflow_id,
              workflow_name: workflow.name,
              severity: 'medium',
              status: 'new',
              title: `Workflow vulnerability: ${workflow.name}`,
              description: enableBaseline && responseDiff
                ? `Workflow execution differs from baseline. Strategy: "${assertionStrategy}". Values: ${JSON.stringify(combination.values)}\n\nSteps:\n${requestSummary}`
                : `Workflow execution with assertion strategy "${assertionStrategy}". Values: ${JSON.stringify(combination.values)}\n\nSteps:\n${requestSummary}`,
              template_name: workflow.name,
              variable_values: variableValues,
              request_raw: stepExecutions.map(r => `${r.method} ${r.url}\n${JSON.stringify(r.headers)}\n\n${r.body || ''}`).join('\n---\n'),
              response_status: stepExecutions[stepExecutions.length - 1]?.response.status,
              response_body: stepExecutions.map(r => `Step ${r.step_order}: ${r.response.body?.substring(0, 2000)}`).join('\n---\n'),
              account_source_map: combination.accountMap,
              attacker_account_id: combination.attackerId || undefined,
              victim_account_ids: combination.victimIds,
              baseline_response: baselineStepExecutions
                ? { steps: baselineStepExecutions.map(s => truncateStepForStorage(s)) }
                : undefined,
              mutated_response: { steps: stepExecutions.map(s => truncateStepForStorage(s)) },
              response_diff: responseDiff || undefined,
              is_suppressed: isSuppressed,
              suppression_rule_id: suppressionRuleId,
              suppressed_reason: suppressedReason,
            };

            await db.repos.findings.create(findingData as any);
          }
        }
      }

      await db.repos.testRuns.update(test_run_id, {
        progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount },
        progress_percent: progressPercent,
      } as any);
    }

    const hasExecutionError = errorsCount > 0;
    let finalStatus = 'completed';
    if (completedTests === 0 && errors.length > 0) {
      finalStatus = 'failed';
    } else if (hasExecutionError) {
      finalStatus = 'completed_with_errors';
    }

    await db.repos.testRuns.update(test_run_id, {
      status: finalStatus,
      completed_at: new Date().toISOString(),
      progress_percent: 100,
      error_message: errors.length > 0 ? errors.slice(0, 10).join('; ') : undefined,
      errors_count: errorsCount,
      has_execution_error: hasExecutionError,
      progress: {
        total: totalTests,
        completed: completedTests,
        findings: findingsCount,
        errors_count: errorsCount,
        warnings: runWarnings.length > 0 ? runWarnings : undefined
      },
      dropped_count: droppedCount,
      findings_count_effective: findingsCount,
      suppressed_count_rule: suppressedRuleCount,
    } as any);

    finishDebugTrace('workflow');

    return {
      success: true,
      test_run_id,
      findings_count: findingsCount,
      errors_count: errorsCount,
      has_execution_error: hasExecutionError,
      warnings: runWarnings.length > 0 ? runWarnings : undefined,
    };

  } catch (error: any) {
    await db.repos.testRuns.update(test_run_id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: error.message || 'Unknown error occurred',
      has_execution_error: true,
    } as any);

    finishDebugTrace('workflow');

    return {
      success: false,
      test_run_id,
      findings_count: 0,
      errors_count: 1,
      has_execution_error: true,
      error: error.message,
    };
  }
}

interface ValueCombination {
  values: Record<string, string>;
  accountMap: Record<string, string>;
  attackerId?: string;
  victimIds: string[];
}

function generateAccountCombinations(
  configs: any[],
  accounts: any[],
  checklists: Map<string, any>,
  securityRules: Map<string, any>,
  globalBindingStrategy?: string,
  globalAttackerAccountId?: string,
  variablePools?: Map<string, any[]>
): ValueCombination[] {
  const accountVars = configs.filter(c => c.data_source === 'account_field' && c.account_field_name);
  const otherVars = configs.filter(c => c.data_source !== 'account_field' && c.data_source !== 'workflow_context');

  let otherValueSets: Array<{ values: Record<string, string> }> = [{ values: {} }];

  for (const config of otherVars) {
    let values: string[] = [];

    if (config.data_source === 'checklist' && config.checklist_id) {
      values = checklists.get(config.checklist_id)?.config?.values || [];
    } else if (config.data_source === 'security_rule' && config.security_rule_id) {
      values = securityRules.get(config.security_rule_id)?.payloads || [];
    }

    if (values.length === 0) continue;

    const newSets: typeof otherValueSets = [];
    for (const set of otherValueSets) {
      for (const value of values) {
        newSets.push({ values: { ...set.values, [config.name]: value } });
      }
    }
    otherValueSets = newSets;
  }

  if (accountVars.length === 0) {
    return otherValueSets.map(set => ({ values: set.values, accountMap: {}, victimIds: [] }));
  }

  const strategy = globalBindingStrategy || 'per_account';
  const combinations: ValueCombination[] = [];

  switch (strategy) {
    case 'independent': {
      let currentCombos: ValueCombination[] = otherValueSets.map(s => ({
        values: s.values,
        accountMap: {},
        victimIds: [],
      }));

      for (const config of accountVars) {
        const pool = variablePools?.get(config.name) || accounts;
        const accountValues: Array<{ value: string; accountId: string }> = [];
        for (const account of pool) {
          const fieldValue = account.fields?.[config.account_field_name];
          if (fieldValue !== undefined && fieldValue !== null && fieldValue !== '') {
            accountValues.push({ value: String(fieldValue), accountId: account.id });
          }
        }

        if (accountValues.length === 0) continue;

        const newCombos: ValueCombination[] = [];
        for (const combo of currentCombos) {
          for (const av of accountValues) {
            const newAccountMap = { ...combo.accountMap, [config.name]: av.accountId };
            newCombos.push({
              values: { ...combo.values, [config.name]: av.value },
              accountMap: newAccountMap,
              victimIds: [...new Set(Object.values(newAccountMap) as string[])],
            });
          }
        }
        currentCombos = newCombos;
      }
      combinations.push(...currentCombos);
      break;
    }

    case 'per_account': {
      for (const account of accounts) {
        const values: Record<string, string> = {};
        const accountMap: Record<string, string> = {};
        let hasAllVars = true;

        for (const config of accountVars) {
          const value = account.fields?.[config.account_field_name];
          if (value === undefined || value === null || value === '') {
            hasAllVars = false;
            break;
          }
          values[config.name] = String(value);
          accountMap[config.name] = account.id;
        }

        if (hasAllVars) {
          for (const otherSet of otherValueSets) {
            combinations.push({
              values: { ...otherSet.values, ...values },
              accountMap,
              victimIds: [account.id],
            });
          }
        }
      }
      break;
    }

    case 'anchor_attacker': {
      if (!globalAttackerAccountId) {
        return generateAccountCombinations(configs, accounts, checklists, securityRules, 'independent', undefined, variablePools);
      }

      const attacker = accounts.find(a => a.id === globalAttackerAccountId);
      if (!attacker) {
        return generateAccountCombinations(configs, accounts, checklists, securityRules, 'independent', undefined, variablePools);
      }

      const nonAttackerAccounts = accounts.filter(a => a.id !== globalAttackerAccountId);
      const attackerVars = accountVars.filter(v => v.is_attacker_field || v.role === 'attacker');
      const victimVars = accountVars.filter(v => !v.is_attacker_field && v.role !== 'attacker');

      const attackerValues: Record<string, string> = {};
      const attackerMap: Record<string, string> = {};

      for (const config of attackerVars) {
        const value = attacker.fields?.[config.account_field_name];
        if (value !== undefined && value !== null && value !== '') {
          attackerValues[config.name] = String(value);
          attackerMap[config.name] = attacker.id;
        }
      }

      if (victimVars.length === 0) {
        for (const otherSet of otherValueSets) {
          combinations.push({
            values: { ...otherSet.values, ...attackerValues },
            accountMap: attackerMap,
            attackerId: attacker.id,
            victimIds: [],
          });
        }
      } else {
        let victimCandidates: any[] | null = null;
        for (const config of victimVars) {
          const pool = variablePools?.get(config.name) || nonAttackerAccounts;
          if (victimCandidates === null) {
            victimCandidates = [...pool];
          } else {
            const poolIds = new Set(pool.map((a: any) => a.id));
            victimCandidates = victimCandidates.filter(a => poolIds.has(a.id));
          }
        }
        const victims = victimCandidates || nonAttackerAccounts;

        for (const victim of victims) {
          const victimValues: Record<string, string> = {};
          const victimMap: Record<string, string> = {};
          let hasAllVictimVars = true;

          for (const config of victimVars) {
            const value = victim.fields?.[config.account_field_name];
            if (value === undefined || value === null || value === '') {
              hasAllVictimVars = false;
              break;
            }
            victimValues[config.name] = String(value);
            victimMap[config.name] = victim.id;
          }

          if (hasAllVictimVars) {
            for (const otherSet of otherValueSets) {
              combinations.push({
                values: { ...otherSet.values, ...attackerValues, ...victimValues },
                accountMap: { ...attackerMap, ...victimMap },
                attackerId: attacker.id,
                victimIds: [victim.id],
              });
            }
          }
        }
      }
      break;
    }

    default: {
      for (const account of accounts) {
        const values: Record<string, string> = {};
        const accountMap: Record<string, string> = {};
        let hasAllVars = true;

        for (const config of accountVars) {
          const value = account.fields?.[config.account_field_name];
          if (value === undefined || value === null || value === '') {
            hasAllVars = false;
            break;
          }
          values[config.name] = String(value);
          accountMap[config.name] = account.id;
        }

        if (hasAllVars) {
          for (const otherSet of otherValueSets) {
            combinations.push({
              values: { ...otherSet.values, ...values },
              accountMap,
              victimIds: [account.id],
            });
          }
        }
      }
    }
  }

  return combinations.length > 0 ? combinations : [{ values: {}, accountMap: {}, victimIds: [] }];
}

function applyContextVariables(
  parsedRequest: any,
  context: WorkflowContext,
  configs: any[],
  stepOrder: number
): any {
  let result = { ...parsedRequest, headers: { ...parsedRequest.headers }, body: parsedRequest.body, path: parsedRequest.path };
  const contextConfigs = configs.filter(c => c.data_source === 'workflow_context');

  for (const config of contextConfigs) {
    const contextValue = context.extractedValues[config.name];
    if (!contextValue) continue;

    const stepMapping = config.step_variable_mappings?.find((m: any) => m.step_order === stepOrder);
    if (stepMapping) {
      result = applyVariableToRequest(result, stepMapping.json_path, contextValue, config.advanced_config);
    }
  }

  return result;
}

function applySessionJarToRequest(
  parsedRequest: any,
  context: WorkflowContext,
  sessionJarConfig: any
): any {
  const result = { ...parsedRequest, headers: { ...parsedRequest.headers }, body: parsedRequest.body };

  if (sessionJarConfig.cookie_mode !== false && Object.keys(context.cookies).length > 0) {
    const cookieString = Object.entries(context.cookies).map(([n, v]) => `${n}=${v}`).join('; ');
    const existing = result.headers['Cookie'] || result.headers['cookie'] || '';
    result.headers['Cookie'] = existing ? `${existing}; ${cookieString}` : cookieString;
  }

  return result;
}

function executeExtractors(
  extractors: any[],
  stepOrder: number,
  response: HttpResponse,
  context: WorkflowContext
): void {
  const stepExtractors = extractors.filter(e => e.step_order === stepOrder);

  for (const extractor of stepExtractors) {
    let extractedValue: string | null = null;

    switch (extractor.source) {
      case 'response_body_jsonpath':
        try {
          const bodyObj = JSON.parse(response.body);
          const value = extractValueByJsonPath(bodyObj, extractor.expression);
          if (value !== undefined && value !== null) {
            extractedValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
          }
        } catch {}
        break;

      case 'response_body_regex':
        try {
          const match = response.body.match(new RegExp(extractor.expression));
          if (match) {
            extractedValue = match[1] || match[0];
          }
        } catch {}
        break;

      case 'response_header':
        const headerValue = response.headers[extractor.expression] ||
          response.headers[extractor.expression.toLowerCase()] ||
          response.headers[extractor.expression.toUpperCase()];
        if (headerValue) {
          extractedValue = headerValue;
        }
        break;

      case 'response_status':
        extractedValue = String(response.status);
        break;
    }

    if (extractedValue !== null) {
      context.extractedValues[extractor.name] = extractedValue;
    }
  }
}

function updateSessionJar(
  response: HttpResponse,
  context: WorkflowContext,
  config: any
): void {
  if (config.cookie_mode !== false) {
    const setCookie = response.headers['set-cookie'] || response.headers['Set-Cookie'];
    const newCookies = parseCookiesFromSetCookie(setCookie);

    if (Object.keys(newCookies).length > 0) {
      context.cookies = { ...(context.cookies || {}), ...newCookies };
    }
  }
}

export function getAssertionLeftValue(
  left: { type: string; path: string },
  response: HttpResponse
): { value: string; isMissing: boolean } {
  if (left.type !== 'response') return { value: '', isMissing: true };

  const path = left.path;

  if (path.startsWith('body.')) {
    try {
      const bodyObj = JSON.parse(response.body);
      const pathParts = path.replace('body.', '').split('.');
      let current: any = bodyObj;

      for (const part of pathParts) {
        if (current === null || current === undefined) return { value: '', isMissing: true };
        current = current[part];
      }

      if (current === undefined || current === null) return { value: '', isMissing: true };
      return { value: String(current), isMissing: false };
    } catch {
      return { value: '', isMissing: true };
    }
  } else if (path.startsWith('headers.')) {
    const headerKey = path.replace('headers.', '');
    const headerValue = response.headers[headerKey] || response.headers[headerKey.toLowerCase()];
    if (!headerValue) return { value: '', isMissing: true };
    return { value: headerValue, isMissing: false };
  } else if (path === 'status') {
    return { value: String(response.status), isMissing: false };
  }

  return { value: '', isMissing: true };
}

export function evaluateAssertionOp(leftValue: string, op: string, rightValue: string): boolean {
  switch (op) {
    case 'equals': return leftValue === rightValue;
    case 'not_equals': return leftValue !== rightValue;
    case 'contains': return leftValue.includes(rightValue);
    case 'not_contains': return !leftValue.includes(rightValue);
    case 'regex':
      try { return new RegExp(rightValue).test(leftValue); }
      catch { return false; }
    default: return false;
  }
}

export function evaluateStepAssertions(
  assertions: StepAssertion[],
  mode: 'all' | 'any',
  response: HttpResponse,
  variableValues: Record<string, string>,
  context: WorkflowContext
): { passed: boolean; results: any[] } {
  if (!assertions || assertions.length === 0) {
    return { passed: true, results: [] };
  }

  const results: any[] = [];
  const evaluatedResults: any[] = [];

  for (const assertion of assertions) {
    const leftResult = getAssertionLeftValue(assertion.left, response);
    let rightValue = '';

    switch (assertion.right.type) {
      case 'literal':
        rightValue = assertion.right.value || '';
        break;
      case 'workflow_variable':
        rightValue = variableValues[assertion.right.key || ''] || '';
        break;
      case 'workflow_context':
        rightValue = context.extractedValues[assertion.right.key || ''] || '';
        break;
    }

    const missingBehavior = assertion.missing_behavior || 'fail';

    if (leftResult.isMissing && missingBehavior === 'skip') {
      results.push({ assertion, passed: true, left_value: leftResult.value, right_value: rightValue });
      continue;
    }

    const passed = evaluateAssertionOp(leftResult.value, assertion.op, rightValue);
    results.push({ assertion, passed, left_value: leftResult.value, right_value: rightValue });
    evaluatedResults.push({ assertion, passed, left_value: leftResult.value, right_value: rightValue });
  }

  if (evaluatedResults.length === 0) {
    return { passed: true, results };
  }

  const overallPassed = mode === 'all'
    ? evaluatedResults.every(r => r.passed)
    : evaluatedResults.some(r => r.passed);

  return { passed: overallPassed, results };
}

function validateStepCompleteness(
  stepExecutions: StepExecution[],
  expectedStepCount: number
): { valid: boolean; reason?: string; hasExecutionError: boolean } {
  if (stepExecutions.length !== expectedStepCount) {
    return {
      valid: false,
      reason: `Expected ${expectedStepCount} steps but only ${stepExecutions.length} were attempted`,
      hasExecutionError: true,
    };
  }

  const unexecutedSteps = stepExecutions.filter(s => !s.executed);
  if (unexecutedSteps.length > 0) {
    return {
      valid: false,
      reason: `Steps ${unexecutedSteps.map(s => s.step_order).join(', ')} were not executed`,
      hasExecutionError: true,
    };
  }

  const zeroStatusSteps = stepExecutions.filter(s => s.response.status === 0);
  if (zeroStatusSteps.length > 0) {
    return {
      valid: false,
      reason: `Steps ${zeroStatusSteps.map(s => s.step_order).join(', ')} received no response (status=0)`,
      hasExecutionError: true,
    };
  }

  return { valid: true, hasExecutionError: false };
}

function isStepPass(step: StepExecution): boolean {
  return step.executed && step.response.status > 0 && !step.matchedFailurePattern && step.assertionsPassed;
}

function evaluateWorkflowAssertion(
  stepExecutions: StepExecution[],
  strategy: string,
  criticalStepOrders: number[]
): boolean {
  switch (strategy) {
    case 'any_step_pass':
      return stepExecutions.some(step => isStepPass(step));

    case 'all_steps_pass':
      return stepExecutions.every(step => isStepPass(step));

    case 'last_step_pass':
      if (stepExecutions.length === 0) return false;
      return isStepPass(stepExecutions[stepExecutions.length - 1]);

    case 'specific_steps':
      if (criticalStepOrders.length === 0) {
        return stepExecutions.some(step => isStepPass(step));
      }
      const criticalSteps = stepExecutions.filter(step => criticalStepOrders.includes(step.step_order));
      return criticalSteps.length > 0 && criticalSteps.every(step => isStepPass(step));

    default:
      return stepExecutions.some(step => isStepPass(step));
  }
}

function buildBaselineValues(
  variableConfigs: any[],
  attacker: any,
  combination: ValueCombination
): ValueCombination {
  const baselineValues: Record<string, string> = {};
  const baselineAccountMap: Record<string, string> = {};

  for (const config of variableConfigs) {
    if (config.data_source === 'account_field' && config.account_field_name) {
      const value = attacker.fields?.[config.account_field_name];
      if (value !== undefined && value !== null) {
        baselineValues[config.name] = String(value);
        baselineAccountMap[config.name] = attacker.id;
      }
    } else if (combination.values[config.name]) {
      baselineValues[config.name] = combination.values[config.name];
    }
  }

  return {
    values: baselineValues,
    accountMap: baselineAccountMap,
    attackerId: attacker.id,
    victimIds: [],
  };
}

async function runWorkflowWithValues(
  stepsWithTemplates: any[],
  variableConfigs: any[],
  combination: ValueCombination,
  baseUrl: string,
  enableExtractor: boolean,
  enableSessionJar: boolean,
  sessionJarConfig: any,
  extractors: any[],
  assertionStrategy?: string,
  criticalStepOrders?: number[],
  variablePool?: VariablePoolManager,
  accounts?: any[],
  globalAttackerAccountId?: string,
  mutationProfile?: MutationProfile,
  globalBindingStrategy?: string,
  isBaseline?: boolean
): Promise<{ valid: boolean; stepExecutions: StepExecution[]; reason?: string }> {
  const context: WorkflowContext = { extractedValues: {}, cookies: {}, sessionFields: {} };
  const stepExecutions: StepExecution[] = [];
  const variableValues: Record<string, string> = { ...combination.values };

  for (const step of stepsWithTemplates) {
    const template = step.api_template;
    const stepAssertions = (step.step_assertions || []) as StepAssertion[];
    const assertionsMode = step.assertions_mode || 'all';

    if (!template) {
      stepExecutions.push({
        step_order: step.step_order,
        template_name: 'Unknown',
        url: '',
        method: 'GET',
        headers: {},
        response: { status: 0, headers: {}, body: '' },
        matchedFailurePattern: false,
        assertionsPassed: true,
        executed: false,
        isExecutionError: true,
      });
      continue;
    }

    let parsedRequest = parseRawRequest(step.request_snapshot_raw || template.raw_request || '');
    if (!parsedRequest) {
      stepExecutions.push({
        step_order: step.step_order,
        template_name: template.name,
        url: '',
        method: 'GET',
        headers: {},
        response: { status: 0, headers: {}, body: '' },
        matchedFailurePattern: false,
        assertionsPassed: true,
        executed: false,
        isExecutionError: true,
      });
      continue;
    }

    for (const config of variableConfigs) {
      if (config.data_source === 'workflow_context') continue;
      const value = combination.values[config.name];
      if (!value) continue;

      const stepMapping = config.step_variable_mappings?.find((m: any) => m.step_order === step.step_order);
      if (stepMapping) {
        parsedRequest = applyVariableToRequest(parsedRequest, stepMapping.json_path, value, {
          ...config.advanced_config,
          original_value: stepMapping.original_value,
        });
      }
    }

    if (enableExtractor) {
      parsedRequest = applyContextVariables(parsedRequest, context, variableConfigs, step.step_order);
    }

    if (enableSessionJar) {
      parsedRequest = applySessionJarToRequest(parsedRequest, context, sessionJarConfig);
    }

    if (!parsedRequest) continue;

    if (variablePool) {
      const requestForPool = buildRequestForPool(parsedRequest);

      const accountIdentity = accounts && globalBindingStrategy
        ? buildAccountIdentity(combination, accounts, globalAttackerAccountId, mutationProfile, step.step_order, globalBindingStrategy)
        : undefined;

      variablePool.injectIntoRequest(step.step_order, requestForPool, accountIdentity);

      if (accountIdentity && mutationProfile?.swap_account_at_steps && mutationProfile.swap_account_at_steps[step.step_order]) {
        applyIdentityOverlay(requestForPool, accountIdentity);
      }

      parsedRequest.headers = { ...parsedRequest.headers, ...requestForPool.headers };

      if (Object.keys(requestForPool.cookies).length > 0) {
        const cookieHeader = Object.entries(requestForPool.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
        parsedRequest.headers['Cookie'] = cookieHeader;
      }

      let pathWithQuery = requestForPool.url;
      if (Object.keys(requestForPool.query).length > 0) {
        const queryString = Object.entries(requestForPool.query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&');
        pathWithQuery = requestForPool.url.includes('?')
          ? `${requestForPool.url}&${queryString}`
          : `${requestForPool.url}?${queryString}`;
      }
      parsedRequest.path = pathWithQuery;

      if (requestForPool.body && typeof requestForPool.body === 'object') {
        parsedRequest.body = JSON.stringify(requestForPool.body);
      }
    }

    const url = baseUrl + parsedRequest.path;
    if (!validateUrl(url)) {
      stepExecutions.push({
        step_order: step.step_order,
        template_name: template.name,
        url,
        method: parsedRequest.method,
        headers: parsedRequest.headers,
        body: parsedRequest.body,
        response: { status: 0, headers: {}, body: '' },
        matchedFailurePattern: false,
        assertionsPassed: true,
        executed: false,
        isExecutionError: true,
      });
      continue;
    }

    let response: HttpResponse;
    let isExecError = false;

    try {
      const fetchResponse = await fetchWithRetry(url, {
        method: parsedRequest.method,
        headers: parsedRequest.headers,
        body: ['GET', 'HEAD'].includes(parsedRequest.method) ? undefined : parsedRequest.body,
      }, 2, {
        step_order: step.step_order,
        step_id: step.id,
        template_id: template.id,
        template_name: template.name,
        label: isBaseline ? 'baseline' : undefined,
      });

      const responseBody = await fetchResponse.text();
      const responseHeaders: Record<string, string> = {};
      fetchResponse.headers.forEach((v, k) => { responseHeaders[k] = v; });

      response = { status: fetchResponse.status, headers: responseHeaders, body: responseBody };
    } catch (e: any) {
      response = { status: 0, headers: {}, body: `Error: ${e.message}` };
      isExecError = true;
    }

    const stepFailurePatternsOverride = step.failure_patterns_override as FailurePattern[] | null;
    const failurePatterns = stepFailurePatternsOverride || (template.failure_patterns as FailurePattern[]) || [];
    const failureLogic = (template.failure_logic || 'OR') as 'OR' | 'AND';
    const matchedFailure = checkFailurePatterns(failurePatterns, failureLogic, response.status, response.body, response.headers);

    if (!isExecError && variablePool) {
      const responseForPool = {
        status: response.status,
        headers: response.headers,
        cookies: parseCookiesFromSetCookie(response.headers['set-cookie'] || response.headers['Set-Cookie']),
        body: tryParseJson(response.body),
      };
      const wasSuccessful = response.status >= 200 && response.status < 300 && !matchedFailure;
      variablePool.extractFromResponse(step.step_order, responseForPool, wasSuccessful);
    }

    if (!isExecError && enableExtractor) {
      executeExtractors(extractors, step.step_order, response, context);
    }

    if (!isExecError && enableSessionJar) {
      updateSessionJar(response, context, sessionJarConfig);
    }

    const assertionEval = !isExecError
      ? evaluateStepAssertions(stepAssertions, assertionsMode as 'all' | 'any', response, variableValues, context)
      : { passed: true, results: [] };

    stepExecutions.push({
      step_order: step.step_order,
      template_name: template.name,
      url,
      method: parsedRequest.method,
      headers: parsedRequest.headers,
      body: parsedRequest.body,
      response,
      matchedFailurePattern: matchedFailure,
      assertionsPassed: assertionEval.passed,
      executed: !isExecError,
      isExecutionError: isExecError,
    });

    Object.entries(context.extractedValues).forEach(([key, value]) => {
      variableValues[`extracted.${key}`] = value;
    });
  }

  const basicValid = stepExecutions.length > 0 &&
    stepExecutions.every(s => s.executed && s.response.status > 0);

  if (!basicValid) {
    return { valid: false, stepExecutions, reason: 'Not all steps executed successfully' };
  }

  const hasFailurePattern = stepExecutions.some(s => s.matchedFailurePattern);
  if (hasFailurePattern) {
    return { valid: false, stepExecutions, reason: 'Baseline matched failure pattern (request failed)' };
  }

  const hasFailedAssertions = stepExecutions.some(s => !s.assertionsPassed);
  if (hasFailedAssertions) {
    return { valid: false, stepExecutions, reason: 'Baseline failed step assertions' };
  }

  if (assertionStrategy) {
    const workflowPassed = evaluateWorkflowAssertion(stepExecutions, assertionStrategy, criticalStepOrders || []);
    if (!workflowPassed) {
      return { valid: false, stepExecutions, reason: 'Baseline did not pass workflow assertion strategy' };
    }
  }

  return { valid: true, stepExecutions };
}

function buildAccountIdentity(
  combination: ValueCombination,
  accounts: any[],
  globalAttackerAccountId?: string,
  mutationProfile?: MutationProfile,
  stepOrder?: number,
  globalBindingStrategy?: string
): Record<string, string> {
  const identity: Record<string, string> = {};

  let activeAccountId: string | undefined;

  if (mutationProfile?.swap_account_at_steps && stepOrder !== undefined) {
    const swapValue = mutationProfile.swap_account_at_steps[stepOrder];
    if (swapValue === 'attacker') {
      activeAccountId = combination.attackerId || globalAttackerAccountId;
    } else if (swapValue === 'victim') {
      activeAccountId = combination.victimIds?.[0];
    } else {
      activeAccountId = swapValue;
    }
  } else {
    if (globalBindingStrategy === 'anchor_attacker') {
      activeAccountId = combination.attackerId || globalAttackerAccountId;
    } else if (globalBindingStrategy === 'per_account') {
      activeAccountId = combination.victimIds?.[0];
    } else {
      activeAccountId = combination.victimIds?.[0] || combination.attackerId || globalAttackerAccountId;
    }
  }

  if (activeAccountId) {
    const account = accounts.find(a => a.id === activeAccountId);
    if (account?.fields) {
      if (account.fields.token) identity.token = account.fields.token;
      if (account.fields.accessToken) identity.accessToken = account.fields.accessToken;
      if (account.fields.access_token) identity.access_token = account.fields.access_token;
      if (account.fields.authorization) identity.authorization = account.fields.authorization;
      if (account.fields.sessionId) identity.sessionId = account.fields.sessionId;
      if (account.fields.session_id) identity.session_id = account.fields.session_id;
      if (account.fields.cookie) identity.cookie = account.fields.cookie;
      if (account.fields.apiKey) identity.apiKey = account.fields.apiKey;
      if (account.fields.api_key) identity.api_key = account.fields.api_key;
    }
  }

  return identity;
}

function applyIdentityOverlay(
  requestForPool: {
    headers: Record<string, string>;
    cookies: Record<string, string>;
    query: Record<string, string>;
    body: any;
    url: string;
  },
  accountIdentity: Record<string, string>
): void {
  const auth = accountIdentity['Authorization'] || accountIdentity['authorization']
            || accountIdentity['accessToken'] || accountIdentity['access_token']
            || accountIdentity['token'];

  if (auth) {
    requestForPool.headers = requestForPool.headers || {};
    if (!String(auth).toLowerCase().startsWith('bearer ') && auth) {
      requestForPool.headers['Authorization'] = `Bearer ${auth}`;
    } else {
      requestForPool.headers['Authorization'] = auth;
    }
  }

  requestForPool.cookies = requestForPool.cookies || {};
  const session = accountIdentity['session'] || accountIdentity['sid'];
  if (session) {
    requestForPool.cookies['session'] = session;
  }
}

function parseCookiesFromHeaders(headers: Record<string, string>): Record<string, string> {
  const cookies: Record<string, string> = {};
  const cookieHeader = headers['Cookie'] || headers['cookie'];
  if (cookieHeader) {
    const pairs = cookieHeader.split(';');
    for (const pair of pairs) {
      const [name, value] = pair.split('=').map(s => s.trim());
      if (name && value) cookies[name] = value;
    }
  }
  return cookies;
}

function parseCookiesFromSetCookie(setCookie?: string | string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!setCookie) return cookies;

  const cookieStrings: string[] = Array.isArray(setCookie) ? setCookie : [setCookie];

  for (const cookieStr of cookieStrings) {
    const parts: string[] = [];
    let currentPart = '';
    let i = 0;

    while (i < cookieStr.length) {
      if (cookieStr[i] === ',' && i + 1 < cookieStr.length) {
        const afterComma = cookieStr.substring(i + 1).trim();
        if (/^[a-zA-Z0-9_-]+=/.test(afterComma)) {
          parts.push(currentPart);
          currentPart = '';
          i++;
          continue;
        }
      }
      currentPart += cookieStr[i];
      i++;
    }
    if (currentPart) parts.push(currentPart);

    for (const part of parts) {
      const cookiePart = part.split(';')[0].trim();
      const eqIndex = cookiePart.indexOf('=');
      if (eqIndex > 0) {
        const name = cookiePart.substring(0, eqIndex).trim();
        const value = cookiePart.substring(eqIndex + 1).trim();
        cookies[name] = value;
      }
    }
  }

  return cookies;
}

function parseQueryFromPath(path: string): Record<string, string> {
  const query: Record<string, string> = {};
  const qIndex = path.indexOf('?');
  if (qIndex < 0) return query;

  const queryString = path.substring(qIndex + 1);
  const pairs = queryString.split('&');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key) query[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
  }
  return query;
}

function buildRequestForPool(parsedRequest: any) {
  const originalPath = parsedRequest.path;
  const pathOnly = originalPath.split('?')[0];

  return {
    headers: { ...parsedRequest.headers },
    cookies: parseCookiesFromHeaders(parsedRequest.headers),
    query: parseQueryFromPath(originalPath),
    body: parsedRequest.body ? tryParseJson(parsedRequest.body) : null,
    url: pathOnly,
  };
}

function tryParseJson(str: string | null | undefined): any {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

function cloneRequest(parsedRequest: any): any {
  return {
    method: parsedRequest.method,
    path: parsedRequest.path,
    headers: { ...parsedRequest.headers },
    body: parsedRequest.body,
  };
}

async function executeConcurrentReplays(
  url: string,
  parsedRequest: any,
  concurrency: number,
  barrier: boolean,
  timeout_ms: number
): Promise<Array<{ ok: boolean; status?: number; error?: string; duration_ms?: number; response?: any }>> {
  let release!: () => void;
  const barrierPromise = new Promise<void>((r) => (release = r));

  const tasks = Array.from({ length: concurrency }, () => async () => {
    if (barrier !== false) await barrierPromise;

    const startTime = Date.now();
    try {
      const fetchResponse = await fetchWithRetry(url, {
        method: parsedRequest.method,
        headers: parsedRequest.headers,
        body: ['GET', 'HEAD'].includes(parsedRequest.method) ? undefined : parsedRequest.body,
      }, 0, {
        label: 'concurrent',
      });

      const responseBody = await fetchResponse.text();
      const responseHeaders: Record<string, string> = {};
      fetchResponse.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });

      const duration = Date.now() - startTime;
      return {
        ok: true,
        status: fetchResponse.status,
        duration_ms: duration,
        response: { status: fetchResponse.status, headers: responseHeaders, body: responseBody },
      };
    } catch (e: any) {
      const duration = Date.now() - startTime;
      return {
        ok: false,
        error: e.message,
        duration_ms: duration,
        response: { status: 0, headers: {}, body: `Error: ${e.message}` },
      };
    }
  });

  setTimeout(() => release(), 0);

  const settled = await Promise.allSettled(
    tasks.map((fn) => withTimeout(fn(), timeout_ms))
  );

  return settled.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      return {
        ok: false,
        error: result.reason?.message || 'Unknown error',
        duration_ms: timeout_ms,
      };
    }
  });
}

function writeRequestFromPool(
  parsedRequest: any,
  requestForPool: {
    headers: Record<string, string>;
    cookies: Record<string, string>;
    query: Record<string, string>;
    body: any;
    url: string;
  }
): void {
  parsedRequest.headers = { ...requestForPool.headers };

  const cookieEntries = Object.entries(requestForPool.cookies);
  if (cookieEntries.length > 0) {
    parsedRequest.headers['Cookie'] = cookieEntries.map(([k, v]) => `${k}=${v}`).join('; ');
  }

  const originalPath = parsedRequest.path;
  const pathOnly = originalPath.split('?')[0];

  const queryEntries = Object.entries(requestForPool.query);
  if (queryEntries.length > 0) {
    const queryString = queryEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    parsedRequest.path = `${pathOnly}?${queryString}`;
  } else {
    parsedRequest.path = pathOnly;
  }

  if (requestForPool.body !== null && requestForPool.body !== undefined) {
    if (typeof requestForPool.body === 'string') {
      parsedRequest.body = requestForPool.body;
    } else {
      parsedRequest.body = JSON.stringify(requestForPool.body);
    }
  }
}

async function executeParallelGroup(
  baseUrl: string,
  anchorParsedRequest: any,
  parallelGroup: any,
  anchorStepOrder: number,
  mutationVariablePool: any,
  accountIdentity: Record<string, string>,
  enableSessionJar: boolean,
  sessionJarConfig: any,
  context: WorkflowContext
): Promise<{
  anchorResponse: any;
  anchorOk: boolean;
  parallelResults: Array<{ name: string; template_id: string; ok: boolean; status?: number; error?: string; duration_ms?: number; response_preview?: string }>;
}> {
  const barrier = parallelGroup.barrier !== false;
  const timeout_ms = parallelGroup.timeout_ms || 5000;
  const extras = parallelGroup.extras || [];

  let release!: () => void;
  const barrierPromise = new Promise<void>((r) => (release = r));

  const anchorTask = async () => {
    if (barrier) await barrierPromise;

    const anchorUrl = `${baseUrl}${anchorParsedRequest.path}`;
    const startTime = Date.now();
    try {
      const fetchResponse = await fetchWithRetry(anchorUrl, {
        method: anchorParsedRequest.method,
        headers: anchorParsedRequest.headers,
        body: ['GET', 'HEAD'].includes(anchorParsedRequest.method) ? undefined : anchorParsedRequest.body,
      }, 0, {
        step_order: anchorStepOrder,
        label: 'parallel_anchor',
      });

      const responseBody = await fetchResponse.text();
      const responseHeaders: Record<string, string> = {};
      fetchResponse.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });

      const duration = Date.now() - startTime;
      return {
        ok: true,
        status: fetchResponse.status,
        duration_ms: duration,
        response: { status: fetchResponse.status, headers: responseHeaders, body: responseBody },
      };
    } catch (e: any) {
      const duration = Date.now() - startTime;
      return {
        ok: false,
        error: e.message,
        duration_ms: duration,
        response: { status: 0, headers: {}, body: `Error: ${e.message}` },
      };
    }
  };

  const extraTasks = extras.map((extra: any) => async () => {
    if (barrier) await barrierPromise;

    const startTime = Date.now();
    try {
      const parsedExtraRequest = parseRawRequest(extra.request_snapshot_raw);

      if (!parsedExtraRequest) {
        throw new Error(`Failed to parse extra request: ${extra.name}`);
      }

      const requestForPool = buildRequestForPool(parsedExtraRequest);

      mutationVariablePool.injectIntoRequest(anchorStepOrder, requestForPool, accountIdentity);

      applyIdentityOverlay(requestForPool, accountIdentity);

      if (enableSessionJar && (context as any).sessionJar) {
        Object.entries((context as any).sessionJar).forEach(([name, value]) => {
          requestForPool.cookies[name] = value as string;
        });
      }

      writeRequestFromPool(parsedExtraRequest, requestForPool);

      const extraUrl = `${baseUrl}${parsedExtraRequest.path}`;
      const fetchResponse = await fetchWithRetry(extraUrl, {
        method: parsedExtraRequest.method,
        headers: parsedExtraRequest.headers,
        body: ['GET', 'HEAD'].includes(parsedExtraRequest.method) ? undefined : parsedExtraRequest.body,
      }, 0, {
        template_id: extra.snapshot_template_id || '',
        template_name: extra.name,
        label: 'parallel_extra',
      });

      const responseBody = await fetchResponse.text();
      const duration = Date.now() - startTime;

      return {
        name: extra.name,
        template_id: extra.snapshot_template_id || '',
        ok: true,
        status: fetchResponse.status,
        duration_ms: duration,
        response_preview: responseBody.substring(0, 200),
      };
    } catch (e: any) {
      const duration = Date.now() - startTime;
      return {
        name: extra.name,
        template_id: extra.snapshot_template_id || '',
        ok: false,
        error: e.message,
        duration_ms: duration,
      };
    }
  });

  setTimeout(() => release(), 0);

  const allTasks = [anchorTask, ...extraTasks];
  const settled = await Promise.allSettled(
    allTasks.map((fn) => withTimeout(fn(), timeout_ms))
  );

  const anchorResult = settled[0];
  let anchorResponse: any;
  let anchorOk: boolean;

  if (anchorResult.status === 'fulfilled') {
    anchorResponse = (anchorResult.value as any).response;
    anchorOk = (anchorResult.value as any).ok;
  } else {
    anchorResponse = { status: 0, headers: {}, body: `Error: ${anchorResult.reason?.message || 'Unknown'}` };
    anchorOk = false;
  }

  const extraResults = settled.slice(1).map((result) => {
    if (result.status === 'fulfilled') {
      return result.value as any;
    } else {
      return {
        name: 'unknown',
        template_id: '',
        ok: false,
        error: result.reason?.message || 'Unknown error',
        duration_ms: timeout_ms,
      };
    }
  });

  return {
    anchorResponse,
    anchorOk,
    parallelResults: extraResults,
  };
}

function pickPrimaryResponse(
  results: Array<{ ok: boolean; status?: number; error?: string; response?: any }>,
  pickStrategy: 'first_success' | 'first' | 'majority_success' = 'first_success'
): { index: number | null; response: any } {
  if (results.length === 0) {
    return { index: null, response: { status: 0, headers: {}, body: '' } };
  }

  if (pickStrategy === 'first') {
    return { index: 0, response: results[0].response || { status: 0, headers: {}, body: '' } };
  }

  if (pickStrategy === 'first_success') {
    for (let i = 0; i < results.length; i++) {
      if (results[i].ok && results[i].status && results[i].status! >= 200 && results[i].status! < 300) {
        return { index: i, response: results[i].response };
      }
    }
    for (let i = 0; i < results.length; i++) {
      if (results[i].ok) {
        return { index: i, response: results[i].response };
      }
    }
    return { index: null, response: { status: 0, headers: {}, body: 'All concurrent requests failed' } };
  }

  if (pickStrategy === 'majority_success') {
    const successResults = results.filter((r) => r.ok && r.status && r.status >= 200 && r.status < 300);
    if (successResults.length > results.length / 2) {
      const firstSuccess = results.findIndex((r) => r.ok && r.status && r.status >= 200 && r.status < 300);
      return { index: firstSuccess, response: results[firstSuccess].response };
    }
    for (let i = 0; i < results.length; i++) {
      if (results[i].ok) {
        return { index: i, response: results[i].response };
      }
    }
    return { index: null, response: { status: 0, headers: {}, body: 'No majority success' } };
  }

  return { index: null, response: { status: 0, headers: {}, body: '' } };
}
