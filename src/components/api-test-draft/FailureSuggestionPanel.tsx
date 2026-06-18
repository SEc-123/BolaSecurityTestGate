import { Checkbox } from '../ui/Form';

interface FailureSuggestionPanelProps {
  title: string;
  suggestions: Array<Record<string, any>>;
  selectedIds: string[];
  onToggle: (id: string) => void;
}

export function FailureSuggestionPanel({ title, suggestions, selectedIds, onToggle }: FailureSuggestionPanelProps) {
  const selected = new Set(selectedIds);
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      <div className="mt-3 space-y-3">
        {suggestions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-500">No suggestions generated.</div>
        ) : suggestions.map((item, index) => {
          const id = String(item.id || item.path || item.kind || item.type || index);
          return (
            <div key={id} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900">{item.label || item.path || item.type || item.kind}</div>
                  <div className="mt-1 break-all text-xs text-gray-500">{item.path || item.type || item.kind} · {item.operator || 'exists'}{item.value !== undefined ? ` · ${String(item.value)}` : ''}</div>
                  <div className="mt-2 text-xs text-gray-600">{item.reason || 'Derived from the recorded success response'}</div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">{typeof item.confidence === 'number' ? `${Math.round(item.confidence * 100)}%` : '-'}</span>
                  <Checkbox checked={selected.has(id)} onChange={() => onToggle(id)} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
