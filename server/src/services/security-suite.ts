import type {
  Account,
  ApiTemplate,
  Checklist,
  CicdGatePolicy,
  DbProvider,
  Environment,
  SecurityRule,
  SecuritySuite,
  Workflow,
  WorkflowVariableConfig,
} from '../types/index.js';

export type SecuritySuiteExecutionMode = 'template' | 'workflow';

export interface SecuritySuiteBundle {
  suite: SecuritySuite;
  environment: Environment | null;
  policy: CicdGatePolicy | null;
  templates: ApiTemplate[];
  workflows: Workflow[];
  accounts: Account[];
  checklists: Checklist[];
  security_rules: SecurityRule[];
  summary: {
    template_count: number;
    workflow_count: number;
    account_count: number;
    checklist_count: number;
    security_rule_count: number;
    available_execution_modes: SecuritySuiteExecutionMode[];
  };
  warnings: string[];
}

export interface SecuritySuiteLaunchConfig {
  suite: SecuritySuite;
  environment: Environment | null;
  execution_mode: SecuritySuiteExecutionMode;
  template_ids: string[];
  workflow_ids: string[];
  workflow_id?: string;
  account_ids: string[];
  checklist_ids: string[];
  security_rule_ids: string[];
  warnings: string[];
}

function normalizeIdList(value: unknown): string[] {
  if (!value) return [];

  if (Array.isArray(value)) {
    return Array.from(new Set(value.map(item => String(item).trim()).filter(Boolean)));
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return normalizeIdList(parsed);
      }
    } catch {
    }

    return Array.from(new Set(value.split(',').map(item => item.trim()).filter(Boolean)));
  }

  return [];
}

async function ensureRecordsExist(repo: any, ids: string[], label: string): Promise<void> {
  for (const id of ids) {
    const item = await repo.findById(id);
    if (!item) {
      throw new Error(`Selected ${label} not found: ${id}`);
    }
  }
}

function collectVariableSourceIds(
  configs: Array<{ data_source?: string; checklist_id?: string; security_rule_id?: string }>,
  checklistIds: Set<string>,
  securityRuleIds: Set<string>
): void {
  for (const config of configs) {
    if (config.data_source === 'checklist' && config.checklist_id) {
      checklistIds.add(config.checklist_id);
    }
    if (config.data_source === 'security_rule' && config.security_rule_id) {
      securityRuleIds.add(config.security_rule_id);
    }
  }
}

async function resolveSuiteEnvironment(db: DbProvider, suite: SecuritySuite): Promise<Environment | null> {
  if (suite.environment_id) {
    const byId = await db.repos.environments.findById(suite.environment_id);
    if (byId) {
      return byId;
    }
  }

  if (suite.environment_name) {
    const byName = await db.repos.environments.findAll({
      where: { name: suite.environment_name } as any,
      limit: 1,
    });
    return byName[0] || null;
  }

  return null;
}

