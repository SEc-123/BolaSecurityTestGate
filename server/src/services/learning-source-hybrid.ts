import { mergeLearningSuggestions } from './learning-suggestion-merger.js';
import type { LearningSuggestionPayload } from './learning-v2-types.js';

export function buildHybridLearningSuggestions(workflowId: string, learningVersion: number, recording: LearningSuggestionPayload, execution: LearningSuggestionPayload) {
  return mergeLearningSuggestions(recording, execution, workflowId, learningVersion);
}
