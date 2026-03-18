import { Link2, Target } from 'lucide-react';
import type { RecordingFieldHit } from '../../lib/api-client';

interface RecordingFieldCandidatesPanelProps {
  fieldHits: RecordingFieldHit[];
}

function uniqueValues(values: Array<string | undefined>, limit = 4): string[] {
  const seen = new Set<string>();
  const items: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    items.push(value);
    if (items.length >= limit) break;
  }

  return items;
}

function getDisplayValue(hit: RecordingFieldHit): string {
  return hit.value_text || hit.value_preview || '';
}

export function RecordingFieldCandidatesPanel({ fieldHits }: RecordingFieldCandidatesPanelProps) {
  const grouped = Object.values(
    fieldHits.reduce<Record<string, {
      fieldName: string;
      bindToAccountField?: string;
      hits: RecordingFieldHit[];
      sources: string[];
      values: string[];
    }>>((acc, hit) => {
      if (!acc[hit.field_name]) {
        acc[hit.field_name] = {
          fieldName: hit.field_name,
          bindToAccountField: hit.bind_to_account_field,
          hits: [],
          sources: [],
          values: [],
        };
      }

      acc[hit.field_name].hits.push(hit);
      acc[hit.field_name].sources.push([hit.source_location, hit.source_key].filter(Boolean).join(': '));
      acc[hit.field_name].values.push(getDisplayValue(hit));
      if (!acc[hit.field_name].bindToAccountField && hit.bind_to_account_field) {
        acc[hit.field_name].bindToAccountField = hit.bind_to_account_field;
      }

      return acc;
    }, {})
  )
    .map(group => ({
      ...group,
      sources: uniqueValues(group.sources, 6),
      values: uniqueValues(group.values, 4),
    }))
    .sort((left, right) => right.hits.length - left.hits.length);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Target size={18} className="text-emerald-600" />
        <h3 className="text-lg font-semibold text-gray-900">Field Candidates</h3>
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
          No field hits have been extracted yet. Continue recording or refine target fields before regenerating drafts.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {grouped.map(group => (
            <div key={group.fieldName} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-gray-900">{group.fieldName}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    {group.hits.length} hit{group.hits.length > 1 ? 's' : ''}
                  </div>
                </div>
                {group.bindToAccountField && (
                  <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                    Account: {group.bindToAccountField}
                  </span>
                )}
              </div>

              <div className="mt-4 space-y-4">
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <Link2 size={14} />
                    Sources
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {group.sources.map(source => (
                      <span
                        key={`${group.fieldName}-${source}`}
                        className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700"
                      >
                        {source}
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Value Previews</div>
                  <div className="mt-2 space-y-2">
                    {group.values.map(value => (
                      <div
                        key={`${group.fieldName}-${value}`}
                        className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-700 break-all"
                      >
                        {value}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