async function collectSuiteAssets(
  db: DbProvider,
  suite: SecuritySuite
): Promise<{
  environment: Environment | null;
  policy: CicdGatePolicy | null;
  templates: ApiTemplate[];
  workflows: Workflow[];
  accounts: Account[];
  checklists: Checklist[];
  securityRules: SecurityRule[];
  warnings: string[];
}> {
  const warnings: string[] = [];

  const environment = await resolveSuiteEnvironment(db, suite);
  if ((suite.environment_id || suite.environment_name) && !environment) {
    warnings.push(`Configured environment is missing: ${suite.environment_id || suite.environment_name}`);
  }

  let policy: CicdGatePolicy | null = null;
  if (suite.policy_id) {
    policy = await db.repos.cicdGatePolicies.findById(suite.policy_id);
    if (!policy) {
      warnings.push(`Configured gate policy is missing: ${suite.policy_id}`);
    }
  }

  const templateIds = normalizeIdList(suite.template_ids);
  const workflowIds = normalizeIdList(suite.workflow_ids);
  const accountIds = normalizeIdList(suite.account_ids);
  const checklistIds = normalizeIdList(suite.checklist_ids);
  const securityRuleIds = normalizeIdList(suite.security_rule_ids);

  const templates = (await Promise.all(templateIds.map(id => db.repos.apiTemplates.findById(id))))
    .filter(Boolean) as ApiTemplate[];
  const missingTemplateIds = templateIds.filter(id => !templates.some(template => template.id === id));
  if (missingTemplateIds.length > 0) {
    warnings.push(`Missing API templates: ${missingTemplateIds.join(', ')}`);
  }

  const workflows = (await Promise.all(workflowIds.map(id => db.repos.workflows.findById(id))))
    .filter(Boolean) as Workflow[];
  const missingWorkflowIds = workflowIds.filter(id => !workflows.some(workflow => workflow.id === id));
  if (missingWorkflowIds.length > 0) {
    warnings.push(`Missing workflows: ${missingWorkflowIds.join(', ')}`);
  }

  const accounts = (await Promise.all(accountIds.map(id => db.repos.accounts.findById(id))))
    .filter(Boolean) as Account[];
  const missingAccountIds = accountIds.filter(id => !accounts.some(account => account.id === id));
  if (missingAccountIds.length > 0) {
    warnings.push(`Missing test accounts: ${missingAccountIds.join(', ')}`);
  }

  const checklists = (await Promise.all(checklistIds.map(id => db.repos.checklists.findById(id))))
    .filter(Boolean) as Checklist[];
  const missingChecklistIds = checklistIds.filter(id => !checklists.some(checklist => checklist.id === id));
  if (missingChecklistIds.length > 0) {
    warnings.push(`Missing checklists: ${missingChecklistIds.join(', ')}`);
  }

  const securityRules = (await Promise.all(securityRuleIds.map(id => db.repos.securityRules.findById(id))))
    .filter(Boolean) as SecurityRule[];
  const missingSecurityRuleIds = securityRuleIds.filter(id => !securityRules.some(rule => rule.id === id));
  if (missingSecurityRuleIds.length > 0) {
    warnings.push(`Missing security rules: ${missingSecurityRuleIds.join(', ')}`);
  }

  const inactiveTemplateNames = templates.filter(template => !template.is_active).map(template => template.name);
  if (inactiveTemplateNames.length > 0) {
    warnings.push(`Inactive API templates: ${inactiveTemplateNames.join(', ')}`);
  }

  const inactiveWorkflowNames = workflows.filter(workflow => workflow.is_active === false).map(workflow => workflow.name);
  if (inactiveWorkflowNames.length > 0) {
    warnings.push(`Inactive workflows: ${inactiveWorkflowNames.join(', ')}`);
  }

  return {
    environment,
    policy,
    templates,
    workflows,
    accounts,
    checklists,
    securityRules,
    warnings,
  };
}

export async function normalizeSecuritySuiteData(
  db: DbProvider,
  existingId: string | undefined,
  data: any
): Promise<any> {
  const existing = existingId ? await db.repos.securitySuites.findById(existingId) : null;
  const merged = existing ? { ...existing, ...data } : { ...data };

  const templateIds = normalizeIdList(merged.template_ids);
  const workflowIds = normalizeIdList(merged.workflow_ids);
  const accountIds = normalizeIdList(merged.account_ids);
  const checklistIds = new Set(normalizeIdList(merged.checklist_ids));
  const securityRuleIds = new Set(normalizeIdList(merged.security_rule_ids));

  if (merged.environment_id) {
    const environment = await db.repos.environments.findById(merged.environment_id);
    if (!environment) {
      throw new Error(`Selected environment not found: ${merged.environment_id}`);
    }
  }

  if (merged.policy_id) {
    const policy = await db.repos.cicdGatePolicies.findById(merged.policy_id);
    if (!policy) {
      throw new Error(`Selected gate policy not found: ${merged.policy_id}`);
    }
  }

  await ensureRecordsExist(db.repos.accounts, accountIds, 'account');
  await ensureRecordsExist(db.repos.checklists, Array.from(checklistIds), 'checklist');
  await ensureRecordsExist(db.repos.securityRules, Array.from(securityRuleIds), 'security rule');

  for (const templateId of templateIds) {
    const template = await db.repos.apiTemplates.findById(templateId);
    if (!template) {
      throw new Error(`Selected API template not found: ${templateId}`);
    }
    collectVariableSourceIds(Array.isArray(template.variables) ? template.variables : [], checklistIds, securityRuleIds);
  }

  for (const workflowId of workflowIds) {
    const workflow = await db.repos.workflows.findById(workflowId);
    if (!workflow) {
      throw new Error(`Selected workflow not found: ${workflowId}`);
    }

    const variableConfigs = await db.repos.workflowVariableConfigs.findAll({
      where: { workflow_id: workflowId } as Partial<WorkflowVariableConfig>,
    });
    collectVariableSourceIds(variableConfigs || [], checklistIds, securityRuleIds);
  }

  await ensureRecordsExist(db.repos.checklists, Array.from(checklistIds), 'checklist');
  await ensureRecordsExist(db.repos.securityRules, Array.from(securityRuleIds), 'security rule');

  return {
    ...merged,
    template_ids: templateIds,
    workflow_ids: workflowIds,
    account_ids: accountIds,
    checklist_ids: Array.from(checklistIds),
    security_rule_ids: Array.from(securityRuleIds),
  };
}

