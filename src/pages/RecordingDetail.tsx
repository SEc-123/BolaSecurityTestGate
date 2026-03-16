import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle,
  Download,
  FileText,
  GitBranch,
  Link2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { Button } from '../components/ui/Form';
import { Modal } from '../components/ui/Modal';
import { RecordingEventTimeline } from '../components/recordings/RecordingEventTimeline';
import { RecordingFieldCandidatesPanel } from '../components/recordings/RecordingFieldCandidatesPanel';
import { RecordingAccountApplyModal } from '../components/recordings/RecordingAccountApplyModal';
import { WorkflowDraftPreview } from '../components/recordings/WorkflowDraftPreview';
import { TestRunDraftPreview } from '../components/recordings/TestRunDraftPreview';
import { WorkflowDraftEditorModal } from '../components/recordings/WorkflowDraftEditorModal';
import {
  accountsService,
  checklistsService,
  environmentsService,
  recordingsService,
  securityRulesService,
} from '../lib/api-service';
import type {
  RecordingAccountApplyPreview,
  RecordingEvent,
  RecordingRolloutConfig,
  RecordingSession,
  RecordingSessionDetail,
  TestRunDraft,
  WorkflowDraft,
} from '../lib/api-client';
import type { Account, Checklist, Environment, SecurityRule } from '../types';

const EVENT_PAGE_SIZE = 6;

interface RecordingDetailProps {
  sessionId: string;
  onBack: () => void;
  onOpenWorkflow?: (workflowId: string) => void;
  onOpenPreconfiguredRuns?: (params?: {
    draftId?: string;
    presetId?: string;
  }) => void;
  onOpenTestRuns?: (runId?: string) => void;
  rolloutConfig: RecordingRolloutConfig;
}

function renderStatusTag(status: RecordingSession['status']) {
  const className = status === 'published'
    ? 'bg-green-100 text-green-700'
    : status === 'completed' || status === 'finished'
      ? 'bg-blue-100 text-blue-700'
      : status === 'processing'
        ? 'bg-indigo-100 text-indigo-700'
        : status === 'failed'
          ? 'bg-red-100 text-red-700'
          : 'bg-amber-100 text-amber-700';

  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${className}`}>
      {status}
    </span>
  );
}

function renderContextEntries(title: string, values?: Record<string, string>) {
  const entries = Object.entries(values || {});

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      {entries.length === 0 ? (
        <div className="mt-2 text-xs text-gray-500">No captured values.</div>
      ) : (
        <div className="mt-3 space-y-2">
          {entries.map(([key, value]) => (
            <div key={`${title}-${key}`} className="text-xs">
              <div className="font-medium text-gray-700">{key}</div>
              <div className="mt-1 break-all text-gray-500">{value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function renderApplyModeTag(mode?: string, persisted?: boolean) {
  if (!mode) return null;

  const label = mode === 'write_back' ? 'Write Back' : 'Session Only';
  const className = mode === 'write_back'
    ? 'bg-emerald-100 text-emerald-700'
    : 'bg-blue-100 text-blue-700';

  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${className}`}>
      {label}{persisted === false ? ' (Not persisted)' : ''}
    </span>
  );
}

