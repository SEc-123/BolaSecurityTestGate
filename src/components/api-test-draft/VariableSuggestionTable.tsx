import { Checkbox } from '../ui/Form';

interface VariableSuggestionTableProps {
  suggestions: Array<Record<string, any>>;
  selectedIds: string[];
  onToggle: (id: string) => void;
}

export function VariableSuggestionTable({ suggestions, selectedIds, onToggle }: VariableSuggestionTableProps) {
  const selected = new Set(selectedIds);

  if (suggestions.length === 0) {
    return <div className="rounded-lg border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">No variable suggestions were generated for this event.</div>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="grid grid-cols-[64px_minmax(0,1.1fr)_minmax(0,0.9fr)_100px_160px] gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
        <div>Use</div>
        <div>Variable</div>
        <div>Target</div>
        <div>Confidence</div>
        <div>Reason</div>
      </div>
      <div className="divide-y divide-gray-100">
        {suggestions.map((item, index) => {
          const id = String(item.id || item.name || index);
          return (
            <div key={id} className="grid grid-cols-[64px_minmax(0,1.1fr)_minmax(0,0.9fr)_100px_160px] gap-3 px-4 py-3 text-sm text-gray-700">
              <div>
                <Checkbox checked={selected.has(id)} onChange={() => onToggle(id)} />
              </div>
              <div>
                <div className="font-medium text-gray-900">{item.name || 'Unnamed variable'}</div>
                <div className="mt-1 text-xs text-gray-500">{item.source || item.data_source || 'recorded_request'} · {item.account_field_name || item.checklist_id || item.security_rule_id || item.runtime_context_key || 'manual'}</div>
              </div>
              <div className="break-all text-xs text-gray-600">{item.target_location || item.json_path || 'request'}</div>
              <div>{typeof item.confidence === 'number' ? `${Math.round(item.confidence * 100)}%` : '-'}</div>
              <div className="text-xs text-gray-600">{item.reason || 'Suggested from recorded traffic'}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
