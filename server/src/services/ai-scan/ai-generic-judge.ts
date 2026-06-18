import type { DbProvider } from '../../types/index.js';
import { dbGet } from '../../db/sql-helpers.js';
import { AIClient } from '../ai/ai-client.js';
import type { AIProvider } from '../ai/types.js';
import type { AIDiscoveredEndpoint } from './types.js';
import type { HttpResponseEvidence } from './http-executor.js';

export interface GenericJudgeResult {
  verdict: 'vulnerable' | 'not_vulnerable' | 'inconclusive';
  confidence: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  reason: string;
  evidence: string[];
}

async function getDefaultProvider(db: DbProvider): Promise<AIProvider | null> {
  const row = await dbGet<any>(db, `SELECT * FROM ai_providers WHERE is_enabled = ? ORDER BY is_default DESC, created_at DESC LIMIT 1`, [db.kind === 'sqlite' ? 1 : true]);
  return row ? (row as AIProvider) : null;
}

function isSensitiveAccessControlSignal(vulnType: string, body: string): boolean {
  if (['bola_idor', 'bfla'].includes(vulnType)) {
    return /other user|victim|secret|admin|administrator|permission|privilege|users\s*[:\[]|email|owner|role|user management/i.test(body);
  }
  if (['business_logic', 'auth_otp', 'email_sms_bypass', 'passcode_bypass', 'replay_race', 'state_machine_race'].includes(vulnType)) {
    return /negative|accepted|paid|success|bypass|discount|coupon|refunded|cancelled|race_window|total\s*[:=]\s*-|quantity\s*[:=]\s*-|admin|verified|replayed|otp|sms|email|passcode|code\s*[:=]|verified\s*[:=]\s*true|login_success|token/i.test(body);
  }
  return false;
}

function heuristic(input: { vuln_type: string; endpoint: AIDiscoveredEndpoint; attempts: any[] }): GenericJudgeResult {
  const semanticPositiveAttempts = input.attempts.filter(item => {
    const body = String(item.mutated?.body_preview || '') + ' ' + JSON.stringify(item.mutated?.headers || {});
    return item.mutated?.status >= 200 && item.mutated?.status < 300 && item.comparison?.changed && isSensitiveAccessControlSignal(input.vuln_type, body);
  });
  const positives = [
    ...input.attempts.filter(item => item.comparison?.security_signal === 'positive'),
    ...semanticPositiveAttempts,
  ].filter((item, index, array) => array.findIndex(other => other.label === item.label && other.target === item.target) === index);
  if (positives.length > 0) {
    const first = positives[0];
    const severity = input.vuln_type === 'command_injection' ? 'critical' : ['bola_idor', 'bfla', 'path_traversal', 'file_download'].includes(input.vuln_type) ? 'high' : 'medium';
    return {
      verdict: 'vulnerable',
      confidence: 0.82,
      severity,
      title: `${input.endpoint.method} ${input.endpoint.path} 可能存在 ${input.vuln_type} 漏洞`,
      reason: `payload ${first.label} 作用于 ${first.target} 后，响应出现安全信号：${first.comparison.reasons.join('; ')}`,
      evidence: positives.slice(0, 5).map(item => `${item.label} target=${item.target} status=${item.mutated?.status ?? 'n/a'} reasons=${item.comparison?.reasons?.join('; ') || ''}`),
    };
  }
  const accepted = input.attempts.filter(item => item.mutated?.status && item.mutated.status >= 200 && item.mutated.status < 300 && item.comparison?.changed);
  if (accepted.length > 0) {
    return {
      verdict: 'inconclusive',
      confidence: 0.58,
      severity: 'low',
      title: `${input.endpoint.method} ${input.endpoint.path} 对 ${input.vuln_type} payload 有可观察差异`,
      reason: '变异请求被 2xx 接受且响应发生变化，但没有足够敏感信号确认漏洞。',
      evidence: accepted.slice(0, 5).map(item => `${item.label} target=${item.target} status=${item.mutated?.status ?? 'n/a'}`),
    };
  }
  return {
    verdict: 'not_vulnerable',
    confidence: 0.68,
    severity: 'low',
    title: `${input.endpoint.method} ${input.endpoint.path} 未发现明显 ${input.vuln_type} 漏洞`,
    reason: '当前 payload 未产生可确认的安全影响。',
    evidence: input.attempts.slice(0, 8).map(item => `${item.label} target=${item.target} status=${item.mutated?.status ?? 'n/a'} signal=${item.comparison?.security_signal || 'n/a'}`),
  };
}

function parseJson(text: string): GenericJudgeResult | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      verdict: ['vulnerable', 'not_vulnerable', 'inconclusive'].includes(parsed.verdict) ? parsed.verdict : 'inconclusive',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      severity: ['critical', 'high', 'medium', 'low'].includes(parsed.severity) ? parsed.severity : 'medium',
      title: String(parsed.title || 'AI vulnerability judgement'),
      reason: String(parsed.reason || ''),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
    };
  } catch {
    return null;
  }
}

export async function judgeGenericAttempts(db: DbProvider, input: {
  vuln_type: string;
  endpoint: AIDiscoveredEndpoint;
  normal: HttpResponseEvidence;
  attempts: any[];
}): Promise<GenericJudgeResult> {
  const fallback = heuristic(input);
  const provider = await getDefaultProvider(db).catch(() => null);
  if (!provider) return fallback;
  try {
    const client = new AIClient(provider);
    const compact = input.attempts.map(item => ({
      label: item.label,
      target: item.target,
      payload: String(item.payload).slice(0, 200),
      mutated_status: item.mutated?.status,
      mutated_headers: item.mutated?.headers,
      mutated_body: String(item.mutated?.body_preview || '').slice(0, 1200),
      comparison: item.comparison,
    }));
    const prompt = `You are judging pre-finding web security evidence for vuln_type=${input.vuln_type}. Return strict JSON only: verdict, confidence, severity, title, reason, evidence.\nEndpoint: ${input.endpoint.method} ${input.endpoint.path}\nBaseline: ${JSON.stringify(input.normal).slice(0, 3000)}\nAttempts: ${JSON.stringify(compact).slice(0, 12000)}`;
    const response = await client.chat({
      model: provider.model,
      messages: [{ role: 'system', content: 'Return strict JSON only. No prose.' }, { role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1200,
    });
    return parseJson(response.choices?.[0]?.message?.content || '') || fallback;
  } catch {
    return fallback;
  }
}
