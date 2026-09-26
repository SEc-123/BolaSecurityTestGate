import type { DbProvider } from '../../types/index.js';
import { dbGet } from '../../db/sql-helpers.js';
import { AIClient } from '../ai/ai-client.js';
import type { AIProvider } from '../ai/types.js';
import type { AIDiscoveredEndpoint } from './types.js';
import type { HttpResponseEvidence } from './http-executor.js';
import {
  extractJsonObject,
  normalizeJudgeConfidence,
  normalizeJudgeEvidence,
  normalizeJudgeSeverity,
  normalizeJudgeVerdict,
} from './ai-judge-normalization.js';
import { localText, outputLanguageInstruction, type OutputLanguage } from '../i18n/language.js';
import { sanitizeForAIModel } from '../../agent/model-context-sanitizer.js';

const AI_JUDGE_MAX_TOKENS = Math.max(2000, Number(process.env.BSTG_AI_JUDGE_MAX_TOKENS || 4096) || 4096);

export interface GenericJudgeResult {
  verdict: 'vulnerable' | 'not_vulnerable' | 'inconclusive';
  confidence: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  reason: string;
  evidence: string[];
  source?: 'ai_provider' | 'heuristic_fallback';
  provider_id?: string;
  model?: string;
}

export class AIProviderJudgementError extends Error {
  provider_id?: string;
  model?: string;
  provider_response?: Record<string, any>;

  constructor(message: string, provider?: AIProvider, cause?: unknown, providerResponse?: Record<string, any>) {
    super(message);
    this.name = 'AIProviderJudgementError';
    this.provider_id = provider?.id;
    this.model = provider?.model;
    this.provider_response = providerResponse;
    if (cause !== undefined) (this as any).cause = cause;
  }
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

function attemptResponseText(item: any): string {
  return `${item?.mutated?.body_preview || ''} ${JSON.stringify(item?.mutated?.headers || {})}`;
}

function hasBaselineAccessControlSignal(_vulnType:string,_normal?:HttpResponseEvidence):boolean {
  // A privileged-looking baseline may be an authorized admin session. It is never an authorization proof.
  return false;
}

function confirmablePositiveAttempts(vulnType: string, attempts: any[]): any[] {
  return attempts.filter(item=>{
    if(!item.normal?.ok || !item.mutated?.ok)return false;
    const before=String(item.normal.body_preview||''),after=String(item.mutated.body_preview||'');
    if(vulnType==='bola_idor')return item.authorization_boundary_verified===true;
    if(vulnType==='command_injection')return /uid=\d+\([^)]+\).*gid=\d+/.test(after)&&!/uid=\d+\([^)]+\).*gid=\d+/.test(before);
    if(['path_traversal','file_download'].includes(vulnType))return /^root:[^\n:]*:0:0:/m.test(after)&&!/^root:[^\n:]*:0:0:/m.test(before);
    if(vulnType==='xss')return item.browser_execution_verified===true;
    return item.business_invariant_verified===true;
  });
}

