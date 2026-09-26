import type { NativeBstgRunResult } from './bstg-native-orchestrator.js';
import { localText, type OutputLanguage } from '../i18n/language.js';

export type EvidenceGateVerdict = 'confirmed' | 'insufficient_native_evidence' | 'inconclusive';

export interface NativeEvidenceGateResult {
  verdict: EvidenceGateVerdict;
  native_required: true;
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
  return Boolean(result && result.success === true && result.test_run_id && !result.has_execution_error);
}

export function evaluateNativeEvidence(native: NativeBstgRunResult | undefined | null, language: OutputLanguage = 'en'): NativeEvidenceGateResult {
  const missing: string[] = [];
  if (!native) {
    return {
      verdict: 'insufficient_native_evidence',
      native_required: true,
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
      evidence_summary: localText(language, 'No native BSTG execution result was produced.', '未生成原生 BSTG 执行结果。'),
    };
  }

  const templateExecuted = testRunExecuted(native.template_run);
  const baselineVerified = testRunExecuted(native.baseline_workflow_run);
  const mutationExecuted = workflowExecuted(native.mutation_workflow_run);
  const apiModeExecuted = Boolean(native.api_mode && testRunExecuted(native.api_mode.baseline_run) && testRunExecuted(native.api_mode.mutation_run));
  const advancedMutationDimensions = Array.isArray(native.advanced_mutation?.plan?.dimensions) ? native.advanced_mutation!.plan.dimensions.map(String) : [];
  const advancedMutationExecuted = Boolean(native.advanced_mutation && advancedMutationDimensions.length > 0 && mutationExecuted);

  if (!apiModeExecuted) missing.push('api_mode_test_run_not_successful');
  if (!templateExecuted) missing.push('template_test_run_not_successful');
  if (!baselineVerified) missing.push('baseline_workflow_not_verified');
  if (!mutationExecuted) missing.push('mutation_workflow_not_executed');
  if (!native.assets?.template_ids?.length) missing.push('native_api_templates_missing');
  if (!native.assets?.baseline_workflow_id) missing.push('native_baseline_workflow_missing');
  if (!native.assets?.mutation_workflow_id) missing.push('native_mutation_workflow_missing');
  if (native.advanced_mutation && advancedMutationDimensions.length > 0 && !advancedMutationExecuted) missing.push('advanced_mutation_not_executed');

  const verdict: EvidenceGateVerdict = missing.length === 0 ? 'confirmed' : 'insufficient_native_evidence';
  return {
    verdict,
    native_required: true,
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
      ? localText(language, 'Native BSTG API-mode template test run, aggregate template run, baseline workflow, mutation workflow, and advanced mutation evidence executed successfully when applicable. Direct evidence can be used as confirmation, not as the sole finding source.', '原生 BSTG API 模式模板测试运行、聚合模板运行、基线工作流、变异工作流以及适用时的高级变异证据均已成功执行。直接证据可作为确认依据，但不应作为唯一发现来源。')
      : localText(language, `Native BSTG evidence is incomplete: ${missing.join(', ')}`, `原生 BSTG 证据不完整：${missing.join(', ')}`),
  };
}

export function canCreateFindingFromNativeAndJudge(native: NativeBstgRunResult | undefined | null, judge: { verdict?: string }, language: OutputLanguage = 'en'): NativeEvidenceGateResult {
  const gate = evaluateNativeEvidence(native, language);
  if (judge.verdict !== 'vulnerable') {
    return {
      ...gate,
      verdict: 'inconclusive',
      evidence_summary: localText(language, `Judge verdict is ${judge.verdict || 'unknown'}; no confirmed finding should be created.`, `判断结果为 ${judge.verdict || 'unknown'}；不应创建已确认发现项。`),
    };
  }
  return gate;
}
