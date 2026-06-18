import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Select } from '../ui/Form';
import { Modal } from '../ui/Modal';
import { SuggestionGraphView } from './SuggestionGraphView';
import { MappingSuggestionTable } from './MappingSuggestionTable';
import { ExtractorSuggestionPanel } from './ExtractorSuggestionPanel';
import type { LearningSuggestionPayloadV2, LearningSourceTypeV2, RecordingSession } from '../../lib/api-client';
import type { Account, Environment, Workflow } from '../../types';

interface Props {
  isOpen: boolean;
  workflow: Workflow | null;
  recordings: RecordingSession[];
  accounts: Account[];
  environments: Environment[];
  initialSource?: LearningSourceTypeV2;
  initialRecordingSessionId?: string;
  payload: LearningSuggestionPayloadV2 | null;
  loading: boolean;
  applying: boolean;
  onClose: () => void;
  onRun: (params: { source: LearningSourceTypeV2; recordingSessionId?: string; accountId?: string; environmentId?: string; includeExtractors: boolean; includeSessionJar: boolean; includeAssertions: boolean }) => Promise<void>;
  onApply: (params: { suggestionId: string; selectedMappingIds: string[]; selectedVariableIds: string[]; selectedExtractorIds: string[]; applySessionJar: boolean; applyAssertions: boolean }) => Promise<void>;
}

const STEPS = ['Choose Source', 'Review Graph', 'Review Variables', 'Review Extractors', 'Apply'];

