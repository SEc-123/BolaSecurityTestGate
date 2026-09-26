export const DISCOVERY_COMPLETED_PHASE = 'tool_completed:browser.discover_target';

export function isDedicatedWebDiscovery(task: Record<string, any>, config: Record<string, any> = {}): boolean {
  return (task.task_type === 'discover_target' || task.execution_plan?.intent === 'discover_target') &&
    ![config.surface, config.surface_type, config.mobile?.platform, config.android?.platform].includes('android');
}

export function requiresAutomaticAccounts(config: Record<string, any> = {}): boolean {
  return config.account_mode === 'auto_execute' || config.enable_account_auto_execution === true;
}
