export type AIScanStatus = 'created' | 'discovering' | 'awaiting_selection' | 'planning' | 'running' | 'completed' | 'failed';
export type AIScanTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'waiting_selection' | 'skipped';

export interface AIScanRun {
  id: string;
  name?: string;
  base_url: string;
  user_prompt?: string;
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

export interface AIToolInvocation {
  id: string;
  scan_run_id: string;
  task_id?: string;
  tool_name: string;
  input_json: Record<string, any>;
  output_json: Record<string, any>;
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
  tool_invocations: AIToolInvocation[];
}
