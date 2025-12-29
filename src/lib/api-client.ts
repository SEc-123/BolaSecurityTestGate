import type {
  Environment,
  Account,
  ApiTemplate,
  SecurityRule,
  TestRun,
  Finding,
  FindingSuppressionRule,
  FindingDropRule,
  GovernanceSettings,
  Checklist,
  Workflow,
  WorkflowStep,
  WorkflowVariableConfig,
  WorkflowExtractor,
  VariableSearchMatch,
  VariableBulkUpdatePatch,
  CICDGatePolicy,
  SecurityRun,
  StepAssertion,
  AssertionsMode,
  DashboardSummary,
} from '../types';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || 'API request failed');
  }

  return result.data !== undefined ? result.data : result;
}

export const environmentsService = {
  async list(): Promise<Environment[]> {
    return apiRequest<Environment[]>('/api/environments');
  },

  async create(env: Omit<Environment, 'id' | 'created_at' | 'updated_at'>): Promise<Environment> {
    return apiRequest<Environment>('/api/environments', {
      method: 'POST',
      body: JSON.stringify(env),
    });
  },

  async update(id: string, updates: Partial<Environment>): Promise<Environment> {
    return apiRequest<Environment>(`/api/environments/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/environments/${id}`, { method: 'DELETE' });
  },
};

export const accountsService = {
  async list(): Promise<Account[]> {
    return apiRequest<Account[]>('/api/accounts');
  },

  async create(account: Omit<Account, 'id' | 'created_at' | 'updated_at'>): Promise<Account> {
    return apiRequest<Account>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(account),
    });
  },

  async update(id: string, updates: Partial<Account>): Promise<Account> {
    return apiRequest<Account>(`/api/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/accounts/${id}`, { method: 'DELETE' });
  },
};

export const apiTemplatesService = {
  async list(groupName?: string): Promise<ApiTemplate[]> {
    const params = groupName ? `?group_name=${encodeURIComponent(groupName)}` : '';
    return apiRequest<ApiTemplate[]>(`/api/api-templates${params}`);
  },

  async getById(id: string): Promise<ApiTemplate> {
    return apiRequest<ApiTemplate>(`/api/api-templates/${id}`);
  },

  async create(template: Omit<ApiTemplate, 'id' | 'created_at' | 'updated_at'>): Promise<ApiTemplate> {
    return apiRequest<ApiTemplate>('/api/api-templates', {
      method: 'POST',
      body: JSON.stringify(template),
    });
  },

  async update(id: string, updates: Partial<ApiTemplate>): Promise<ApiTemplate> {
    return apiRequest<ApiTemplate>(`/api/api-templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/api-templates/${id}`, { method: 'DELETE' });
  },
};

export const securityRulesService = {
  async list(): Promise<SecurityRule[]> {
    return apiRequest<SecurityRule[]>('/api/security-rules');
  },

  async getById(id: string): Promise<SecurityRule> {
    return apiRequest<SecurityRule>(`/api/security-rules/${id}`);
  },

  async create(rule: Omit<SecurityRule, 'id' | 'created_at' | 'updated_at'>): Promise<SecurityRule> {
    return apiRequest<SecurityRule>('/api/security-rules', {
      method: 'POST',
      body: JSON.stringify(rule),
    });
  },

  async update(id: string, updates: Partial<SecurityRule>): Promise<SecurityRule> {
    return apiRequest<SecurityRule>(`/api/security-rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/security-rules/${id}`, { method: 'DELETE' });
  },
};

export const testRunsService = {
  async list(): Promise<TestRun[]> {
    return apiRequest<TestRun[]>('/api/test-runs');
  },

  async getById(id: string): Promise<TestRun> {
    return apiRequest<TestRun>(`/api/test-runs/${id}`);
  },

  async create(run: Omit<TestRun, 'id' | 'created_at'>): Promise<TestRun> {
    return apiRequest<TestRun>('/api/test-runs', {
      method: 'POST',
      body: JSON.stringify(run),
    });
  },

  async update(id: string, updates: Partial<TestRun>): Promise<TestRun> {
    return apiRequest<TestRun>(`/api/test-runs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/test-runs/${id}`, { method: 'DELETE' });
  },
};

