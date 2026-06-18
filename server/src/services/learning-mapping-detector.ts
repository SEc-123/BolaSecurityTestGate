import type { MappingSuggestion } from './learning-v2-types.js';

export function groupMappingsByStep(mappings: MappingSuggestion[]) {
  return mappings.reduce<Record<string, MappingSuggestion[]>>((acc, item) => {
    const key = `${item.fromStepOrder}->${item.toStepOrder}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

export function lowConfidenceMappings(mappings: MappingSuggestion[], threshold = 0.65) {
  return mappings.filter((item) => item.confidence < threshold);
}
