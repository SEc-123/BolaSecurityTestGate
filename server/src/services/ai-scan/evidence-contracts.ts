export type NativeEvidenceRequirement =
  | 'api_mode'
  | 'aggregate_template_run'
  | 'baseline_workflow_run'
  | 'mutation_workflow_run'
  | 'template_assets'
  | 'baseline_workflow_asset'
  | 'mutation_workflow_asset'
  | 'advanced_mutation';

export interface VulnerabilityEvidenceContract {
  id: string;
  description: string;
  required: NativeEvidenceRequirement[];
  optional: NativeEvidenceRequirement[];
}

const CONTRACTS: Record<string, VulnerabilityEvidenceContract> = {
  stateless_input_v1: {
    id: 'stateless_input_v1',
    description: 'Reproducible baseline/mutation API execution for stateless input-manipulation vulnerabilities.',
    required: ['api_mode', 'template_assets'],
    optional: ['aggregate_template_run', 'baseline_workflow_run', 'mutation_workflow_run', 'baseline_workflow_asset', 'mutation_workflow_asset'],
  },
  file_upload_v1: {
    id: 'file_upload_v1',
    description: 'Upload mutation must be represented by native BSTG assets and a baseline-to-mutation workflow chain.',
    required: ['aggregate_template_run', 'baseline_workflow_run', 'mutation_workflow_run', 'template_assets', 'baseline_workflow_asset', 'mutation_workflow_asset'],
    optional: ['api_mode'],
  },
  authorization_stateful_v1: {
    id: 'authorization_stateful_v1',
    description: 'Authorization findings require a valid baseline state plus identity/object mutation through native workflows.',
    required: ['baseline_workflow_run', 'mutation_workflow_run', 'template_assets', 'baseline_workflow_asset', 'mutation_workflow_asset'],
    optional: ['api_mode', 'aggregate_template_run'],
  },
  business_stateful_v1: {
    id: 'business_stateful_v1',
    description: 'Business/auth state findings require executable prerequisite state and a native baseline-to-mutation workflow.',
    required: ['baseline_workflow_run', 'mutation_workflow_run', 'template_assets', 'baseline_workflow_asset', 'mutation_workflow_asset'],
    optional: ['api_mode', 'aggregate_template_run'],
  },
  race_v1: {
    id: 'race_v1',
    description: 'Race/replay findings require native workflow state plus an executed advanced concurrent mutation dimension.',
    required: ['baseline_workflow_run', 'mutation_workflow_run', 'template_assets', 'baseline_workflow_asset', 'mutation_workflow_asset', 'advanced_mutation'],
    optional: ['api_mode', 'aggregate_template_run'],
  },
  strict_generic_v1: {
    id: 'strict_generic_v1',
    description: 'Fallback contract retaining the original strict native BSTG evidence requirements.',
    required: ['api_mode', 'aggregate_template_run', 'baseline_workflow_run', 'mutation_workflow_run', 'template_assets', 'baseline_workflow_asset', 'mutation_workflow_asset'],
    optional: ['advanced_mutation'],
  },
};

export function evidenceContractForVulnerability(vulnType?: string | null): VulnerabilityEvidenceContract {
  const type = String(vulnType || '').toLowerCase();
  if (type === 'file_upload') return CONTRACTS.file_upload_v1;
  if (['xss', 'command_injection', 'path_traversal', 'file_download'].includes(type)) return CONTRACTS.stateless_input_v1;
  if (['bola_idor', 'bfla'].includes(type)) return CONTRACTS.authorization_stateful_v1;
  if (['business_logic', 'auth_otp', 'email_sms_bypass', 'passcode_bypass'].includes(type)) return CONTRACTS.business_stateful_v1;
  if (['replay_race', 'state_machine_race'].includes(type)) return CONTRACTS.race_v1;
  return CONTRACTS.strict_generic_v1;
}

export function listEvidenceContracts(): VulnerabilityEvidenceContract[] {
  return Object.values(CONTRACTS).map(contract => ({ ...contract, required: [...contract.required], optional: [...contract.optional] }));
}