export const findingsService = {
  async list(testRunId?: string): Promise<Finding[]> {
    const params = testRunId ? `?test_run_id=${encodeURIComponent(testRunId)}` : '';
    return apiRequest<Finding[]>(`/api/findings${params}`);
  },

  async getById(id: string): Promise<Finding> {
    return apiRequest<Finding>(`/api/findings/${id}`);
  },

  async create(finding: Omit<Finding, 'id' | 'created_at' | 'updated_at'>): Promise<Finding> {
    return apiRequest<Finding>('/api/findings', {
      method: 'POST',
      body: JSON.stringify(finding),
    });
  },

  async update(id: string, updates: Partial<Finding>): Promise<Finding> {
    return apiRequest<Finding>(`/api/findings/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/findings/${id}`, { method: 'DELETE' });
  },
};

export const checklistsService = {
  async list(): Promise<Checklist[]> {
    return apiRequest<Checklist[]>('/api/checklists');
  },

  async getById(id: string): Promise<Checklist> {
    return apiRequest<Checklist>(`/api/checklists/${id}`);
  },

  async create(checklist: Omit<Checklist, 'id' | 'created_at' | 'updated_at'>): Promise<Checklist> {
    return apiRequest<Checklist>('/api/checklists', {
      method: 'POST',
      body: JSON.stringify(checklist),
    });
  },

  async update(id: string, updates: Partial<Checklist>): Promise<Checklist> {
    return apiRequest<Checklist>(`/api/checklists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/checklists/${id}`, { method: 'DELETE' });
  },
};

