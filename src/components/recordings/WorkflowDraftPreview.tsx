import { GitBranch, Link2, Pencil, Upload } from 'lucide-react';
import { Button } from '../ui/Form';
import type { WorkflowDraft } from '../../lib/api-client';

interface WorkflowDraftPreviewProps {
  draft: WorkflowDraft;
  publishing?: boolean;
  onEdit?: () => void;
  onPublish?: () => void;
  onOpenWorkflow?: (workflowId: string) => void;
}

function renderVariableBinding(candidate: any): string {
  if (candidate.binding_label) {
    return candidate.binding_label;
  }

  return `${candidate.data_source || 'variable'} | ${candidate.json_path || candidate.source_location || 'n/a'}`;
}

export function WorkflowDraftPreview({
  draft,
  publishing = false,
  onEdit,
  onPublish,
  onOpenWorkflow,
}: WorkflowDraftPreviewProps) {
  const payload = draft.draft_payload || {};
  const workflowConfig = payload.workflow || {};
  const payloadSteps = payload.steps || [];
  const variableCandidates = draft.variable_candidates || payload.variable_candidates || [];
  const extractorCandidates = draft.extractor_candidates || payload.extractor_candidates || [];
  const publishedWorkflowId = draft.published_workflow_id;

  return (
    <div className="rounded-2xl border border-purple-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-purple-700">
            <GitBranch size={18} />
            <span className="text-xs font-semibold uppercase tracking-wide">Workflow Draft Preview</span>
          </div>
          <h4 className="mt-2 text-xl font-semibold text-gray-900">{draft.name}</h4>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700">
              {draft.status}
            </span>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
              {draft.summary?.step_count || payloadSteps.length || 0} step{(draft.summary?.step_count || payloadSteps.length || 0) === 1 ? '' : 's'}
            </span>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
              {draft.summary?.variable_candidate_count || variableCandidates.length || 0} variable candidate{(draft.summary?.variable_candidate_count || variableCandidates.length || 0) === 1 ? '' : 's'}
            </span>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
              {draft.summary?.extractor_candidate_count || extractorCandidates.length || 0} extractor candidate{(draft.summary?.extractor_candidate_count || extractorCandidates.length || 0) === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {onEdit && draft.status !== 'published' && (
            <Button variant="secondary" size="sm" onClick={onEdit}>
              <Pencil size={14} className="mr-1" />
              Edit Draft
            </Button>
          )}
          {publishedWorkflowId && onOpenWorkflow && (
            <Button variant="secondary" size="sm" onClick={() => onOpenWorkflow(publishedWorkflowId)}>
              <Link2 size={14} className="mr-1" />
              Open Workflow
            </Button>
          )}
          {onPublish && (
            <Button onClick={onPublish} size="sm" loading={publishing} disabled={draft.status === 'published'}>
              <Upload size={14} className="mr-1" />
              {draft.status === 'published' ? 'Published' : 'Publish Workflow'}
            </Button>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Workflow Settings</div>
          <div className="mt-3 space-y-2 text-sm text-gray-700">
            <div>Name: {workflowConfig.name || 'Generated workflow'}</div>
            <div>Template Mode: {workflowConfig.template_mode || 'snapshot'}</div>
            <div>Extractor: {workflowConfig.enable_extractor ? 'Enabled' : 'Disabled'}</div>
            <div>Session Jar: {workflowConfig.enable_session_jar ? 'Enabled' : 'Disabled'}</div>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 lg:col-span-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Step Drafts</div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {(draft.steps || payloadSteps).map((step: any) => (
              <div key={step.id || `${draft.id}-${step.sequence}`} className="rounded-lg border border-white bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-sm font-semibold text-gray-900">
                    Step {step.sequence}: {step.step_name || step.request_template_payload?.name || step.method}
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${step.enabled === false ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                    {step.enabled === false ? 'disabled' : 'enabled'}
                  </span>
                </div>
                <div className="mt-1 break-all text-xs text-gray-500">{step.method} {step.path}</div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-gray-500">
                  {step.business_action && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5">
                      {step.business_action}
                    </span>
                  )}
                  {(step.merged_event_count || step.summary?.merged_event_count) > 1 && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5">
                      merged x{step.merged_event_count || step.summary?.merged_event_count}
                    </span>
                  )}
                  {(step.response_status || step.summary?.response_status) && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5">
                      response {step.response_status || step.summary?.response_status}
                    </span>
                  )}
                </div>
                {(step.variable_injections || []).length > 0 && (
                  <div className="mt-2 text-xs text-blue-700">
                    {(step.variable_injections || []).map((item: any) => item.binding_label || item.json_path || item.name).join(' | ')}
                  </div>
                )}
                {(step.extractor_candidates || []).length > 0 && (
                  <div className="mt-2 text-xs text-gray-600">
                    {(step.extractor_candidates || []).map((item: any) => `${item.name} <= ${item.expression}`).join(' | ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 p-4">
          <div className="text-sm font-semibold text-gray-900">Variable Candidates</div>
          <div className="mt-3 space-y-3">
            {variableCandidates.length === 0 ? (
              <div className="text-sm text-gray-500">No variable candidates inferred yet.</div>
            ) : variableCandidates.map((candidate: any, index: number) => (
              <div key={candidate.id || `${draft.id}-var-${index}`} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm">
                <div className="font-medium text-gray-900">{candidate.name}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {renderVariableBinding(candidate)}
                </div>
                {(candidate.account_field_name || candidate.runtime_context_key) && (
                  <div className="mt-1 text-xs text-blue-600">
                    {candidate.account_field_name ? `Account: ${candidate.account_field_name}` : `Runtime Context: ${candidate.runtime_context_key}`}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 p-4">
          <div className="text-sm font-semibold text-gray-900">Extractor Candidates</div>
          <div className="mt-3 space-y-3">
            {extractorCandidates.length === 0 ? (
              <div className="text-sm text-gray-500">No extractors inferred yet.</div>
            ) : extractorCandidates.map((candidate: any, index: number) => (
              <div key={candidate.id || `${draft.id}-ext-${index}`} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm">
                <div className="font-medium text-gray-900">{candidate.name}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {candidate.source} | {candidate.expression}
                </div>
                {candidate.value_preview && (
                  <div className="mt-2 break-all text-xs text-gray-600">{candidate.value_preview}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