export function RecordingDetail({
  sessionId,
  onBack,
  onOpenWorkflow,
  onOpenPreconfiguredRuns,
  onOpenTestRuns,
  rolloutConfig,
}: RecordingDetailProps) {
  const [detail, setDetail] = useState<RecordingSessionDetail | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [securityRules, setSecurityRules] = useState<SecurityRule[]>([]);
  const [events, setEvents] = useState<RecordingEvent[]>([]);
  const [pagination, setPagination] = useState({
    total: 0,
    limit: EVENT_PAGE_SIZE,
    offset: 0,
  });
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [exportPayload, setExportPayload] = useState('');
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [editingDraft, setEditingDraft] = useState<WorkflowDraft | null>(null);
  const [isApplyModalOpen, setIsApplyModalOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [applyMode, setApplyMode] = useState<'session_only' | 'write_back'>('session_only');
  const [accountPreview, setAccountPreview] = useState<RecordingAccountApplyPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const accountName = useMemo(
    () => accounts.find(item => item.id === detail?.session.account_id)?.name || detail?.session.account_id || 'Unbound',
    [accounts, detail?.session.account_id]
  );
  const environmentName = useMemo(
    () => environments.find(item => item.id === detail?.session.environment_id)?.name || detail?.session.environment_id || 'Unbound',
    [detail?.session.environment_id, environments]
  );

  useEffect(() => {
    void loadPage();
  }, [sessionId]);

  useEffect(() => {
    void loadEventsPage(0);
  }, [sessionId]);

  useEffect(() => {
    const fallbackAccountId = detail?.session.account_id || accounts[0]?.id || '';
    if (!fallbackAccountId) return;
    if (!selectedAccountId) {
      setSelectedAccountId(fallbackAccountId);
      return;
    }
    if (!accounts.some(account => account.id === selectedAccountId)) {
      setSelectedAccountId(fallbackAccountId);
    }
  }, [accounts, detail?.session.account_id, selectedAccountId]);

  async function loadPage() {
    try {
      setLoading(true);
      const [detailData, accountsData, checklistsData, environmentsData, rulesData] = await Promise.all([
        recordingsService.getSession(sessionId),
        accountsService.list(),
        checklistsService.list(),
        environmentsService.list(),
        securityRulesService.list(),
      ]);
      setDetail(detailData);
      setAccounts(accountsData);
      setChecklists(checklistsData);
      setEnvironments(environmentsData);
      setSecurityRules(rulesData);
    } catch (error) {
      console.error('Failed to load recording detail:', error);
      alert('Failed to load recording detail');
    } finally {
      setLoading(false);
    }
  }

  async function loadEventsPage(offset: number) {
    try {
      setTimelineLoading(true);
      const response = await recordingsService.getEvents(sessionId, {
        limit: EVENT_PAGE_SIZE,
        offset,
      });
      setEvents(response.events);
      setPagination(response.pagination);
    } catch (error) {
      console.error('Failed to load recording timeline:', error);
      alert('Failed to load recording timeline');
    } finally {
      setTimelineLoading(false);
    }
  }

  async function refreshDetailAndTimeline(offset = pagination.offset) {
    await Promise.all([
      loadPage(),
      loadEventsPage(offset),
    ]);
  }

  async function loadAccountPreview(accountId = selectedAccountId, mode = applyMode) {
    if (!accountId) return;

    try {
      setPreviewLoading(true);
      const preview = await recordingsService.getAccountPreview(sessionId, {
        account_id: accountId,
        mode,
      });
      setAccountPreview(preview);
    } catch (error: any) {
      console.error('Failed to load account linkage preview:', error);
      alert(`Failed to load account linkage preview: ${error.message || 'Unknown error'}`);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleFinishSession() {
    setBusyAction('finish');
    try {
      const result = await recordingsService.finishSession(sessionId);
      setDetail(result);
      await loadEventsPage(pagination.offset);
    } catch (error: any) {
      console.error('Failed to finish recording session:', error);
      alert(`Failed to finish recording session: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRegenerate() {
    setBusyAction('regenerate');
    try {
      const result = await recordingsService.regenerate(sessionId);
      setDetail(result);
      await loadEventsPage(pagination.offset);
    } catch (error: any) {
      console.error('Failed to regenerate recording artifacts:', error);
      alert(`Failed to regenerate recording artifacts: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleOpenApplyModal() {
    const fallbackAccountId = detail?.session.account_id || accounts[0]?.id;
    if (!fallbackAccountId) {
      alert('Create at least one test account before applying recording values.');
      return;
    }

    setSelectedAccountId(fallbackAccountId);
    setApplyMode(detail?.account_linkage?.mode === 'write_back' ? 'write_back' : 'session_only');
    setIsApplyModalOpen(true);
    await loadAccountPreview(
      fallbackAccountId,
      detail?.account_linkage?.mode === 'write_back' ? 'write_back' : 'session_only'
    );
  }

  async function handleApplyToAccount() {
    if (!selectedAccountId) {
      alert('Choose a target account before applying recording values.');
      return;
    }

    setBusyAction('apply-account');
    try {
      const result = await recordingsService.applyToAccount(sessionId, {
        account_id: selectedAccountId,
        mode: applyMode,
        applied_by: 'recording_center_detail',
      });
      setAccountPreview(result.preview);
      setAccounts(current => current.map(account => account.id === result.account.id ? result.account : account));
      setIsApplyModalOpen(false);
      await refreshDetailAndTimeline();
      alert(applyMode === 'write_back'
        ? 'Captured values have been written back to the selected account.'
        : 'Captured values have been linked to this recording session without overwriting the account.');
    } catch (error: any) {
      console.error('Failed to apply recording values to account:', error);
      alert(`Failed to apply recording values to account: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleExportRaw() {
    setBusyAction('export');
    try {
      const raw = await recordingsService.exportRaw(sessionId);
      setExportPayload(JSON.stringify(raw, null, 2));
      setIsExportModalOpen(true);
    } catch (error: any) {
      console.error('Failed to export recording session:', error);
      alert(`Failed to export recording session: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePublishWorkflowDraft(draft: WorkflowDraft) {
    setBusyAction(`publish-workflow-${draft.id}`);
    try {
      await recordingsService.publishWorkflowDraft(draft.id, {
        published_by: 'recording_center_detail',
      });
      await refreshDetailAndTimeline();
      alert(`Workflow draft "${draft.name}" has been published.`);
    } catch (error: any) {
      console.error('Failed to publish workflow draft:', error);
      alert(`Failed to publish workflow draft: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveWorkflowDraft(payload: {
    name?: string;
    steps: Array<{
      id: string;
      sequence: number;
      enabled: boolean;
      name: string;
      description?: string;
    }>;
    extractor_candidates: Array<{
      workflow_draft_step_id: string;
      name: string;
      source: string;
      expression: string;
      required?: boolean;
      confidence?: number;
    }>;
    variable_candidates: Array<{
      workflow_draft_step_id: string;
      name: string;
      data_source: string;
      source_location: string;
      json_path?: string;
      checklist_id?: string;
      security_rule_id?: string;
      account_field_name?: string;
      runtime_context_key?: string;
      step_variable_mappings?: any[];
      advanced_config?: Record<string, any>;
      role?: string;
      confidence?: number;
    }>;
  }) {
    if (!editingDraft) return;

    setBusyAction(`save-workflow-${editingDraft.id}`);
    try {
      const updatedDetail = await recordingsService.updateWorkflowDraft(editingDraft.id, payload);
      setDetail(updatedDetail);
      setEditingDraft(null);
      await loadEventsPage(pagination.offset);
      alert(`Workflow draft "${editingDraft.name}" has been updated.`);
    } catch (error: any) {
      console.error('Failed to save workflow draft:', error);
      alert(`Failed to save workflow draft: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePublishTestRunDraft(draft: TestRunDraft) {
    setBusyAction(`publish-test-run-${draft.id}`);
    try {
      await recordingsService.publishTestRunDraft(draft.id, {
        published_by: 'recording_center_detail',
      });
      await refreshDetailAndTimeline();
      alert(`API draft "${draft.name}" has been published as a reusable preset.`);
    } catch (error: any) {
      console.error('Failed to publish API draft:', error);
      alert(`Failed to publish API draft: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePromoteTestRunDraft(draft: TestRunDraft) {
    setBusyAction(`promote-test-run-${draft.id}`);
    try {
      const result = await recordingsService.promoteTestRunDraftToTestRun(draft.id, {
        published_by: 'recording_center_detail',
      });
      await refreshDetailAndTimeline();
      alert(result.reused_existing
        ? `Formal test run "${result.test_run.name || result.test_run.id}" already exists and has been reopened.`
        : `API draft "${draft.name}" has been promoted to a formal test run.`);
      onOpenTestRuns?.(result.test_run.id);
    } catch (error: any) {
      console.error('Failed to promote API draft to formal test run:', error);
      alert(`Failed to promote API draft to formal test run: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  function downloadExportPayload() {
    const blob = new Blob([exportPayload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${detail?.session.name || 'recording-session'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (loading || !detail) {
    return <div className="p-8 text-gray-500">Loading recording detail...</div>;
  }

  const session = detail.session;
  const recentApplyLogs = (detail.account_apply_logs || []).slice(0, 6);
  const nextStepText = session.mode === 'workflow'
    ? 'Review the generated workflow draft below, then publish it into Workflows for deeper editing and execution.'
    : 'Review each recorded API draft below, move it into the Preconfigured Runs workspace for editing, then publish it into reusable presets, templates, or formal test runs.';

  return (
    <div className="space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Button variant="secondary" size="sm" onClick={onBack}>
            <ArrowLeft size={14} className="mr-1" />
            Back To Recording List
          </Button>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold text-gray-900">{session.name}</h1>
            {renderStatusTag(session.status)}
          </div>
          <p className="mt-2 text-sm text-gray-600">
            Recording detail is the confirmation desk for captured events, field candidates, runtime context, and generated drafts.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => refreshDetailAndTimeline()}>
            <RefreshCw size={16} className="mr-2" />
            Refresh
          </Button>
          <Button
            variant="secondary"
            onClick={handleRegenerate}
            loading={busyAction === 'regenerate'}
            disabled={session.status === 'processing'}
          >
            <RefreshCw size={16} className="mr-2" />
            Regenerate
          </Button>
          <Button
            onClick={handleFinishSession}
            loading={busyAction === 'finish'}
            disabled={session.status === 'processing'}
          >
            <Upload size={16} className="mr-2" />
            Finish And Generate
          </Button>
          <Button variant="secondary" onClick={handleOpenApplyModal}>
            <Link2 size={16} className="mr-2" />
            Review Account Linkage
          </Button>
          <Button variant="secondary" onClick={handleExportRaw} loading={busyAction === 'export'}>
            <Download size={16} className="mr-2" />
            Export Raw
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5">
        <div className="flex items-start gap-3">
          {session.mode === 'workflow' ? (
            <GitBranch size={20} className="mt-0.5 text-blue-700" />
          ) : (
            <FileText size={20} className="mt-0.5 text-blue-700" />
          )}
          <div>
            <div className="text-sm font-semibold uppercase tracking-wide text-blue-800">
              {session.mode === 'workflow' ? 'Workflow Mode' : 'API Mode'}
            </div>
            <div className="mt-1 text-sm text-blue-700">{nextStepText}</div>
            {!rolloutConfig.publish_enabled && (
              <div className="mt-2 text-xs font-medium text-amber-700">
                Publish and promotion actions are disabled in rollout phase {rolloutConfig.phase}.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Mode</div>
          <div className="mt-1 text-lg font-semibold uppercase text-gray-900">{session.mode}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Environment</div>
          <div className="mt-1 text-lg font-semibold text-gray-900">{environmentName}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Bound Account</div>
          <div className="mt-1 text-lg font-semibold text-gray-900">{accountName}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Role</div>
          <div className="mt-1 text-lg font-semibold text-gray-900">{session.role || 'Unspecified'}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Started</div>
          <div className="mt-1 text-lg font-semibold text-gray-900">
            {new Date(session.started_at).toLocaleString()}
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Finished</div>
          <div className="mt-1 text-lg font-semibold text-gray-900">
            {session.finished_at ? new Date(session.finished_at).toLocaleString() : 'In progress'}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Events</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{session.event_count}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Field Hits</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{session.field_hit_count}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Runtime Contexts</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{session.runtime_context_count}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Generated Results</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{session.generated_result_count}</div>
        </div>
      </div>

      <RecordingFieldCandidatesPanel fieldHits={detail.field_hits} />

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Link2 size={18} className="text-indigo-600" />
          <h3 className="text-lg font-semibold text-gray-900">Runtime Context Summary</h3>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {renderContextEntries('Values', detail.runtime_context_summary?.values)}
          {renderContextEntries('Cookies', detail.runtime_context_summary?.cookies)}
          {renderContextEntries('Headers', detail.runtime_context_summary?.headers)}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Link2 size={18} className="text-blue-600" />
          <h3 className="text-lg font-semibold text-gray-900">Account Linkage</h3>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          {detail.account_linkage ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-gray-900">
                    {detail.account_linkage.account_name || 'Linked account'}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Last applied at {detail.account_linkage.last_applied_at ? new Date(detail.account_linkage.last_applied_at).toLocaleString() : 'unknown time'}
                  </div>
                </div>
                {renderApplyModeTag(detail.account_linkage.mode, detail.account_linkage.persisted)}
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="rounded-xl bg-gray-50 p-4">
                  <div className="text-xs uppercase tracking-wide text-gray-500">Field Overlay</div>
                  <div className="mt-1 text-xl font-semibold text-gray-900">
                    {detail.account_linkage.summary?.field_change_count || 0}
                  </div>
                </div>
                <div className="rounded-xl bg-gray-50 p-4">
                  <div className="text-xs uppercase tracking-wide text-gray-500">Auth Overlay</div>
                  <div className="mt-1 text-xl font-semibold text-gray-900">
                    {detail.account_linkage.summary?.auth_profile_change_count || 0}
                  </div>
                </div>
                <div className="rounded-xl bg-gray-50 p-4">
                  <div className="text-xs uppercase tracking-wide text-gray-500">Variables</div>
                  <div className="mt-1 text-xl font-semibold text-gray-900">
                    {detail.account_linkage.summary?.variable_change_count || 0}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-500">
              No account linkage has been reviewed for this recording yet. Use "Review Account Linkage" to preview captured write-backs.
            </div>
          )}
        </div>

        {recentApplyLogs.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-2">
            {recentApplyLogs.map(log => (
              <div key={log.id} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-gray-900">
                    {accounts.find(account => account.id === log.account_id)?.name || log.account_id}
                  </div>
                  {renderApplyModeTag(log.mode, log.persisted)}
                </div>
                <div className="mt-2 text-xs text-gray-500">
                  {log.created_at ? new Date(log.created_at).toLocaleString() : 'Unknown time'}
                  {log.applied_by ? ` by ${log.applied_by}` : ''}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-gray-500">Fields</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{log.summary?.field_change_count || 0}</div>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-gray-500">Auth</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{log.summary?.auth_profile_change_count || 0}</div>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-gray-500">Variables</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{log.summary?.variable_change_count || 0}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <RecordingEventTimeline
        events={events}
        pagination={pagination}
        loading={timelineLoading}
        onPreviousPage={() => loadEventsPage(Math.max(0, pagination.offset - pagination.limit))}
        onNextPage={() => loadEventsPage(pagination.offset + pagination.limit)}
      />

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <CheckCircle size={18} className="text-green-600" />
          <h3 className="text-lg font-semibold text-gray-900">Draft Results</h3>
        </div>

        {session.mode === 'workflow' ? (
          detail.workflow_drafts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
              Finish or regenerate this recording session to create workflow draft previews.
            </div>
          ) : (
            <div className="space-y-4">
              {detail.workflow_drafts.map(draft => (
                <WorkflowDraftPreview
                  key={draft.id}
                  draft={draft}
                  onEdit={() => setEditingDraft(draft)}
                  publishing={busyAction === `publish-workflow-${draft.id}`}
                  onPublish={rolloutConfig.publish_enabled ? (() => handlePublishWorkflowDraft(draft)) : undefined}
                  onOpenWorkflow={onOpenWorkflow}
                />
              ))}
            </div>
          )
        ) : (
          detail.test_run_drafts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
              Finish or regenerate this recording session to create test run draft previews.
            </div>
          ) : (
            <div className="space-y-4">
              {detail.test_run_drafts.map(draft => (
                <TestRunDraftPreview
                  key={draft.id}
                  draft={draft}
                  publishing={busyAction === `publish-test-run-${draft.id}`}
                  promotingTestRun={busyAction === `promote-test-run-${draft.id}`}
                  onPublish={rolloutConfig.publish_enabled ? (() => handlePublishTestRunDraft(draft)) : undefined}
                  onPromoteToTestRun={rolloutConfig.publish_enabled ? (() => handlePromoteTestRunDraft(draft)) : undefined}
                  onOpenWorkspace={() => onOpenPreconfiguredRuns?.({ draftId: draft.id })}
                  onOpenPreset={(presetId) => onOpenPreconfiguredRuns?.({ presetId })}
                  onOpenTestRun={(testRunId) => onOpenTestRuns?.(testRunId)}
                />
              ))}
            </div>
          )
        )}
      </section>

      {detail.draft_publish_logs.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <CheckCircle size={18} className="text-emerald-600" />
            <h3 className="text-lg font-semibold text-gray-900">Publish History</h3>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {detail.draft_publish_logs.map(log => (
              <div key={log.id} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-sm font-semibold text-gray-900">{log.target_asset_type}</div>
                <div className="mt-1 break-all text-xs text-gray-500">{log.target_asset_id}</div>
                <div className="mt-2 text-xs text-gray-500">
                  Published by {log.published_by || 'system'} at{' '}
                  {log.published_at ? new Date(log.published_at).toLocaleString() : 'unknown time'}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <Modal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        title="Export Raw Recording"
        size="xl"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setIsExportModalOpen(false)}>
              Close
            </Button>
            <Button onClick={downloadExportPayload}>
              <Download size={16} className="mr-2" />
              Download JSON
            </Button>
          </>
        )}
      >
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-gray-950 p-4 text-xs text-gray-100">
          {exportPayload}
        </pre>
      </Modal>

      <RecordingAccountApplyModal
        isOpen={isApplyModalOpen}
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        mode={applyMode}
        preview={accountPreview}
        loadingPreview={previewLoading}
        applying={busyAction === 'apply-account'}
        onClose={() => setIsApplyModalOpen(false)}
        onAccountChange={(accountId) => {
          setSelectedAccountId(accountId);
          void loadAccountPreview(accountId, applyMode);
        }}
        onModeChange={(mode) => {
          setApplyMode(mode);
          void loadAccountPreview(selectedAccountId, mode);
        }}
        onRefreshPreview={() => { void loadAccountPreview(selectedAccountId, applyMode); }}
        onApply={handleApplyToAccount}
      />

      <WorkflowDraftEditorModal
        isOpen={!!editingDraft}
        draft={editingDraft}
        checklists={checklists}
        securityRules={securityRules}
        saving={busyAction === `save-workflow-${editingDraft?.id || ''}`}
        onClose={() => setEditingDraft(null)}
        onSave={handleSaveWorkflowDraft}
      />
    </div>
  );
}
