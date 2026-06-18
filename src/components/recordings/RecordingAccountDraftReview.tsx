import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, UserPlus } from 'lucide-react';
import { Button, Input, Select } from '../ui/Form';
import type { Account } from '../../types';
import type { RecordingAccountDraft } from '../../lib/api-client';

export type RecordingAccountSaveMode = 'create_new' | 'merge' | 'replace' | 'session_only';

export interface RecordingAccountDraftSubmitPayload {
  saveMode: RecordingAccountSaveMode;
  existingAccountId?: string;
  selectedFields: string[];
  selectedAuthMappings: string[];
  selectedVariables: string[];
  accountName: string;
  role?: string;
  label?: string;
}

interface RecordingAccountDraftReviewProps {
  draft: RecordingAccountDraft | null;
  accounts: Account[];
  loading?: boolean;
  saving?: boolean;
  title?: string;
  onRegenerate?: () => void;
  onSubmit: (payload: RecordingAccountDraftSubmitPayload) => void;
  submitLabel?: string;
}

function checkboxSet(values: string[]): Record<string, boolean> {
  return Object.fromEntries(values.map(value => [value, true]));
}

export function RecordingAccountDraftReview({
  draft,
  accounts,
  loading,
  saving,
  title = 'Account Draft Review',
  onRegenerate,
  onSubmit,
  submitLabel = 'Save Account',
}: RecordingAccountDraftReviewProps) {
  const [saveMode, setSaveMode] = useState<RecordingAccountSaveMode>('create_new');
  const [existingAccountId, setExistingAccountId] = useState('');
  const [accountName, setAccountName] = useState('');
  const [role, setRole] = useState('');
  const [label, setLabel] = useState('');
  const [selectedFields, setSelectedFields] = useState<Record<string, boolean>>({});
  const [selectedAuth, setSelectedAuth] = useState<Record<string, boolean>>({});
  const [selectedVariables, setSelectedVariables] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!draft) return;
    setAccountName(draft.account_name_suggestion || '');
    setRole(draft.role || '');
    setLabel(draft.label || '');
    setExistingAccountId(draft.summary?.suggested_existing_account_id || '');
    setSelectedFields(checkboxSet(draft.field_suggestions.map(item => item.target_path)));
    setSelectedAuth(checkboxSet(draft.auth_profile_suggestions.map(item => item.target_path)));
    setSelectedVariables(checkboxSet(draft.variable_suggestions.map(item => item.target_path)));
  }, [draft]);

  const suggestedAccountName = useMemo(
    () => accounts.find(account => account.id === existingAccountId)?.name || '',
    [accounts, existingAccountId]
  );

  function toggle(target: 'field' | 'auth' | 'variable', key: string) {
    const setter = target === 'field' ? setSelectedFields : target === 'auth' ? setSelectedAuth : setSelectedVariables;
    setter(current => ({ ...current, [key]: !current[key] }));
  }

  function selectedKeys(map: Record<string, boolean>): string[] {
    return Object.entries(map).filter(([, enabled]) => enabled).map(([key]) => key);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <p className="mt-1 text-sm text-gray-500">
            Review the recording-derived suggestions, then save as a clean test account. Environment and run settings stay out of the template/account itself.
          </p>
        </div>
        {onRegenerate && (
          <Button variant="secondary" size="sm" onClick={onRegenerate} loading={loading}>
            <RefreshCw size={14} className="mr-1" />
            Regenerate Suggestions
          </Button>
        )}
      </div>

      {!draft ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-500">
          Choose a recording session first to load account suggestions.
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">Field Suggestions</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900">{draft.summary?.field_suggestion_count || 0}</div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">Auth Suggestions</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900">{draft.summary?.auth_profile_suggestion_count || 0}</div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">Variables</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900">{draft.summary?.variable_suggestion_count || 0}</div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">Coverage</div>
              <div className="mt-1 text-sm font-semibold text-gray-900">
                {draft.coverage?.matched_requested_field_count || 0} / {draft.coverage?.requested_field_count || 0} requested fields
              </div>
            </div>
          </div>

          {draft.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="font-semibold">Review Notes</div>
              <ul className="mt-2 space-y-1 list-disc pl-5">
                {draft.warnings.map(item => <li key={item}>{item}</li>)}
              </ul>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <Input label="Account Name" value={accountName} onChange={event => setAccountName(event.target.value)} placeholder="QA Buyer" />
            <Select
              label="Save Mode"
              value={saveMode}
              onChange={event => setSaveMode(event.target.value as RecordingAccountSaveMode)}
              options={[
                { value: 'create_new', label: 'Create New Account' },
                { value: 'merge', label: 'Merge Into Existing Account' },
                { value: 'replace', label: 'Replace Existing Account' },
                { value: 'session_only', label: 'Session Only (no account write)' },
              ]}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Input label="Role (optional)" value={role} onChange={event => setRole(event.target.value)} placeholder="buyer / admin / victim" />
            <Input label="Label (optional)" value={label} onChange={event => setLabel(event.target.value)} placeholder="buyer-us-east" />
          </div>

          {(saveMode === 'merge' || saveMode === 'replace' || saveMode === 'session_only') && (
            <Select
              label="Existing Account"
              value={existingAccountId}
              onChange={event => setExistingAccountId(event.target.value)}
              options={[
                { value: '', label: draft.summary?.suggested_existing_account_id ? 'Use suggested account below' : 'Choose account' },
                ...accounts.map(account => ({ value: account.id, label: account.name })),
              ]}
            />
          )}

          {draft.summary?.suggested_existing_account_name && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
              Suggested existing account: <span className="font-semibold">{draft.summary.suggested_existing_account_name}</span>
              {suggestedAccountName && suggestedAccountName !== draft.summary.suggested_existing_account_name ? ` · currently selected ${suggestedAccountName}` : ''}
            </div>
          )}

          {[{
            title: 'Account Fields',
            items: draft.field_suggestions,
            selected: selectedFields,
            kind: 'field' as const,
          }, {
            title: 'Auth Profile',
            items: draft.auth_profile_suggestions,
            selected: selectedAuth,
            kind: 'auth' as const,
          }, {
            title: 'Variables',
            items: draft.variable_suggestions,
            selected: selectedVariables,
            kind: 'variable' as const,
          }].map(section => (
            <div key={section.title} className="rounded-2xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-base font-semibold text-gray-900">{section.title}</div>
                <div className="text-xs text-gray-500">{Object.values(section.selected).filter(Boolean).length} selected</div>
              </div>
              {section.items.length === 0 ? (
                <div className="mt-3 text-sm text-gray-500">No suggestions.</div>
              ) : (
                <div className="mt-3 space-y-3">
                  {section.items.map(item => (
                    <label key={item.id} className="flex gap-3 rounded-xl border border-gray-200 p-3 text-sm">
                      <input
                        type="checkbox"
                        checked={!!section.selected[item.target_path]}
                        onChange={() => toggle(section.kind, item.target_path)}
                        className="mt-1 h-4 w-4 rounded border-gray-300"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-gray-900">{item.target_path}</span>
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">{Math.round(item.confidence * 100)}%</span>
                        </div>
                        <div className="mt-1 break-all text-gray-600">{item.value_text || item.value_preview || '(empty)'}</div>
                        <div className="mt-1 text-xs text-gray-500">
                          {item.source_type} · {item.source_name}
                          {item.source_location ? ` · ${item.source_location}` : ''}
                          {item.reason ? ` · ${item.reason}` : ''}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className="flex justify-end">
            <Button
              onClick={() => onSubmit({
                saveMode,
                existingAccountId: existingAccountId || undefined,
                selectedFields: selectedKeys(selectedFields),
                selectedAuthMappings: selectedKeys(selectedAuth),
                selectedVariables: selectedKeys(selectedVariables),
                accountName,
                role: role || undefined,
                label: label || undefined,
              })}
              loading={saving}
              disabled={!accountName.trim() && saveMode !== 'session_only'}
            >
              <UserPlus size={16} className="mr-2" />
              {submitLabel}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