function downgradeUnsupportedVulnerableVerdict(input: { vuln_type: string; normal?: HttpResponseEvidence; attempts: any[] }, judge: GenericJudgeResult, language: OutputLanguage): GenericJudgeResult {
  const positiveAttempts = confirmablePositiveAttempts(input.vuln_type, input.attempts);
  if (judge.verdict !== 'vulnerable' && positiveAttempts.length > 0) {
    const first = positiveAttempts[0];
    return {
      ...judge,
      verdict: 'vulnerable',
      confidence: Math.max(Number(judge.confidence || 0), 0.82),
      severity: input.vuln_type === 'command_injection' ? 'critical' : ['bola_idor', 'bfla', 'path_traversal', 'file_download', 'email_sms_bypass', 'passcode_bypass'].includes(input.vuln_type) ? 'high' : 'medium',
      title: localText(language, `AI-confirmed ${input.vuln_type} evidence`, `AI 确认的 ${input.vuln_type} 证据`),
      reason: `${judge.reason || localText(language, 'Provider verdict was not vulnerable.', '提供方未判定为漏洞。')} ${localText(language, 'Local native evidence contained a confirmed mutated-response security signal, so the evidence gate upgraded the verdict.', '本地原生证据包含已确认的变异响应安全信号，因此证据门禁升级判断。')}`,
      evidence: [
        ...(judge.evidence || []).slice(0, 2),
        `local_evidence_gate=confirmable_mutated_response_signal label=${first.label || 'n/a'} target=${first.target || 'n/a'} status=${first.mutated?.status ?? 'n/a'}`,
      ],
    };
  }
  if (judge.verdict !== 'vulnerable' && hasBaselineAccessControlSignal(input.vuln_type, input.normal)) {
    return {
      ...judge,
      verdict: 'vulnerable',
      confidence: Math.max(Number(judge.confidence || 0), 0.82),
      severity: 'high',
      title: input.vuln_type === 'bfla' ? localText(language, 'AI-confirmed BFLA evidence', 'AI 确认的 BFLA 证据') : judge.title,
      reason: `${judge.reason || localText(language, 'Access-control sensitive response observed.', '观察到访问控制敏感响应。')} ${localText(language, 'Baseline request under attacker identity reached privileged/admin data, which is confirmable BFLA evidence.', '攻击者身份下的基线请求访问到特权/管理员数据，可确认 BFLA 证据。')}`,
      evidence: [
        ...(judge.evidence || []).slice(0, 3),
        'baseline_access_control_signal=attacker_session_reached_privileged_function',
      ],
    };
  }
  if (judge.verdict !== 'vulnerable') return judge;
  const positives = confirmablePositiveAttempts(input.vuln_type, input.attempts);
  if (positives.length > 0) return judge;
  if (hasBaselineAccessControlSignal(input.vuln_type, input.normal)) {
    return {
      ...judge,
      evidence: [
        ...(judge.evidence || []).slice(0, 3),
        'baseline_access_control_signal=attacker_session_reached_privileged_function',
      ],
    };
  }

  const acceptedChanged = input.attempts.filter(item => {
    const status = Number(item?.mutated?.status || 0);
    return status >= 200 && status < 300 && Boolean(item?.comparison?.changed);
  });
  const verdict = 'inconclusive' as const;
  return {
    ...judge,
    verdict,
    confidence: Math.min(Number(judge.confidence || 0.55), verdict === 'inconclusive' ? 0.6 : 0.68),
    severity: 'low',
    title: verdict === 'inconclusive'
      ? localText(language, `${input.vuln_type} evidence changed but lacks a confirmed security signal`, `${input.vuln_type} 证据发生变化但缺少确认的安全信号`)
      : localText(language, `No confirmed ${input.vuln_type} impact in local evidence`, `本地证据未确认 ${input.vuln_type} 影响`),
    reason: `${judge.reason || localText(language, 'AI provider marked the evidence vulnerable.', 'AI 提供方将证据标记为漏洞。')} ${localText(language, 'Local evidence gate downgraded the verdict because no mutated response contained a confirmable security signal.', '本地证据门禁将判断降级，因为没有变异响应包含可确认的安全信号。')}`,
    evidence: [
      ...(judge.evidence || []).slice(0, 2),
      'local_evidence_gate=no_confirmable_mutated_response_signal',
      ...acceptedChanged.slice(0, 3).map(item => `${item.label} target=${item.target} status=${item.mutated?.status ?? 'n/a'} signal=${item.comparison?.security_signal || 'n/a'}`),
    ],
  };
}

