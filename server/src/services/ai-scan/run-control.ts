import { AsyncLocalStorage } from 'node:async_hooks';

export interface PolicyDenial {
  code: 'provider_policy_denied';
  at: string;
  provider_id: string;
  model: string;
}
interface ScanControl {
  runId: string;
  controller: AbortController;
  denial?: PolicyDenial;
  users: number;
}
const scans = new AsyncLocalStorage<ScanControl>();
const activeScopes = new Map<string, ScanControl>();
export const POLICY_DENIAL_MESSAGE = '模型服务因安全策略或权限拒绝了本轮请求，整轮安全分析已停止。已保留此前证据，未完成项不能理解为未发现风险。';
export class ScanPolicyDeniedError extends Error {
  readonly code = 'provider_policy_denied';
  constructor() { super(POLICY_DENIAL_MESSAGE); this.name = 'ScanPolicyDeniedError'; }
}

/** Scope follows nested planners/judges and parallel tasks, never other runs. */
export function withScanControl<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  if (scans.getStore()?.runId === runId) return operation();
  const scope = activeScopes.get(runId) || { runId, controller: new AbortController(), users: 0 };
  activeScopes.set(runId, scope);
  scope.users += 1;
  return scans.run(scope, async () => {
    try { assertScanActive(); return await operation(); }
    finally {
      scope.users -= 1;
      if (scope.users === 0 && activeScopes.get(runId) === scope) activeScopes.delete(runId);
    }
  });
}
export function scanPolicyDenial(): PolicyDenial | undefined { return scans.getStore()?.denial; }
export function assertScanActive(): void {
  if (scans.getStore()?.controller.signal.aborted) throw new ScanPolicyDeniedError();
}
export function stopScanForPolicyDenial(provider: { provider_id: string; model: string }): void {
  const scope = scans.getStore();
  if (!scope || scope.denial) return;
  scope.denial = { code: 'provider_policy_denied', at: new Date().toISOString(), ...provider };
  // Synchronous: stop siblings before any persistence or error handling awaits.
  scope.controller.abort(new ScanPolicyDeniedError());
}
export function scanAbortSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  assertScanActive();
  const runSignal = scans.getStore()?.controller.signal;
  return signal && runSignal ? AbortSignal.any([signal, runSignal]) : runSignal || signal || undefined;
}
