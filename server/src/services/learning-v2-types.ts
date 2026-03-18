export type LearningSourceType = 'recording_only' | 'execution_only' | 'hybrid';

export interface SuggestionGraphNode {
  id: string;
  stepOrder: number;
  location: string;
  path: string;
  label: string;
  predictedType: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC' | 'NOISE';
  valuePreview?: string;
  source: 'recording' | 'execution' | 'hybrid';
  confidence: number;
}

export interface SuggestionGraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  variableName: string;
  confidence: number;
  reason: string;
  source: 'recording' | 'execution' | 'hybrid';
  evidenceCount: number;
  transformHint?: string;
}

export interface WorkflowVariableSuggestion {
  id: string;
  variableName: string;
  predictedType: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC';
  sourceStepOrder: number;
  sourceLocation: string;
  sourcePath: string;
  confidence: number;
  reason: string;
  writePolicySuggestion: 'first' | 'overwrite' | 'on_success_only';
  lockSuggestion: boolean;
  source: 'recording' | 'execution' | 'hybrid';
}

export interface MappingSuggestion {
  id: string;
  fromStepOrder: number;
  fromLocation: string;
  fromPath: string;
  toStepOrder: number;
  toLocation: string;
  toPath: string;
  variableName: string;
  transformHint?: string;
  confidence: number;
  evidenceCount: number;
  reason: string;
  predictedType: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC';
  source: 'recording' | 'execution' | 'hybrid';
  selectedByDefault?: boolean;
}

export interface ExtractorSuggestion {
  id: string;
  stepOrder: number;
  extractorType: 'json_path' | 'header' | 'cookie';
  sourceLocation: string;
  sourcePath: string;
  targetVariableName: string;
  confidence: number;
  reason: string;
  source: 'recording' | 'execution' | 'hybrid';
  required?: boolean;
}

export interface SessionJarSuggestion {
  cookieMode: boolean;
  headerKeys: string[];
  bodyJsonPaths: string[];
  confidence: number;
  reason: string;
  source: 'recording' | 'execution' | 'hybrid';
}

export interface AssertionSuggestion {
  id: string;
  stepOrder: number;
  type: 'status' | 'body_contains' | 'header_exists';
  config: Record<string, any>;
  confidence: number;
  reason: string;
  source: 'recording' | 'execution' | 'hybrid';
}

export interface LearningSuggestionPayload {
  workflowId: string;
  suggestionId?: string;
  learningVersion: number;
  sourceType: LearningSourceType;
  sourceRecordingSessionId?: string;
  sourceExecutionRunId?: string;
  stepSnapshots?: any[];
  graph: {
    nodes: SuggestionGraphNode[];
    edges: SuggestionGraphEdge[];
  };
  suggestions: {
    workflowVariables: WorkflowVariableSuggestion[];
    mappings: MappingSuggestion[];
    extractors: ExtractorSuggestion[];
    sessionJar: SessionJarSuggestion | null;
    assertions: AssertionSuggestion[];
  };
  conflicts: {
    mappings: Array<{ existingId?: string; variableName: string; reason: string }>;
    extractors: Array<{ existingId?: string; targetVariableName: string; reason: string }>;
    sessionJar?: { reason: string; existing?: Record<string, any> } | null;
  };
  summary: {
    nodeCount: number;
    edgeCount: number;
    variableSuggestionCount: number;
    mappingSuggestionCount: number;
    extractorSuggestionCount: number;
    assertionSuggestionCount: number;
  };
  evidence: Array<{
    fromStepOrder?: number;
    toStepOrder?: number;
    evidenceType: string;
    confidence: number;
    payload: Record<string, any>;
  }>;
  createdAt?: string;
}

export interface LearnV2Options {
  source: LearningSourceType;
  recordingSessionId?: string;
  accountId?: string;
  environmentId?: string;
  includeExtractors?: boolean;
  includeSessionJar?: boolean;
  includeAssertions?: boolean;
}