export async function getSecuritySuiteBundle(db: DbProvider, suiteId: string): Promise<SecuritySuiteBundle> {
  const suite = await db.repos.securitySuites.findById(suiteId);
  if (!suite) {
    throw new Error(`Security suite not found: ${suiteId}`);
  }

  const {
    environment,
    policy,
    templates,
    workflows,
    accounts,
    checklists,
    securityRules,
    warnings,
  } = await collectSuiteAssets(db, suite);

  const availableExecutionModes: SecuritySuiteExecutionMode[] = [];
  if (templates.length > 0) {
    availableExecutionModes.push('template');
  }
  if (workflows.length > 0) {
    availableExecutionModes.push('workflow');
  }

  return {
    suite,
    environment,
    policy,
    templates,
    workflows,
    accounts,
    checklists,
    security_rules: securityRules,
    summary: {
      template_count: templates.length,
      workflow_count: workflows.length,
      account_count: accounts.length,
      checklist_count: checklists.length,
      security_rule_count: securityRules.length,
      available_execution_modes: availableExecutionModes,
    },
    warnings,
  };
}

export async function getSecuritySuiteLaunchConfig(
  db: DbProvider,
  suiteId: string,
  requestedMode?: SecuritySuiteExecutionMode,
  requestedWorkflowId?: string
): Promise<SecuritySuiteLaunchConfig> {
  const bundle = await getSecuritySuiteBundle(db, suiteId);
  const blockingWarnings = bundle.warnings.filter(warning =>
    warning.startsWith('Configured environment is missing') ||
    warning.startsWith('Missing API templates') ||
    warning.startsWith('Missing workflows') ||
    warning.startsWith('Missing test accounts') ||
    warning.startsWith('Missing checklists') ||
    warning.startsWith('Missing security rules')
  );

  if (blockingWarnings.length > 0) {
    throw new Error(`Security suite "${bundle.suite.name}" is incomplete: ${blockingWarnings.join('; ')}`);
  }

  if (bundle.summary.available_execution_modes.length === 0) {
    throw new Error(`Security suite "${bundle.suite.name}" has no reusable templates or workflows`);
  }

  const executionMode = requestedMode || bundle.summary.available_execution_modes[0];

  if (executionMode === 'template') {
    if (bundle.templates.length === 0) {
      throw new Error(`Security suite "${bundle.suite.name}" has no active API templates to execute`);
    }
    if (bundle.warnings.some(warning => warning.startsWith('Inactive API templates'))) {
      throw new Error(`Security suite "${bundle.suite.name}" contains inactive API templates and cannot launch in template mode`);
    }
  }

  let workflowId: string | undefined;
  if (executionMode === 'workflow') {
    if (bundle.workflows.length === 0) {
      throw new Error(`Security suite "${bundle.suite.name}" has no workflows to execute`);
    }
    if (bundle.warnings.some(warning => warning.startsWith('Inactive workflows'))) {
      throw new Error(`Security suite "${bundle.suite.name}" contains inactive workflows and cannot launch in workflow mode`);
    }

    workflowId = requestedWorkflowId;
    if (!workflowId && bundle.workflows.length === 1) {
      workflowId = bundle.workflows[0].id;
    }

    if (!workflowId) {
      throw new Error(`Security suite "${bundle.suite.name}" contains multiple workflows; workflow_id is required`);
    }

    if (!bundle.workflows.some(workflow => workflow.id === workflowId)) {
      throw new Error(`Workflow ${workflowId} is not part of security suite "${bundle.suite.name}"`);
    }
  }

  return {
    suite: bundle.suite,
    environment: bundle.environment,
    execution_mode: executionMode,
    template_ids: bundle.templates.map(template => template.id),
    workflow_ids: bundle.workflows.map(workflow => workflow.id),
    workflow_id: workflowId,
    account_ids: bundle.accounts.map(account => account.id),
    checklist_ids: bundle.checklists.map(checklist => checklist.id),
    security_rule_ids: bundle.security_rules.map(rule => rule.id),
    warnings: bundle.warnings,
  };
}
