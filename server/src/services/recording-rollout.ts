import { RecordingGuardError } from './recording-guard.js';

export type RecordingRolloutPhase =
  | 'hidden'
  | 'internal_plugin'
  | 'workflow_only'
  | 'api_publish'
  | 'formal';

export interface RecordingRolloutConfig {
  phase: RecordingRolloutPhase;
  recording_center_visible: boolean;
  workflow_mode_enabled: boolean;
  api_mode_enabled: boolean;
  publish_enabled: boolean;
  allowed_account_ids: string[];
  notes: string;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseCsv(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizePhase(value: string | undefined): RecordingRolloutPhase {
  const normalized = String(value || 'formal').trim().toLowerCase();
  switch (normalized) {
    case 'hidden':
      return 'hidden';
    case 'internal_plugin':
    case 'internal':
      return 'internal_plugin';
    case 'workflow_only':
    case 'workflow':
      return 'workflow_only';
    case 'api_publish':
    case 'api':
      return 'api_publish';
    case 'formal':
    default:
      return 'formal';
  }
}

function getPhaseDefaults(phase: RecordingRolloutPhase): Omit<RecordingRolloutConfig, 'allowed_account_ids'> {
  switch (phase) {
    case 'hidden':
      return {
        phase,
        recording_center_visible: false,
        workflow_mode_enabled: false,
        api_mode_enabled: false,
        publish_enabled: false,
        notes: 'Backend deployed with hidden switch. UI entry and recording creation should stay hidden.',
      };
    case 'internal_plugin':
      return {
        phase,
        recording_center_visible: true,
        workflow_mode_enabled: true,
        api_mode_enabled: false,
        publish_enabled: false,
        notes: 'Internal plugin rollout only. Restrict to a small allowlist of accounts and keep publish disabled.',
      };
    case 'workflow_only':
      return {
        phase,
        recording_center_visible: true,
        workflow_mode_enabled: true,
        api_mode_enabled: false,
        publish_enabled: false,
        notes: 'Workflow recording is enabled. API recording and publish actions remain gated.',
      };
    case 'api_publish':
      return {
        phase,
        recording_center_visible: true,
        workflow_mode_enabled: true,
        api_mode_enabled: true,
        publish_enabled: true,
        notes: 'Workflow/API recording and draft promotion are enabled for gray rollout.',
      };
    case 'formal':
    default:
      return {
        phase: 'formal',
        recording_center_visible: true,
        workflow_mode_enabled: true,
        api_mode_enabled: true,
        publish_enabled: true,
        notes: 'All recording features are open. Operate with alerts, audits, and dead-letter recovery enabled.',
      };
  }
}

export function getRecordingRolloutConfig(): RecordingRolloutConfig {
  const phase = normalizePhase(process.env.RECORDING_ROLLOUT_PHASE || process.env.BSTG_RECORDING_ROLLOUT_PHASE);
  const defaults = getPhaseDefaults(phase);
  return {
    ...defaults,
    recording_center_visible: parseBool(process.env.RECORDING_CENTER_VISIBLE, defaults.recording_center_visible),
    workflow_mode_enabled: parseBool(process.env.RECORDING_WORKFLOW_MODE_ENABLED, defaults.workflow_mode_enabled),
    api_mode_enabled: parseBool(process.env.RECORDING_API_MODE_ENABLED, defaults.api_mode_enabled),
    publish_enabled: parseBool(process.env.RECORDING_PUBLISH_ENABLED, defaults.publish_enabled),
    allowed_account_ids: parseCsv(process.env.RECORDING_ALLOWED_ACCOUNT_IDS || process.env.BSTG_RECORDING_ALLOWED_ACCOUNT_IDS),
  };
}

export function ensureRecordingModeEnabled(mode: 'workflow' | 'api'): void {
  const config = getRecordingRolloutConfig();
  if (!config.recording_center_visible) {
    throw new RecordingGuardError(403, 'Recording center is hidden in the current rollout phase');
  }

  if (mode === 'workflow' && !config.workflow_mode_enabled) {
    throw new RecordingGuardError(403, 'Workflow recording is not enabled in the current rollout phase');
  }

  if (mode === 'api' && !config.api_mode_enabled) {
    throw new RecordingGuardError(403, 'API recording is not enabled in the current rollout phase');
  }
}

export function ensureRecordingPublishEnabled(action = 'publish'): void {
  const config = getRecordingRolloutConfig();
  if (!config.publish_enabled) {
    throw new RecordingGuardError(403, `Recording ${action} is disabled in the current rollout phase`);
  }
}

export function ensureRecordingAccountAllowed(accountId?: string): void {
  const config = getRecordingRolloutConfig();
  if (config.allowed_account_ids.length === 0) {
    return;
  }

  if (!accountId) {
    throw new RecordingGuardError(403, 'This rollout phase requires account binding to a permitted account');
  }

  if (!config.allowed_account_ids.includes(accountId)) {
    throw new RecordingGuardError(403, `Account ${accountId} is not enabled for the current rollout phase`);
  }
}
