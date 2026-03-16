import { Link2 } from 'lucide-react';
import { Button } from '../ui/Form';
import { Modal } from '../ui/Modal';
import type { RecordingAccountApplyPreview } from '../../lib/api-client';
import type { Account } from '../../types';

interface RecordingAccountApplyModalProps {
  isOpen: boolean;
  accounts: Account[];
  selectedAccountId: string;
  mode: 'session_only' | 'write_back';
  preview: RecordingAccountApplyPreview | null;
  loadingPreview: boolean;
  applying: boolean;
  onClose: () => void;
  onAccountChange: (accountId: string) => void;
  onModeChange: (mode: 'session_only' | 'write_back') => void;
  onRefreshPreview: () => void;
  onApply: () => void;
}

function renderSectionLabel(section: string): string {
  if (section === 'auth_profile') return 'Auth Profile';
  if (section === 'variables') return 'Recording Variables';
  return 'Account Fields';
}

export function RecordingAccountApplyModal({
  isOpen,
  accounts,
  selectedAccountId,
  mode,
  preview,
  loadingPreview,
  applying,
  onClose,
  onAccountChange,
  onModeChange,
  onRefreshPreview,
  onApply,
}: RecordingAccountApplyModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Apply Recording To Account"
      size="xl"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="secondary" onClick={onRefreshPreview} loading={loadingPreview}>
            Refresh Preview
          </Button>
          <Button onClick={onApply} loading={applying} disabled={!preview || preview.changes.length === 0}>
            Confirm Apply
          </Button>
        </>
      )}
    >
      <div className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Target Account</label>
            <select
              value={selectedAccountId}
              onChange={(event) => onAccountChange(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {accounts.map(account => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="block text-sm font-medium text-gray-700 mb-1">Apply Mode</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => onModeChange('session_only')}
                className={`rounded-xl border p-4 text-left ${mode === 'session_only' ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-white'}`}
              >
                <div className="text-sm font-semibold text-gray-900">Only This Recording</div>
                <div className="mt-1 text-xs text-gray-600">
                  Save the linkage on this recording session without overwriting the account.
                </div>
              </button>
              <button
                type="button"
                onClick={() => onModeChange('write_back')}
                className={`rounded-xl border p-4 text-left ${mode === 'write_back' ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-white'}`}
              >
                <div className="text-sm font-semibold text-gray-900">Write Back To Account</div>
                <div className="mt-1 text-xs text-gray-600">
                  Persist fields, auth profile, and recording variables for later reuse.
                </div>
              </button>
            </div>
          </div>
        </div>

        {loadingPreview ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-500">
            Loading account linkage preview...
          </div>
        ) : !preview ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-500">
            Generate a preview before applying captured values to an account.
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500">Changes</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900">{preview.summary.total_changes || 0}</div>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500">Fields</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900">{preview.summary.field_change_count || 0}</div>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500">Auth Profile</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900">{preview.summary.auth_profile_change_count || 0}</div>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500">Variables</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900">{preview.summary.variable_change_count || 0}</div>
              </div>
            </div>

            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
              <div className="flex items-center gap-2 font-semibold">
                <Link2 size={16} />
                Preview Target
              </div>
              <div className="mt-2">
                {preview.account_name} ({preview.account_id})
              </div>
              <div className="mt-1 text-xs text-blue-700">
                Mode: {preview.mode === 'write_back' ? 'write back to account' : 'recording session only'}
              </div>
            </div>

            <div className="space-y-3">
              {preview.changes.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-500">
                  No mapped fields were found for this recording yet.
                </div>
              ) : (
                preview.changes.map((change, index) => (
                  <div key={`${change.target_section}-${change.target_path}-${index}`} className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-gray-900">
                          {renderSectionLabel(change.target_section)} {'->'} {change.target_path}
                        </div>
                        <div className="mt-1 text-xs text-gray-500">
                          {change.source_type === 'runtime_context' ? 'Runtime Context' : 'Field Hit'} from {change.source_name}
                          {change.source_location ? ` (${change.source_location}${change.source_key ? `: ${change.source_key}` : ''})` : ''}
                        </div>
                      </div>
                      {change.bind_to_account_field && (
                        <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                          bind: {change.bind_to_account_field}
                        </span>
                      )}
                    </div>
                    <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700 break-all">
                      {change.value_text || change.value_preview || '(empty)'}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
