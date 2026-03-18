import type { LearningSuggestionPayload, MappingSuggestion, WorkflowVariableSuggestion, ExtractorSuggestion, SuggestionGraphEdge, SuggestionGraphNode } from './learning-v2-types.js';

function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = seen.get(key) as any;
    if (!existing || ((item as any).confidence ?? 0) > ((existing as any).confidence ?? 0)) {
      seen.set(key, item);
    }
  }
  return Array.from(seen.values());
}

export function mergeLearningSuggestions(recording: LearningSuggestionPayload | null, execution: LearningSuggestionPayload | null, workflowId: string, learningVersion: number): LearningSuggestionPayload {
  const nodes = uniqueBy([...(recording?.graph.nodes || []), ...(execution?.graph.nodes || [])], (n) => `${n.stepOrder}:${n.location}:${n.path}`)
    .map((node) => ({ ...node, source: recording && execution ? 'hybrid' as const : node.source }));
  const edges = uniqueBy([...(recording?.graph.edges || []), ...(execution?.graph.edges || [])], (e) => `${e.fromNodeId}:${e.toNodeId}:${e.variableName}`)
    .map((edge) => ({ ...edge, source: recording && execution ? 'hybrid' as const : edge.source, confidence: Math.min(1, (edge.confidence || 0) + (recording && execution ? 0.08 : 0)) }));
  const mappings = uniqueBy([...(recording?.suggestions.mappings || []), ...(execution?.suggestions.mappings || [])], (m) => `${m.fromStepOrder}:${m.fromPath}:${m.toStepOrder}:${m.toPath}:${m.variableName}`)
    .map((mapping) => ({ ...mapping, source: recording && execution ? 'hybrid' as const : mapping.source, confidence: Math.min(1, (mapping.confidence || 0) + (recording && execution ? 0.1 : 0)), selectedByDefault: (mapping.confidence || 0) >= 0.65 }));
  const variables = uniqueBy([...(recording?.suggestions.workflowVariables || []), ...(execution?.suggestions.workflowVariables || [])], (v) => v.variableName)
    .map((variable) => ({ ...variable, source: recording && execution ? 'hybrid' as const : variable.source, confidence: Math.min(1, (variable.confidence || 0) + (recording && execution ? 0.08 : 0)) }));
  const extractors = uniqueBy([...(recording?.suggestions.extractors || []), ...(execution?.suggestions.extractors || [])], (e) => `${e.stepOrder}:${e.sourceLocation}:${e.sourcePath}:${e.targetVariableName}`)
    .map((extractor) => ({ ...extractor, source: recording && execution ? 'hybrid' as const : extractor.source, confidence: Math.min(1, (extractor.confidence || 0) + (recording && execution ? 0.08 : 0)) }));
  const sessionJar = recording?.suggestions.sessionJar || execution?.suggestions.sessionJar
    ? {
        ...(recording?.suggestions.sessionJar || execution?.suggestions.sessionJar)!,
        source: recording && execution ? 'hybrid' as const : ((recording?.suggestions.sessionJar || execution?.suggestions.sessionJar)!.source),
        confidence: Math.min(1, Math.max(recording?.suggestions.sessionJar?.confidence || 0, execution?.suggestions.sessionJar?.confidence || 0) + (recording && execution ? 0.08 : 0)),
      }
    : null;
  return {
    workflowId,
    learningVersion,
    sourceType: 'hybrid',
    sourceRecordingSessionId: recording?.sourceRecordingSessionId,
    sourceExecutionRunId: execution?.sourceExecutionRunId,
    graph: { nodes, edges },
    suggestions: {
      workflowVariables: variables,
      mappings,
      extractors,
      sessionJar,
      assertions: uniqueBy([...(recording?.suggestions.assertions || []), ...(execution?.suggestions.assertions || [])], (a) => `${a.stepOrder}:${a.type}:${JSON.stringify(a.config)}`),
    },
    conflicts: {
      mappings: [...(recording?.conflicts.mappings || []), ...(execution?.conflicts.mappings || [])],
      extractors: [...(recording?.conflicts.extractors || []), ...(execution?.conflicts.extractors || [])],
      sessionJar: recording?.conflicts.sessionJar || execution?.conflicts.sessionJar || null,
    },
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      variableSuggestionCount: variables.length,
      mappingSuggestionCount: mappings.length,
      extractorSuggestionCount: extractors.length,
      assertionSuggestionCount: (recording?.suggestions.assertions?.length || 0) + (execution?.suggestions.assertions?.length || 0),
    },
    evidence: [...(recording?.evidence || []), ...(execution?.evidence || [])],
  };
}
