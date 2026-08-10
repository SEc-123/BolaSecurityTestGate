import type { AIScanRepository } from './repository.js';
import type { NativeBstgAssetBundle } from './bstg-native-orchestrator.js';

export interface GeneratedAssetRef {
  asset_type: string;
  asset_id?: string | null;
  metadata_json?: Record<string, any>;
}

export function nativeAssetRefs(assets: Partial<NativeBstgAssetBundle>): GeneratedAssetRef[] {
  const refs: GeneratedAssetRef[] = [];
  const pushMany = (assetType: string, ids?: Array<string | null | undefined>) => {
    for (const id of ids || []) if (id) refs.push({ asset_type: assetType, asset_id: id });
  };
  // Environment ownership is registered only at the AI Scan creation boundary.
  // Native execution may reuse a caller-provided environment and must not claim it as generated.
  pushMany('api_template', assets.template_ids);
  pushMany('api_template', assets.api_mode_template_ids);
  pushMany('test_run', [assets.template_test_run_id, assets.baseline_workflow_test_run_id, assets.mutation_workflow_test_run_id, assets.api_mode_baseline_test_run_id, assets.api_mode_mutation_test_run_id]);
  pushMany('security_rule', [...(assets.security_rule_ids || []), assets.api_mode_security_rule_id]);
  pushMany('checklist', [...(assets.checklist_ids || []), assets.api_mode_checklist_id]);
  pushMany('workflow', [assets.baseline_workflow_id, assets.mutation_workflow_id]);
  pushMany('workflow_variable', assets.workflow_variable_ids);
  pushMany('workflow_mapping', assets.workflow_mapping_ids);
  pushMany('workflow_extractor', assets.workflow_extractor_ids);
  pushMany('workflow_variable_config', assets.workflow_variable_config_ids);
  return refs;
}

export async function registerNativeGeneratedAssets(repo: AIScanRepository, scanRunId: string, taskId: string | undefined, assets: Partial<NativeBstgAssetBundle>): Promise<void> {
  await repo.registerGeneratedAssets(scanRunId, taskId, nativeAssetRefs(assets));
}

export async function retainNativeGeneratedAssetsForReplay(repo: AIScanRepository, scanRunId: string, assets: Partial<NativeBstgAssetBundle>, extraIds: string[] = []): Promise<void> {
  // account_ids are safe to include for retention because retainGeneratedAssetsForReplay only
  // updates assets that were explicitly registered as AI-generated; reused/manual accounts are untouched.
  const ids = [
    ...nativeAssetRefs(assets).map(ref => ref.asset_id).filter((id): id is string => Boolean(id)),
    ...(assets.account_ids || []),
    ...(assets.environment_id ? [assets.environment_id] : []),
    ...extraIds,
  ];
  await repo.retainGeneratedAssetsForReplay(scanRunId, ids);
}