export const workflowsService = {
  async list(): Promise<Workflow[]> {
    return apiRequest<Workflow[]>('/api/workflows');
  },

  async getById(id: string): Promise<Workflow> {
    return apiRequest<Workflow>(`/api/workflows/${id}`);
  },

  async getWithDetails(id: string): Promise<Workflow> {
    return apiRequest<Workflow>(`/api/workflows/${id}/full`);
  },

  async create(workflow: Omit<Workflow, 'id' | 'created_at' | 'updated_at' | 'steps' | 'variable_configs'>): Promise<Workflow> {
    return apiRequest<Workflow>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify(workflow),
    });
  },

  async update(id: string, updates: Partial<Workflow>): Promise<Workflow> {
    const { steps, variable_configs, ...workflowUpdates } = updates;
    return apiRequest<Workflow>(`/api/workflows/${id}`, {
      method: 'PUT',
      body: JSON.stringify(workflowUpdates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/workflows/${id}`, { method: 'DELETE' });
  },

  async setSteps(workflowId: string, templateIds: string[]): Promise<WorkflowStep[]> {
    return apiRequest<WorkflowStep[]>(`/api/workflows/${workflowId}/steps`, {
      method: 'PUT',
      body: JSON.stringify({ template_ids: templateIds }),
    });
  },

  async getSteps(workflowId: string): Promise<WorkflowStep[]> {
    return apiRequest<WorkflowStep[]>(`/api/workflows/${workflowId}/steps`);
  },

  async setVariableConfigs(
    workflowId: string,
    configs: Omit<WorkflowVariableConfig, 'id' | 'workflow_id' | 'created_at'>[]
  ): Promise<WorkflowVariableConfig[]> {
    return apiRequest<WorkflowVariableConfig[]>(`/api/workflows/${workflowId}/variable-configs`, {
      method: 'PUT',
      body: JSON.stringify({ configs }),
    });
  },

  async getVariableConfigs(workflowId: string): Promise<WorkflowVariableConfig[]> {
    return apiRequest<WorkflowVariableConfig[]>(`/api/workflows/${workflowId}/variable-configs`);
  },

  async getExtractors(workflowId: string): Promise<WorkflowExtractor[]> {
    return apiRequest<WorkflowExtractor[]>(`/api/workflows/${workflowId}/extractors`);
  },

  async setExtractors(
    workflowId: string,
    extractors: Omit<WorkflowExtractor, 'id' | 'workflow_id' | 'created_at'>[]
  ): Promise<WorkflowExtractor[]> {
    return apiRequest<WorkflowExtractor[]>(`/api/workflows/${workflowId}/extractors`, {
      method: 'PUT',
      body: JSON.stringify({ extractors }),
    });
  },

  async updateStepAssertions(
    stepId: string,
    assertions: StepAssertion[],
    assertionsMode: AssertionsMode
  ): Promise<WorkflowStep[]> {
    return apiRequest<WorkflowStep[]>(`/api/workflow-steps/${stepId}/assertions`, {
      method: 'PUT',
      body: JSON.stringify({ assertions, assertions_mode: assertionsMode }),
    });
  },
};

export const templateVariableService = {
  async search(params: {
    search_type: 'jsonpath' | 'keyword' | 'header_key' | 'query_param';
    pattern: string;
    scopes: ('body' | 'header' | 'query' | 'path')[];
    match_mode: 'exact' | 'contains';
  }): Promise<{ matches: VariableSearchMatch[]; total_count: number }> {
    return apiRequest<{ matches: VariableSearchMatch[]; total_count: number }>('/api/template-variables/search', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  async bulkUpdate(params: {
    selected_matches: { template_id: string; variable_name: string; json_path?: string }[];
    patch: VariableBulkUpdatePatch;
    dry_run: boolean;
  }): Promise<{
    success: boolean;
    dry_run: boolean;
    affected_count: number;
    updated_templates: number;
    updates: any[];
    warnings?: any[];
  }> {
    return apiRequest('/api/template-variables/bulk-update', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },
};

export const suppressionRulesService = {
  async list(): Promise<FindingSuppressionRule[]> {
    return apiRequest<FindingSuppressionRule[]>('/api/suppression-rules');
  },

  async create(rule: Omit<FindingSuppressionRule, 'id' | 'created_at' | 'updated_at'>): Promise<FindingSuppressionRule> {
    return apiRequest<FindingSuppressionRule>('/api/suppression-rules', {
      method: 'POST',
      body: JSON.stringify(rule),
    });
  },

  async update(id: string, updates: Partial<FindingSuppressionRule>): Promise<FindingSuppressionRule> {
    return apiRequest<FindingSuppressionRule>(`/api/suppression-rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/suppression-rules/${id}`, { method: 'DELETE' });
  },
};

export const gatePoliciesService = {
  async list(): Promise<CICDGatePolicy[]> {
    return apiRequest<CICDGatePolicy[]>('/api/gate-policies');
  },

  async getById(id: string): Promise<CICDGatePolicy> {
    return apiRequest<CICDGatePolicy>(`/api/gate-policies/${id}`);
  },

  async create(policy: Omit<CICDGatePolicy, 'id' | 'created_at' | 'updated_at'>): Promise<CICDGatePolicy> {
    return apiRequest<CICDGatePolicy>('/api/gate-policies', {
      method: 'POST',
      body: JSON.stringify(policy),
    });
  },

  async update(id: string, updates: Partial<CICDGatePolicy>): Promise<CICDGatePolicy> {
    return apiRequest<CICDGatePolicy>(`/api/gate-policies/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/gate-policies/${id}`, { method: 'DELETE' });
  },
};

export interface SecuritySuite {
  id: string;
  name: string;
  description?: string;
  environment_id?: string;
  environment_name?: string;
  template_ids: string[];
  workflow_ids: string[];
  account_ids: string[];
  policy_id?: string;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export const securitySuitesService = {
  async list(): Promise<SecuritySuite[]> {
    return apiRequest<SecuritySuite[]>('/api/security-suites');
  },

  async getById(id: string): Promise<SecuritySuite> {
    return apiRequest<SecuritySuite>(`/api/security-suites/${id}`);
  },

  async create(suite: Omit<SecuritySuite, 'id' | 'created_at' | 'updated_at'>): Promise<SecuritySuite> {
    return apiRequest<SecuritySuite>('/api/security-suites', {
      method: 'POST',
      body: JSON.stringify(suite),
    });
  },

  async update(id: string, updates: Partial<SecuritySuite>): Promise<SecuritySuite> {
    return apiRequest<SecuritySuite>(`/api/security-suites/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/security-suites/${id}`, { method: 'DELETE' });
  },
};

export const securityRunsService = {
  async list(): Promise<SecurityRun[]> {
    return apiRequest<SecurityRun[]>('/api/security-runs');
  },

  async getById(id: string): Promise<SecurityRun> {
    return apiRequest<SecurityRun>(`/api/security-runs/${id}`);
  },

  async triggerSecurityRun(params: {
    policy_id?: string;
    template_ids?: string[];
    workflow_ids?: string[];
    account_ids?: string[];
    environment_id?: string;
    metadata?: Record<string, any>;
  }): Promise<{
    success: boolean;
    security_run_id: string;
    gate_result: 'PASS' | 'WARN' | 'BLOCK';
    exit_code: 0 | 2 | 3 | 4;
    test_findings_count: number;
    workflow_findings_count: number;
    gate_score: number;
    details?: Record<string, any>;
    errors?: string[];
  }> {
    return apiRequest('/api/run/gate', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/security-runs/${id}`, { method: 'DELETE' });
  },
};

export interface DbProfile {
  id: string;
  name: string;
  kind: 'sqlite' | 'postgres' | 'mysql' | 'supabase_postgres';
  config: {
    file?: string;
    url?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: boolean;
  };
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbStatus {
  activeProfileId: string;
  activeProfileName: string;
  kind: 'sqlite' | 'postgres' | 'mysql' | 'supabase_postgres';
  schemaVersion: string;
  connected: boolean;
  runningRunsCount: number;
}

export const dbAdminService = {
  async getStatus(): Promise<DbStatus> {
    return apiRequest<DbStatus>('/admin/db/status');
  },

  async listProfiles(): Promise<DbProfile[]> {
    return apiRequest<DbProfile[]>('/admin/db/profiles');
  },

  async createProfile(data: {
    name: string;
    kind: DbProfile['kind'];
    config: DbProfile['config'];
  }): Promise<DbProfile> {
    return apiRequest<DbProfile>('/admin/db/profiles', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateProfile(id: string, updates: Partial<DbProfile>): Promise<DbProfile> {
    return apiRequest<DbProfile>(`/admin/db/profiles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async deleteProfile(id: string): Promise<void> {
    await apiRequest(`/admin/db/profiles/${id}`, { method: 'DELETE' });
  },

  async testConnection(data: {
    kind: DbProfile['kind'];
    config: DbProfile['config'];
  }): Promise<{ success: boolean; error?: string }> {
    return apiRequest('/admin/db/test-connection', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async migrateProfile(profileId: string): Promise<{ success: boolean; error?: string; schemaVersion?: string }> {
    return apiRequest('/admin/db/migrate', {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId }),
    });
  },

  async switchProfile(profileId: string): Promise<{ success: boolean; error?: string }> {
    return apiRequest('/admin/db/switch', {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId }),
    });
  },

  async exportData(): Promise<Record<string, any[]>> {
    return apiRequest('/admin/db/export', { method: 'POST' });
  },

  async importData(
    data: Record<string, any[]>,
    targetProfileId?: string
  ): Promise<{ success: boolean; error?: string; counts?: Record<string, number> }> {
    return apiRequest('/admin/db/import', {
      method: 'POST',
      body: JSON.stringify({ data, target_profile_id: targetProfileId }),
    });
  },
};

export const executionService = {
  async executeTemplate(params: {
    test_run_id: string;
    template_ids: string[];
    account_ids?: string[];
    environment_id?: string;
    rule_ids?: string[];
  }): Promise<{
    success: boolean;
    test_run_id: string;
    findings_count: number;
    errors_count: number;
    has_execution_error: boolean;
    error?: string;
  }> {
    return apiRequest('/api/run/template', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  async executeWorkflow(params: {
    test_run_id: string;
    workflow_id: string;
    account_ids?: string[];
    environment_id?: string;
    security_run_id?: string;
  }): Promise<{
    success: boolean;
    test_run_id: string;
    findings_count: number;
    errors_count: number;
    has_execution_error: boolean;
    error?: string;
  }> {
    return apiRequest('/api/run/workflow', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },
};

export const dropRulesService = {
  async list(): Promise<FindingDropRule[]> {
    return apiRequest<FindingDropRule[]>('/api/drop-rules');
  },

  async create(rule: Omit<FindingDropRule, 'id' | 'created_at' | 'updated_at'>): Promise<FindingDropRule> {
    return apiRequest<FindingDropRule>('/api/drop-rules', {
      method: 'POST',
      body: JSON.stringify(rule),
    });
  },

  async update(id: string, updates: Partial<FindingDropRule>): Promise<FindingDropRule> {
    return apiRequest<FindingDropRule>(`/api/drop-rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/drop-rules/${id}`, { method: 'DELETE' });
  },

  async preview(params: {
    method: string;
    path: string;
    service_id?: string;
    template_id?: string;
    workflow_id?: string;
    source_type?: 'test_run' | 'workflow';
  }): Promise<{ dropped: boolean; ruleId?: string; ruleName?: string }> {
    return apiRequest('/api/drop-rules/preview', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },
};

export const governanceService = {
  async getSettings(): Promise<GovernanceSettings> {
    return apiRequest<GovernanceSettings>('/api/governance/settings');
  },

  async updateSettings(updates: Partial<GovernanceSettings>): Promise<GovernanceSettings> {
    return apiRequest<GovernanceSettings>('/api/governance/settings', {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async runCleanup(): Promise<{
    success: boolean;
    deleted_effective: number;
    deleted_suppressed_rule: number;
    deleted_suppressed_rate_limit: number;
    deleted_test_runs: number;
    vacuumed: boolean;
    duration_ms: number;
    error?: string;
  }> {
    return apiRequest('/api/governance/cleanup', {
      method: 'POST',
    });
  },
};

export interface DictionaryRule {
  id: string;
  scope: 'global' | 'project';
  scope_id?: string | null;
  pattern: string;
  category: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'NOISE';
  priority: number;
  is_enabled: boolean | number;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowVariable {
  id: string;
  workflow_id: string;
  name: string;
  type: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC';
  source: 'account_injected' | 'extracted' | 'manual';
  write_policy: 'first' | 'overwrite' | 'on_success_only';
  is_locked: boolean | number;
  description?: string | null;
  current_value?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowMapping {
  id: string;
  workflow_id: string;
  from_step_order: number;
  from_location: string;
  from_path: string;
  to_step_order: number;
  to_location: string;
  to_path: string;
  variable_name: string;
  confidence: number;
  reason: 'same_name' | 'same_value' | 'heuristic' | 'manual';
  is_enabled: boolean | number;
  created_at: string;
}

export interface MappingCandidate {
  fromStepOrder: number;
  fromLocation: string;
  fromPath: string;
  toStepOrder: number;
  toLocation: string;
  toPath: string;
  confidence: number;
  reason: 'same_name' | 'same_value' | 'heuristic' | 'manual';
  predictedType: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC';
  variableName: string;
  fromValuePreview: string;
}

export interface CandidateField {
  stepOrder: number;
  location: string;
  path: string;
  valuePreview: string;
  predictedType: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC' | 'NOISE';
  score: number;
  matchedRule?: string;
}

export interface StepSnapshot {
  stepOrder: number;
  templateId: string;
  templateName: string;
  request: {
    method: string;
    url: string;
    path?: string;
    headers: Record<string, string>;
    cookies: Record<string, string>;
    query: Record<string, string>;
    body: any;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    cookies: Record<string, string>;
    body: any;
  };
}

export interface LearningResult {
  workflowId: string;
  learningVersion: number;
  stepSnapshots: StepSnapshot[];
  candidateFields: Record<number, CandidateField[]>;
  requestFields: Record<number, { stepOrder: number; location: string; path: string; currentValue?: any }[]>;
  mappingCandidates: MappingCandidate[];
}

export interface MutationProfile {
  skip_steps?: number[];
  swap_account_at_steps?: Record<number, string>;
  lock_variables?: string[];
  reuse_tickets?: boolean;
  repeat_steps?: Record<number, number>;
}

export const dictionaryService = {
  async list(scope: 'global' | 'project' = 'global', scopeId?: string): Promise<DictionaryRule[]> {
    const params = new URLSearchParams({ scope });
    if (scopeId) params.append('scope_id', scopeId);
    return apiRequest<DictionaryRule[]>(`/api/dictionary?${params}`);
  },

  async create(rule: Omit<DictionaryRule, 'id' | 'created_at' | 'updated_at'>): Promise<DictionaryRule> {
    return apiRequest<DictionaryRule>('/api/dictionary', {
      method: 'POST',
      body: JSON.stringify(rule),
    });
  },

  async update(id: string, updates: Partial<DictionaryRule>): Promise<void> {
    await apiRequest(`/api/dictionary/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/dictionary/${id}`, { method: 'DELETE' });
  },
};

export const learningService = {
  async runLearning(workflowId: string, options?: { accountId?: string; environmentId?: string }): Promise<LearningResult> {
    return apiRequest<LearningResult>(`/api/workflows/${workflowId}/learn`, {
      method: 'POST',
      body: JSON.stringify(options || {}),
    });
  },

  async applyMappings(
    workflowId: string,
    params: {
      acceptedCandidates: MappingCandidate[];
      editedMappings?: Partial<WorkflowMapping>[];
      variables: Partial<WorkflowVariable>[];
      learningVersion: number;
    }
  ): Promise<{ success: boolean; variables: WorkflowVariable[]; mappings: WorkflowMapping[] }> {
    return apiRequest(`/api/workflows/${workflowId}/mappings/apply`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },
};

export const workflowVariablesService = {
  async list(workflowId: string): Promise<WorkflowVariable[]> {
    return apiRequest<WorkflowVariable[]>(`/api/workflows/${workflowId}/variables`);
  },

  async create(workflowId: string, variable: Omit<WorkflowVariable, 'id' | 'workflow_id' | 'created_at' | 'updated_at'>): Promise<WorkflowVariable> {
    return apiRequest<WorkflowVariable>(`/api/workflows/${workflowId}/variables`, {
      method: 'POST',
      body: JSON.stringify(variable),
    });
  },

  async update(workflowId: string, varId: string, updates: Partial<WorkflowVariable>): Promise<void> {
    await apiRequest(`/api/workflows/${workflowId}/variables/${varId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(workflowId: string, varId: string): Promise<void> {
    await apiRequest(`/api/workflows/${workflowId}/variables/${varId}`, { method: 'DELETE' });
  },
};

export const workflowMappingsService = {
  async list(workflowId: string): Promise<WorkflowMapping[]> {
    return apiRequest<WorkflowMapping[]>(`/api/workflows/${workflowId}/mappings`);
  },

  async create(workflowId: string, mapping: Omit<WorkflowMapping, 'id' | 'workflow_id' | 'created_at'>): Promise<WorkflowMapping> {
    return apiRequest<WorkflowMapping>(`/api/workflows/${workflowId}/mappings`, {
      method: 'POST',
      body: JSON.stringify(mapping),
    });
  },

  async update(workflowId: string, mappingId: string, updates: Partial<WorkflowMapping>): Promise<void> {
    await apiRequest(`/api/workflows/${workflowId}/mappings/${mappingId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(workflowId: string, mappingId: string): Promise<void> {
    await apiRequest(`/api/workflows/${workflowId}/mappings/${mappingId}`, { method: 'DELETE' });
  },
};

export const mutationsService = {
  async list(baselineId: string): Promise<(Workflow & { mutation_profile: MutationProfile })[]> {
    return apiRequest(`/api/workflows/${baselineId}/mutations`);
  },

  async create(baselineId: string, params: {
    name?: string;
    description?: string;
    mutation_profile: MutationProfile;
  }): Promise<Workflow & { mutation_profile: MutationProfile }> {
    return apiRequest(`/api/workflows/${baselineId}/mutations`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  async update(mutationId: string, params: {
    name?: string;
    description?: string;
    mutation_profile?: MutationProfile;
  }): Promise<void> {
    await apiRequest(`/api/mutations/${mutationId}`, {
      method: 'PUT',
      body: JSON.stringify(params),
    });
  },
};

export const dashboardService = {
  async summary(): Promise<DashboardSummary> {
    return apiRequest<DashboardSummary>('/api/dashboard/summary');
  },
};

export interface DebugRequestRecord {
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  truncated_body?: boolean;
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: string;
    truncated_body?: boolean;
  };
  error?: string;
  duration_ms: number;
  retry_attempt: number;
  meta?: {
    step_order?: number;
    step_id?: string;
    template_id?: string;
    template_name?: string;
    label?: string;
  };
}

export interface DebugTrace {
  run_meta: {
    kind: 'workflow' | 'template';
    run_id: string;
    test_run_id?: string;
    git_sha?: string;
    started_at: string;
    finished_at?: string;
  };
  summary: {
    total_requests: number;
    errors_count: number;
    total_duration_ms: number;
    max_concurrency?: number;
  };
  records: DebugRequestRecord[];
  truncated?: boolean;
}

export const debugService = {
  async getLast(kind: 'workflow' | 'template'): Promise<DebugTrace | null> {
    try {
      const result = await apiRequest<DebugTrace>(`/api/debug/last/${kind}`);
      return result;
    } catch (error: any) {
      if (error.message?.includes('No trace found')) {
        return null;
      }
      throw error;
    }
  },

  async clear(kind: 'workflow' | 'template'): Promise<void> {
    await apiRequest(`/api/debug/last/${kind}`, { method: 'DELETE' });
  },

  exportUrl(kind: 'workflow' | 'template', format: 'json' | 'txt'): string {
    return `${API_BASE_URL}/api/debug/last/${kind}/export?format=${format}`;
  },
};

export interface AIProvider {
  id: string;
  name: string;
  provider_type: 'openai' | 'deepseek' | 'qwen' | 'llama' | 'openai_compat';
  base_url?: string;
  model: string;
  is_enabled: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface AIVerdictV2 {
  is_vulnerability: boolean;
  confidence: number;
  title: string;
  category: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  risk_description: string;
  exploit_steps: string[];
  impact: string;
  mitigations: string[];
  false_positive_reason?: string;
  key_signals: string[];
  evidence_citations: string[];
}

export interface AIVerdictV1 {
  is_vulnerability: boolean;
  confidence: number;
  title: string;
  category: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  risk_description: string;
  exploit_steps: string[];
  impact: string;
  mitigations: string[];
  false_positive_reason?: string;
  key_signals: string[];
  evidence_excerpt: {
    source_type: 'test_run' | 'workflow';
    template_or_workflow: string;
    baseline_summary: string;
    mutated_summary: string;
  };
}

export type AIVerdict = AIVerdictV2 | AIVerdictV1;

export interface AnalysisError {
  error: string;
}

export interface AnalysisSkipped {
  skipped: boolean;
  reason: string;
}

export type AnalysisResult = AIVerdict | AnalysisError | AnalysisSkipped;

export interface AIAnalysis {
  id: string;
  run_id: string;
  finding_id: string;
  provider_id: string;
  model: string;
  prompt_version: string;
  input_hash: string;
  result_json: AnalysisResult;
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  created_at: string;
}

export interface AIReport {
  id: string;
  run_id: string;
  provider_id: string;
  model: string;
  prompt_version: string;
  filters: {
    min_confidence?: number;
    include_severities?: string[];
  };
  report_markdown: string;
  stats: {
    total_findings: number;
    vulnerabilities_found: number;
    severity_distribution: Record<string, number>;
  };
  created_at: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  latency_ms?: number;
  model?: string;
  error_message?: string;
}

export interface AnalyzeRunOptions {
  only_unsuppressed?: boolean;
  max_findings?: number;
  prompt_max_body_chars_test_run?: number;
  prompt_max_body_chars_workflow_step?: number;
  prompt_max_headers_chars_test_run?: number;
  prompt_max_headers_chars_workflow_step?: number;
  require_baseline?: boolean;
  include_all_steps?: boolean;
  key_steps_only?: boolean;
  max_steps?: number;
  redaction_enabled?: boolean;
}

export interface AnalyzeRunResult {
  completed: number;
  failed: number;
  skipped: number;
  message?: string;
}

export const aiService = {
  async listProviders(): Promise<AIProvider[]> {
    return apiRequest<AIProvider[]>('/api/ai/providers');
  },

  async getProvider(id: string): Promise<AIProvider> {
    return apiRequest<AIProvider>(`/api/ai/providers/${id}`);
  },

  async createProvider(provider: Omit<AIProvider, 'id' | 'created_at' | 'updated_at'>): Promise<AIProvider> {
    return apiRequest<AIProvider>('/api/ai/providers', {
      method: 'POST',
      body: JSON.stringify(provider),
    });
  },

  async updateProvider(id: string, updates: Partial<AIProvider>): Promise<AIProvider> {
    return apiRequest<AIProvider>(`/api/ai/providers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async deleteProvider(id: string): Promise<void> {
    await apiRequest(`/api/ai/providers/${id}`, { method: 'DELETE' });
  },

  async testConnection(id: string): Promise<ConnectionTestResult> {
    return apiRequest<ConnectionTestResult>(`/api/ai/providers/${id}/test`, {
      method: 'POST',
    });
  },

  async analyzeRun(runId: string, providerId: string, options?: AnalyzeRunOptions): Promise<AnalyzeRunResult> {
    return apiRequest<AnalyzeRunResult>('/api/ai/analyze-run', {
      method: 'POST',
      body: JSON.stringify({
        run_id: runId,
        provider_id: providerId,
        options,
      }),
    });
  },

  async listAnalyses(runId?: string, findingId?: string): Promise<AIAnalysis[]> {
    const params = new URLSearchParams();
    if (runId) params.append('run_id', runId);
    if (findingId) params.append('finding_id', findingId);
    const query = params.toString() ? `?${params.toString()}` : '';
    return apiRequest<AIAnalysis[]>(`/api/ai/analyses${query}`);
  },

  async generateReport(
    runId: string,
    providerId: string,
    filters?: { min_confidence?: number; include_severities?: string[] }
  ): Promise<AIReport> {
    return apiRequest<AIReport>('/api/ai/generate-report', {
      method: 'POST',
      body: JSON.stringify({
        run_id: runId,
        provider_id: providerId,
        filters,
      }),
    });
  },

  async listReports(runId?: string): Promise<AIReport[]> {
    const query = runId ? `?run_id=${runId}` : '';
    return apiRequest<AIReport[]>(`/api/ai/reports${query}`);
  },

  exportReportUrl(reportId: string, format: 'md' = 'md'): string {
    return `${API_BASE_URL}/api/ai/reports/${reportId}/export?format=${format}`;
  },
};
