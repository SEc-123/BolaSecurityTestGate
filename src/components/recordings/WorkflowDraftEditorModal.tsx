import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Settings2, Trash2 } from 'lucide-react';
import { Button, Input, Select, TextArea } from '../ui/Form';
import { Modal } from '../ui/Modal';
import type {
  RecordingExtractorCandidate,
  RecordingVariableCandidate,
  WorkflowDraft,
} from '../../lib/api-client';
import type { Checklist, SecurityRule } from '../../types';

interface EditableStep {
  id: string;
  sequence: number;
  enabled: boolean;
  name: string;
  description: string;
  method: string;
  path: string;
}

interface EditableExtractor {
  workflow_draft_step_id: string;
  name: string;
  source: string;
  expression: string;
  required: boolean;
  confidence?: number;
}

interface EditableVariable {
  workflow_draft_step_id: string;
  name: string;
  data_source: string;
  source_location: string;
  json_path: string;
  checklist_id?: string;
  security_rule_id?: string;
  account_field_name?: string;
  runtime_context_key?: string;
  step_variable_mappings?: any[];
  advanced_config?: Record<string, any>;
  role?: string;
  confidence?: number;
}

interface WorkflowDraftEditorModalProps {
  isOpen: boolean;
  draft: WorkflowDraft | null;
  checklists: Checklist[];
  securityRules: SecurityRule[];
  saving?: boolean;
  onClose: () => void;
  onSave: (payload: {
    name?: string;
    steps: Array<{
      id: string;
      sequence: number;
      enabled: boolean;
      name: string;
      description?: string;
    }>;
    extractor_candidates: EditableExtractor[];
    variable_candidates: EditableVariable[];
  }) => Promise<void>;
}

const VARIABLE_SOURCES = [
  { value: 'account_field', label: 'Account Field' },
  { value: 'workflow_context', label: 'Workflow Context' },
  { value: 'checklist', label: 'Checklist' },
  { value: 'security_rule', label: 'Security Rule' },
];

const VARIABLE_LOCATIONS = [
  { value: 'request.path', label: 'request.path' },
  { value: 'request.query', label: 'request.query' },
  { value: 'request.header', label: 'request.header' },
  { value: 'request.cookie', label: 'request.cookie' },
  { value: 'request.body', label: 'request.body' },
  { value: 'response.header', label: 'response.header' },
  { value: 'response.body', label: 'response.body' },
];

const PATH_REPLACEMENT_MODES = [
  { value: 'segment_index', label: 'segment_index' },
  { value: 'placeholder', label: 'placeholder' },
  { value: 'regex', label: 'regex' },
];

function mapStepName(step: any): string {
  return step.request_template_payload?.name || step.summary?.step_name || `Step ${step.sequence}`;
}

function mapStepDescription(step: any): string {
  return step.request_template_payload?.description || '';
}

function normalizeExtractor(candidate: RecordingExtractorCandidate, fallbackStepId: string): EditableExtractor {
  return {
    workflow_draft_step_id: candidate.workflow_draft_step_id || fallbackStepId,
    name: candidate.name,
    source: candidate.source,
    expression: candidate.expression,
    required: !!candidate.required,
    confidence: candidate.confidence,
  };
}

function normalizeVariable(candidate: RecordingVariableCandidate, fallbackStepId: string): EditableVariable {
  return {
    workflow_draft_step_id: candidate.workflow_draft_step_id || fallbackStepId,
    name: candidate.name,
    data_source: candidate.data_source,
    source_location: candidate.source_location,
    json_path: candidate.json_path || '',
    checklist_id: candidate.checklist_id,
    security_rule_id: candidate.security_rule_id,
    account_field_name: candidate.account_field_name,
    runtime_context_key: candidate.runtime_context_key,
    step_variable_mappings: candidate.step_variable_mappings,
    advanced_config: candidate.advanced_config,
    role: candidate.role,
    confidence: candidate.confidence,
  };
}

function isPathVariable(variable: EditableVariable): boolean {
  return variable.source_location === 'request.path' || variable.json_path.startsWith('path.');
}

