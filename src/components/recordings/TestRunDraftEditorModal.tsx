import { useEffect, useState } from 'react';
import { Button, Input, Select, TextArea } from '../ui/Form';
import { Modal } from '../ui/Modal';
import type { TestRunDraft } from '../../lib/api-client';
import type { Account, Environment } from '../../types';

interface TestRunDraftEditorModalProps {
  isOpen: boolean;
  draft: TestRunDraft | null;
  environments: Environment[];
  accounts: Account[];
  saving?: boolean;
  onClose: () => void;
  onSave: (payload: {
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
  }) => void;
}

function normalizedValue(value: string): string {
  return value.trim();
}

export function TestRunDraftEditorModal({
  isOpen,
  draft,
  environments,
  accounts,
  saving = false,
  onClose,
  onSave,
}: TestRunDraftEditorModalProps) {
  const [draftName, setDraftName] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetDescription, setPresetDescription] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [defaultAccountId, setDefaultAccountId] = useState('');
  const [failureLogic, setFailureLogic] = useState<'OR' | 'AND'>('OR');
  const [showRunBinding, setShowRunBinding] = useState(false);
  const [variables, setVariables] = useState<Array<Record<string, any>>>([]);
  const [failurePatterns, setFailurePatterns] = useState<Array<Record<string, any>>>([]);

  useEffect(() => {
    if (!draft) {
      return;
    }

    const payload = draft.draft_payload || {};
    const templatePayload = payload.template || {};
    const presetPayload = payload.preset || {};

    setDraftName(draft.name || '');
    setTemplateName(templatePayload.name || '');
    setTemplateDescription(templatePayload.description || '');
    setPresetName(presetPayload.name || '');
    setPresetDescription(presetPayload.description || '');
    setEnvironmentId(presetPayload.environment_id || '');
    setDefaultAccountId(presetPayload.default_account_id || '');
    setFailureLogic(templatePayload.failure_logic === 'AND' ? 'AND' : 'OR');
    setShowRunBinding(Boolean(presetPayload.name || presetPayload.description || presetPayload.environment_id || presetPayload.default_account_id));
    setVariables(Array.isArray(templatePayload.variables) ? templatePayload.variables : []);
    setFailurePatterns(Array.isArray(templatePayload.failure_patterns) ? templatePayload.failure_patterns : []);
  }, [draft]);

  if (!draft) {
    return null;
  }

  const payload = draft.draft_payload || {};
  const templatePayload = payload.template || {};
  const responseSnapshot = templatePayload.response_snapshot || {};
  const fieldCandidates = Array.isArray(templatePayload.field_candidates) ? templatePayload.field_candidates : [];
  const assertionCandidates = Array.isArray(templatePayload.assertion_candidates) ? templatePayload.assertion_candidates : [];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Edit API Template Draft: ${draft.name}`}
      size="xl"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => onSave({
              name: normalizedValue(draftName),
              template: {
                name: normalizedValue(templateName),
                description: normalizedValue(templateDescription),
                variables,
                failure_patterns: failurePatterns,
                failure_logic: failureLogic,
              },
              preset: {
                name: normalizedValue(presetName),
                description: normalizedValue(presetDescription),
                environment_id: normalizedValue(environmentId),
                default_account_id: normalizedValue(defaultAccountId),
              },
            })}
            loading={saving}
          >
            Save Draft
          </Button>
        </>
      )}
    >
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Input
            label="Draft Name"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="Recorded API Draft"
          />
          <Input
            label="Template Name"
            value={templateName}
            onChange={(event) => setTemplateName(event.target.value)}
            placeholder="Reusable API Template"
          />
        </div>

        <TextArea
          label="Template Description"
          value={templateDescription}
          onChange={(event) => setTemplateDescription(event.target.value)}
          rows={3}
          placeholder="Describe the purpose of this recorded API"
        />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900 md:col-span-1">
            This draft saves a reusable template first. Environment and account are optional run bindings for presets later.
          </div>
          <Select
            label="Assertion Logic"
            value={failureLogic}
            onChange={(event) => setFailureLogic(event.target.value as 'OR' | 'AND')}
            options={[
              { value: 'OR', label: 'Any failure pattern triggers' },
              { value: 'AND', label: 'All failure patterns must match' },
            ]}
          />
        </div>

        <section className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Optional Run Binding</h3>
              <p className="mt-1 text-xs text-gray-500">Only fill this when you want this draft to also remember how to run later as a preset.</p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => setShowRunBinding((current) => !current)}>
              {showRunBinding ? 'Hide' : 'Configure'}
            </Button>
          </div>

          {showRunBinding && (
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  label="Preset Name"
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                  placeholder="Optional reusable preset name"
                />
                <TextArea
                  label="Preset Description"
                  value={presetDescription}
                  onChange={(event) => setPresetDescription(event.target.value)}
                  rows={2}
                  placeholder="Optional note for future runs"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Select
                  label="Environment"
                  value={environmentId}
                  onChange={(event) => setEnvironmentId(event.target.value)}
                  options={[
                    { value: '', label: 'Unbound' },
                    ...environments.map((environment) => ({
                      value: environment.id,
                      label: environment.name,
                    })),
                  ]}
                />
                <Select
                  label="Default Account"
                  value={defaultAccountId}
                  onChange={(event) => setDefaultAccountId(event.target.value)}
                  options={[
                    { value: '', label: 'Unbound' },
                    ...accounts.map((account) => ({
                      value: account.id,
                      label: account.name,
                    })),
                  ]}
                />
              </div>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Template Variables</h3>
              <p className="mt-1 text-xs text-gray-500">
                Review parameterized request fields before promoting this draft.
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setVariables((current) => [
                ...current,
                {
                  name: `variable_${current.length + 1}`,
                  json_path: '',
                  original_value: '',
                  operation_type: 'replace',
                  data_source: 'account_field',
                  account_field_name: '',
                },
              ])}
            >
              Add Variable
            </Button>
          </div>

          <div className="mt-4 space-y-3">
            {variables.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">
                No variable suggestions yet.
              </div>
            ) : variables.map((variable, index) => (
              <div key={`${draft.id}-variable-${index}`} className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <Input
                    label="Variable Name"
                    value={variable.name || ''}
                    onChange={(event) => setVariables((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, name: event.target.value } : item
                    )))}
                  />
                  <Input
                    label="JSON Path"
                    value={variable.json_path || ''}
                    onChange={(event) => setVariables((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, json_path: event.target.value } : item
                    )))}
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <Input
                    label="Original Value"
                    value={variable.original_value || ''}
                    onChange={(event) => setVariables((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, original_value: event.target.value } : item
                    )))}
                  />
                  <Select
                    label="Data Source"
                    value={variable.data_source || 'account_field'}
                    onChange={(event) => setVariables((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, data_source: event.target.value } : item
                    )))}
                    options={[
                      { value: 'account_field', label: 'Account field' },
                      { value: 'checklist', label: 'Checklist' },
                      { value: 'security_rule', label: 'Security rule' },
                    ]}
                  />
                  <Input
                    label="Binding Key"
                    value={variable.account_field_name || variable.checklist_id || variable.security_rule_id || ''}
                    onChange={(event) => setVariables((current) => current.map((item, itemIndex) => {
                      if (itemIndex !== index) {
                        return item;
                      }
                      if (item.data_source === 'checklist') {
                        return { ...item, checklist_id: event.target.value, account_field_name: undefined, security_rule_id: undefined };
                      }
                      if (item.data_source === 'security_rule') {
                        return { ...item, security_rule_id: event.target.value, account_field_name: undefined, checklist_id: undefined };
                      }
                      return { ...item, account_field_name: event.target.value, checklist_id: undefined, security_rule_id: undefined };
                    }))}
                  />
                </div>
                <div className="mt-3 flex justify-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setVariables((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    Remove Variable
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Failure Patterns</h3>
              <p className="mt-1 text-xs text-gray-500">
                These are the executable assertions used after promotion.
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setFailurePatterns((current) => [
                ...current,
                {
                  type: 'http_status',
                  operator: 'not_equals',
                  value: String(responseSnapshot.status || '500'),
                },
              ])}
            >
              Add Pattern
            </Button>
          </div>

          <div className="mt-4 space-y-3">
            {failurePatterns.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">
                No failure patterns configured.
              </div>
            ) : failurePatterns.map((pattern, index) => (
              <div key={`${draft.id}-pattern-${index}`} className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <Select
                    label="Type"
                    value={pattern.type || 'http_status'}
                    onChange={(event) => setFailurePatterns((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, type: event.target.value } : item
                    )))}
                    options={[
                      { value: 'http_status', label: 'HTTP Status' },
                      { value: 'response_header', label: 'Response Header' },
                      { value: 'response_message', label: 'Response Message' },
                      { value: 'response_code', label: 'Response Code' },
                    ]}
                  />
                  <Select
                    label="Operator"
                    value={pattern.operator || 'equals'}
                    onChange={(event) => setFailurePatterns((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, operator: event.target.value } : item
                    )))}
                    options={[
                      { value: 'equals', label: 'Equals' },
                      { value: 'contains', label: 'Contains' },
                      { value: 'regex', label: 'Regex' },
                      { value: 'not_equals', label: 'Not Equals' },
                      { value: 'not_contains', label: 'Not Contains' },
                    ]}
                  />
                  <Input
                    label="Value"
                    value={pattern.value || ''}
                    onChange={(event) => setFailurePatterns((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, value: event.target.value } : item
                    )))}
                  />
                </div>
                <Input
                  label="Path (Optional)"
                  value={pattern.path || ''}
                  onChange={(event) => setFailurePatterns((current) => current.map((item, itemIndex) => (
                    itemIndex === index ? { ...item, path: event.target.value } : item
                  )))}
                  placeholder="headers.content-type or body.code"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setFailurePatterns((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    Remove Pattern
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-gray-900">Field Candidates</h3>
            <div className="mt-3 space-y-3">
              {fieldCandidates.length === 0 ? (
                <div className="text-sm text-gray-500">No field candidates captured.</div>
              ) : fieldCandidates.map((candidate: Record<string, any>, index: number) => (
                <div key={`${draft.id}-field-${index}`} className="rounded-lg bg-gray-50 p-3 text-sm">
                  <div className="font-medium text-gray-900">{candidate.name || candidate.field_name || 'Unnamed field'}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    {candidate.json_path || candidate.source_location || 'request'} · {candidate.value_preview || 'No preview'}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-gray-900">Assertion Candidates</h3>
            <div className="mt-3 space-y-3">
              {assertionCandidates.length === 0 ? (
                <div className="text-sm text-gray-500">No assertion candidates captured.</div>
              ) : assertionCandidates.map((candidate: Record<string, any>, index: number) => (
                <div key={`${draft.id}-assertion-${index}`} className="rounded-lg bg-gray-50 p-3 text-sm">
                  <div className="font-medium text-gray-900">
                    {candidate.label || `${candidate.path || 'response'} ${candidate.operator || 'equals'} ${candidate.value || ''}`}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {candidate.path || 'response'} · {candidate.operator || 'equals'} · {candidate.value || 'N/A'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">Recorded Request</h3>
          <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-gray-100 whitespace-pre-wrap">
            {templatePayload.raw_request || 'No raw request payload available'}
          </pre>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">Response Snapshot</h3>
          <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-gray-100 whitespace-pre-wrap">
            {JSON.stringify(responseSnapshot, null, 2)}
          </pre>
        </div>
      </div>
    </Modal>
  );
}
