import { dbManager } from '../db/db-manager.js';
import {
  parseRawRequest,
  validateUrl,
  applyVariableToRequest,
  checkFailurePatterns,
  fetchWithRetry,
  FailurePattern,
} from './execution-utils.js';
import { startDebugTrace, finishDebugTrace } from './debug-trace.js';
import {
  compareResponses,
  hasSignificantDiff,
  truncateResponseForStorage,
  truncateRequestResponseForStorage,
  RequestData,
  BaselineConfig,
  HttpResponse,
  ResponseDiff,
} from './baseline-utils.js';
import {
  checkSuppressionRulesForTemplate,
  SuppressionRule,
} from './suppression.js';
import {
  checkDropRules,
  DropCheckContext,
} from './drop-filter.js';
import {
  getGovernanceSettings,
  createRateLimitState,
  checkRateLimit,
  getRateLimitForTemplate,
} from './rate-limiter.js';
import {
  validateAndPrepareAccountPoolsForTemplateRun,
  TemplateVariable,
  Account as ValidationAccount,
  ValidationReport,
} from './variable-validation.js';
import type { ApiTemplate, Account, Environment, Finding, FindingDropRule } from '../types/index.js';

interface TemplateRunRequest {
  test_run_id: string;
  template_ids: string[];
  account_ids?: string[];
  environment_id?: string;
  security_run_id?: string;
}

interface VariableConfig {
  name: string;
  json_path: string;
  operation_type: string;
  original_value: string;
  data_source?: string;
  checklist_id?: string;
  security_rule_id?: string;
  account_field_name?: string;
  is_attacker_field?: boolean;
  role?: string;
  account_scope_mode?: 'all' | 'only_selected' | 'exclude_selected';
  account_scope_ids?: string[];
  path_replacement_mode?: string;
  path_segment_index?: number;
  path_regex_pattern?: string;
  body_content_type?: string;
}

type AccountBindingStrategy = 'independent' | 'per_account' | 'anchor_attacker';

interface ValueCombination {
  values: Record<string, string>;
  accountMap: Record<string, string>;
  attackerId?: string;
  victimIds: string[];
  varConfigs: Record<string, VariableConfig>;
}

