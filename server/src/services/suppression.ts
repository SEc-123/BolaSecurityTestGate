export interface SuppressionRule {
  id: string;
  name: string;
  is_enabled: boolean;
  applies_to: 'test_run' | 'workflow' | 'both';
  match_method: string;
  match_type: 'exact' | 'prefix' | 'regex' | 'contains';
  match_path?: string;
  match_service_id?: string;
  match_template_id?: string;
  match_workflow_id?: string;
  match_environment_id?: string;
}

export interface SuppressionCheckResult {
  suppressed: boolean;
  ruleId?: string;
  ruleName?: string;
}

export function matchSuppressionRuleForTemplate(
  rule: SuppressionRule,
  method: string,
  path: string,
  requestRaw: string,
  templateId: string,
  environmentId?: string
): boolean {
  if (rule.applies_to !== 'test_run' && rule.applies_to !== 'both') return false;
  if (rule.match_method && rule.match_method !== 'ANY' && rule.match_method !== method) return false;
  if (rule.match_template_id && rule.match_template_id !== templateId) return false;
  if (rule.match_environment_id) {
    if (!environmentId || rule.match_environment_id !== environmentId) return false;
  }
  if (rule.match_service_id && !requestRaw.includes(rule.match_service_id)) return false;

  if (rule.match_path) {
    switch (rule.match_type) {
      case 'exact':
        if (path !== rule.match_path) return false;
        break;
      case 'prefix':
        if (!path.startsWith(rule.match_path)) return false;
        break;
      case 'contains':
        if (!path.includes(rule.match_path)) return false;
        break;
      case 'regex':
        try {
          if (!new RegExp(rule.match_path).test(path)) return false;
        } catch {
          return false;
        }
        break;
    }
  }

  return true;
}

export function checkSuppressionRulesForTemplate(
  rules: SuppressionRule[],
  method: string,
  path: string,
  requestRaw: string,
  templateId: string,
  environmentId?: string
): SuppressionCheckResult {
  for (const rule of rules) {
    if (!rule.is_enabled) continue;
    if (matchSuppressionRuleForTemplate(rule, method, path, requestRaw, templateId, environmentId)) {
      return { suppressed: true, ruleId: rule.id, ruleName: rule.name };
    }
  }
  return { suppressed: false };
}

export interface StepExecutionForSuppression {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export function matchSuppressionRuleForWorkflow(
  rule: SuppressionRule,
  workflowId: string,
  stepExecutions: StepExecutionForSuppression[],
  environmentId?: string
): boolean {
  if (rule.applies_to !== 'workflow' && rule.applies_to !== 'both') return false;
  if (rule.match_workflow_id && rule.match_workflow_id !== workflowId) return false;
  if (rule.match_environment_id) {
    if (!environmentId || rule.match_environment_id !== environmentId) return false;
  }

  for (const step of stepExecutions) {
    if (rule.match_service_id) {
      const serviceIdInUrl = step.url.includes(rule.match_service_id);
      const serviceIdInHeaders = JSON.stringify(step.headers).includes(rule.match_service_id);
      if (!serviceIdInUrl && !serviceIdInHeaders) continue;
    }

    let methodMatches = !rule.match_method || rule.match_method === 'ANY' || rule.match_method === step.method;
    if (!methodMatches) continue;

    let pathMatches = true;
    if (rule.match_path) {
      let stepPath: string;
      try {
        const urlObj = new URL(step.url);
        stepPath = urlObj.pathname + urlObj.search;
      } catch {
        stepPath = step.url;
      }

      switch (rule.match_type) {
        case 'exact':
          pathMatches = stepPath === rule.match_path;
          break;
        case 'prefix':
          pathMatches = stepPath.startsWith(rule.match_path);
          break;
        case 'contains':
          pathMatches = stepPath.includes(rule.match_path);
          break;
        case 'regex':
          try {
            pathMatches = new RegExp(rule.match_path).test(stepPath);
          } catch {
            pathMatches = false;
          }
          break;
      }
    }

    if (methodMatches && pathMatches) {
      return true;
    }
  }

  return false;
}

export function checkSuppressionRulesForWorkflow(
  rules: SuppressionRule[],
  workflowId: string,
  workflowName: string,
  stepExecutions: StepExecutionForSuppression[],
  environmentId?: string
): SuppressionCheckResult {
  for (const rule of rules) {
    if (!rule.is_enabled) continue;
    if (matchSuppressionRuleForWorkflow(rule, workflowId, stepExecutions, environmentId)) {
      return { suppressed: true, ruleId: rule.id, ruleName: rule.name };
    }
  }
  return { suppressed: false };
}