export function WorkflowDraftEditorModal({
  isOpen,
  draft,
  checklists,
  securityRules,
  saving = false,
  onClose,
  onSave,
}: WorkflowDraftEditorModalProps) {
  const [draftName, setDraftName] = useState('');
  const [steps, setSteps] = useState<EditableStep[]>([]);
  const [extractors, setExtractors] = useState<EditableExtractor[]>([]);
  const [variables, setVariables] = useState<EditableVariable[]>([]);

  useEffect(() => {
    if (!draft || !isOpen) {
      return;
    }

    const orderedSteps = [...(draft.steps || [])]
      .sort((left, right) => left.sequence - right.sequence)
      .map(step => ({
        id: step.id,
        sequence: step.sequence,
        enabled: !!step.enabled,
        name: mapStepName(step),
        description: mapStepDescription(step),
        method: step.method,
        path: step.path,
      }));

    const firstStepId = orderedSteps[0]?.id || '';

    setDraftName(draft.name);
    setSteps(orderedSteps);
    setExtractors((draft.extractor_candidates || []).map(candidate => normalizeExtractor(candidate, firstStepId)));
    setVariables((draft.variable_candidates || []).map(candidate => normalizeVariable(candidate, firstStepId)));
  }, [draft, isOpen]);

  if (!draft) {
    return null;
  }

  const stepOptions = steps.map(step => ({
    value: step.id,
    label: `${step.sequence}. ${step.name}`,
  }));

  function moveStep(index: number, direction: -1 | 1) {
    setSteps(prev => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.length) {
        return prev;
      }

      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(nextIndex, 0, item);
      return copy.map((step, currentIndex) => ({
        ...step,
        sequence: currentIndex + 1,
      }));
    });
  }

  function updateStep(index: number, patch: Partial<EditableStep>) {
    setSteps(prev => prev.map((step, currentIndex) => currentIndex === index ? { ...step, ...patch } : step));
  }

  function updateExtractor(index: number, patch: Partial<EditableExtractor>) {
    setExtractors(prev => prev.map((item, currentIndex) => currentIndex === index ? { ...item, ...patch } : item));
  }

  function updateVariable(index: number, patch: Partial<EditableVariable>) {
    setVariables(prev => prev.map((item, currentIndex) => currentIndex === index ? { ...item, ...patch } : item));
  }

  function updateVariableAdvancedConfig(index: number, patch: Record<string, any>) {
    setVariables(prev => prev.map((item, currentIndex) => {
      if (currentIndex !== index) {
        return item;
      }

      return {
        ...item,
        advanced_config: {
          ...(item.advanced_config || {}),
          ...patch,
        },
      };
    }));
  }

  function addExtractor() {
    setExtractors(prev => [
      ...prev,
      {
        workflow_draft_step_id: steps[0]?.id || '',
        name: '',
        source: 'response_body_jsonpath',
        expression: '',
        required: false,
        confidence: 0.9,
      },
    ]);
  }

  function addVariable() {
    setVariables(prev => [
      ...prev,
      {
        workflow_draft_step_id: steps[0]?.id || '',
        name: '',
        data_source: 'workflow_context',
        source_location: 'request.header',
        json_path: '',
        confidence: 0.9,
      },
    ]);
  }

  async function handleSave() {
    const currentDraft = draft;
    if (!currentDraft) {
      return;
    }

    await onSave({
      name: draftName.trim() || currentDraft.name,
      steps: steps.map((step, index) => ({
        id: step.id,
        sequence: index + 1,
        enabled: step.enabled,
        name: step.name.trim() || `Step ${index + 1}`,
        description: step.description.trim() || undefined,
      })),
      extractor_candidates: extractors
        .filter(item => item.workflow_draft_step_id && item.name.trim() && item.expression.trim())
        .map(item => ({
          ...item,
          name: item.name.trim(),
          expression: item.expression.trim(),
        })),
      variable_candidates: variables
        .filter(item => item.workflow_draft_step_id && item.name.trim() && item.data_source && item.source_location && item.json_path.trim())
        .map(item => ({
          ...item,
          name: item.name.trim(),
          json_path: item.json_path.trim(),
          account_field_name: item.account_field_name?.trim() || undefined,
          runtime_context_key: item.runtime_context_key?.trim() || undefined,
        })),
    });
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Edit Workflow Draft"
      size="xl"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save Draft
          </Button>
        </>
      )}
    >
      <div className="space-y-6">
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-4 text-sm text-purple-800">
          Adjust step order, enable or disable noisy steps, refine step names, and supplement extractor or variable suggestions before publishing.
        </div>

        <Input
          label="Draft Name"
          value={draftName}
          onChange={event => setDraftName(event.target.value)}
          placeholder="Workflow draft name"
        />

        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <Settings2 size={18} className="text-purple-600" />
            <h3 className="text-lg font-semibold text-gray-900">Steps</h3>
          </div>
          <div className="space-y-3">
            {steps.map((step, index) => (
              <div key={step.id} className="rounded-xl border border-gray-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="rounded-full bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white">
                      {index + 1}
                    </span>
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={step.enabled}
                        onChange={event => updateStep(index, { enabled: event.target.checked })}
                      />
                      Enabled
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => moveStep(index, -1)} disabled={index === 0}>
                      <ArrowUp size={14} />
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1}>
                      <ArrowDown size={14} />
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <Input
                    label="Step Name"
                    value={step.name}
                    onChange={event => updateStep(index, { name: event.target.value })}
                    placeholder="e.g., Login Request"
                  />
                  <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-700">
                    <div className="font-medium text-gray-900">{step.method}</div>
                    <div className="mt-1 break-all text-xs text-gray-500">{step.path}</div>
                  </div>
                </div>

                <TextArea
                  label="Step Description"
                  value={step.description}
                  onChange={event => updateStep(index, { description: event.target.value })}
                  placeholder="Optional description shown in the generated template."
                  rows={2}
                />
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Extractor Suggestions</h3>
            <Button variant="secondary" size="sm" onClick={addExtractor}>
              <Plus size={14} className="mr-1" />
              Add Extractor
            </Button>
          </div>
          <div className="space-y-3">
            {extractors.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 p-4 text-sm text-gray-500">
                No extractor suggestions yet.
              </div>
            ) : extractors.map((extractor, index) => (
              <div key={`extractor-${index}`} className="rounded-xl border border-gray-200 p-4">
                <div className="flex justify-end">
                  <Button variant="danger" size="sm" onClick={() => setExtractors(prev => prev.filter((_, currentIndex) => currentIndex !== index))}>
                    <Trash2 size={14} />
                  </Button>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Select
                    label="Step"
                    value={extractor.workflow_draft_step_id}
                    onChange={event => updateExtractor(index, { workflow_draft_step_id: event.target.value })}
                    options={stepOptions}
                  />
                  <Input
                    label="Extractor Name"
                    value={extractor.name}
                    onChange={event => updateExtractor(index, { name: event.target.value })}
                    placeholder="token / order_id"
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Select
                    label="Source"
                    value={extractor.source}
                    onChange={event => updateExtractor(index, { source: event.target.value })}
                    options={[
                      { value: 'response_body_jsonpath', label: 'response_body_jsonpath' },
                      { value: 'response_header', label: 'response_header' },
                    ]}
                  />
                  <Input
                    label="Expression"
                    value={extractor.expression}
                    onChange={event => updateExtractor(index, { expression: event.target.value })}
                    placeholder="$.token / authorization"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={extractor.required}
                    onChange={event => updateExtractor(index, { required: event.target.checked })}
                  />
                  Required
                </label>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Variable Suggestions</h3>
            <Button variant="secondary" size="sm" onClick={addVariable}>
              <Plus size={14} className="mr-1" />
              Add Variable
            </Button>
          </div>
          <div className="space-y-3">
            {variables.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 p-4 text-sm text-gray-500">
                No variable suggestions yet.
              </div>
            ) : variables.map((variable, index) => (
              <div key={`variable-${index}`} className="rounded-xl border border-gray-200 p-4">
                <div className="flex justify-end">
                  <Button variant="danger" size="sm" onClick={() => setVariables(prev => prev.filter((_, currentIndex) => currentIndex !== index))}>
                    <Trash2 size={14} />
                  </Button>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Select
                    label="Step"
                    value={variable.workflow_draft_step_id}
                    onChange={event => updateVariable(index, { workflow_draft_step_id: event.target.value })}
                    options={stepOptions}
                  />
                  <Input
                    label="Variable Name"
                    value={variable.name}
                    onChange={event => updateVariable(index, { name: event.target.value })}
                    placeholder="token / order_id"
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Select
                    label="Data Source"
                    value={variable.data_source}
                    onChange={event => updateVariable(index, {
                      data_source: event.target.value,
                      checklist_id: undefined,
                      security_rule_id: undefined,
                    })}
                    options={VARIABLE_SOURCES}
                  />
                  <Select
                    label="Source Location"
                    value={variable.source_location}
                    onChange={event => updateVariable(index, {
                      source_location: event.target.value,
                      advanced_config: event.target.value === 'request.path'
                        ? {
                          path_replacement_mode: variable.advanced_config?.path_replacement_mode || 'segment_index',
                          path_segment_index: variable.advanced_config?.path_segment_index ?? 0,
                          path_regex_pattern: variable.advanced_config?.path_regex_pattern,
                        }
                        : variable.advanced_config,
                    })}
                    options={VARIABLE_LOCATIONS}
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Input
                    label="JSON / Request Path"
                    value={variable.json_path}
                    onChange={event => updateVariable(index, { json_path: event.target.value })}
                    placeholder={isPathVariable(variable) ? 'path.order_id' : 'headers.authorization / body.orderId'}
                  />
                  {variable.data_source === 'account_field' && (
                    <Input
                      label="Account Field"
                      value={variable.account_field_name || ''}
                      onChange={event => updateVariable(index, { account_field_name: event.target.value })}
                      placeholder="access_token / order_id"
                    />
                  )}
                  {variable.data_source === 'workflow_context' && (
                    <Input
                      label="Runtime Context Key"
                      value={variable.runtime_context_key || ''}
                      onChange={event => updateVariable(index, { runtime_context_key: event.target.value })}
                      placeholder="token / order_id"
                    />
                  )}
                  {variable.data_source === 'checklist' && (
                    <Select
                      label="Checklist"
                      value={variable.checklist_id || ''}
                      onChange={event => updateVariable(index, { checklist_id: event.target.value })}
                      options={[
                        { value: '', label: 'Select checklist' },
                        ...checklists.map(item => ({ value: item.id, label: item.name })),
                      ]}
                    />
                  )}
                  {variable.data_source === 'security_rule' && (
                    <Select
                      label="Security Rule"
                      value={variable.security_rule_id || ''}
                      onChange={event => updateVariable(index, { security_rule_id: event.target.value })}
                      options={[
                        { value: '', label: 'Select security rule' },
                        ...securityRules.map(item => ({ value: item.id, label: item.name })),
                      ]}
                    />
                  )}
                </div>
                {isPathVariable(variable) && (
                  <div className="grid gap-4 md:grid-cols-3">
                    <Select
                      label="Path Replace Mode"
                      value={variable.advanced_config?.path_replacement_mode || 'segment_index'}
                      onChange={event => updateVariableAdvancedConfig(index, {
                        path_replacement_mode: event.target.value,
                      })}
                      options={PATH_REPLACEMENT_MODES}
                    />
                    {(variable.advanced_config?.path_replacement_mode || 'segment_index') === 'segment_index' && (
                      <Input
                        label="Path Segment Index"
                        type="number"
                        value={String(variable.advanced_config?.path_segment_index ?? 0)}
                        onChange={event => updateVariableAdvancedConfig(index, {
                          path_segment_index: Number.isFinite(Number(event.target.value))
                            ? Number(event.target.value)
                            : 0,
                        })}
                        placeholder="0"
                      />
                    )}
                    {(variable.advanced_config?.path_replacement_mode || 'segment_index') === 'regex' && (
                      <Input
                        label="Path Regex Pattern"
                        value={variable.advanced_config?.path_regex_pattern || ''}
                        onChange={event => updateVariableAdvancedConfig(index, {
                          path_regex_pattern: event.target.value,
                        })}
                        placeholder="ord-[A-Za-z0-9_-]+"
                      />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}
