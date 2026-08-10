import type { NativeBstgRunResult } from './bstg-native-orchestrator.js';
import { localText, type OutputLanguage } from '../i18n/language.js';
import { evidenceContractForVulnerability, type NativeEvidenceRequirement } from './evidence-contracts.js';

export type EvidenceGateVerdict = 'confirmed' | 'insufficient_native_evidence' | 'inconclusive';

export interface NativeEvidenceGateResult {
  verdict: EvidenceGateVerdict;
  native_required: true;
  contract_id: string;
  contract_description: string;
  required_evidence: NativeEvidenceRequirement[];
  optional_evidence: NativeEvidenceRequirement[];
  satisfied_evidence: NativeEvidenceRequirement[];
  baseline_verified: boolean;
  mutation_executed: boolean;
  template_executed: boolean;
  native_test_run_ids: string[];
  native_api_mode_executed: boolean;
  native_api_test_run_ids: string[];
  native_workflow_ids: string[];
  native_template_ids: string[];
  advanced_mutation_executed: boolean;
  advanced_mutation_dimensions: string[];
  missing_evidence: string[];
  evidence_summary: string;
}

function testRunExecuted(result: any): boolean {
  return Boolean(result && result.success === true && result.test_run_id && !result.has_execution_error);
}

function workflowExecuted(result: any): boolean {
  return Boolean(result && result.success === true && result.test_run_id);
}

export function evaluateNativeEvidence(
  native: NativeBstgRunResult | undefined | null,
  language: OutputLanguage = 'en',
  vulnType?: string | null,
): NativeEvidenceGateResult {
  const contract = evidenceContractForVulnerability(vulnType);
  if (!native) {
    return {
      verdict: 'insufficient_native_evidence',
      native_required: true,
      contract_id: contract.id,
      contract_description: contract.description,
      required_evidence: [...contract.required],
      optional_evidence: [...contract.optional],
      satisfied_evidence: [],
      baseline_verified: false,
      mutation_executed: false,
      template_executed: false,
      native_test_run_ids: [],
      native_api_mode_executed: false,
      native_api_test_run_ids: [],
      native_workflow_ids: [],
      native_template_ids: [],
      advanced_mutation_executed: false,
      advanced_mutation_dimensions: [],
      missing_evidence: ['native_bstg_orchestration_missing'],
      evidence_summary: localText(language, `No native BSTG execution result was produced for evidence contract ${contract.id}.`, `证据合同 ${contract.id} 未获得原生 BSTG 执行结果。`),
    };
  }

  const templateExecuted = testRunExecuted(native.template_run);
  const baselineVerified = testRunExecuted(native.baseline_workflow_run);
  const mutationExecuted = workflowExecuted(native.mutation_workflow_run);
  const apiModeExecuted = Boolean(native.api_mode && testRunExecuted(native.api_mode.baseline_run) && testRunExecuted(native.api_mode.mutation_run));
  const advancedMutationDimensions = Array.isArray(native.advanced_mutation?.plan?.dimensions) ? native.advanced_mutation!.plan.dimensions.map(String) : [];
  const advancedMutationExecuted = Boolean(native.advanced_mutation && advancedMutationDimensions.length > 0 && mutationExecuted);

  const evidence: Record<NativeEvidenceRequirement, boolean> = {
    api_mode: apiModeExecuted,
    aggregate_template_run: templateExecuted,
    baseline_workflow_run: baselineVerified,
    mutation_workflow_run: mutationExecuted,
    template_assets: Boolean(native.assets?.template_ids?.length || native.assets?.api_mode_template_ids?.length),
    baseline_workflow_asset: Boolean(native.assets?.baseline_workflow_id),
    mutation_workflow_asset: Boolean(native.assets?.mutation_workflow_id),
    advanced_mutation: advancedMutationExecuted,
  };
  const satisfied = (Object.entries(evidence).filter(([, ok]) => ok).map(([key]) => key) as NativeEvidenceRequirement[]);
  const missing = contract.required.filter(requirement => !evidence[requirement]).map(requirement => `required:${requirement}`);
  const verdict: EvidenceGateVerdict = missing.length === 0 ? 'confirmed' : 'insufficient_native_evidence';

  return {
    verdict,
    native_required: true,
    contract_id: contract.id,
    contract_description: contract.description,
    required_evidence: [...contract.required],
    optional_evidence: [...contract.optional],
    satisfied_evidence: satisfied,
    baseline_verified: baselineVerified,
    mutation_executed: mutationExecuted,
    template_executed: templateExecuted,
    native_test_run_ids: [
      native.assets.template_test_run_id,
      native.assets.baseline_workflow_test_run_id,
      native.assets.mutation_workflow_test_run_id,
      native.assets.api_mode_baseline_test_run_id,
      native.assets.api_mode_mutation_test_run_id,
    ].filter((id): id is string => Boolean(id)),
    native_api_mode_executed: apiModeExecuted,
    native_api_test_run_ids: [native.assets.api_mode_baseline_test_run_id, native.assets.api_mode_mutation_test_run_id].filter((id): id is string => Boolean(id)),
    native_workflow_ids: [native.assets.baseline_workflow_id, native.assets.mutation_workflow_id].filter((id): id is string => Boolean(id)),
    native_template_ids: [...(native.assets.template_ids || []), ...(native.assets.api_mode_template_ids || [])],
    advanced_mutation_executed: advancedMutationExecuted,
    advanced_mutation_dimensions: advancedMutationDimensions,
    missing_evidence: missing,
    evidence_summary: verdict === 'confirmed'
      ? localText(language, `Native evidence contract ${contract.id} is satisfied. Required evidence: ${contract.required.join(', ')}.`, `原生证据合同 ${contract.id} 已满足。必需证据：${contract.required.join(', ')}。`)
      : localText(language, `Native evidence contract ${contract.id} is incomplete: ${missing.join(', ')}`, `原生证据合同 ${contract.id} 不完整：${missing.join(', ')}`),
  };
}

export function canCreateFindingFromNativeAndJudge(
  native: NativeBstgRunResult | undefined | null,
  judge: { verdict?: string },
  language: OutputLanguage = 'en',
  vulnType?: string | null,
): NativeEvidenceGateResult {
  const gate = evaluateNativeEvidence(native, language, vulnType);
  if (judge.verdict !== 'vulnerable') {
    return {
      ...gate,
      verdict: 'inconclusive',
      evidence_summary: localText(language, `Judge verdict is ${judge.verdict || 'unknown'}; no confirmed finding should be created.`, `判断结果为 ${judge.verdict || 'unknown'}；不应创建已确认发现项。`),
    };
  }
  return gate;
}