export function LearningSourceWizard({ isOpen, workflow, recordings, accounts, environments, initialSource = 'recording_only', initialRecordingSessionId, payload, loading, applying, onClose, onRun, onApply }: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [source, setSource] = useState<LearningSourceTypeV2>(initialSource);
  const [recordingSessionId, setRecordingSessionId] = useState(initialRecordingSessionId || '');
  const [accountId, setAccountId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [includeExtractors, setIncludeExtractors] = useState(true);
  const [includeSessionJar, setIncludeSessionJar] = useState(true);
  const [includeAssertions, setIncludeAssertions] = useState(false);
  const [selectedMappingIds, setSelectedMappingIds] = useState<Set<string>>(new Set());
  const [selectedVariableIds, setSelectedVariableIds] = useState<Set<string>>(new Set());
  const [selectedExtractorIds, setSelectedExtractorIds] = useState<Set<string>>(new Set());
  const [applySessionJar, setApplySessionJar] = useState(true);
  const [applyAssertions, setApplyAssertions] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSource(initialSource);
    setRecordingSessionId(initialRecordingSessionId || '');
    setStepIndex(0);
  }, [isOpen, initialRecordingSessionId, initialSource]);

  useEffect(() => {
    if (!payload) return;
    setStepIndex(1);
    setSelectedMappingIds(new Set(payload.suggestions.mappings.filter((item) => item.selectedByDefault !== false).map((item) => item.id)));
    setSelectedVariableIds(new Set(payload.suggestions.workflowVariables.filter((item) => item.confidence >= 0.65).map((item) => item.id)));
    setSelectedExtractorIds(new Set(payload.suggestions.extractors.filter((item) => item.confidence >= 0.65).map((item) => item.id)));
    setApplySessionJar(!!payload.suggestions.sessionJar);
    setApplyAssertions(false);
  }, [payload]);

  const eligibleRecordings = useMemo(() => recordings.filter((item) => item.mode === 'workflow'), [recordings]);

  function toggleId(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleRun() {
    await onRun({ source, recordingSessionId: recordingSessionId || undefined, accountId: accountId || undefined, environmentId: environmentId || undefined, includeExtractors, includeSessionJar, includeAssertions });
  }

  async function handleApply() {
    if (!payload?.suggestionId) return;
    await onApply({
      suggestionId: payload.suggestionId,
      selectedMappingIds: Array.from(selectedMappingIds),
      selectedVariableIds: Array.from(selectedVariableIds),
      selectedExtractorIds: Array.from(selectedExtractorIds),
      applySessionJar,
      applyAssertions,
    });
  }

  const canRun = source === 'recording_only' ? !!recordingSessionId : source === 'execution_only' ? !!accountId && !!environmentId : !!recordingSessionId && !!accountId && !!environmentId;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={workflow ? `Workflow Learning · ${workflow.name}` : 'Workflow Learning'}
      size="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="text-xs text-gray-500">{STEPS[stepIndex]}</div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {payload && stepIndex > 0 && stepIndex < 4 && (
              <Button variant="secondary" onClick={() => setStepIndex((prev) => Math.min(prev + 1, 4))}>Next</Button>
            )}
            {!payload && <Button onClick={handleRun} disabled={!canRun || loading}>{loading ? 'Running…' : 'Run Learn'}</Button>}
            {payload && <Button onClick={handleApply} disabled={applying}>{applying ? 'Applying…' : 'Apply Suggestions'}</Button>}
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {STEPS.map((item, index) => (
            <button key={item} onClick={() => payload && setStepIndex(index)} className={`rounded-full px-3 py-1 text-xs ${index === stepIndex ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
              {index + 1}. {item}
            </button>
          ))}
        </div>

        {stepIndex === 0 && (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
              <Select label="Learning Source" value={source} onChange={(e) => setSource(e.target.value as LearningSourceTypeV2)}>
                <option value="recording_only">Learn from Recording</option>
                <option value="execution_only">Learn from Execution</option>
                <option value="hybrid">Hybrid Learn</option>
              </Select>
              {(source === 'recording_only' || source === 'hybrid') && (
                <Select label="Recording Session" value={recordingSessionId} onChange={(e) => setRecordingSessionId(e.target.value)}>
                  <option value="">Select a recording session</option>
                  {eligibleRecordings.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
              )}
              {(source === 'execution_only' || source === 'hybrid') && (
                <>
                  <Select label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                    <option value="">Select account</option>
                    {accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </Select>
                  <Select label="Environment" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
                    <option value="">Select environment</option>
                    {environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </Select>
                </>
              )}
            </div>
            <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
              <label className="flex items-start gap-3"><Checkbox checked={includeExtractors} onChange={() => setIncludeExtractors((v) => !v)} /><span className="text-sm text-gray-700">Include extractor suggestions</span></label>
              <label className="flex items-start gap-3"><Checkbox checked={includeSessionJar} onChange={() => setIncludeSessionJar((v) => !v)} /><span className="text-sm text-gray-700">Include session jar suggestions</span></label>
              <label className="flex items-start gap-3"><Checkbox checked={includeAssertions} onChange={() => setIncludeAssertions((v) => !v)} /><span className="text-sm text-gray-700">Include assertion suggestions</span></label>
              <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-700">Recording-first learning uses captured business flow as factual evidence. Execution and hybrid also validate against a runnable baseline.</div>
            </div>
          </div>
        )}

        {payload && stepIndex === 1 && <SuggestionGraphView payload={payload} />}
        {payload && (stepIndex === 2 || stepIndex === 4) && <MappingSuggestionTable payload={payload} selectedMappingIds={selectedMappingIds} selectedVariableIds={selectedVariableIds} onToggleMapping={(id) => toggleId(setSelectedMappingIds, id)} onToggleVariable={(id) => toggleId(setSelectedVariableIds, id)} />}
        {payload && (stepIndex === 3 || stepIndex === 4) && <ExtractorSuggestionPanel payload={payload} selectedExtractorIds={selectedExtractorIds} applySessionJar={applySessionJar} applyAssertions={applyAssertions} onToggleExtractor={(id) => toggleId(setSelectedExtractorIds, id)} onToggleSessionJar={() => setApplySessionJar((v) => !v)} onToggleAssertions={() => setApplyAssertions((v) => !v)} />}
      </div>
    </Modal>
  );
}
