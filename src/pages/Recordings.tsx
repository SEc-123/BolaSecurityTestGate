import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  KeyRound,
  Plus,
  RefreshCw,
  RotateCcw,
  Shield,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { Button, Input, Select } from '../components/ui/Form';
import { Modal } from '../components/ui/Modal';
import {
  accountsService,
  environmentsService,
  getRecordingAdminKey as loadStoredRecordingAdminKey,
  getRecordingApiKey as loadStoredRecordingApiKey,
  recordingsService,
  setRecordingAdminKey as persistRecordingAdminKey,
  setRecordingApiKey as persistRecordingApiKey,
} from '../lib/api-service';
import type {
  RecordingOpsSummary,
  RecordingRolloutConfig,
  RecordingSession,
} from '../lib/api-client';
import type { Account, Environment } from '../types';

type RecordingMode = 'workflow' | 'api';

type TargetFieldForm = {
  name: string;
  aliases: string;
  from_sources: string;
  bind_to_account_field: string;
  category: string;
};

const EMPTY_TARGET: TargetFieldForm = {
  name: '',
  aliases: '',
  from_sources: 'request.body,response.body,response.header',
  bind_to_account_field: '',
  category: '',
};

interface RecordingsProps {
  onOpenDetail: (sessionId: string) => void;
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

function renderAuditStatusTag(status: 'success' | 'failed') {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
      status === 'success'
        ? 'bg-emerald-100 text-emerald-700'
        : 'bg-red-100 text-red-700'
    }`}>
      {status}
    </span>
  );
}

export function Recordings({ onOpenDetail, rolloutConfig }: RecordingsProps) {
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [opsSummary, setOpsSummary] = useState<RecordingOpsSummary | null>(null);
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsError, setOpsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [recordingApiKeyInput, setRecordingApiKeyInput] = useState(() => loadStoredRecordingApiKey());
  const [recordingAdminKeyInput, setRecordingAdminKeyInput] = useState(() => loadStoredRecordingAdminKey());
  const [filters, setFilters] = useState({
    search: '',
    mode: 'all',
    status: 'all',
    environment_id: 'all',
    account_id: 'all',
  });
  const [formData, setFormData] = useState<{
    name: string;
    mode: RecordingMode;
    environment_id: string;
    account_id: string;
    role: string;
    source_tool: string;
  }>({
    name: '',
    mode: 'workflow',
    environment_id: '',
    account_id: '',
    role: '',
    source_tool: 'burp_montoya',
  });
  const [targetFields, setTargetFields] = useState<TargetFieldForm[]>([{ ...EMPTY_TARGET }]);

  useEffect(() => {
    void loadPage();
    void loadOpsSummary();
  }, []);

  async function loadPage() {
    try {
      setLoading(true);
      const [sessionsData, environmentsData, accountsData] = await Promise.all([
        recordingsService.listSessions(),
        environmentsService.list(),
        accountsService.list(),
      ]);
      setSessions(sessionsData);
      setEnvironments(environmentsData);
      setAccounts(accountsData);
    } catch (error) {
      console.error('Failed to load recording center:', error);
      alert('Failed to load recording center');
    } finally {
      setLoading(false);
    }
  }

  async function loadOpsSummary() {
    try {
      setOpsLoading(true);
      const summary = await recordingsService.getOpsSummary();
      setOpsSummary(summary);
      setOpsError('');
    } catch (error: any) {
      console.error('Failed to load recording observability summary:', error);
      setOpsSummary(null);
      setOpsError(error.message || 'Failed to load recording observability summary');
    } finally {
      setOpsLoading(false);
    }
  }

  async function handleSaveRecordingKeys() {
    persistRecordingApiKey(recordingApiKeyInput);
    persistRecordingAdminKey(recordingAdminKeyInput);
    await Promise.all([
      loadPage(),
      loadOpsSummary(),
    ]);
  }

  function resetCreateForm() {
    const defaultEnvironment = environments.find(env => env.is_active) || environments[0];
    const defaultMode: RecordingMode = rolloutConfig.workflow_mode_enabled
      ? 'workflow'
      : 'api';
    setFormData({
      name: '',
      mode: defaultMode,
      environment_id: defaultEnvironment?.id || '',
      account_id: '',
      role: '',
      source_tool: 'burp_montoya',
    });
    setTargetFields([{ ...EMPTY_TARGET }]);
  }

  function openCreateModal() {
    resetCreateForm();
    setIsCreateModalOpen(true);
  }

  function updateTarget(index: number, patch: Partial<TargetFieldForm>) {
    setTargetFields(prev => prev.map((item, currentIndex) => currentIndex === index ? { ...item, ...patch } : item));
  }

  function addTargetField() {
    setTargetFields(prev => [...prev, { ...EMPTY_TARGET }]);
  }

  function removeTargetField(index: number) {
    setTargetFields(prev => prev.filter((_, currentIndex) => currentIndex !== index));
  }

  async function handleCreateSession() {
    if (!rolloutConfig.recording_center_visible) {
      alert('Recording center is hidden in the current rollout phase.');
      return;
    }
    if (formData.mode === 'workflow' && !rolloutConfig.workflow_mode_enabled) {
      alert('Workflow recording is not enabled in the current rollout phase.');
      return;
    }
    if (formData.mode === 'api' && !rolloutConfig.api_mode_enabled) {
      alert('API recording is not enabled in the current rollout phase.');
      return;
    }
    if (!formData.name.trim()) {
      alert('Recording session name is required');
      return;
    }

    setBusyAction('create-session');
    try {
      const created = await recordingsService.createSession({
        ...formData,
        environment_id: formData.environment_id || undefined,
        account_id: formData.account_id || undefined,
        role: formData.role || undefined,
        target_fields: targetFields
          .filter(item => item.name.trim())
          .map(item => ({
            name: item.name.trim(),
            aliases: item.aliases.split(',').map(value => value.trim()).filter(Boolean),
            from_sources: item.from_sources.split(',').map(value => value.trim()).filter(Boolean),
            bind_to_account_field: item.bind_to_account_field.trim() || undefined,
            category: item.category.trim() || undefined,
          })),
      });

      setIsCreateModalOpen(false);
      await loadPage();
      onOpenDetail(created.id);
    } catch (error: any) {
      console.error('Failed to create recording session:', error);
      alert(`Failed to create recording session: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRetryDeadLetter(deadLetterId: string) {
    setBusyAction(`retry-dead-letter-${deadLetterId}`);
    try {
      await recordingsService.retryDeadLetter(deadLetterId);
      await Promise.all([
        loadPage(),
        loadOpsSummary(),
      ]);
      alert('Dead letter replay completed.');
    } catch (error: any) {
      console.error('Failed to retry recording dead letter:', error);
      alert(`Failed to retry recording dead letter: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDiscardDeadLetter(deadLetterId: string) {
    setBusyAction(`discard-dead-letter-${deadLetterId}`);
    try {
      await recordingsService.discardDeadLetter(deadLetterId);
      await loadOpsSummary();
      alert('Dead letter has been discarded.');
    } catch (error: any) {
      console.error('Failed to discard recording dead letter:', error);
      alert(`Failed to discard recording dead letter: ${error.message || 'Unknown error'}`);
    } finally {
      setBusyAction(null);
    }
  }

  const environmentMap = useMemo(
    () => new Map(environments.map(item => [item.id, item.name])),
    [environments]
  );
  const accountMap = useMemo(
    () => new Map(accounts.map(item => [item.id, item.name])),
    [accounts]
  );
  const selectableAccounts = useMemo(
    () => rolloutConfig.allowed_account_ids.length === 0
      ? accounts
      : accounts.filter(account => rolloutConfig.allowed_account_ids.includes(account.id)),
    [accounts, rolloutConfig.allowed_account_ids]
  );

  const filteredSessions = useMemo(() => {
    const normalizedSearch = filters.search.trim().toLowerCase();

    return [...sessions]
      .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
      .filter(session => {
        if (filters.mode !== 'all' && session.mode !== filters.mode) return false;
        if (filters.status !== 'all' && session.status !== filters.status) return false;
        if (filters.environment_id !== 'all' && (session.environment_id || '') !== filters.environment_id) return false;
        if (filters.account_id !== 'all' && (session.account_id || '') !== filters.account_id) return false;
        if (!normalizedSearch) return true;

        const environmentName = environmentMap.get(session.environment_id || '') || '';
        const accountName = accountMap.get(session.account_id || '') || '';
        return [
          session.name,
          session.mode,
          session.role,
          session.source_tool,
          environmentName,
          accountName,
        ]
          .filter(Boolean)
          .some(value => String(value).toLowerCase().includes(normalizedSearch));
      });
  }, [accountMap, environmentMap, filters, sessions]);

  const summary = useMemo(() => ({
    sessions: filteredSessions.length,
    events: filteredSessions.reduce((total, session) => total + session.event_count, 0),
    fieldHits: filteredSessions.reduce((total, session) => total + session.field_hit_count, 0),
    generated: filteredSessions.reduce((total, session) => total + session.generated_result_count, 0),
  }), [filteredSessions]);

  if (loading) {
    return <div className="p-8 text-gray-500">Loading recording center...</div>;
  }

  return (
    <div className="space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Recording Center</h1>
          <p className="mt-1 text-gray-600">
            Review Burp recording sessions, filter by mode and scope, then open the detail page to confirm events and generated drafts.
          </p>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => { void Promise.all([loadPage(), loadOpsSummary()]); }}>
            <RefreshCw size={18} className="mr-2" />
            Refresh
          </Button>
          <Button
            onClick={openCreateModal}
            disabled={!rolloutConfig.recording_center_visible || (!rolloutConfig.workflow_mode_enabled && !rolloutConfig.api_mode_enabled)}
          >
            <Plus size={18} className="mr-2" />
            New Session
          </Button>
        </div>
      </div>

      <div className="grid gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm md:grid-cols-2 xl:grid-cols-5">
        <Input
          label="Search"
          value={filters.search}
          onChange={event => setFilters(prev => ({ ...prev, search: event.target.value }))}
          placeholder="Session, environment, account..."
        />
        <Select
          label="Mode"
          value={filters.mode}
          onChange={event => setFilters(prev => ({ ...prev, mode: event.target.value }))}
          options={[
            { value: 'all', label: 'All modes' },
            { value: 'workflow', label: 'Workflow' },
            { value: 'api', label: 'API' },
          ]}
        />
        <Select
          label="Status"
          value={filters.status}
          onChange={event => setFilters(prev => ({ ...prev, status: event.target.value }))}
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'recording', label: 'Recording' },
            { value: 'processing', label: 'Processing' },
            { value: 'completed', label: 'Completed' },
            { value: 'finished', label: 'Finished' },
            { value: 'published', label: 'Published' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
        <Select
          label="Environment"
          value={filters.environment_id}
          onChange={event => setFilters(prev => ({ ...prev, environment_id: event.target.value }))}
          options={[
            { value: 'all', label: 'All environments' },
            ...environments.map(item => ({ value: item.id, label: item.name })),
          ]}
        />
        <Select
          label="Test Account"
          value={filters.account_id}
          onChange={event => setFilters(prev => ({ ...prev, account_id: event.target.value }))}
          options={[
            { value: 'all', label: 'All accounts' },
            ...selectableAccounts.map(item => ({ value: item.id, label: item.name })),
          ]}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Visible Sessions</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{summary.sessions}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Visible Events</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{summary.events}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Field Hits</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{summary.fieldHits}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">Generated Results</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{summary.generated}</div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-sky-50 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-slate-900">
              <Shield size={18} />
              <h2 className="text-xl font-semibold">Security, Stability, Observability</h2>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Configure recording keys, review ingress limits, and operate dead letters without leaving the recording center.
            </p>
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => void loadOpsSummary()} loading={opsLoading}>
              <Activity size={16} className="mr-2" />
              Refresh Ops
            </Button>
            <Button onClick={handleSaveRecordingKeys}>
              <KeyRound size={16} className="mr-2" />
              Save Keys
            </Button>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <Input
              label="Recording API Key"
              type="password"
              value={recordingApiKeyInput}
              onChange={event => setRecordingApiKeyInput(event.target.value)}
              placeholder="Used for create / finish / batch ingest protected routes"
            />
            <p className="text-xs text-slate-500">
              Keep this aligned with `RECORDING_API_KEY` when ingress protection is enabled.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <Input
              label="Recording Admin Key"
              type="password"
              value={recordingAdminKeyInput}
              onChange={event => setRecordingAdminKeyInput(event.target.value)}
              placeholder="Used for publish, formal promotion, account write-back, and ops actions"
            />
            <p className="text-xs text-slate-500">
              Keep this aligned with `RECORDING_ADMIN_API_KEY` when privileged actions are isolated.
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-sky-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-sky-800">
            <Shield size={16} />
            Rollout Phase: {rolloutConfig.phase}
          </div>
          <div className="mt-2 text-sm text-slate-600">{rolloutConfig.notes}</div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className={`rounded-full px-3 py-1 ${rolloutConfig.workflow_mode_enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'}`}>
              Workflow Mode {rolloutConfig.workflow_mode_enabled ? 'Enabled' : 'Disabled'}
            </span>
            <span className={`rounded-full px-3 py-1 ${rolloutConfig.api_mode_enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'}`}>
              API Mode {rolloutConfig.api_mode_enabled ? 'Enabled' : 'Disabled'}
            </span>
            <span className={`rounded-full px-3 py-1 ${rolloutConfig.publish_enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              Publish {rolloutConfig.publish_enabled ? 'Enabled' : 'Disabled'}
            </span>
            {rolloutConfig.allowed_account_ids.length > 0 && (
              <span className="rounded-full bg-blue-100 px-3 py-1 text-blue-700">
                Allowlist {rolloutConfig.allowed_account_ids.length} account(s)
              </span>
            )}
          </div>
        </div>

        {opsError ? (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <div className="flex items-center gap-2 font-medium">
              <ShieldAlert size={16} />
              Ops summary unavailable
            </div>
            <div className="mt-1">{opsError}</div>
          </div>
        ) : opsSummary && (
          <>
            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-sm text-slate-500">Ingress Auth</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {opsSummary.ingress.api_key_required ? 'API key required' : 'Open'}
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  Batch limit {opsSummary.ingress.max_batch_size}, {opsSummary.ingress.max_batches_per_minute} batches/min
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-sm text-slate-500">Privilege Isolation</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {opsSummary.privilege.admin_key_required ? 'Admin key required' : 'Shared privilege'}
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  {opsSummary.privilege.privileged_actions.length} protected actions
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-sm text-slate-500">Pending Dead Letters</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{opsSummary.totals.pending_dead_letters}</div>
                <div className="mt-2 text-xs text-slate-500">Total {opsSummary.totals.dead_letters}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-sm text-slate-500">Audit Events</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{opsSummary.totals.audit_logs}</div>
                <div className="mt-2 text-xs text-slate-500">Recent activity retained below</div>
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Sessions Created</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{opsSummary.metrics.recording_sessions_created_total}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Events Ingested</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{opsSummary.metrics.recording_events_ingested_total}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Deduplicated</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{opsSummary.metrics.recording_event_deduplicated_total}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Batch Failures</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{opsSummary.metrics.recording_batches_failed_total}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Promotions</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{opsSummary.metrics.promotion_success_total}</div>
              </div>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Draft Gen Last</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{opsSummary.metrics.draft_generation_duration_ms_last} ms</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Draft Gen Avg</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{opsSummary.metrics.draft_generation_duration_ms_avg} ms</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Draft Gen Max</div>
                <div className="mt-1 text-xl font-semibold text-slate-900">{opsSummary.metrics.draft_generation_duration_ms_max} ms</div>
              </div>
            </div>

            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">Recent Audit Logs</h3>
                    <p className="text-sm text-slate-500">Session creation, finish, publish, overwrite, and recovery actions.</p>
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  {opsSummary.audit_logs.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                      No audit logs yet.
                    </div>
                  ) : opsSummary.audit_logs.map(log => (
                    <div key={log.id} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900">{log.action}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {new Date(log.created_at).toLocaleString()}
                            {log.actor ? ` · actor ${log.actor}` : ''}
                            {log.target_type ? ` · ${log.target_type}` : ''}
                          </div>
                        </div>
                        {renderAuditStatusTag(log.status)}
                      </div>
                      {log.message && (
                        <div className="mt-2 text-sm text-slate-600">{log.message}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">Dead Letter Queue</h3>
                  <p className="text-sm text-slate-500">Failed ingest batches and generation jobs can be replayed or discarded here.</p>
                </div>
                <div className="mt-4 space-y-3">
                  {opsSummary.dead_letters.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                      No dead letters recorded.
                    </div>
                  ) : opsSummary.dead_letters.map(deadLetter => (
                    <div key={deadLetter.id} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900">{deadLetter.failure_stage}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {new Date(deadLetter.created_at).toLocaleString()}
                            {deadLetter.session_id ? ` · session ${deadLetter.session_id}` : ''}
                            {` · batch ${deadLetter.batch_size}`}
                          </div>
                        </div>
                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                          deadLetter.status === 'pending'
                            ? 'bg-amber-100 text-amber-700'
                            : deadLetter.status === 'replayed'
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-slate-200 text-slate-700'
                        }`}>
                          {deadLetter.status}
                        </span>
                      </div>
                      <div className="mt-2 text-sm text-slate-600">{deadLetter.error_message}</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleRetryDeadLetter(deadLetter.id)}
                          loading={busyAction === `retry-dead-letter-${deadLetter.id}`}
                          disabled={deadLetter.status !== 'pending'}
                        >
                          <RotateCcw size={14} className="mr-1" />
                          Retry
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDiscardDeadLetter(deadLetter.id)}
                          loading={busyAction === `discard-dead-letter-${deadLetter.id}`}
                          disabled={deadLetter.status !== 'pending'}
                        >
                          <Trash2 size={14} className="mr-1" />
                          Discard
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="space-y-4">
        {filteredSessions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-sm text-gray-500">
            No recording sessions match the current filters.
          </div>
        ) : filteredSessions.map(session => (
          <div key={session.id} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-semibold text-gray-900">{session.name}</h2>
                  {renderStatusTag(session.status)}
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${session.mode === 'workflow' ? 'bg-purple-100 text-purple-700' : 'bg-sky-100 text-sky-700'}`}>
                    {session.mode.toUpperCase()}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500">
                  <span>Environment: {environmentMap.get(session.environment_id || '') || 'Unbound'}</span>
                  <span>Account: {accountMap.get(session.account_id || '') || 'Unbound'}</span>
                  <span>Role: {session.role || 'Unspecified'}</span>
                  <span>Started: {new Date(session.started_at).toLocaleString()}</span>
                </div>
              </div>
              <Button onClick={() => onOpenDetail(session.id)}>
                Open Detail
                <ArrowRight size={16} className="ml-2" />
              </Button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3 xl:grid-cols-4">
              <div className="rounded-xl bg-gray-50 p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500">Events</div>
                <div className="mt-1 text-xl font-semibold text-gray-900">{session.event_count}</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500">Field Hits</div>
                <div className="mt-1 text-xl font-semibold text-gray-900">{session.field_hit_count}</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500">Runtime Contexts</div>
                <div className="mt-1 text-xl font-semibold text-gray-900">{session.runtime_context_count}</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500">Generated Results</div>
                <div className="mt-1 text-xl font-semibold text-gray-900">{session.generated_result_count}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        title="Create Recording Session"
        size="xl"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setIsCreateModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateSession} loading={busyAction === 'create-session'}>
              Create Session
            </Button>
          </>
        )}
      >
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label="Session Name"
              value={formData.name}
              onChange={event => setFormData(prev => ({ ...prev, name: event.target.value }))}
              placeholder="e.g., Login workflow recording"
            />
            <Select
              label="Mode"
              value={formData.mode}
              onChange={event => setFormData(prev => ({ ...prev, mode: event.target.value as RecordingMode }))}
              options={[
                ...(rolloutConfig.workflow_mode_enabled ? [{ value: 'workflow', label: 'Workflow Recording' }] : []),
                ...(rolloutConfig.api_mode_enabled ? [{ value: 'api', label: 'API Recording' }] : []),
              ]}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Select
              label="Environment"
              value={formData.environment_id}
              onChange={event => setFormData(prev => ({ ...prev, environment_id: event.target.value }))}
              options={[
                { value: '', label: 'Select environment' },
                ...environments.map(item => ({ value: item.id, label: item.name })),
              ]}
            />
            <Select
              label="Test Account"
              value={formData.account_id}
              onChange={event => setFormData(prev => ({ ...prev, account_id: event.target.value }))}
              options={[
                { value: '', label: 'Select account' },
                ...selectableAccounts.map(item => ({ value: item.id, label: item.name })),
              ]}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label="Role"
              value={formData.role}
              onChange={event => setFormData(prev => ({ ...prev, role: event.target.value }))}
              placeholder="attacker / victim / admin"
            />
            <Input
              label="Source Tool"
              value={formData.source_tool}
              onChange={event => setFormData(prev => ({ ...prev, source_tool: event.target.value }))}
              placeholder="burp_montoya"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Target Fields</h3>
                <p className="text-sm text-gray-500">Used for field hit extraction and account linkage during recording.</p>
              </div>
              <Button variant="secondary" size="sm" onClick={addTargetField}>
                <Plus size={16} className="mr-1" />
                Add Field
              </Button>
            </div>

            {targetFields.map((target, index) => (
              <div key={`target-${index}`} className="rounded-xl border border-gray-200 p-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <Input
                    label="Field Name"
                    value={target.name}
                    onChange={event => updateTarget(index, { name: event.target.value })}
                    placeholder="token / user_id / object_id"
                  />
                  <Input
                    label="Aliases"
                    value={target.aliases}
                    onChange={event => updateTarget(index, { aliases: event.target.value })}
                    placeholder="access_token, jwt, uid"
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Input
                    label="Source Locations"
                    value={target.from_sources}
                    onChange={event => updateTarget(index, { from_sources: event.target.value })}
                    placeholder="request.body,response.body,response.header"
                  />
                  <Input
                    label="Bind To Account Field"
                    value={target.bind_to_account_field}
                    onChange={event => updateTarget(index, { bind_to_account_field: event.target.value })}
                    placeholder="access_token / session_id / user_id"
                  />
                </div>
                <div className="flex flex-wrap items-end gap-4">
                  <Input
                    label="Category"
                    value={target.category}
                    onChange={event => updateTarget(index, { category: event.target.value })}
                    placeholder="IDENTITY / OBJECT_ID"
                  />
                  {targetFields.length > 1 && (
                    <Button variant="danger" size="sm" onClick={() => removeTargetField(index)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
