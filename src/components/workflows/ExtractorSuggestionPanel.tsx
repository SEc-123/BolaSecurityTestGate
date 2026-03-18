import { Checkbox } from '../ui/Form';
import type { LearningSuggestionPayloadV2 } from '../../lib/api-client';

interface Props {
  payload: LearningSuggestionPayloadV2;
  selectedExtractorIds: Set<string>;
  applySessionJar: boolean;
  applyAssertions: boolean;
  onToggleExtractor: (id: string) => void;
  onToggleSessionJar: () => void;
  onToggleAssertions: () => void;
}

export function ExtractorSuggestionPanel({ payload, selectedExtractorIds, applySessionJar, applyAssertions, onToggleExtractor, onToggleSessionJar, onToggleAssertions }: Props) {
  const sessionJar = payload.suggestions.sessionJar;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="text-sm font-semibold text-gray-900">Extractor Suggestions</div>
        <div className="mt-3 space-y-2">
          {payload.suggestions.extractors.map((item) => (
            <label key={item.id} className="flex items-start gap-3 rounded-lg border border-gray-200 p-3">
              <Checkbox checked={selectedExtractorIds.has(item.id)} onChange={() => onToggleExtractor(item.id)} />
              <div className="min-w-0 flex-1 text-xs text-gray-600">
                <div className="font-medium text-gray-900">Step {item.stepOrder} · {item.targetVariableName}</div>
                <div className="mt-1">{item.extractorType} · {item.sourceLocation}:{item.sourcePath}</div>
                <div className="mt-1">{Math.round(item.confidence * 100)}% · {item.reason}</div>
              </div>
            </label>
          ))}
          {payload.suggestions.extractors.length === 0 && <div className="text-sm text-gray-500">No extractor suggestions.</div>}
        </div>
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
        <label className="flex items-start gap-3">
          <Checkbox checked={applySessionJar} onChange={onToggleSessionJar} />
          <div>
            <div className="text-sm font-medium text-gray-900">Apply Session Jar Suggestion</div>
            <div className="mt-1 text-xs text-gray-600">
              {sessionJar ? `${sessionJar.cookieMode ? 'Cookie mode' : 'Header mode'} · headers: ${(sessionJar.headerKeys || []).join(', ') || 'none'}` : 'No session jar suggestion generated.'}
            </div>
          </div>
        </label>
        <label className="flex items-start gap-3">
          <Checkbox checked={applyAssertions} onChange={onToggleAssertions} />
          <div>
            <div className="text-sm font-medium text-gray-900">Apply Assertion Suggestions</div>
            <div className="mt-1 text-xs text-gray-600">Adds learned assertions back to workflow steps.</div>
          </div>
        </label>
      </div>
    </div>
  );
}