function heuristic(input: { vuln_type: string; endpoint: AIDiscoveredEndpoint; normal?: HttpResponseEvidence; attempts: any[] }, language: OutputLanguage): GenericJudgeResult {
  if(!input.normal?.ok || !input.attempts.length || input.attempts.some(a=>a.mutated?.error))return {verdict:'inconclusive',confidence:0,severity:'low',title:'测试前提或请求执行未满足',reason:'基线必须成功，且实际变体请求必须执行完成。',evidence:[]};
  const positives = confirmablePositiveAttempts(input.vuln_type, input.attempts);
  if (positives.length > 0) {
    const first = positives[0];
    const severity = input.vuln_type === 'command_injection' ? 'critical' : ['bola_idor', 'bfla', 'path_traversal', 'file_download'].includes(input.vuln_type) ? 'high' : 'medium';
    return {
      verdict: 'vulnerable',
      confidence: 0.82,
      severity,
      title: localText(language, `${input.endpoint.method} ${input.endpoint.path} may be vulnerable to ${input.vuln_type}`, `${input.endpoint.method} ${input.endpoint.path} 可能存在 ${input.vuln_type} 漏洞`),
      reason: localText(language, `After payload ${first.label} targeted ${first.target}, the response showed security signals: ${first.comparison.reasons.join('; ')}`, `payload ${first.label} 作用于 ${first.target} 后，响应出现安全信号：${first.comparison.reasons.join('; ')}`),
      evidence: positives.slice(0, 5).map(item => `${item.label} target=${item.target} status=${item.mutated?.status ?? 'n/a'} reasons=${item.comparison?.reasons?.join('; ') || ''}`),
    };
  }
  if (hasBaselineAccessControlSignal(input.vuln_type, input.normal)) {
    return {
      verdict: 'vulnerable',
      confidence: 0.82,
      severity: 'high',
      title: localText(language, `${input.endpoint.method} ${input.endpoint.path} may be vulnerable to ${input.vuln_type}`, `${input.endpoint.method} ${input.endpoint.path} 可能存在 ${input.vuln_type} 漏洞`),
      reason: localText(language, 'The normal/attacker session baseline directly accessed admin or permission-sensitive data, indicating the target function lacks an authorization boundary.', '普通/攻击者会话 baseline 直接访问到后台或权限敏感数据，说明目标函数缺少权限边界。'),
      evidence: [`baseline status=${input.normal?.status ?? 'n/a'} contains privileged access-control signal`],
    };
  }
  const accepted = input.attempts.filter(item => item.mutated?.status && item.mutated.status >= 200 && item.mutated.status < 300 && item.comparison?.changed);
  if (accepted.length > 0) {
    return {
      verdict: 'inconclusive',
      confidence: 0.58,
      severity: 'low',
      title: localText(language, `${input.endpoint.method} ${input.endpoint.path} shows observable differences for ${input.vuln_type} payloads`, `${input.endpoint.method} ${input.endpoint.path} 对 ${input.vuln_type} payload 有可观察差异`),
      reason: localText(language, 'The mutated request was accepted with a 2xx response and the response changed, but there are not enough sensitive signals to confirm a vulnerability.', '变异请求被 2xx 接受且响应发生变化，但没有足够敏感信号确认漏洞。'),
      evidence: accepted.slice(0, 5).map(item => `${item.label} target=${item.target} status=${item.mutated?.status ?? 'n/a'}`),
    };
  }
  if(['bola_idor','bfla','business_logic','auth_otp','email_sms_bypass','passcode_bypass','replay_race','state_machine_race'].includes(input.vuln_type))return {
    verdict:'inconclusive',confidence:0,severity:'low',title:'业务或身份对照证据不足',reason:'请求已执行，但本轮缺少可证明对象归属、权限边界或业务状态的对照证据。',evidence:input.attempts.map(item=>`${item.label}: HTTP ${item.mutated?.status??'unknown'}`)};
  return {
    verdict: 'not_vulnerable',
    confidence: 0.68,
    severity: 'low',
    title: localText(language, `No obvious ${input.vuln_type} vulnerability confirmed at ${input.endpoint.method} ${input.endpoint.path}`, `${input.endpoint.method} ${input.endpoint.path} 未发现明显 ${input.vuln_type} 漏洞`),
    reason: localText(language, 'Current payloads did not produce confirmable security impact.', '当前 payload 未产生可确认的安全影响。'),
    evidence: input.attempts.slice(0, 8).map(item => `${item.label} target=${item.target} status=${item.mutated?.status ?? 'n/a'} signal=${item.comparison?.security_signal || 'n/a'}`),
  };
}

function parseJson(text: string, language: OutputLanguage): GenericJudgeResult | null {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;
  return {
    verdict: normalizeJudgeVerdict(parsed),
    confidence: normalizeJudgeConfidence(parsed.confidence),
    severity: normalizeJudgeSeverity(parsed.severity),
    title: String(parsed.title || parsed.summary || localText(language, 'AI vulnerability judgement', 'AI 漏洞判断')),
    reason: String(parsed.reason || parsed.rationale || parsed.analysis || ''),
    evidence: normalizeJudgeEvidence(parsed.evidence ?? parsed.evidence_summary ?? parsed.key_evidence),
  };
}

function choiceText(response: any): string {
  const message = response?.choices?.[0]?.message || {};
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      try { return JSON.stringify(part); } catch { return String(part); }
    }).join('\n');
  }
  if (content && typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return '';
}

