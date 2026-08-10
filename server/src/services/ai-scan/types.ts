export type AIScanStatus = 'created' | 'discovering' | 'awaiting_selection' | 'planning' | 'running' | 'completed' | 'failed';
export type AIScanTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'waiting_selection' | 'skipped';

export interface AIScanRun {
  id: string;
  name?: string;
  base_url: string;
  user_prompt?: string;
  language?: 'en' | 'zh';
  status: AIScanStatus;
  current_phase?: string;
  selected_vuln_types: string[];
  scan_config: Record<string, any>;
  summary: Record<string, any>;
  environment_id?: string;
  created_at: string;
  updated_at: string;
}

export interface AIScanTask {
  id: string;
  scan_run_id: string;
  parent_task_id?: string;
  title: string;
  task_type: string;
  vuln_type?: string;
  feature_id?: string;
  endpoint_ids: string[];
  status: AIScanTaskStatus;
  phase?: string;
  priority: number;
  dependencies: string[];
  agent_goal?: string;
  execution_plan: Record<string, any>;
  created_assets_json: Record<string, any>;
  result_summary?: string;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AIScanArtifact {
  id: string;
  scan_run_id: string;
  task_id?: string;
  artifact_type: string;
  title?: string;
  content_json: Record<string, any>;
  content_text?: string;
  source_ref?: string;
  created_at: string;
  updated_at: string;
}

export interface AIDiscoveredEndpoint {
  id: string;
  scan_run_id: string;
  method: string;
  path: string;
  url?: string;
  request_summary?: string;
  response_summary?: string;
  auth_required?: boolean;
  content_type?: string;
  feature_guess?: string;
  source_type?: string;
  source_id?: string;
  raw_event_id?: string;
  created_at: string;
  updated_at: string;
}

export interface AIFeatureNode {
  id: string;
  scan_run_id: string;
  parent_id?: string;
  name: string;
  node_type: string;
  description?: string;
  confidence: number;
  evidence_artifact_ids: string[];
  endpoint_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface AIVulnerabilityCandidate {
  id: string;
  scan_run_id: string;
  feature_id?: string;
  vuln_type: string;
  title: string;
  reason?: string;
  confidence: number;
  endpoint_ids: string[];
  required_accounts: string[];
  status: string;
  created_at: string;
  updated_at: string;
}


export interface AIScanSharedResource {
  id: string;
  scan_run_id: string;
  resource_type: string;
  resource_key: string;
  title?: string;
  content_json: Record<string, any>;
  owner_task_id?: string;
  usage_count: number;
  created_at: string;
  updated_at: string;
}


export type AIAgentMemoryScope = 'scan' | 'task' | 'identity' | 'feature' | 'endpoint';
export type AIAgentMemorySensitivity = 'public' | 'internal' | 'secret_ref';
export type AIAgentMemoryVisibility = 'full' | 'summary' | 'reference_only' | 'hidden';
export type AIAgentMemoryStatus = 'active' | 'superseded' | 'expired';

export interface AIAgentMemory {
  id: string;
  scan_run_id: string;
  owner_task_id?: string;
  memory_type: string;
  memory_key: string;
  scope_type: AIAgentMemoryScope;
  scope_ref: string;
  title?: string;
  summary?: string;
  content_json: Record<string, any>;
  sensitivity: AIAgentMemorySensitivity;
  llm_visibility: AIAgentMemoryVisibility;
  confidence: number;
  version: number;
  status: AIAgentMemoryStatus;
  ttl_seconds?: number;
  expires_at?: string;
  provenance_json: Record<string, any>;
  depends_on_json: string[];
  supersedes_id?: string;
  usage_count: number;
  last_used_at?: string;
  created_at: string;
  updated_at: string;
}

export type AIBrowserContextScope = 'scan' | 'task' | 'identity';
export type AIBrowserContextStatus = 'active' | 'closed' | 'expired' | 'failed';

export interface AIBrowserContextRecord {
  id: string;
  scan_run_id: string;
  task_id?: string;
  context_key: string;
  scope_type: AIBrowserContextScope;
  identity_key: string;
  status: AIBrowserContextStatus;
  storage_state_json: Record<string, any>;
  storage_state_present?: boolean;
  storage_cookie_count?: number;
  storage_origin_count?: number;
  current_url?: string;
  title?: string;
  dom_summary_json: Record<string, any>;
  network_summary_json: Record<string, any>;
  last_error?: string;
  ttl_seconds?: number;
  expires_at?: string;
  last_used_at?: string;
  created_at: string;
  updated_at: string;
}

export type AIPlannerValidationStatus = 'accepted' | 'rejected' | 'fallback' | 'local_only';

export interface AIPlannerDecisionRecord {
  id: string;
  scan_run_id: string;
  task_id: string;
  iteration: number;
  source: string;
  proposal_json: Record<string, any>;
  decision_json: Record<string, any>;
  policy_json: Record<string, any>;
  validation_status: AIPlannerValidationStatus;
  rejection_reason?: string;
  decision_signature?: string;
  created_at: string;
}

export type AIGeneratedAssetLifecycleStatus = 'ephemeral' | 'reusable' | 'promoted' | 'cleaned';

export interface AIGeneratedAsset {
  id: string;
  scan_run_id: string;
  task_id?: string;
  asset_type: string;
  asset_id: string;
  lifecycle_status: AIGeneratedAssetLifecycleStatus;
  retention_policy: string;
  generated_by: string;
  metadata_json: Record<string, any>;
  promoted_at?: string;
  cleaned_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AIToolInvocation {
  id: string;
  scan_run_id: string;
  task_id?: string;
  tool_name: string;
  input_json: Record<string, any>;
  output_json: Record<string, any>;
  contract_json: Record<string, any>;
  traffic_json: Record<string, any>;
  status: string;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AIScanSnapshot {
  run: AIScanRun;
  tasks: AIScanTask[];
  endpoints: AIDiscoveredEndpoint[];
  features: AIFeatureNode[];
  candidates: AIVulnerabilityCandidate[];
  artifacts: AIScanArtifact[];
  shared_resources: AIScanSharedResource[];
  agent_memories: AIAgentMemory[];
  browser_contexts: AIBrowserContextRecord[];
  planner_decisions: AIPlannerDecisionRecord[];
  generated_assets: AIGeneratedAsset[];
  tool_invocations: AIToolInvocation[];
}
