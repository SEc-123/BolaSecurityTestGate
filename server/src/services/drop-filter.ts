import type { FindingDropRule } from '../types/index.js';

export interface DropCheckResult {
  dropped: boolean;
  ruleId?: string;
  ruleName?: string;
}

export interface DropCheckContext {
  method: string;
  path: string;
  requestRaw: string;
  templateId?: string;
  workflowId?: string;
  sourceType: 'test_run' | 'workflow';
}

export function matchDropRule(rule: FindingDropRule, ctx: DropCheckContext): boolean {
  if (ctx.sourceType === 'test_run' && rule.applies_to !== 'test_run' && rule.applies_to !== 'both') {
    return false;
  }
  if (ctx.sourceType === 'workflow' && rule.applies_to !== 'workflow' && rule.applies_to !== 'both') {
    return false;
  }

  if (rule.match_method && rule.match_method !== 'ANY' && rule.match_method !== ctx.method) {
    return false;
  }

  if (rule.match_template_id) {
    if (!ctx.templateId || rule.match_template_id !== ctx.templateId) {
      return false;
    }
  }

  if (rule.match_workflow_id) {
    if (!ctx.workflowId || rule.match_workflow_id !== ctx.workflowId) {
      return false;
    }
  }

  if (rule.match_service_id && !ctx.requestRaw.includes(rule.match_service_id)) {
    return false;
  }

  if (rule.match_path) {
    switch (rule.match_type) {
      case 'exact':
        if (ctx.path !== rule.match_path) return false;
        break;
      case 'prefix':
        if (!ctx.path.startsWith(rule.match_path)) return false;
        break;
      case 'contains':
        if (!ctx.path.includes(rule.match_path)) return false;
        break;
      case 'regex':
        try {
          if (!new RegExp(rule.match_path).test(ctx.path)) return false;
        } catch {
          return false;
        }
        break;
    }
  }

  return true;
}

export function checkDropRules(
  rules: FindingDropRule[],
  ctx: DropCheckContext
): DropCheckResult {
  const enabledRules = rules
    .filter(r => r.is_enabled)
    .sort((a, b) => a.priority - b.priority);

  for (const rule of enabledRules) {
    if (matchDropRule(rule, ctx)) {
      return { dropped: true, ruleId: rule.id, ruleName: rule.name };
    }
  }

  return { dropped: false };
}

export function previewDropRule(
  rule: Partial<FindingDropRule>,
  ctx: DropCheckContext
): boolean {
  const fullRule: FindingDropRule = {
    id: 'preview',
    name: 'Preview',
    is_enabled: true,
    priority: 0,
    applies_to: rule.applies_to || 'both',
    match_method: rule.match_method || 'ANY',
    match_type: rule.match_type || 'contains',
    match_path: rule.match_path,
    match_service_id: rule.match_service_id,
    match_template_id: rule.match_template_id,
    match_workflow_id: rule.match_workflow_id,
    created_at: '',
    updated_at: '',
  };

  return matchDropRule(fullRule, ctx);
}