function responseSummary(response: any): Record<string, any> {
  const message = response?.choices?.[0]?.message || {};
  const text = choiceText(response);
  return {
    id: response?.id,
    model: response?.model,
    finish_reason: response?.choices?.[0]?.finish_reason,
    content_type: Array.isArray(message.content) ? 'array' : typeof message.content,
    content_length: text.length,
    content_excerpt: text.slice(0, 4000),
    usage: response?.usage,
  };
}

export async function judgeGenericAttempts(db: DbProvider, input: {
  vuln_type: string;
  endpoint: AIDiscoveredEndpoint;
  normal: HttpResponseEvidence;
  attempts: any[];
  language?: OutputLanguage;
}): Promise<GenericJudgeResult> {
  const language = input.language || 'en';
  const fallback: GenericJudgeResult = { ...heuristic(input, language), source: 'heuristic_fallback' };
  if(!input.normal?.ok || !input.attempts.length)return fallback;
  if(['bola_idor','bfla','business_logic','auth_otp','email_sms_bypass','passcode_bypass','replay_race','state_machine_race'].includes(input.vuln_type)&&!confirmablePositiveAttempts(input.vuln_type,input.attempts).length)return fallback;
  const provider = await getDefaultProvider(db).catch(() => null);
  if (!provider) return fallback;
  try {
    const client = new AIClient(provider);
    const compact = sanitizeForAIModel(input.attempts.map(item => ({
      label: item.label,
      target: item.target,
      payload: String(item.payload).slice(0, 200),
      mutated_status: item.mutated?.status,
      mutated_headers: item.mutated?.headers,
      mutated_body: String(item.mutated?.body_preview || '').slice(0, 1200),
      comparison: item.comparison,
    })));
    const safeNormal = sanitizeForAIModel(input.normal);
    const prompt = `You are judging pre-finding web security evidence for vuln_type=${input.vuln_type}. Return one compact JSON object only with this schema: {"verdict":"vulnerable|not_vulnerable|inconclusive","confidence":0.0,"severity":"critical|high|medium|low","title":"...","reason":"max 500 chars","evidence":["max 4 short evidence strings"]}. Keep JSON keys and enum values stable; write title, reason, and evidence strings in the requested output language. Do not mark a vulnerability unless the evidence reached the target function and shows a security impact.\n${outputLanguageInstruction(language)}\nEndpoint: ${input.endpoint.method} ${input.endpoint.path}\nBaseline: ${JSON.stringify(safeNormal).slice(0, 2500)}\nAttempts: ${JSON.stringify(compact).slice(0, 10000)}`;
    const request = {
      model: provider.model,
      messages: [{ role: 'system' as const, content: localText(language, 'Return strict JSON only. No markdown. No prose.', '只返回严格 JSON。不要 Markdown，不要说明文字。') }, { role: 'user' as const, content: prompt }],
      temperature: 0.1,
      max_tokens: AI_JUDGE_MAX_TOKENS,
      response_format: { type: 'json_object' as const },
      timeout_ms: 60000,
      max_retries: 1,
    };
    const response = await client.chat(request);
    const firstText = choiceText(response);
    let parsed = parseJson(firstText, language);
    let retryResponse: any | null = null;
    if (!parsed) {
      retryResponse = await client.chat({
        ...request,
        messages: [
          { role: 'system', content: localText(language, 'Return exactly one valid JSON object. No markdown. No prose.', '只返回一个有效 JSON 对象。不要 Markdown，不要说明文字。') },
          {
            role: 'user',
            content: `${prompt}\n\nThe previous provider response was not valid parseable JSON. Re-judge from the evidence above and return only the required compact JSON object. Previous response excerpt:\n${firstText.slice(0, 4000)}`,
          },
        ],
        max_tokens: AI_JUDGE_MAX_TOKENS,
        max_retries: 0,
      });
      parsed = parseJson(choiceText(retryResponse), language);
    }
    if (!parsed) {
      throw new AIProviderJudgementError(
        'AI provider returned non-JSON or unparsable judgement; task paused instead of heuristic fallback.',
        provider,
        undefined,
        { first_response: responseSummary(response), retry_response: retryResponse ? responseSummary(retryResponse) : null }
      );
    }
    return downgradeUnsupportedVulnerableVerdict(input, { ...parsed, source: 'ai_provider', provider_id: provider.id, model: provider.model }, language);
  } catch (error) {
    if (error instanceof AIProviderJudgementError) throw error;
    throw new AIProviderJudgementError('AI provider judgement failed; task paused instead of heuristic fallback.', provider, error);
  }
}
