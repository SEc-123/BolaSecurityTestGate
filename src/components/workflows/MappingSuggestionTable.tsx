import { Checkbox } from '../ui/Form';
import type { LearningSuggestionPayloadV2 } from '../../lib/api-client';

interface Props {
  payload: LearningSuggestionPayloadV2;
  selectedMappingIds: Set<string>;
  selectedVariableIds: Set<string>;
  onToggleMapping: (id: string) => void;
  onToggleVariable: (id: string) => void;
}

export function MappingSuggestionTable({ payload, selectedMappingIds, selectedVariableIds, onToggleMapping, onToggleVariable }: Props) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="text-sm font-semibold text-gray-900">Variables</div>
        <div className="mt-3 space-y-2">
          {payload.suggestions.workflowVariables.map((item) => (
            <label key={item.id} className="flex items-start gap-3 rounded-lg border border-gray-200 p-3">
              <Checkbox checked={selectedVariableIds.has(item.id)} onChange={() => onToggleVariable(item.id)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="rounded bg-gray-100 px-2 py-0.5 text-xs">{item.variableName}</code>
                  <span className="text-xs text-gray-500">{item.predictedType}</span>
                  <span className="text-xs text-gray-500">{Math.round(item.confidence * 100)}%</span>
                </div>
                <div className="mt-1 text-xs text-gray-600">Step {item.sourceStepOrder} · {item.sourceLocation} · {item.sourcePath}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="text-sm font-semibold text-gray-900">Mappings</div>
        <div className="mt-3 space-y-2">
          {payload.suggestions.mappings.map((item) => (
            <label key={item.id} className="flex items-start gap-3 rounded-lg border border-gray-200 p-3">
              <Checkbox checked={selectedMappingIds.has(item.id)} onChange={() => onToggleMapping(item.id)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="rounded bg-gray-100 px-2 py-0.5 text-xs">{item.variableName}</code>
                  <span className="text-xs text-gray-500">{item.source}</span>
                  <span className="text-xs text-gray-500">{Math.round(item.confidence * 100)}%</span>
                </div>
                <div className="mt-1 text-xs text-gray-600">Step {item.fromStepOrder} {item.fromLocation}:{item.fromPath} → Step {item.toStepOrder} {item.toLocation}:{item.toPath}</div>
                <div className="mt-1 text-xs text-gray-500">{item.reason}{item.transformHint ? ` · ${item.transformHint}` : ''}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