export async function executeTemplateRun(request: TemplateRunRequest): Promise<{
  success: boolean;
  test_run_id: string;
  findings_count: number;
  errors_count: number;
  has_execution_error: boolean;
  error?: string;
}> {
  const db = dbManager.getActive();
  const { test_run_id, template_ids, account_ids = [], environment_id, security_run_id } = request;

  startDebugTrace('template', test_run_id, {
    test_run_id,
    template_ids,
    security_run_id,
  });

  try {
    await db.repos.testRuns.update(test_run_id, {
      status: 'running',
      started_at: new Date().toISOString(),
      error_message: undefined,
      progress: { total: 0, completed: 0, findings: 0, errors_count: 0, current_template: 'Loading...' },
    } as any);

    let environment: Environment | null = null;
    if (environment_id) {
      environment = await db.repos.environments.findById(environment_id);
    }

    const templates: ApiTemplate[] = [];
    for (const id of template_ids) {
      const template = await db.repos.apiTemplates.findById(id);
      if (template && template.is_active) {
        templates.push(template);
      }
    }

    if (templates.length === 0) {
      throw new Error('No active templates found');
    }

    const accounts: Account[] = [];
    for (const id of account_ids) {
      const account = await db.repos.accounts.findById(id);
      if (account) {
        accounts.push(account);
      }
    }

    const checklistIds = new Set<string>();
    const securityRuleIds = new Set<string>();
    for (const template of templates) {
      const variables = template.variables as VariableConfig[] || [];
      for (const v of variables) {
        if (v.data_source === 'checklist' && v.checklist_id) {
          checklistIds.add(v.checklist_id);
        }
        if (v.data_source === 'security_rule' && v.security_rule_id) {
          securityRuleIds.add(v.security_rule_id);
        }
      }
    }

    const checklists = new Map<string, any>();
    for (const id of checklistIds) {
      const checklist = await db.repos.checklists.findById(id);
      if (checklist) {
        checklists.set(id, checklist);
      }
    }

    const securityRules = new Map<string, any>();
    for (const id of securityRuleIds) {
      const rule = await db.repos.securityRules.findById(id);
      if (rule) {
        securityRules.set(id, rule);
      }
    }

    const suppressionRules = await db.repos.findingSuppressionRules.findAll({ where: { is_enabled: true } as any });
    const dropRules = await db.repos.findingDropRules.findAll({ where: { is_enabled: true } as any });
    const governanceSettings = await getGovernanceSettings(db);
    const rateLimitState = createRateLimitState();
    const baseUrl = environment?.base_url || '';

    let totalTests = 0;
    let completedTests = 0;
    let findingsCount = 0;
    let errorsCount = 0;
    let droppedCount = 0;
    let suppressedRuleCount = 0;
    let suppressedRateLimitCount = 0;
    const errors: string[] = [];

    for (const template of templates) {
      const variables = template.variables as VariableConfig[] || [];
      const bindingStrategy = (template.account_binding_strategy || 'independent') as AccountBindingStrategy;
      const attackerAccountId = template.attacker_account_id;

      const combinations = generateAccountCombinations(
        variables,
        accounts,
        checklists,
        securityRules,
        bindingStrategy,
        attackerAccountId
      );
      totalTests += combinations.length || 1;
    }

    await db.repos.testRuns.update(test_run_id, {
      progress: { total: totalTests, completed: 0, findings: 0, errors_count: 0 },
    } as any);

    for (const template of templates) {
      const parsedRequest = parseRawRequest(template.raw_request);
      if (!parsedRequest) {
        errors.push(`Template "${template.name}" has invalid request format`);
        errorsCount++;
        continue;
      }

      const variables = template.variables as VariableConfig[] || [];
      const failurePatterns = template.failure_patterns as FailurePattern[] || [];
      const failureLogic = (template.failure_logic || 'OR') as 'OR' | 'AND';
      const bindingStrategy = (template.account_binding_strategy || 'independent') as AccountBindingStrategy;
      const attackerAccountId = template.attacker_account_id;
      const enableBaseline = template.enable_baseline || false;
      const baselineConfig = (template.baseline_config || {}) as BaselineConfig;

      const validationResult = validateAndPrepareAccountPoolsForTemplateRun(
        accounts as ValidationAccount[],
        variables as TemplateVariable[],
        bindingStrategy,
        attackerAccountId
      );

      if (!validationResult.valid) {
        const templateErrors = validationResult.report.fatal_errors;
        for (const err of templateErrors) {
          errors.push(`Template "${template.name}": ${err}`);
        }
        errorsCount++;
        completedTests++;
        await db.repos.testRuns.update(test_run_id, {
          progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount },
          progress_percent: Math.round((completedTests / totalTests) * 100),
          validation_report: validationResult.report,
        } as any);
        continue;
      }

      const combinations = generateAccountCombinations(
        variables,
        validationResult.filteredAccounts as Account[],
        checklists,
        securityRules,
        bindingStrategy,
        attackerAccountId,
        validationResult.variablePools
      );

      const attacker = attackerAccountId ? accounts.find(a => a.id === attackerAccountId) : null;

      for (const combination of combinations.length > 0 ? combinations : [{ values: {}, accountMap: {}, victimIds: [], varConfigs: {} }]) {
        let baselineResponse: HttpResponse | null = null;
        let baselineRequest: RequestData | null = null;

        if (enableBaseline && bindingStrategy === 'anchor_attacker' && attacker && combination.attackerId) {
          const baselineValues: Record<string, string> = {};
          const baselineConfigs: Record<string, VariableConfig> = {};

          for (const variable of variables) {
            if (variable.data_source === 'account_field' && variable.account_field_name) {
              const value = attacker.fields?.[variable.account_field_name];
              if (value !== undefined && value !== null) {
                baselineValues[variable.name] = String(value);
                baselineConfigs[variable.name] = variable;
              }
            } else if (combination.values[variable.name]) {
              baselineValues[variable.name] = combination.values[variable.name];
              baselineConfigs[variable.name] = variable;
            }
          }

          const baselineCombination: ValueCombination = {
            values: baselineValues,
            accountMap: {},
            victimIds: [],
            varConfigs: baselineConfigs,
          };

          const baselineRequestBuilt = buildRequest(parsedRequest, baselineCombination, variables);
          const baselineUrl = baseUrl + baselineRequestBuilt.path;

          if (validateUrl(baselineUrl)) {
            baselineRequest = {
              method: baselineRequestBuilt.method,
              url: baselineUrl,
              headers: baselineRequestBuilt.headers,
              body: baselineRequestBuilt.body,
            };

            try {
              const fetchResponse = await fetchWithRetry(baselineUrl, {
                method: baselineRequestBuilt.method,
                headers: baselineRequestBuilt.headers,
                body: ['GET', 'HEAD'].includes(baselineRequestBuilt.method) ? undefined : baselineRequestBuilt.body,
              }, 2, {
                template_id: template.id,
                template_name: template.name,
                label: 'baseline',
              });

              const body = await fetchResponse.text();
              const headers: Record<string, string> = {};
              fetchResponse.headers.forEach((v, k) => { headers[k] = v; });
              baselineResponse = { status: fetchResponse.status, headers, body };

              if (baselineResponse.status === 0) {
                errorsCount++;
                completedTests++;
                continue;
              }

              if (checkFailurePatterns(failurePatterns, failureLogic, baselineResponse.status, baselineResponse.body, baselineResponse.headers)) {
                completedTests++;
                continue;
              }
            } catch (e: any) {
              errorsCount++;
              completedTests++;
              continue;
            }
          }
        }

        const modifiedRequest = buildRequest(parsedRequest, combination, variables);
        const url = baseUrl + modifiedRequest.path;

        if (!validateUrl(url)) {
          errors.push(`Invalid URL: ${url}`);
          errorsCount++;
          completedTests++;
          continue;
        }

        let responseStatus = 0;
        let responseBody = '';
        let responseHeaders: Record<string, string> = {};
        let isExecutionError = false;

        try {
          const fetchResponse = await fetchWithRetry(url, {
            method: modifiedRequest.method,
            headers: modifiedRequest.headers,
            body: ['GET', 'HEAD'].includes(modifiedRequest.method) ? undefined : modifiedRequest.body,
          }, 2, {
            template_id: template.id,
            template_name: template.name,
          });

          responseStatus = fetchResponse.status;
          responseBody = await fetchResponse.text();
          fetchResponse.headers.forEach((v, k) => {
            responseHeaders[k] = v;
          });
        } catch (error: any) {
          responseBody = `Error: ${error.message}`;
          isExecutionError = true;
          errorsCount++;
        }

        const mutatedResponse: HttpResponse = { status: responseStatus, headers: responseHeaders, body: responseBody };

        const matchedFailure = !isExecutionError && checkFailurePatterns(
          failurePatterns,
          failureLogic,
          responseStatus,
          responseBody,
          responseHeaders
        );

        if (!matchedFailure && !isExecutionError) {
          let shouldCreateFinding = true;
          let responseDiff: ResponseDiff | null = null;

          if (enableBaseline && baselineResponse) {
            responseDiff = compareResponses(baselineResponse, mutatedResponse, baselineConfig);
            shouldCreateFinding = hasSignificantDiff(responseDiff);
          }

          if (shouldCreateFinding) {
            const requestRaw = `${modifiedRequest.method} ${url}\n${Object.entries(modifiedRequest.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${modifiedRequest.body || ''}`;

            const dropContext: DropCheckContext = {
              method: modifiedRequest.method,
              path: modifiedRequest.path,
              requestRaw,
              templateId: template.id,
              sourceType: 'test_run',
            };
            const dropResult = checkDropRules(dropRules as FindingDropRule[], dropContext);

            if (dropResult.dropped) {
              droppedCount++;
            } else {
              const suppressionResult = checkSuppressionRulesForTemplate(
                suppressionRules as SuppressionRule[],
                modifiedRequest.method,
                modifiedRequest.path,
                requestRaw,
                template.id,
                environment_id
              );

              let isSuppressed = suppressionResult.suppressed;
              let suppressionRuleId = suppressionResult.ruleId;
              let suppressedReason: 'rule' | 'rate_limited' | undefined = undefined;

              if (suppressionResult.suppressed) {
                suppressedReason = 'rule';
                suppressedRuleCount++;
              } else if (governanceSettings.rate_limit_enabled) {
                const templateRateLimit = getRateLimitForTemplate(
                  governanceSettings.rate_limit_default,
                  template.rate_limit_override
                );
                const rateLimitResult = checkRateLimit(rateLimitState, template.id, templateRateLimit);

                if (rateLimitResult.shouldSuppress) {
                  isSuppressed = true;
                  suppressedReason = 'rate_limited';
                  suppressedRateLimitCount++;
                } else {
                  findingsCount++;
                }
              } else {
                findingsCount++;
              }

              const mutatedRequest: RequestData = {
                method: modifiedRequest.method,
                url,
                headers: modifiedRequest.headers,
                body: modifiedRequest.body,
              };

              const finding: Omit<Finding, 'id' | 'created_at' | 'updated_at'> = {
                source_type: 'test_run',
                test_run_id,
                security_run_id: security_run_id || undefined,
                template_id: template.id,
                severity: 'medium',
                status: 'new',
                title: `Potential vulnerability in ${template.name}`,
                description: enableBaseline && responseDiff
                  ? `Response succeeded and differs from baseline. Variables: ${JSON.stringify(combination.values)}`
                  : `Request succeeded without matching failure patterns. Variables: ${JSON.stringify(combination.values)}`,
                template_name: template.name,
                variable_values: combination.values,
                request_raw: `${modifiedRequest.method} ${url}\n${JSON.stringify(modifiedRequest.headers)}\n\n${modifiedRequest.body || ''}`,
                response_status: responseStatus,
                response_headers: responseHeaders,
                response_body: responseBody.substring(0, 50000),
                account_source_map: combination.accountMap,
                attacker_account_id: combination.attackerId,
                victim_account_ids: combination.victimIds,
                baseline_response: (baselineResponse && baselineRequest)
                  ? truncateRequestResponseForStorage(baselineRequest, baselineResponse)
                  : undefined,
                mutated_response: truncateRequestResponseForStorage(mutatedRequest, mutatedResponse),
                response_diff: responseDiff || undefined,
                is_suppressed: isSuppressed,
                suppression_rule_id: suppressionRuleId,
                suppressed_reason: suppressedReason,
              };

              await db.repos.findings.create(finding);
            }
          }
        }

        completedTests++;
        const progressPercent = Math.round((completedTests / totalTests) * 100);

        await db.repos.testRuns.update(test_run_id, {
          progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount },
          progress_percent: progressPercent,
        } as any);
      }
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
      progress: { total: totalTests, completed: completedTests, findings: findingsCount, errors_count: errorsCount },
      dropped_count: droppedCount,
      findings_count_effective: findingsCount,
      suppressed_count_rule: suppressedRuleCount,
      suppressed_count_rate_limit: suppressedRateLimitCount,
    } as any);

    finishDebugTrace('template');

    return {
      success: true,
      test_run_id,
      findings_count: findingsCount,
      errors_count: errorsCount,
      has_execution_error: hasExecutionError,
    };

  } catch (error: any) {
    await db.repos.testRuns.update(test_run_id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: error.message || 'Unknown error occurred',
      has_execution_error: true,
    } as any);

    finishDebugTrace('template');

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

