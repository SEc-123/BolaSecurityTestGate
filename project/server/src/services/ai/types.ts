export type ProviderType = 'openai' | 'deepseek' | 'qwen' | 'llama' | 'openai_compat';

export type SeverityLevel = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AIProvider {
  id: string;
  name: string;
  provider_type: ProviderType;
  base_url?: string;
  api_key: string;
  model: string;
  is_enabled: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface AIVerdict {
  is_vulnerability: boolean;
  confidence: number;
  title: string;
  category: string;
  severity: SeverityLevel;
  risk_description: string;
  exploit_steps: string[];
  impact: string;
  mitigations: string[];
  false_positive_reason: string;
  key_signals: string[];
  evidence_citations: string[];
  evidence_excerpt?: {
    source_type: 'test_run' | 'workflow';
    template_or_workflow: string;
    baseline_summary: string;
    mutated_summary: string;
  };
}

export interface AIAnalysis {
  id: string;
  run_id: string;
  finding_id: string;
  provider_id: string;
  model: string;
  prompt_version: string;
  input_hash: string;
  result_json: AIVerdict;
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
    include_severities?: SeverityLevel[];
  };
  report_markdown: string;
  stats: {
    total_findings: number;
    vulnerabilities_found: number;
    severity_distribution: Record<SeverityLevel, number>;
  };
  created_at: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ConnectionTestResult {
  ok: boolean;
  latency_ms?: number;
  model?: string;
  error_message?: string;
}

export interface StandardizedFindingInput {
  finding_id: string;
  source_type: 'test_run' | 'workflow';
  template_or_workflow: string;
  method?: string;
  path?: string;
  host?: string;
  baseline?: {
    status: number;
    key_fields: Record<string, any>;
    body_excerpt: string;
  };
  mutated?: {
    status: number;
    key_fields: Record<string, any>;
    body_excerpt: string;
  };
  mutation?: {
    variable_name: string;
    original_value: any;
    mutated_value: any;
  };
  assertion_result?: string;
  evidence_signals: string[];
  workflow_steps?: Array<{
    step_index: number;
    status?: number;
    body_excerpt?: string;
    variant?: string;
  }>;
  extractors?: Record<string, any>;
}
