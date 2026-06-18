import { ChevronLeft, ChevronRight, Clock3, Sparkles } from 'lucide-react';
import { Button } from '../ui/Form';
import type { RecordingEvent } from '../../lib/api-client';

interface RecordingEventTimelineProps {
  events: RecordingEvent[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
  loading?: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onGenerateApiTestDraft?: (eventId: string) => void;
}

function statusClass(status?: number) {
  if (!status) return 'bg-gray-100 text-gray-600';
  if (status >= 200 && status < 300) return 'bg-green-100 text-green-700';
  if (status >= 400) return 'bg-red-100 text-red-700';
  return 'bg-amber-100 text-amber-700';
}

export function RecordingEventTimeline({
  events,
  pagination,
  loading = false,
  onPreviousPage,
  onNextPage,
  onGenerateApiTestDraft,
}: RecordingEventTimelineProps) {
  const totalPages = Math.max(1, Math.ceil((pagination.total || 0) / Math.max(1, pagination.limit || 1)));
  const currentPage = Math.floor((pagination.offset || 0) / Math.max(1, pagination.limit || 1)) + 1;
  const canGoPrevious = pagination.offset > 0;
  const canGoNext = pagination.offset + events.length < pagination.total;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clock3 size={18} className="text-blue-600" />
          <h3 className="text-lg font-semibold text-gray-900">Event Timeline</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">
            Page {currentPage} / {totalPages} • {pagination.total} total event{pagination.total === 1 ? '' : 's'}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onPreviousPage} disabled={!canGoPrevious || loading}>
              <ChevronLeft size={14} className="mr-1" />
              Previous
            </Button>
            <Button variant="secondary" size="sm" onClick={onNextPage} disabled={!canGoNext || loading}>
              Next
              <ChevronRight size={14} className="ml-1" />
            </Button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-sm text-gray-500">
          Loading captured events...
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-sm text-gray-500">
          No events captured yet for this page.
        </div>
      ) : (
        <div className="space-y-4">
          {events.map(event => (
            <div key={event.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white">
                      #{event.sequence}
                    </span>
                    <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                      {event.method}
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(event.response_status)}`}>
                      {event.response_status || 'No Status'}
                    </span>
                  </div>
                  <div className="mt-3 text-sm font-medium text-gray-900 break-all">{event.path}</div>
                  <div className="mt-1 text-xs text-gray-500 break-all">{event.url}</div>
                </div>
                <div className="flex min-w-[240px] flex-col gap-2 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-gray-50 px-3 py-2">
                      <div className="text-xs text-gray-500">Field Hits</div>
                      <div className="mt-1 font-semibold text-gray-900">{event.field_hits?.length || 0}</div>
                    </div>
                    <div className="rounded-lg bg-gray-50 px-3 py-2">
                      <div className="text-xs text-gray-500">Runtime Contexts</div>
                      <div className="mt-1 font-semibold text-gray-900">{event.runtime_contexts?.length || 0}</div>
                    </div>
                  </div>
                  {onGenerateApiTestDraft && (
                    <Button size="sm" variant="secondary" onClick={() => onGenerateApiTestDraft(event.id)}>
                      <Sparkles size={14} className="mr-1" />
                      Create API Test Draft
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Matched Fields</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(event.field_hits || []).length === 0 ? (
                      <span className="text-sm text-gray-400">No field hits.</span>
                    ) : (
                      (event.field_hits || []).map(hit => (
                        <span
                          key={hit.id}
                          className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700"
                        >
                          {hit.field_name}
                          {hit.source_key ? ` • ${hit.source_key}` : ''}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Runtime Context Keys</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(event.runtime_contexts || []).length === 0 ? (
                      <span className="text-sm text-gray-400">No runtime context.</span>
                    ) : (
                      (event.runtime_contexts || []).map(context => (
                        <span
                          key={context.id}
                          className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs text-indigo-700"
                        >
                          {context.context_key}
                        </span>
                      ))
                    )}
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
