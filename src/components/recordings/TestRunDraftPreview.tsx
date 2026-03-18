import { Edit3, FileText, Link2, Upload } from 'lucide-react';
import { Button } from '../ui/Form';
import type { TestRunDraft } from '../../lib/api-client';

interface TestRunDraftPreviewProps {
  draft: TestRunDraft;
  publishing?: boolean;
  creatingTemplate?: boolean;
  promotingTestRun?: boolean;
  onEdit?: () => void;
  onPublish?: () => void;
  onCreateTemplate?: () => void;
  onOpenPreset?: (presetId: string) => void;
  onPromoteToTestRun?: () => void;
  onOpenTestRun?: (testRunId: string) => void;
  onOpenWorkspace?: () => void;
}

export function TestRunDraftPreview({
  draft,
  publishing = false,
  creatingTemplate = false,
  promotingTestRun = false,
  onEdit,
  onPublish,
  onCreateTemplate,
  onOpenPreset,
  onPromoteToTestRun,
  onOpenTestRun,
  onOpenWorkspace,
}: TestRunDraftPreviewProps) {
  const payload = draft.draft_payload || {};
  const templatePayload = payload.template || {};
  const presetPayload = payload.preset || {};
  const variableSuggestions = Array.isArray(templatePayload.variables) ? templatePayload.variables : [];
  const fieldCandidates = Array.isArray(templatePayload.field_candidates) ? templatePayload.field_candidates : [];
  const assertionCandidates = Array.isArray(templatePayload.assertion_candidates) ? templatePayload.assertion_candidates : [];
  const responseSnapshot = templatePayload.response_snapshot || {};
  const publishedPresetId =
    draft.published_preset_id ||
    payload.published_assets?.latest_test_run_preset_id;
  const publishedTestRunId =
    draft.published_test_run_id ||
    payload.published_assets?.latest_test_run_id ||
    draft.summary?.latest_published_test_run_id;
  const latestTemplateId = payload.published_assets?.latest_api_template_id || draft.summary?.latest_published_template_id;

  return (
    <div className="rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-blue-700">
            <FileText size={18} />
            <span className="text-xs font-semibold uppercase tracking-wide">API Template Draft</span>
          </div>
          <h4 className="mt-2 text-xl font-semibold text-gray-900">{draft.name}</h4>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
              {draft.status}
            </span>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
              Seq {draft.sequence || '-'}
            </span>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
              {draft.summary?.method || templatePayload.parsed_structure?.method || 'GET'}
            </span>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
              {draft.summary?.path || templatePayload.parsed_structure?.path || '/'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {onOpenWorkspace && (
            <Button variant="secondary" size="sm" onClick={onOpenWorkspace}>
              <Link2 size={14} className="mr-1" />
              Open Workspace
            </Button>
          )}
          {onEdit && (
            <Button variant="secondary" size="sm" onClick={onEdit}>
              <Edit3 size={14} className="mr-1" />
              Edit Draft
            </Button>
          )}
          {onCreateTemplate && (
            <Button size="sm" onClick={onCreateTemplate} loading={creatingTemplate}>
              <FileText size={14} className="mr-1" />
              Save As Template
            </Button>
          )}
          {publishedPresetId && onOpenPreset && (
            <Button variant="secondary" size="sm" onClick={() => onOpenPreset(publishedPresetId)}>
              <Link2 size={14} className="mr-1" />
              Open Preset
            </Button>
          )}
          {publishedTestRunId && onOpenTestRun && (
            <Button variant="secondary" size="sm" onClick={() => onOpenTestRun(publishedTestRunId)}>
              <Link2 size={14} className="mr-1" />
              Open Test Run
            </Button>
          )}
          {!publishedTestRunId && onPromoteToTestRun && (
            <Button variant="secondary" size="sm" onClick={onPromoteToTestRun} loading={promotingTestRun}>
              <Upload size={14} className="mr-1" />
              Promote Test Run
            </Button>
          )}
          {onPublish && (
            <Button variant="secondary" onClick={onPublish} size="sm" loading={publishing} disabled={!!publishedPresetId}>
              <Upload size={14} className="mr-1" />
              {publishedPresetId ? 'Preset Published' : 'Publish Preset'}
            </Button>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)]">
        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 p-4">
            <div className="text-sm font-semibold text-gray-900">Recorded Request Template</div>
            <div className="mt-2 text-xs text-gray-500">
              {templatePayload.description || draft.summary?.path || 'No description'}
            </div>
            <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-gray-100 whitespace-pre-wrap">
              {templatePayload.raw_request || 'No request payload available'}
            </pre>
          </div>

          <div className="rounded-xl border border-gray-200 p-4">
            <div className="text-sm font-semibold text-gray-900">Response Snapshot</div>
            <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-gray-950 p-3 text-xs text-gray-100 whitespace-pre-wrap">
              {JSON.stringify(responseSnapshot, null, 2)}
            </pre>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Template Summary</div>
            <div className="mt-3 space-y-2 text-sm text-gray-700">
              <div>Status Code Snapshot: {draft.summary?.response_status || 'Unknown'}</div>
              <div>Field Candidates: {fieldCandidates.length}</div>
              <div>Assertion Suggestions: {assertionCandidates.length}</div>
              {latestTemplateId && <div>Latest Template: {latestTemplateId}</div>}
              {publishedTestRunId && <div>Formal Test Run: {publishedTestRunId}</div>}
            </div>
            {(presetPayload.name || presetPayload.environment_id || presetPayload.default_account_id) && (
              <div className="mt-4 rounded-lg border border-dashed border-gray-300 bg-white p-3 text-xs text-gray-600">
                <div className="font-semibold text-gray-800">Optional Run Binding</div>
                <div className="mt-2 space-y-1">
                  <div>Preset: {presetPayload.name || 'Generated preset'}</div>
                  <div>Environment: {presetPayload.environment_id || 'Unbound'}</div>
                  <div>Default Account: {presetPayload.default_account_id || 'Unbound'}</div>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-gray-200 p-4">
            <div className="text-sm font-semibold text-gray-900">Variable Suggestions</div>
            <div className="mt-3 space-y-3">
              {variableSuggestions.length === 0 ? (
                <div className="text-sm text-gray-500">No variable suggestions inferred.</div>
              ) : variableSuggestions.map((variable: any, index: number) => (
                <div key={`${draft.id}-variable-${index}`} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm">
                  <div className="font-medium text-gray-900">{variable.name}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    {variable.json_path || 'request'} · {variable.account_field_name || variable.checklist_id || variable.security_rule_id || variable.data_source || 'manual'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
