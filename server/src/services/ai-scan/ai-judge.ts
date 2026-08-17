import type { DbProvider } from '../../types/index.js';
import { dbGet } from '../../db/sql-helpers.js';
import { AIClient } from '../ai/ai-client.js';
import type { AIProvider } from '../ai/types.js';
import {
  extractJsonObject,
  normalizeJudgeConfidence,
  normalizeJudgeEvidence,
  normalizeJudgeSeverity,
  normalizeJudgeVerdict,
} from './ai-judge-normalization.js';
import { localText, outputLanguageInstruction, type OutputLanguage } from '../i18n/language.js';
import { sanitizeForAIModel } from '../../agent/model-context-sanitizer.js';

const AI_JUDGE_MAX_TOKENS = Math.max(1600, Number(process.env.BSTG_AI_JUDGE_MAX_TOKENS || 4096) || 4096);

export interface UploadAttemptEvidence {
  label: string;
  filename: string;
  content_type: string;
  accepted: boolean;
  status?: number;
  response_headers?: Record<string, string>;
  response_body_preview?: string;
  location?: string;
  fetch_status?: number;
  fetched_content_type?: string;
  fetched_body_preview?: string;
  error?: string;
}

export interface UploadJudgeResult {
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

export class AIProviderUploadJudgementError extends Error {
  provider_id?: string;
  model?: string;
  provider_response?: Record<string, any>;

