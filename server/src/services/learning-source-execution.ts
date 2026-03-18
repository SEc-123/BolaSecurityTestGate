import { LearningEngine, type StepSnapshot } from './learning-engine.js';
import { conflictWithExistingSessionJar, detectSessionJarSuggestion } from './learning-session-jar-detector.js';
import { inferWritePolicy } from './learning-field-classifier.js';
import type { LearningSuggestionPayload } from './learning-v2-types.js';

export async function buildExecutionLearningSuggestions(db: any, workflowId: string, stepSnapshots: StepSnapshot[], options?: { includeExtractors?: boolean; includeSessionJar?: boolean; includeAssertions?: boolean }): Promise<LearningSuggestionPayload> {
  const engine = new LearningEngine(db);
  const result = await engine.learn(workflowId, stepSnapshots);
  const responseNodes: any[] = result.candidateFields ? Object.values(result.candidateFields).flat().map((field) => ({
    id: `resp:${field.stepOrder}:${field.location}:${field.path}`,
    stepOrder: field.stepOrder,
    location: field.location,
    path: field.path,
    label: `${field.location}:${field.path}`,
    predictedType: field.predictedType,
    valuePreview: field.valuePreview,
    source: 'execution' as const,
    confidence: Math.min(1, field.score / 100),
  })) : [];
  const requestNodes: any[] = Object.values(result.requestFields).flat().map((field) => ({
    id: `req:${field.stepOrder}:${field.location}:${field.path}`,
    stepOrder: field.stepOrder,
    location: field.location,
    path: field.path,
    label: `${field.location}:${field.path}`,
    predictedType: 'GENERIC' as const,
    valuePreview: field.currentValue == null ? '' : String(field.currentValue),
    source: 'execution' as const,
    confidence: 0.6,
  }));
  const graphNodes: any[] = [...responseNodes, ...requestNodes];

  const mappings = result.mappingCandidates.map((mapping, idx) => ({
    id: `exec-map-${idx}`,
    fromStepOrder: mapping.fromStepOrder,
    fromLocation: mapping.fromLocation,
    fromPath: mapping.fromPath,
    toStepOrder: mapping.toStepOrder,
    toLocation: mapping.toLocation,
    toPath: mapping.toPath,
    variableName: mapping.variableName,
    transformHint: mapping.toLocation === 'request.header' && /authorization/i.test(mapping.toPath) ? 'wrap_bearer' : undefined,
    confidence: mapping.confidence,
    evidenceCount: 1,
    reason: mapping.reason,
    predictedType: mapping.predictedType,
    source: 'execution' as const,
    selectedByDefault: mapping.confidence >= 0.7,
  }));
  const variables = mappings.reduce<any[]>((acc, mapping) => {
    if (acc.some((item) => item.variableName === mapping.variableName)) return acc;
    acc.push({
      id: `exec-var-${mapping.variableName}`,
      variableName: mapping.variableName,
      predictedType: mapping.predictedType,
      sourceStepOrder: mapping.fromStepOrder,
      sourceLocation: mapping.fromLocation,
      sourcePath: mapping.fromPath,
      confidence: mapping.confidence,
      reason: `execution:${mapping.reason}`,
      writePolicySuggestion: inferWritePolicy(mapping.predictedType),
      lockSuggestion: mapping.predictedType === 'IDENTITY',
      source: 'execution' as const,
    });
    return acc;
  }, []);
  const extractors = (options?.includeExtractors !== false ? mappings : []).map((mapping, idx) => ({
    id: `exec-ext-${idx}`,
    stepOrder: mapping.fromStepOrder,
    extractorType: mapping.fromLocation === 'response.header' ? 'header' as const : mapping.fromLocation === 'response.cookie' ? 'cookie' as const : 'json_path' as const,
    sourceLocation: mapping.fromLocation,
    sourcePath: mapping.fromPath,
    targetVariableName: mapping.variableName,
    confidence: Math.max(0.55, mapping.confidence),
    reason: 'derived from execution mapping',
    source: 'execution' as const,
    required: mapping.predictedType === 'FLOW_TICKET' || mapping.predictedType === 'IDENTITY',
  }));
  const workflowRows = await db.runRawQuery(`SELECT session_jar_config FROM workflows WHERE id = ?`, [workflowId]);
  const existingSessionJar = workflowRows?.[0]?.session_jar_config || null;
  const sessionJar = options?.includeSessionJar === false ? null : detectSessionJarSuggestion(mappings, 'execution');
  const edges = mappings.map((mapping) => ({
    id: mapping.id,
    fromNodeId: `resp:${mapping.fromStepOrder}:${mapping.fromLocation}:${mapping.fromPath}`,
    toNodeId: `req:${mapping.toStepOrder}:${mapping.toLocation}:${mapping.toPath}`,
    variableName: mapping.variableName,
    confidence: mapping.confidence,
    reason: mapping.reason,
    source: 'execution' as const,
    evidenceCount: mapping.evidenceCount,
    transformHint: mapping.transformHint,
  }));
  return {
    workflowId,
    learningVersion: result.learningVersion,
    sourceType: 'execution_only',
    stepSnapshots: result.stepSnapshots,
    graph: { nodes: graphNodes, edges },
    suggestions: {
      workflowVariables: variables,
      mappings,
      extractors,
      sessionJar,
      assertions: options?.includeAssertions ? result.stepSnapshots.map((step, idx) => ({ id: `assert-${idx}`, stepOrder: step.stepOrder, type: 'status' as const, config: { operator: 'between', min: 200, max: 299 }, confidence: 0.6, reason: 'response status observed in execution baseline', source: 'execution' as const })) : [],
    },
    conflicts: {
      mappings: [],
      extractors: [],
      sessionJar: conflictWithExistingSessionJar(existingSessionJar, sessionJar),
    },
    summary: {
      nodeCount: graphNodes.length,
      edgeCount: edges.length,
      variableSuggestionCount: variables.length,
      mappingSuggestionCount: mappings.length,
      extractorSuggestionCount: extractors.length,
      assertionSuggestionCount: options?.includeAssertions ? result.stepSnapshots.length : 0,
    },
    evidence: mappings.map((mapping) => ({ fromStepOrder: mapping.fromStepOrder, toStepOrder: mapping.toStepOrder, evidenceType: 'execution_mapping', confidence: mapping.confidence, payload: { fromLocation: mapping.fromLocation, fromPath: mapping.fromPath, toLocation: mapping.toLocation, toPath: mapping.toPath, variableName: mapping.variableName } })),
  };
}
