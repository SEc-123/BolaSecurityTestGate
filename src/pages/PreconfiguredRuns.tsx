import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, FileText, Play, RefreshCw } from 'lucide-react';
import { TestRunDraftEditorModal } from '../components/recordings/TestRunDraftEditorModal';
import { TestRunDraftPreview } from '../components/recordings/TestRunDraftPreview';
import { Button, Select } from '../components/ui/Form';
import {
  accountsService,
  apiTemplatesService,
  environmentsService,
  executionService,
  recordingsService,
  testRunPresetsService,
} from '../lib/api-service';
import type { RecordingRolloutConfig, RecordingSession, TestRunDraft, TestRunPreset } from '../lib/api-client';
import type { Account, ApiTemplate, Environment } from '../types';

interface PreconfiguredRunsProps {
  focusDraftId?: string;
  focusPresetId?: string;
  onDraftFocusHandled?: () => void;
  onPresetFocusHandled?: () => void;
  onOpenRecordingDetail?: (sessionId: string) => void;
  onOpenTemplates?: () => void;
  onOpenTestRuns?: (runId?: string) => void;
  rolloutConfig: RecordingRolloutConfig;
}

type DraftFilter = 'all' | 'preconfigured' | 'published';

export function PreconfiguredRuns({
  focusDraftId,
  focusPresetId,
  onDraftFocusHandled,
  onPresetFocusHandled,
  onOpenRecordingDetail,
  onOpenTemplates,
  onOpenTestRuns,
  rolloutConfig,
}: PreconfiguredRunsProps) {
  const [drafts, setDrafts] = useState<TestRunDraft[]>([]);
  const [presets, setPresets] = useState<TestRunPreset[]>([]);
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [templates, setTemplates] = useState<ApiTemplate[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [draftFilter, setDraftFilter] = useState<DraftFilter>('all');
  const [editingDraft, setEditingDraft] = useState<TestRunDraft | null>(null);
  const [highlightedDraftId, setHighlightedDraftId] = useState<string | null>(null);
  const [highlightedPresetId, setHighlightedPresetId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [draftData, presetData, sessionData, templateData, environmentData, accountData] = await Promise.all([
        recordingsService.listTestRunDrafts(),
        testRunPresetsService.list(),
        recordingsService.listSessions(),
        apiTemplatesService.list(),
        environmentsService.list(),
        accountsService.list(),
      ]);
      setDrafts(draftData || []);
      setPresets(presetData || []);
      setSessions(sessionData || []);
      setTemplates(templateData || []);
      setEnvironments(environmentData || []);
      setAccounts(accountData || []);
    } catch (error) {
      console.error('Failed to load preconfigured runs workspace:', error);
      alert('Failed to load preconfigured runs workspace');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!focusDraftId || drafts.length === 0) {
      return;
    }

    const target = drafts.find((draft) => draft.id === focusDraftId);
    if (!target) {
      return;
    }

    setHighlightedDraftId(target.id);
    document.getElementById(`test-run-draft-${target.id}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
    onDraftFocusHandled?.();

    const timeoutId = window.setTimeout(() => {
      setHighlightedDraftId((current) => current === target.id ? null : current);
    }, 4000);

    return () => window.clearTimeout(timeoutId);
  }, [drafts, focusDraftId, onDraftFocusHandled]);

  useEffect(() => {
    if (!focusPresetId || presets.length === 0) {
      return;
    }

    const target = presets.find((preset) => preset.id === focusPresetId);
    if (!target) {
      return;
    }

    setHighlightedPresetId(target.id);
    document.getElementById(`test-run-preset-${target.id}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
    onPresetFocusHandled?.();

    const timeoutId = window.setTimeout(() => {
      setHighlightedPresetId((current) => current === target.id ? null : current);
    }, 4000);

    return () => window.clearTimeout(timeoutId);
  }, [focusPresetId, onPresetFocusHandled, presets]);

  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions]
  );
  const templateById = useMemo(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates]
  );

  const visibleDrafts = useMemo(() => {
    if (draftFilter === 'all') {
      return drafts;
    }
    return drafts.filter((draft) => draft.status === draftFilter);
  }, [draftFilter, drafts]);

  async function handleSaveDraft(payload: {
    name?: string;
    template?: {
      name?: string;
      description?: string;
      variables?: Array<Record<string, any>>;
      failure_patterns?: Array<Record<string, any>>;
      failure_logic?: 'OR' | 'AND';
    };
    preset?: {
      name?: string;
      description?: string;
      environment_id?: string;
      default_account_id?: string;
    };
  }) {
    if (!editingDraft) {
      return;
    }

    setBusyAction(`save-${editingDraft.id}`);
    try {
      await recordingsService.updateTestRunDraft(editingDraft.id, payload);
      setEditingDraft(null);
      await loadData();
      alert(`API draft "${editingDraft.name}" has been updated.`);
    } catch (error: any) {
      console.error('Failed to update API draft:', error);
      alert(`Failed to update API draft: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePublishDraft(draft: TestRunDraft) {
    setBusyAction(`publish-${draft.id}`);
    try {
      await recordingsService.publishTestRunDraft(draft.id, {
        published_by: 'preconfigured_runs_workspace',
      });
      await loadData();
      alert(`API draft "${draft.name}" has been published as a reusable preset.`);
    } catch (error: any) {
      console.error('Failed to publish API draft:', error);
      alert(`Failed to publish API draft: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCreateTemplate(draft: TestRunDraft) {
    setBusyAction(`template-${draft.id}`);
    try {
      const result = await recordingsService.createApiTemplateFromTestRunDraft(draft.id, {
        published_by: 'preconfigured_runs_workspace',
      });
      await loadData();
      alert(`API template "${result.template.name}" has been created from "${draft.name}".`);
    } catch (error: any) {
      console.error('Failed to create API template from draft:', error);
      alert(`Failed to create API template from draft: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePromoteTestRun(draft: TestRunDraft) {
    setBusyAction(`promote-run-${draft.id}`);
    try {
      const result = await recordingsService.promoteTestRunDraftToTestRun(draft.id, {
        published_by: 'preconfigured_runs_workspace',
      });
      await loadData();
      alert(result.reused_existing
        ? `Formal test run "${result.test_run.name || result.test_run.id}" already exists and has been reopened.`
        : `Formal test run "${result.test_run.name || result.test_run.id}" has been created from "${draft.name}".`);
      onOpenTestRuns?.(result.test_run.id);
    } catch (error: any) {
      console.error('Failed to promote API draft to formal test run:', error);
      alert(`Failed to promote API draft to formal test run: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRunPreset(preset: TestRunPreset) {
    setBusyAction(`run-preset-${preset.id}`);
    try {
      await executionService.executePreset({
        preset_id: preset.id,
        name: `${preset.name} - ${new Date().toLocaleString()}`,
      });
      alert(`Preset "${preset.name}" has started running in Test Runs.`);
    } catch (error: any) {
      console.error('Failed to run preset:', error);
      alert(`Failed to run preset: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Preconfigured Runs</h1>
          <p className="mt-1 text-sm text-gray-600">
            API recordings land here first as template drafts. Save the template first, then optionally add environment/account binding later when you want a preset or a runnable test run.
          </p>
        </div>

        <div className="flex gap-3">
          <div className="min-w-52">
            <Select
              label="Draft Status"
              value={draftFilter}
              onChange={(event) => setDraftFilter(event.target.value as DraftFilter)}
              options={[
                { value: 'all', label: 'All drafts' },
                { value: 'preconfigured', label: 'Preconfigured only' },
                { value: 'published', label: 'Published only' },
              ]}
            />
          </div>
          <Button variant="secondary" onClick={() => void loadData()}>
            <RefreshCw size={16} className="mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      <section className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
        {!rolloutConfig.publish_enabled && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            Rollout phase {rolloutConfig.phase} keeps preset publish, template creation, and formal promotion disabled.
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-5">
          <div className="rounded-xl border border-indigo-100 bg-white p-4">
            <div className="text-sm text-gray-500">All Drafts</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900">{drafts.length}</div>
          </div>
          <div className="rounded-xl border border-indigo-100 bg-white p-4">
            <div className="text-sm text-gray-500">Preconfigured</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900">
              {drafts.filter((draft) => draft.status === 'preconfigured').length}
            </div>
          </div>
          <div className="rounded-xl border border-indigo-100 bg-white p-4">
            <div className="text-sm text-gray-500">Published Presets</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900">{presets.length}</div>
          </div>
          <div className="rounded-xl border border-indigo-100 bg-white p-4">
            <div className="text-sm text-gray-500">Generated Templates</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900">
              {drafts.reduce((count, draft) => count + Number(draft.summary?.published_template_count || 0), 0)}
            </div>
          </div>
          <div className="rounded-xl border border-indigo-100 bg-white p-4">
            <div className="text-sm text-gray-500">Promoted Test Runs</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900">
              {drafts.reduce((count, draft) => count + Number(draft.summary?.published_test_run_count || 0), 0)}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <FileText size={18} className="text-blue-600" />
          <h2 className="text-xl font-semibold text-gray-900">API Template Drafts</h2>
        </div>

        {loading ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
            Loading preconfigured drafts...
          </div>
        ) : visibleDrafts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
            No API drafts match the current filter.
          </div>
        ) : (
          <div className="space-y-5">
            {visibleDrafts.map((draft) => {
              const sourceSession = sessionById.get(draft.session_id);
              return (
                <div
                  key={draft.id}
                  id={`test-run-draft-${draft.id}`}
                  className={`rounded-3xl border p-5 transition-all ${
                    highlightedDraftId === draft.id
                      ? 'border-blue-300 bg-blue-50 ring-2 ring-blue-100'
                      : 'border-transparent bg-transparent'
                  }`}
                >
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">
                        Source Recording: {sourceSession?.name || draft.session_id}
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        Session mode {sourceSession?.mode || 'api'} · Updated {new Date(draft.updated_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {sourceSession && onOpenRecordingDetail && (
                        <Button variant="secondary" size="sm" onClick={() => onOpenRecordingDetail(sourceSession.id)}>
                          <ExternalLink size={14} className="mr-1" />
                          Open Recording
                        </Button>
                      )}
                      {draft.summary?.latest_published_template_id && onOpenTemplates && (
                        <Button variant="secondary" size="sm" onClick={onOpenTemplates}>
                          <FileText size={14} className="mr-1" />
                          Open Templates
                        </Button>
                      )}
                    </div>
                  </div>

                  <TestRunDraftPreview
                    draft={draft}
                    publishing={busyAction === `publish-${draft.id}`}
                    creatingTemplate={busyAction === `template-${draft.id}`}
                    promotingTestRun={busyAction === `promote-run-${draft.id}`}
                    onEdit={() => setEditingDraft(draft)}
                    onPublish={rolloutConfig.publish_enabled ? (() => void handlePublishDraft(draft)) : undefined}
                    onCreateTemplate={rolloutConfig.publish_enabled ? (() => void handleCreateTemplate(draft)) : undefined}
                    onPromoteToTestRun={rolloutConfig.publish_enabled ? (() => void handlePromoteTestRun(draft)) : undefined}
                    onOpenPreset={(presetId) => {
                      const target = presets.find((preset) => preset.id === presetId);
                      if (!target) return;
                      setHighlightedPresetId(target.id);
                      document.getElementById(`test-run-preset-${target.id}`)?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center',
                      });
                    }}
                    onOpenTestRun={(testRunId) => onOpenTestRuns?.(testRunId)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Play size={18} className="text-emerald-600" />
          <h2 className="text-xl font-semibold text-gray-900">Published Presets</h2>
        </div>

        {presets.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
            No reusable presets have been published from recordings yet.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {presets.map((preset) => {
              const sourceDraft = drafts.find((draft) => draft.id === preset.source_draft_id);
              const sourceSession = sourceDraft ? sessionById.get(sourceDraft.session_id) : undefined;
              const template = templateById.get(preset.template_id);

              return (
                <div
                  key={preset.id}
                  id={`test-run-preset-${preset.id}`}
                  className={`rounded-2xl border bg-white p-5 shadow-sm transition-all ${
                    highlightedPresetId === preset.id
                      ? 'border-emerald-300 ring-2 ring-emerald-100'
                      : 'border-emerald-100'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-lg font-semibold text-gray-900">{preset.name}</div>
                      <div className="mt-1 text-sm text-gray-500">{preset.description || 'No description'}</div>
                    </div>
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                      Reusable Preset
                    </span>
                  </div>

                  <div className="mt-4 space-y-2 text-sm text-gray-700">
                    <div>Template: {template?.name || preset.template_id}</div>
                    <div>Source Recording: {sourceSession?.name || sourceDraft?.session_id || 'Unknown'}</div>
                    {(preset.environment_id || preset.default_account_id) && (
                      <>
                        <div>Environment: {preset.environment_id || 'Unbound'}</div>
                        <div>Default Account: {preset.default_account_id || 'Unbound'}</div>
                      </>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    {sourceSession && onOpenRecordingDetail && (
                      <Button variant="secondary" size="sm" onClick={() => onOpenRecordingDetail(sourceSession.id)}>
                        <ExternalLink size={14} className="mr-1" />
                        Open Recording
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => void handleRunPreset(preset)}
                      loading={busyAction === `run-preset-${preset.id}`}
                    >
                      <Play size={14} className="mr-1" />
                      Run Preset
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <TestRunDraftEditorModal
        isOpen={!!editingDraft}
        draft={editingDraft}
        environments={environments}
        accounts={accounts}
        saving={busyAction === `save-${editingDraft?.id || ''}`}
        onClose={() => setEditingDraft(null)}
        onSave={handleSaveDraft}
      />
    </div>
  );
}