  constructor(message: string, provider?: AIProvider, cause?: unknown, providerResponse?: Record<string, any>) {
    super(message);
    this.name = 'AIProviderUploadJudgementError';
    this.provider_id = provider?.id;
    this.model = provider?.model;
    this.provider_response = providerResponse;
    if (cause !== undefined) (this as any).cause = cause;
  }
}

function headersToText(headers?: Record<string, string>): string {
  return Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
}

async function getDefaultProvider(db: DbProvider): Promise<AIProvider | null> {
  const row = await dbGet<any>(
    db,
    `SELECT * FROM ai_providers WHERE is_enabled = ? ORDER BY is_default DESC, created_at DESC LIMIT 1`,
    [db.kind === 'sqlite' ? 1 : true]
  );
  return row ? (row as AIProvider) : null;
}

function heuristicJudge(endpointPath: string, attempts: UploadAttemptEvidence[], language: OutputLanguage): UploadJudgeResult {
  const dangerous = dangerousAcceptedAttempts(attempts);

  if (dangerous.length > 0) {
    const attempt = dangerous[0];
    return {
      verdict: 'vulnerable',
      confidence: attempt.location ? 0.88 : 0.76,
      severity: /php|jsp|aspx|phtml/i.test(attempt.filename) ? 'high' : 'medium',
      title: localText(language, `File upload endpoint ${endpointPath} accepts a dangerous file or content type`, `文件上传点 ${endpointPath} 接受危险文件或危险内容`),
      reason: localText(language, `Mutated file ${attempt.filename} was accepted by the server${attempt.location ? ' and returned an accessible upload location' : ''}.`, `异常文件 ${attempt.filename} 被服务端接受${attempt.location ? '，并返回/可访问上传位置' : ''}。`),
      evidence: dangerous.map(item => `${item.label}: ${item.filename} status=${item.status ?? 'n/a'} location=${item.location || 'n/a'} fetched_content_type=${item.fetched_content_type || 'n/a'}`),
    };
  }

  const anyAccepted = attempts.some(attempt => attempt.label !== 'normal' && attempt.accepted);
  if (anyAccepted) {
    return {
      verdict: 'inconclusive',
      confidence: 0.55,
      severity: 'low',
      title: localText(language, `File upload endpoint ${endpointPath} accepts some abnormal files`, `文件上传点 ${endpointPath} 接受部分异常文件`),
      reason: localText(language, 'Mutated files were accepted, but current evidence is insufficient to confirm accessibility or exploitable impact.', '异常文件被接受，但当前证据不足以确认文件是否可访问或是否具备可利用影响。'),
      evidence: attempts.filter(item => item.label !== 'normal' && item.accepted).map(item => `${item.label}: ${item.filename} status=${item.status ?? 'n/a'}`),
    };
  }

  return {
    verdict: 'not_vulnerable',
    confidence: 0.7,
    severity: 'low',
    title: localText(language, `No obvious file upload vulnerability confirmed at ${endpointPath}`, `文件上传点 ${endpointPath} 未发现明显文件上传漏洞`),
    reason: localText(language, 'Current payloads were not accepted, or did not produce accessible dangerous-file evidence.', '当前 payload 均未被接受，或未形成可访问的危险文件证据。'),
    evidence: attempts.map(item => `${item.label}: ${item.filename} accepted=${item.accepted} status=${item.status ?? 'n/a'} error=${item.error || ''}`),
  };
}

function dangerousAcceptedAttempts(attempts: UploadAttemptEvidence[]): UploadAttemptEvidence[] {
  return attempts.filter(attempt =>
    attempt.accepted &&
    (
      /svg|html|javascript|xml/i.test(attempt.content_type) ||
      /\.svg|\.html|\.php|\.jsp|\.aspx|\.phtml/i.test(attempt.filename) ||
      /image\/svg\+xml|text\/html|application\/x-php/i.test(attempt.fetched_content_type || '') ||
      /<script|onload=|<svg|<html|<\?php/i.test(attempt.fetched_body_preview || attempt.response_body_preview || '')
    )
  );
}

function downgradeUnsupportedUploadVerdict(endpointPath: string, attempts: UploadAttemptEvidence[], judge: UploadJudgeResult, language: OutputLanguage): UploadJudgeResult {
  if (judge.verdict !== 'vulnerable' || dangerousAcceptedAttempts(attempts).length > 0) return judge;
  const accepted = attempts.filter(attempt => attempt.label !== 'normal' && attempt.accepted);
  const verdict = accepted.length > 0 ? 'inconclusive' : 'not_vulnerable';
  return {
    ...judge,
    verdict,
    confidence: Math.min(Number(judge.confidence || 0.55), verdict === 'inconclusive' ? 0.6 : 0.7),
    severity: 'low',
    title: verdict === 'inconclusive'
      ? localText(language, `File upload endpoint ${endpointPath} accepts files but lacks exploitable evidence`, `文件上传点 ${endpointPath} 有接受行为但缺少可利用证据`)
      : localText(language, `No file upload impact confirmed at ${endpointPath}`, `文件上传点 ${endpointPath} 未确认文件上传影响`),
    reason: `${judge.reason || localText(language, 'AI provider marked the upload vulnerable.', 'AI 提供方将上传标记为漏洞。')} ${localText(language, 'Local evidence gate downgraded the verdict because no accepted upload showed dangerous accessible content or executable impact.', '本地证据门禁将判断降级，因为没有被接受的上传显示可访问的危险内容或可执行影响。')}`,
    evidence: [
      ...(judge.evidence || []).slice(0, 2),
      'local_evidence_gate=no_dangerous_accepted_upload',
      ...accepted.slice(0, 3).map(item => `${item.label}: ${item.filename} status=${item.status ?? 'n/a'} location=${item.location || 'n/a'}`),
    ],
  };
}

function parseJudgeJson(text: string, language: OutputLanguage): UploadJudgeResult | null {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;
  return {
    verdict: normalizeJudgeVerdict(parsed),
    confidence: normalizeJudgeConfidence(parsed.confidence),
    severity: normalizeJudgeSeverity(parsed.severity),
    title: String(parsed.title || parsed.summary || localText(language, 'AI upload judgement', 'AI 上传判断')),
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

export async function judgeUploadAttempts(db: DbProvider, endpointPath: string, attempts: UploadAttemptEvidence[], language: OutputLanguage = 'en'): Promise<UploadJudgeResult> {
  const fallback: UploadJudgeResult = { ...heuristicJudge(endpointPath, attempts, language), source: 'heuristic_fallback' };
  const provider = await getDefaultProvider(db).catch(() => null);
  if (!provider) return fallback;

  try {
    const client = new AIClient(provider);
    const safeAttempts = sanitizeForAIModel(attempts);
    const prompt = `You are judging a web security file upload test before writing a finding. Compare the normal upload and mutated upload evidence. Return one compact JSON object only with this schema: {"verdict":"vulnerable|not_vulnerable|inconclusive","confidence":0.0,"severity":"critical|high|medium|low","title":"...","reason":"max 500 chars","evidence":["max 4 short evidence strings"]}. Keep JSON keys and enum values stable; write title, reason, and evidence strings in the requested output language. Do not mark a vulnerability unless the upload was accepted and there is exploitable impact evidence.\n\n${outputLanguageInstruction(language)}\n\nEndpoint: ${endpointPath}\n\nAttempts:\n${safeAttempts.map(attempt => `---\nlabel=${attempt.label}\nfilename=${attempt.filename}\ncontent_type=${attempt.content_type}\naccepted=${attempt.accepted}\nstatus=${attempt.status}\nheaders=${headersToText(attempt.response_headers)}\nresponse=${attempt.response_body_preview || ''}\nlocation=${attempt.location || ''}\nfetch_status=${attempt.fetch_status || ''}\nfetched_content_type=${attempt.fetched_content_type || ''}\nfetched_body=${attempt.fetched_body_preview || ''}\nerror=${attempt.error || ''}`).join('\n').slice(0, 10000)}`;
    const request = {
      model: provider.model,
      messages: [
        { role: 'system' as const, content: localText(language, 'Return strict JSON only. No markdown. No prose.', '只返回严格 JSON。不要 Markdown，不要说明文字。') },
        { role: 'user' as const, content: prompt },
      ],
      temperature: 0.1,
      max_tokens: AI_JUDGE_MAX_TOKENS,
      response_format: { type: 'json_object' as const },
      timeout_ms: 60000,
      max_retries: 1,
    };
    const response = await client.chat(request);
    const firstText = choiceText(response);
    let parsed = parseJudgeJson(firstText, language);
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
      parsed = parseJudgeJson(choiceText(retryResponse), language);
    }
    if (!parsed) {
      throw new AIProviderUploadJudgementError(
        'AI provider returned non-JSON or unparsable upload judgement; task paused instead of heuristic fallback.',
        provider,
        undefined,
        { first_response: responseSummary(response), retry_response: retryResponse ? responseSummary(retryResponse) : null }
      );
    }
    return downgradeUnsupportedUploadVerdict(endpointPath, attempts, { ...parsed, source: 'ai_provider', provider_id: provider.id, model: provider.model }, language);
  } catch (error) {
    if (error instanceof AIProviderUploadJudgementError) throw error;
    throw new AIProviderUploadJudgementError('AI provider upload judgement failed; task paused instead of heuristic fallback.', provider, error);
  }
}
