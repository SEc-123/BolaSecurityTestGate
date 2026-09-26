import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MobileObservation, MobileSession, NormalizedHttpFlow } from './mobile-types.js';
import type { StepCaptureScope } from './mobile-network-assertions.js';
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export async function setCaptureStep(session: MobileSession, scope: StepCaptureScope | null): Promise<void> {
  const file = session.health_json?.capture?.path;
  if (!file) { if (scope) throw new Error('Session has no capture path for Appium step correlation.'); return; }
  const target = `${file}.step.json`;
  if (!scope) { await fs.rm(target, { force: true }); return; }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ ...scope, expires_at: new Date(Date.now() + 180000).toISOString() }), { mode: 0o600 });
  await fs.rename(temp, target); // Request hook never sees a half-written context.
}
export async function captureDiagnostics(session: MobileSession, scope?: StepCaptureScope): Promise<Record<string, any>[]> {
  const file = session.health_json?.capture?.path;
  if (!file) return [];
  try {
    const stat = await fs.stat(`${file}.diagnostics.jsonl`);
    if (stat.size > 4 * 1024 * 1024) return [{ event: 'diagnostics_limit_exceeded' }];
    const text = await fs.readFile(`${file}.diagnostics.jsonl`, 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.capture_session_id === session.health_json.capture.id && (!scope || e.test_run_id === scope.run_id && e.step_id === scope.step_id));
  } catch (e: any) { if (e.code === 'ENOENT') return []; return [{ event: 'diagnostics_unreadable' }]; }
}
export async function persistStepEvidence(session: MobileSession, stepId: string, observation: MobileObservation | null, flows: NormalizedHttpFlow[], trace: unknown[]) {
  if (!/^[a-f0-9-]{36}$/i.test(stepId)) throw new Error('Invalid evidence step identifier.');
  const dir = path.resolve(process.env.BSTG_DATA_DIR || 'data', 'mobile', 'test-evidence', session.id, stepId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const files: Record<string, { path: string; sha256: string; bytes: number }> = {};
  const save = async (name: string, data: string | Buffer) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const file = path.join(dir, name);
    await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
    files[name] = { path: file, sha256: sha256(bytes), bytes: bytes.length };
  };
  if (observation?.screenshot_base64) await save('screen.png', Buffer.from(observation.screenshot_base64, 'base64'));
  if (observation) await save('ui.json', JSON.stringify({ ...observation, screenshot_base64: undefined, suggested_actions: [] }));
  await save('network.json', JSON.stringify(flows));
  await save('appium.json', JSON.stringify(trace));
  return { files, contains_sensitive_test_data: true };
}
export async function verifyEvidenceFile(file: { path: string; sha256: string }): Promise<Buffer> {
  const bytes = await fs.readFile(file.path);
  if (sha256(bytes) !== file.sha256) throw new Error('Mobile test evidence integrity check failed.');
  return bytes;
}
