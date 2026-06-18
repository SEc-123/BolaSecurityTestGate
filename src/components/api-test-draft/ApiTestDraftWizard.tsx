import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Play, Sparkles } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button, Checkbox, Input, Select } from '../ui/Form';
import { recordingsService } from '../../lib/api-service';
import type { RecordingSession, RecordingEvent, TestRunDraft } from '../../lib/api-client';
import type { Account, Environment } from '../../types';
import { VariableSuggestionTable } from './VariableSuggestionTable';
import { FailureSuggestionPanel } from './FailureSuggestionPanel';

interface ApiTestDraftWizardProps {
  isOpen: boolean;
  sessions: RecordingSession[];
  environments: Environment[];
  accounts: Account[];
  initialSessionId?: string;
  initialEventId?: string;
  onClose: () => void;
  onPublished?: (draftId: string) => void;
  onRunCreated?: (testRunId?: string) => void;
  onOpenWorkspace?: (draftId: string) => void;
}

export function ApiTestDraftWizard({
  isOpen,
  sessions,
  environments,
  accounts,
  initialSessionId,
  initialEventId,
  onClose,
  onPublished,
  onRunCreated,
  onOpenWorkspace,
}: ApiTestDraftWizardProps) {
  const apiSessions = useMemo(
    () => sessions.filter((session) => session.mode === 'api'),
    [sessions]
  );
  const [sessionId, setSessionId] = useState(initialSessionId || '');
  const [eventId, setEventId] = useState(initialEventId || '');
  const [events, setEvents] = useState<RecordingEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [draft, setDraft] = useState<TestRunDraft | null>(null);
  const [generatePreset, setGeneratePreset] = useState(true);
  const [generateAssertions, setGenerateAssertions] = useState(true);
  const [generateFailurePatterns, setGenerateFailurePatterns] = useState(true);
  const [selectedVariableIds, setSelectedVariableIds] = useState<string[]>([]);
  const [selectedAssertionIds, setSelectedAssertionIds] = useState<string[]>([]);
  const [selectedFailureIds, setSelectedFailureIds] = useState<string[]>([]);
  const [environmentId, setEnvironmentId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [runName, setRunName] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setSessionId(initialSessionId || apiSessions[0]?.id || '');
    setEventId(initialEventId || '');
    setDraft(null);
    setSelectedVariableIds([]);
    setSelectedAssertionIds([]);
    setSelectedFailureIds([]);
    setEnvironmentId('');
    setAccountId('');
    setRunName('');
  }, [isOpen, initialSessionId, initialEventId, apiSessions]);

  useEffect(() => {
    if (!isOpen || !sessionId) {
      setEvents([]);
      return;
    }
    let mounted = true;
    setLoadingEvents(true);
    recordingsService.getEvents(sessionId, { limit: 100, offset: 0 })
      .then((result) => {
        if (!mounted) return;
        setEvents(result.events || []);
        if (initialEventId && result.events.some((item) => item.id === initialEventId)) {
          setEventId(initialEventId);
        } else if (!result.events.some((item) => item.id === eventId)) {
          setEventId(result.events[0]?.id || '');
        }
      })
      .catch((error) => {
        console.error('Failed to load recording events for wizard:', error);
        if (mounted) {
          setEvents([]);
          alert('Failed to load recording events');
        }
      })
      .finally(() => {
        if (mounted) setLoadingEvents(false);
      });
    return () => { mounted = false; };
  }, [isOpen, sessionId, initialEventId]);

  const payload = draft?.draft_payload || {};
  const templatePayload = payload.template || {};
  const variableSuggestions = Array.isArray(templatePayload.variables) ? templatePayload.variables : [];
  const assertionSuggestions = Array.isArray(templatePayload.assertion_candidates) ? templatePayload.assertion_candidates : [];
  const failureSuggestions = Array.isArray(templatePayload.failure_patterns) ? templatePayload.failure_patterns : [];
  const accountBindingSuggestions = Array.isArray(templatePayload.account_binding_suggestions) ? templatePayload.account_binding_suggestions : [];

  useEffect(() => {
    if (!draft) return;
    setSelectedVariableIds(variableSuggestions.map((item: any, index: number) => String(item.id || item.name || index)));
    setSelectedAssertionIds(assertionSuggestions.map((item: any, index: number) => String(item.id || item.path || item.kind || index)));
    setSelectedFailureIds(failureSuggestions.map((item: any, index: number) => String(item.id || item.path || item.type || index)));
    setRunName(draft.name.replace(/ Draft$/i, ''));
  }, [draft]);

  function toggle(setter: (value: string[] | ((current: string[]) => string[])) => void, id: string) {
    setter((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function handleGenerate() {
    if (!sessionId || !eventId) {
      alert('Please choose a recording session and event first.');
      return;
    }
    setGenerating(true);
    try {
      const result = await recordingsService.createApiTestDrafts(sessionId, {
        eventIds: [eventId],
        generatePreset,
        generateTemplate: true,
        generateAssertions,
        generateFailurePatterns,
      });
      setDraft(result.drafts?.[0] || null);
    } catch (error: any) {
      console.error('Failed to generate API test draft:', error);
      alert(error.message || 'Failed to generate API test draft');
    } finally {
      setGenerating(false);
    }
  }

  async function handlePublish(createPreset: boolean) {
    if (!draft) return;
    setPublishing(true);
    try {
      const result = await recordingsService.publishApiTestDraft(draft.id, {
        createPreset,
        template_name: runName || undefined,
      });
      onPublished?.(draft.id);
      if (result?.preset) {
        alert(`Published template and preset from ${draft.name}`);
      } else {
        alert(`Saved template from ${draft.name}`);
      }
    } catch (error: any) {
      console.error('Failed to publish API test draft:', error);
      alert(error.message || 'Failed to publish API test draft');
    } finally {
      setPublishing(false);
    }
  }

  async function handlePublishAndRun() {
    if (!draft) return;
    setPublishing(true);
    try {
      const result = await recordingsService.publishAndRunApiTestDraft(draft.id, {
        test_run_name: runName || undefined,
        environment_id: environmentId || undefined,
        account_ids: accountId ? [accountId] : undefined,
      });
      alert(`Created and started formal test run from ${draft.name}`);
      onRunCreated?.(result?.test_run?.id);
    } catch (error: any) {
      console.error('Failed to publish and run API test draft:', error);
      alert(error.message || 'Failed to publish and run API test draft');
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="API Test Draft Review Wizard"
      size="xl"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {draft && onOpenWorkspace && (
            <Button variant="secondary" onClick={() => onOpenWorkspace(draft.id)}>
              Open Workspace
            </Button>
          )}
          {draft && (
            <Button variant="secondary" loading={publishing} onClick={() => void handlePublish(false)}>
              Save Template
            </Button>
          )}
          {draft && (
            <Button variant="secondary" loading={publishing} onClick={() => void handlePublish(true)}>
              Publish Preset
            </Button>
          )}
          {draft ? (
            <Button loading={publishing} onClick={() => void handlePublishAndRun()}>
              <Play size={14} className="mr-1" />
              Publish & Run
            </Button>
          ) : (
            <Button loading={generating} onClick={() => void handleGenerate()}>
              <Sparkles size={14} className="mr-1" />
              Generate Draft
            </Button>
          )}
        </>
      )}
    >
      <div className="space-y-6">
        <section className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Select
              label="1. Choose Recording Session"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              options={[
                { value: '', label: 'Select a recording session' },
                ...apiSessions.map((session) => ({
                  value: session.id,
                  label: `${session.name} · ${(session.intent || 'api_test_seed').replace(/_/g, ' ')} · ${session.status}`,
                })),
              ]}
            />
            <Select
              label="2. Choose Event"
              value={eventId}
              onChange={(event) => setEventId(event.target.value)}
              options={[
                { value: '', label: loadingEvents ? 'Loading events...' : 'Select an event' },
                ...events.map((item) => ({
                  value: item.id,
                  label: `#${item.sequence} ${item.method} ${item.path} (${item.response_status || 'n/a'})`,
                })),
              ]}
            />
          </div>

          <div className="mt-2 grid gap-3 md:grid-cols-3">
            <Checkbox label="Generate preset suggestion" checked={generatePreset} onChange={(e) => setGeneratePreset(e.target.checked)} />
            <Checkbox label="Generate assertion suggestions" checked={generateAssertions} onChange={(e) => setGenerateAssertions(e.target.checked)} />
            <Checkbox label="Generate failure suggestions" checked={generateFailurePatterns} onChange={(e) => setGenerateFailurePatterns(e.target.checked)} />
          </div>
        </section>

        {draft && (
          <section className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.65fr)]">
            <div className="space-y-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900"><CheckCircle2 size={16} className="text-green-600" />Request Template</div>
                <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-gray-100 whitespace-pre-wrap">{templatePayload.raw_request || 'No raw request available'}</pre>
              </div>
              <VariableSuggestionTable
                suggestions={variableSuggestions}
                selectedIds={selectedVariableIds}
                onToggle={(id) => toggle(setSelectedVariableIds, id)}
              />
              <div className="grid gap-4 lg:grid-cols-2">
                <FailureSuggestionPanel
                  title="Assertion Suggestions"
                  suggestions={assertionSuggestions}
                  selectedIds={selectedAssertionIds}
                  onToggle={(id) => toggle(setSelectedAssertionIds, id)}
                />
                <FailureSuggestionPanel
                  title="Failure Pattern Suggestions"
                  suggestions={failureSuggestions}
                  selectedIds={selectedFailureIds}
                  onToggle={(id) => toggle(setSelectedFailureIds, id)}
                />
              </div>
            </div>
            <div className="space-y-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-sm font-semibold text-gray-900">Response & Confidence</div>
                <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-gray-950 p-3 text-xs text-gray-100 whitespace-pre-wrap">{JSON.stringify(templatePayload.response_fingerprint_summary || templatePayload.response_snapshot || {}, null, 2)}</pre>
                <div className="mt-3 text-sm text-gray-600">Draft confidence: <span className="font-semibold text-gray-900">{typeof draft.suggestion_summary?.confidence === 'number' ? `${Math.round(draft.suggestion_summary.confidence * 100)}%` : '-'}</span></div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-sm font-semibold text-gray-900">Account Binding Suggestions</div>
                <div className="mt-3 space-y-3">
                  {accountBindingSuggestions.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-500">No account binding suggestions generated.</div>
                  ) : accountBindingSuggestions.map((item: any, index: number) => (
                    <div key={item.id || index} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                      <div className="font-medium text-gray-900">{item.target_path}</div>
                      <div className="mt-1 text-xs text-gray-500">{item.binding_type} → {item.binding_key}</div>
                      <div className="mt-2 text-xs text-gray-600">{item.reason}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <Input label="Published Test Run Name" value={runName} onChange={(e) => setRunName(e.target.value)} placeholder="Recorded API Test" />
                <Select
                  label="Optional Environment"
                  value={environmentId}
                  onChange={(e) => setEnvironmentId(e.target.value)}
                  options={[{ value: '', label: 'Unbound' }, ...environments.map((env) => ({ value: env.id, label: env.name }))]}
                />
                <Select
                  label="Optional Default Account"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  options={[{ value: '', label: 'Unbound' }, ...accounts.map((account) => ({ value: account.id, label: account.name }))]}
                />
              </div>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
