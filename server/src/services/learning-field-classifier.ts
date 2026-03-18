const AUTH_NAMES = [/token/i, /auth/i, /session/i, /cookie/i, /bearer/i, /csrf/i, /authorization/i];
const FLOW_NAMES = [/challenge/i, /nonce/i, /state/i, /ticket/i, /verification/i, /flow/i];
const OBJECT_NAMES = [/id$/i, /_id$/i, /uuid/i, /guid/i, /order/i, /user/i, /account/i];
const NOISE_NAMES = [/timestamp/i, /^time$/i, /trace/i, /request.?id/i, /^message$/i, /^code$/i, /^status$/i];
const JWT = /^eyJ[A-Za-z0-9_-]+\./;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PredictedType = 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC' | 'NOISE';

export function classifyField(path: string, value: any): { predictedType: PredictedType; confidence: number; reason: string } {
  const name = path.split(/[.\[\]]+/).filter(Boolean).pop() || path;
  const raw = String(value ?? '');
  if (NOISE_NAMES.some((r) => r.test(name))) return { predictedType: 'NOISE', confidence: 0.15, reason: 'noise_name' };
  if (JWT.test(raw) || AUTH_NAMES.some((r) => r.test(name))) return { predictedType: 'IDENTITY', confidence: 0.88, reason: 'auth_pattern' };
  if (FLOW_NAMES.some((r) => r.test(name))) return { predictedType: 'FLOW_TICKET', confidence: 0.8, reason: 'flow_pattern' };
  if (UUID.test(raw) || OBJECT_NAMES.some((r) => r.test(name))) return { predictedType: 'OBJECT_ID', confidence: 0.74, reason: 'object_pattern' };
  return { predictedType: 'GENERIC', confidence: 0.55, reason: 'generic' };
}

export function suggestVariableName(path: string, predictedType: PredictedType): string {
  const base = (path.split(/[.\[\]]+/).filter(Boolean).pop() || 'value')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const prefix = predictedType === 'IDENTITY' ? 'auth' : predictedType === 'FLOW_TICKET' ? 'flow' : predictedType === 'OBJECT_ID' ? 'obj' : 'var';
  return `${prefix}.${base || 'value'}`;
}

export function inferWritePolicy(predictedType: PredictedType): 'first' | 'overwrite' | 'on_success_only' {
  if (predictedType === 'FLOW_TICKET') return 'on_success_only';
  if (predictedType === 'IDENTITY') return 'first';
  return 'overwrite';
}