function buildRequest(
  parsedRequest: any,
  combination: ValueCombination,
  variables: VariableConfig[]
): any {
  let modifiedRequest = { ...parsedRequest, headers: { ...parsedRequest.headers } };

  for (const [varName, varValue] of Object.entries(combination.values)) {
    const varConfig = combination.varConfigs[varName] || variables.find(v => v.name === varName);
    if (varConfig) {
      modifiedRequest = applyVariableToRequest(
        modifiedRequest,
        varConfig.json_path,
        varValue,
        {
          path_replacement_mode: varConfig.path_replacement_mode,
          path_segment_index: varConfig.path_segment_index,
          path_regex_pattern: varConfig.path_regex_pattern,
          body_content_type: varConfig.body_content_type,
          operation_type: varConfig.operation_type as 'replace' | 'append' | undefined,
          original_value: varConfig.original_value,
        }
      );
    }
  }

  return modifiedRequest;
}

function generateAccountCombinations(
  variables: VariableConfig[],
  accounts: Account[],
  checklists: Map<string, any>,
  securityRules: Map<string, any>,
  strategy: AccountBindingStrategy,
  attackerAccountId?: string,
  variablePools?: Map<string, any[]>
): ValueCombination[] {
  const accountVars = variables.filter(v => v.data_source === 'account_field' && v.account_field_name);
  const otherVars = variables.filter(v => v.data_source !== 'account_field');

  let otherValueSets: Array<{ values: Record<string, string>; configs: Record<string, VariableConfig> }> = [{ values: {}, configs: {} }];

  for (const varConfig of otherVars) {
    let values: string[] = [];

    switch (varConfig.data_source) {
      case 'checklist':
        if (varConfig.checklist_id) {
          const checklist = checklists.get(varConfig.checklist_id);
          values = checklist?.config?.values || [];
        }
        break;
      case 'security_rule':
        if (varConfig.security_rule_id) {
          const rule = securityRules.get(varConfig.security_rule_id);
          values = rule?.payloads || [];
        }
        break;
      default:
        if (varConfig.original_value) {
          values = [varConfig.original_value];
        }
    }

    if (values.length === 0) continue;

    const newSets: typeof otherValueSets = [];
    for (const set of otherValueSets) {
      for (const value of values) {
        newSets.push({
          values: { ...set.values, [varConfig.name]: value },
          configs: { ...set.configs, [varConfig.name]: varConfig },
        });
      }
    }
    otherValueSets = newSets;
  }

  if (accountVars.length === 0) {
    return otherValueSets.map(set => ({
      values: set.values,
      accountMap: {},
      victimIds: [],
      varConfigs: set.configs,
    }));
  }

  const combinations: ValueCombination[] = [];

  switch (strategy) {
    case 'independent': {
      let currentCombos: ValueCombination[] = otherValueSets.map(s => ({
        values: s.values,
        accountMap: {},
        victimIds: [],
        varConfigs: s.configs,
      }));

      for (const varConfig of accountVars) {
        const pool = variablePools?.get(varConfig.name) || accounts;
        const accountValues: Array<{ value: string; accountId: string }> = [];
        for (const account of pool) {
          const fieldValue = account.fields?.[varConfig.account_field_name!];
          if (fieldValue !== undefined && fieldValue !== null && fieldValue !== '') {
            accountValues.push({ value: String(fieldValue), accountId: account.id });
          }
        }

        if (accountValues.length === 0) continue;

        const newCombos: ValueCombination[] = [];
        for (const combo of currentCombos) {
          for (const av of accountValues) {
            const newAccountMap = { ...combo.accountMap, [varConfig.name]: av.accountId };
            newCombos.push({
              values: { ...combo.values, [varConfig.name]: av.value },
              accountMap: newAccountMap,
              victimIds: [...new Set(Object.values(newAccountMap) as string[])],
              varConfigs: { ...combo.varConfigs, [varConfig.name]: varConfig },
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
        const configs: Record<string, VariableConfig> = {};
        let hasAllVars = true;

        for (const varConfig of accountVars) {
          const fieldValue = account.fields?.[varConfig.account_field_name!];
          if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
            hasAllVars = false;
            break;
          }
          values[varConfig.name] = String(fieldValue);
          accountMap[varConfig.name] = account.id;
          configs[varConfig.name] = varConfig;
        }

        if (hasAllVars) {
          for (const otherSet of otherValueSets) {
            combinations.push({
              values: { ...otherSet.values, ...values },
              accountMap,
              victimIds: [account.id],
              varConfigs: { ...otherSet.configs, ...configs },
            });
          }
        }
      }
      break;
    }

    case 'anchor_attacker': {
      if (!attackerAccountId) {
        return generateAccountCombinations(variables, accounts, checklists, securityRules, 'independent', undefined, variablePools);
      }

      const attacker = accounts.find(a => a.id === attackerAccountId);
      if (!attacker) {
        return generateAccountCombinations(variables, accounts, checklists, securityRules, 'independent', undefined, variablePools);
      }

      const nonAttackerAccounts = accounts.filter(a => a.id !== attackerAccountId);
      const attackerVars = accountVars.filter(v => v.is_attacker_field || v.role === 'attacker');
      const victimVars = accountVars.filter(v => !v.is_attacker_field && v.role !== 'attacker');

      const attackerValues: Record<string, string> = {};
      const attackerMap: Record<string, string> = {};
      const attackerConfigs: Record<string, VariableConfig> = {};

      for (const varConfig of attackerVars) {
        const value = attacker.fields?.[varConfig.account_field_name!];
        if (value !== undefined && value !== null && value !== '') {
          attackerValues[varConfig.name] = String(value);
          attackerMap[varConfig.name] = attacker.id;
          attackerConfigs[varConfig.name] = varConfig;
        }
      }

      if (victimVars.length === 0) {
        for (const otherSet of otherValueSets) {
          combinations.push({
            values: { ...otherSet.values, ...attackerValues },
            accountMap: attackerMap,
            attackerId: attacker.id,
            victimIds: [],
            varConfigs: { ...otherSet.configs, ...attackerConfigs },
          });
        }
      } else {
        let victimCandidates: Account[] | null = null;
        for (const varConfig of victimVars) {
          const pool = variablePools?.get(varConfig.name) || nonAttackerAccounts;
          if (victimCandidates === null) {
            victimCandidates = [...pool] as Account[];
          } else {
            const poolIds = new Set(pool.map((a: any) => a.id));
            victimCandidates = victimCandidates.filter(a => poolIds.has(a.id));
          }
        }
        const victims = victimCandidates || nonAttackerAccounts;

        for (const victim of victims) {
          const victimValues: Record<string, string> = {};
          const victimMap: Record<string, string> = {};
          const victimConfigs: Record<string, VariableConfig> = {};
          let hasAllVictimVars = true;

          for (const varConfig of victimVars) {
            const value = victim.fields?.[varConfig.account_field_name!];
            if (value === undefined || value === null || value === '') {
              hasAllVictimVars = false;
              break;
            }
            victimValues[varConfig.name] = String(value);
            victimMap[varConfig.name] = victim.id;
            victimConfigs[varConfig.name] = varConfig;
          }

          if (hasAllVictimVars) {
            for (const otherSet of otherValueSets) {
              combinations.push({
                values: { ...otherSet.values, ...attackerValues, ...victimValues },
                accountMap: { ...attackerMap, ...victimMap },
                attackerId: attacker.id,
                victimIds: [victim.id],
                varConfigs: { ...otherSet.configs, ...attackerConfigs, ...victimConfigs },
              });
            }
          }
        }
      }
      break;
    }
  }

  return combinations.length > 0 ? combinations : [{ values: {}, accountMap: {}, victimIds: [], varConfigs: {} }];
}

