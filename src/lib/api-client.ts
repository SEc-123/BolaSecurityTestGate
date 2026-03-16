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
const RECORDING_API_KEY_STORAGE_KEY = 'bstg.recording.apiKey';
const RECORDING_ADMIN_KEY_STORAGE_KEY = 'bstg.recording.adminKey';

function getStoredValue(key: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function setStoredValue(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (value.trim()) {
      window.localStorage.setItem(key, value.trim());
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
  }
}

export function getRecordingApiKey(): string {
  return getStoredValue(RECORDING_API_KEY_STORAGE_KEY);
}

export function setRecordingApiKey(value: string): void {
  setStoredValue(RECORDING_API_KEY_STORAGE_KEY, value);
}

export function getRecordingAdminKey(): string {
  return getStoredValue(RECORDING_ADMIN_KEY_STORAGE_KEY);
}

export function setRecordingAdminKey(value: string): void {
  setStoredValue(RECORDING_ADMIN_KEY_STORAGE_KEY, value);
}

async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const recordingApiKey = getRecordingApiKey();
  const recordingAdminKey = getRecordingAdminKey();
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(recordingApiKey ? { 'X-API-Key': recordingApiKey } : {}),
      ...(recordingAdminKey ? { 'X-Recording-Admin-Key': recordingAdminKey } : {}),
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

  async listRecordingApplyLogs(accountId?: string, sessionId?: string): Promise<RecordingAccountApplyLog[]> {
    const params = new URLSearchParams();
    if (accountId) params.set('account_id', accountId);
    if (sessionId) params.set('session_id', sessionId);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return apiRequest<RecordingAccountApplyLog[]>(`/api/accounts/recording-apply-logs${suffix}`);
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
  checklist_ids: string[];
  security_rule_ids: string[];
  policy_id?: string;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type SecuritySuiteExecutionMode = 'template' | 'workflow';

export interface SecuritySuiteBundle {
  suite: SecuritySuite;
  environment: Environment | null;
  policy: CICDGatePolicy | null;
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

export interface RecordingFieldTarget {
  id: string;
  session_id: string;
  name: string;
  aliases: string[];
  from_sources: string[];
  bind_to_account_field?: string;
  category?: string;
  created_at: string;
  updated_at: string;
}

export interface RecordingSession {
  id: string;
  name: string;
  mode: 'workflow' | 'api';
  status: 'recording' | 'processing' | 'completed' | 'finished' | 'published' | 'failed';
  source_tool?: string;
  environment_id?: string;
  account_id?: string;
  role?: string;
  target_fields: RecordingFieldTarget[];
  event_count: number;
  field_hit_count: number;
  runtime_context_count: number;
  generated_result_count: number;
  published_result_count: number;
  summary?: Record<string, any>;
  started_at: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
}

export interface RecordingEvent {
  id: string;
  session_id: string;
  sequence: number;
  fingerprint: string;
  source_tool?: string;
  method: string;
  url: string;
  scheme?: string;
  host?: string;
  path: string;
  query_params: Record<string, string[]>;
  request_headers: Record<string, string>;
  request_body_text?: string;
  request_cookies: Record<string, string>;
  parsed_request_body?: Record<string, any> | null;
  response_status?: number;
  response_headers: Record<string, string>;
  response_body_text?: string;
  response_cookies: Record<string, string>;
  parsed_response_body?: Record<string, any> | null;
  field_hit_count: number;
  created_at: string;
  updated_at: string;
  field_hits?: RecordingFieldHit[];
  runtime_contexts?: RecordingRuntimeContext[];
}

export interface RecordingFieldHit {
  id: string;
  session_id: string;
  event_id: string;
  field_name: string;
  matched_alias?: string;
  source_location: string;
  source_key?: string;
  value_preview?: string;
  value_text?: string;
  value_hash?: string;
  bind_to_account_field?: string;
  confidence?: number;
  created_at: string;
  updated_at: string;
}

export interface RecordingRuntimeContext {
  id: string;
  session_id: string;
  event_id?: string;
  context_key: string;
  category: string;
  source_location?: string;
  value_preview?: string;
  value_text?: string;
  bind_to_account_field?: string;
  created_at: string;
  updated_at: string;
}

export interface RecordingAccountApplyChange {
  source_type: 'field_hit' | 'runtime_context';
  source_name: string;
  source_location?: string;
  source_key?: string;
  bind_to_account_field?: string;
  target_section: 'fields' | 'auth_profile' | 'variables';
  target_path: string;
  value_preview?: string;
  value_text?: string;
  confidence?: number;
}

export interface RecordingAccountApplyPreview {
  session_id: string;
  account_id: string;
  account_name: string;
  mode: 'session_only' | 'write_back';
  summary: Record<string, any>;
  changes: RecordingAccountApplyChange[];
  field_changes: RecordingAccountApplyChange[];
  auth_profile_changes: RecordingAccountApplyChange[];
  variable_changes: RecordingAccountApplyChange[];
  account_patch: {
    fields: Record<string, any>;
    auth_profile: Record<string, any>;
    variables: Record<string, any>;
  };
  session_overlay: {
    account_id: string;
    account_name: string;
    fields: Record<string, any>;
    auth_profile: Record<string, any>;
    variables: Record<string, any>;
  };
  target_snapshot: Record<string, any>;
}

export interface RecordingAccountApplyLog {
  id: string;
  session_id: string;
  account_id: string;
  mode: 'session_only' | 'write_back';
  persisted: boolean;
  applied_by?: string;
  target_snapshot?: Record<string, any>;
  field_changes?: RecordingAccountApplyChange[];
  auth_profile_changes?: RecordingAccountApplyChange[];
  variable_changes?: RecordingAccountApplyChange[];
  summary?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface RecordingAuditLog {
  id: string;
  session_id?: string;
  action: string;
  actor?: string;
  target_type?: string;
  target_id?: string;
  status: 'success' | 'failed';
  message?: string;
  details?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface RecordingDeadLetter {
  id: string;
  session_id?: string;
  failure_stage: string;
  status: 'pending' | 'replayed' | 'discarded';
  error_message: string;
  batch_size: number;
  retry_count: number;
  payload: Record<string, any>;
  last_retried_at?: string;
  resolved_at?: string;
  created_at: string;
  updated_at: string;
}

export interface RecordingOpsSummary {
  ingress: {
    api_key_required: boolean;
    max_batch_size: number;
    max_batches_per_minute: number;
    max_events_per_minute: number;
  };
  privilege: {
    admin_key_required: boolean;
    privileged_actions: string[];
  };
  metrics: {
    recording_sessions_created_total: number;
    recording_events_ingested_total: number;
    recording_event_deduplicated_total: number;
    recording_batches_failed_total: number;
    promotion_success_total: number;
    draft_generation_duration_ms_total: number;
    draft_generation_duration_ms_last: number;
    draft_generation_duration_ms_avg: number;
    draft_generation_duration_ms_max: number;
    draft_generation_runs_total: number;
  };
  totals: {
    audit_logs: number;
    dead_letters: number;
    pending_dead_letters: number;
    replayed_dead_letters: number;
    discarded_dead_letters: number;
  };
  audit_logs: RecordingAuditLog[];
  dead_letters: RecordingDeadLetter[];
}

export interface RecordingRolloutConfig {
  phase: 'hidden' | 'internal_plugin' | 'workflow_only' | 'api_publish' | 'formal';
  recording_center_visible: boolean;
  workflow_mode_enabled: boolean;
  api_mode_enabled: boolean;
  publish_enabled: boolean;
  allowed_account_ids: string[];
  notes: string;
}

export interface RecordingAccountApplyResult {
  mode: 'session_only' | 'write_back';
  persisted: boolean;
  account: Account;
  preview: RecordingAccountApplyPreview;
  log: RecordingAccountApplyLog;
}

export interface WorkflowDraftStep {
  id: string;
  workflow_draft_id: string;
  session_id: string;
  source_event_id: string;
  sequence: number;
  method: string;
  path: string;
  enabled: boolean;
  summary: Record<string, any>;
  request_template_payload: Record<string, any>;
  response_signature: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface RecordingExtractorCandidate {
  id: string;
  workflow_draft_id: string;
  workflow_draft_step_id?: string;
  session_id: string;
  source_event_id?: string;
  step_sequence?: number;
  name: string;
  source: string;
  expression: string;
  transform?: Record<string, any>;
  required: boolean;
  confidence: number;
  value_preview?: string;
  created_at: string;
  updated_at: string;
}

export interface RecordingVariableCandidate {
  id: string;
  workflow_draft_id: string;
  workflow_draft_step_id?: string;
  session_id: string;
  source_event_id?: string;
  name: string;
  data_source: string;
  source_location: string;
  json_path?: string;
  checklist_id?: string;
  security_rule_id?: string;
  account_field_name?: string;
  runtime_context_key?: string;
  step_variable_mappings: any[];
  advanced_config?: Record<string, any>;
  role?: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowDraft {
  id: string;
  session_id: string;
  name: string;
  status: 'generated' | 'published';
  summary: Record<string, any>;
  draft_payload: Record<string, any>;
  published_workflow_id?: string;
  created_at: string;
  updated_at: string;
  steps?: WorkflowDraftStep[];
  extractor_candidates?: RecordingExtractorCandidate[];
  variable_candidates?: RecordingVariableCandidate[];
}

export interface TestRunDraft {
  id: string;
  session_id: string;
  name: string;
  status: 'generated' | 'preconfigured' | 'published';
  sequence?: number;
  source_event_id?: string;
  summary: Record<string, any>;
  draft_payload: Record<string, any>;
  published_preset_id?: string;
  published_test_run_id?: string;
  created_at: string;
  updated_at: string;
}

export interface TestRunPreset {
  id: string;
  name: string;
  description?: string;
  source_draft_id?: string;
  template_id: string;
  environment_id?: string;
  default_account_id?: string;
  preset_config: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface DraftPublishLog {
  id: string;
  draft_type: 'workflow' | 'test_run';
  source_draft_id: string;
  source_recording_session_id?: string;
  target_asset_type: string;
  target_asset_id: string;
  published_by?: string;
  published_at?: string;
  created_at: string;
  updated_at: string;
}

export interface RecordingSessionDetail {
  session: RecordingSession;
  runtime_context_summary?: {
    values: Record<string, string>;
    cookies: Record<string, string>;
    headers: Record<string, string>;
  };
  account_linkage?: Record<string, any> | null;
  account_apply_logs?: RecordingAccountApplyLog[];
  targets: RecordingFieldTarget[];
  events: RecordingEvent[];
  field_hits: RecordingFieldHit[];
  runtime_contexts: RecordingRuntimeContext[];
  workflow_drafts: WorkflowDraft[];
  workflow_draft_steps: WorkflowDraftStep[];
  test_run_drafts: TestRunDraft[];
  test_run_presets: TestRunPreset[];
  draft_publish_logs: DraftPublishLog[];
  generated: {
    workflow_draft_count: number;
    test_run_draft_count: number;
    published_preset_count: number;
    published_template_count?: number;
    published_test_run_count?: number;
    promoted_asset_count?: number;
    step_map_size: number;
  };
}

export const securitySuitesService = {
  async list(): Promise<SecuritySuite[]> {
    return apiRequest<SecuritySuite[]>('/api/security-suites');
  },

  async getById(id: string): Promise<SecuritySuite> {
    return apiRequest<SecuritySuite>(`/api/security-suites/${id}`);
  },

  async getBundle(id: string): Promise<SecuritySuiteBundle> {
    return apiRequest<SecuritySuiteBundle>(`/api/security-suites/${id}/bundle`);
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

export const recordingsService = {
  async getRolloutConfig(): Promise<RecordingRolloutConfig> {
    return apiRequest<RecordingRolloutConfig>('/api/recordings/config');
  },

  async listSessions(): Promise<RecordingSession[]> {
    return apiRequest<RecordingSession[]>('/api/recordings/sessions');
  },

  async getOpsSummary(): Promise<RecordingOpsSummary> {
    return apiRequest<RecordingOpsSummary>('/api/recordings/ops/summary');
  },

  async listAuditLogs(params?: {
    session_id?: string;
    action?: string;
    status?: 'success' | 'failed';
    target_type?: string;
    limit?: number;
  }): Promise<RecordingAuditLog[]> {
    const search = new URLSearchParams();
    if (params?.session_id) search.set('session_id', params.session_id);
    if (params?.action) search.set('action', params.action);
    if (params?.status) search.set('status', params.status);
    if (params?.target_type) search.set('target_type', params.target_type);
    if (params?.limit) search.set('limit', String(params.limit));
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return apiRequest<RecordingAuditLog[]>(`/api/recordings/ops/audit-logs${suffix}`);
  },

  async listDeadLetters(params?: {
    session_id?: string;
    status?: 'pending' | 'replayed' | 'discarded';
    failure_stage?: string;
    limit?: number;
  }): Promise<RecordingDeadLetter[]> {
    const search = new URLSearchParams();
    if (params?.session_id) search.set('session_id', params.session_id);
    if (params?.status) search.set('status', params.status);
    if (params?.failure_stage) search.set('failure_stage', params.failure_stage);
    if (params?.limit) search.set('limit', String(params.limit));
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return apiRequest<RecordingDeadLetter[]>(`/api/recordings/ops/dead-letters${suffix}`);
  },

  async retryDeadLetter(id: string): Promise<{
    dead_letter: RecordingDeadLetter;
    result: Record<string, any>;
  }> {
    return apiRequest(`/api/recordings/ops/dead-letters/${id}/retry`, {
      method: 'POST',
    });
  },

  async discardDeadLetter(id: string, reason?: string): Promise<RecordingDeadLetter> {
    return apiRequest<RecordingDeadLetter>(`/api/recordings/ops/dead-letters/${id}/discard`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    });
  },

  async listPublishLogs(params?: {
    draft_type?: 'workflow' | 'test_run';
    source_draft_id?: string;
    source_recording_session_id?: string;
    target_asset_type?: string;
    target_asset_id?: string;
  }): Promise<DraftPublishLog[]> {
    const search = new URLSearchParams();
    if (params?.draft_type) search.set('draft_type', params.draft_type);
    if (params?.source_draft_id) search.set('source_draft_id', params.source_draft_id);
    if (params?.source_recording_session_id) {
      search.set('source_recording_session_id', params.source_recording_session_id);
    }
    if (params?.target_asset_type) search.set('target_asset_type', params.target_asset_type);
    if (params?.target_asset_id) search.set('target_asset_id', params.target_asset_id);
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return apiRequest<DraftPublishLog[]>(`/api/recordings/publish-logs${suffix}`);
  },

  async createSession(data: {
    name: string;
    mode: 'workflow' | 'api';
    source_tool?: string;
    environment_id?: string;
    account_id?: string;
    role?: string;
    target_fields?: Array<{
      name: string;
      aliases?: string[];
      from?: string[];
      from_sources?: string[];
      bind_to_account_field?: string;
      category?: string;
    }>;
  }): Promise<RecordingSession> {
    return apiRequest<RecordingSession>('/api/recordings/sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async getSession(id: string): Promise<RecordingSessionDetail> {
    return apiRequest<RecordingSessionDetail>(`/api/recordings/sessions/${id}`);
  },

  async getCandidates(id: string): Promise<Pick<RecordingSessionDetail, 'session' | 'targets' | 'field_hits' | 'runtime_contexts' | 'workflow_drafts' | 'test_run_drafts' | 'test_run_presets'>> {
    return apiRequest(`/api/recordings/sessions/${id}/candidates`);
  },

  async listTestRunDrafts(): Promise<TestRunDraft[]> {
    return apiRequest<TestRunDraft[]>('/api/recordings/test-run-drafts');
  },

  async getEvents(id: string, params?: { limit?: number; offset?: number }): Promise<{
    session: RecordingSession;
    events: RecordingEvent[];
    pagination: {
      total: number;
      limit: number;
      offset: number;
    };
  }> {
    const search = new URLSearchParams();
    if (params?.limit) search.set('limit', String(params.limit));
    if (params?.offset) search.set('offset', String(params.offset));
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return apiRequest(`/api/recordings/sessions/${id}/events${suffix}`);
  },

  async ingestBatch(id: string, events: Array<{
    sequence: number;
    source_tool?: string;
    sourceTool?: string;
    method: string;
    url: string;
    request_headers?: Record<string, unknown>;
    requestHeaders?: Record<string, unknown>;
    request_body_text?: string;
    requestBodyText?: string;
    response_status?: number;
    responseStatus?: number;
    response_headers?: Record<string, unknown>;
    responseHeaders?: Record<string, unknown>;
    response_body_text?: string;
    responseBodyText?: string;
  }>): Promise<{
    session: RecordingSession;
    inserted: number;
    skipped: number;
    accepted: number;
    deduplicated: number;
    field_hits_created: number;
    runtime_contexts_created: number;
    }> {
      return apiRequest(`/api/recordings/sessions/${id}/events/batch`, {
        method: 'POST',
        body: JSON.stringify({ events }),
      });
  },

  async finishSession(id: string): Promise<RecordingSessionDetail> {
    return apiRequest<RecordingSessionDetail>(`/api/recordings/sessions/${id}/finish`, {
      method: 'POST',
    });
  },

  async regenerate(id: string): Promise<RecordingSessionDetail> {
    return apiRequest<RecordingSessionDetail>(`/api/recordings/sessions/${id}/regenerate`, {
      method: 'POST',
    });
  },

  async getAccountPreview(id: string, params?: {
    account_id?: string;
    field_map?: Record<string, string>;
    mode?: 'session_only' | 'write_back';
  }): Promise<RecordingAccountApplyPreview> {
    const search = new URLSearchParams();
    if (params?.account_id) search.set('account_id', params.account_id);
    if (params?.mode) search.set('mode', params.mode);
    if (params?.field_map) search.set('field_map', JSON.stringify(params.field_map));
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return apiRequest<RecordingAccountApplyPreview>(`/api/recordings/sessions/${id}/account-preview${suffix}`);
  },

  async applyToAccount(id: string, data?: {
    account_id?: string;
    field_map?: Record<string, string>;
    mode?: 'session_only' | 'write_back';
    applied_by?: string;
  }): Promise<RecordingAccountApplyResult> {
    return apiRequest<RecordingAccountApplyResult>(`/api/recordings/sessions/${id}/apply-account`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
  },

  async exportRaw(id: string): Promise<any> {
    return apiRequest(`/api/recordings/sessions/${id}/export/raw`);
  },

  async updateWorkflowDraft(id: string, data: {
    name?: string;
    steps?: Array<{
      id: string;
      sequence?: number;
      enabled?: boolean;
      name?: string;
      description?: string;
    }>;
    extractor_candidates?: Array<{
      workflow_draft_step_id: string;
      name: string;
      source: string;
      expression: string;
      required?: boolean;
      transform?: Record<string, any>;
      value_preview?: string;
      confidence?: number;
    }>;
    variable_candidates?: Array<{
      workflow_draft_step_id: string;
      name: string;
      data_source: string;
      source_location: string;
      json_path?: string;
      checklist_id?: string;
      security_rule_id?: string;
      account_field_name?: string;
      runtime_context_key?: string;
      step_variable_mappings?: any[];
      advanced_config?: Record<string, any>;
      role?: string;
      confidence?: number;
    }>;
  }): Promise<RecordingSessionDetail> {
    return apiRequest<RecordingSessionDetail>(`/api/recordings/workflow-drafts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async publishWorkflowDraft(id: string, data?: {
    workflow_name?: string;
    published_by?: string;
  }): Promise<{
    workflow: Workflow;
    published_from_draft_id: string;
  }> {
    return apiRequest(`/api/recordings/workflow-drafts/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
  },

  async updateTestRunDraft(id: string, data: {
    name?: string;
    template?: {
      name?: string;
      description?: string;
      raw_request?: string;
      parsed_structure?: Record<string, any>;
      variables?: Array<Record<string, any>>;
      failure_patterns?: Array<Record<string, any>>;
      failure_logic?: 'OR' | 'AND';
      field_candidates?: Array<Record<string, any>>;
      assertion_candidates?: Array<Record<string, any>>;
      response_snapshot?: Record<string, any>;
    };
    preset?: {
      name?: string;
      description?: string;
      environment_id?: string;
      default_account_id?: string;
      preset_config?: Record<string, any>;
    };
  }): Promise<RecordingSessionDetail> {
    return apiRequest<RecordingSessionDetail>(`/api/recordings/test-run-drafts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async createApiTemplateFromTestRunDraft(id: string, data?: {
    template_name?: string;
    published_by?: string;
  }): Promise<{
    template: ApiTemplate;
    published_from_draft_id: string;
  }> {
    return apiRequest(`/api/recordings/test-run-drafts/${id}/template`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
  },

  async publishTestRunDraft(id: string, data?: {
    preset_name?: string;
    published_by?: string;
  }): Promise<{
    template: ApiTemplate;
    preset: TestRunPreset;
    published_from_draft_id: string;
  }> {
    return apiRequest(`/api/recordings/test-run-drafts/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
  },

  async promoteTestRunDraftToTestRun(id: string, data?: {
    test_run_name?: string;
    published_by?: string;
  }): Promise<{
    template: ApiTemplate | null;
    test_run: TestRun;
    published_from_draft_id: string;
    reused_existing?: boolean;
  }> {
    return apiRequest(`/api/recordings/test-run-drafts/${id}/test-run`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
  },
};

export const testRunPresetsService = {
  async list(): Promise<TestRunPreset[]> {
    return apiRequest<TestRunPreset[]>('/api/test-run-presets');
  },

  async getById(id: string): Promise<TestRunPreset> {
    return apiRequest<TestRunPreset>(`/api/test-run-presets/${id}`);
  },

  async update(id: string, updates: Partial<TestRunPreset>): Promise<TestRunPreset> {
    return apiRequest<TestRunPreset>(`/api/test-run-presets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest(`/api/test-run-presets/${id}`, { method: 'DELETE' });
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

  async executeSuite(params: {
    suite_id: string;
    execution_mode?: SecuritySuiteExecutionMode;
    workflow_id?: string;
    name?: string;
  }): Promise<{
    success: boolean;
    test_run_id: string;
    suite_id: string;
    suite_name: string;
    execution_mode: SecuritySuiteExecutionMode;
    workflow_id?: string;
    findings_count: number;
    errors_count: number;
    has_execution_error: boolean;
    warnings?: string[];
    error?: string;
  }> {
    return apiRequest('/api/run/suite', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  async executePreset(params: {
    preset_id: string;
    account_ids?: string[];
    environment_id?: string;
    name?: string;
  }): Promise<{
    success: boolean;
    test_run_id: string;
    preset_id: string;
    preset_name: string;
    findings_count: number;
    errors_count: number;
    has_execution_error: boolean;
    error?: string;
  }> {
    return apiRequest('/api/run/preset', {
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
  category: 'AUTH' | 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'NOISE';
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

  exportUrl(kind: 'workflow' | 'template', format: 'json' | 'txt' | 'raw'): string {
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
