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

function heuristicJudge(endpointPath: string, attempts: UploadAttemptEvidence[]): UploadJudgeResult {
  const dangerous = attempts.filter(attempt =>
    attempt.accepted &&
    (
      /svg|html|javascript|xml/i.test(attempt.content_type) ||
      /\.svg|\.html|\.php|\.jsp|\.aspx|\.phtml/i.test(attempt.filename) ||
      /image\/svg\+xml|text\/html|application\/x-php/i.test(attempt.fetched_content_type || '') ||
      /<script|onload=|<svg|<html|<\?php/i.test(attempt.fetched_body_preview || attempt.response_body_preview || '')
    )
  );

  if (dangerous.length > 0) {
    const attempt = dangerous[0];
    return {
      verdict: 'vulnerable',
      confidence: attempt.location ? 0.88 : 0.76,
      severity: /php|jsp|aspx|phtml/i.test(attempt.filename) ? 'high' : 'medium',
      title: `文件上传点 ${endpointPath} 接受危险文件或危险内容`,
      reason: `异常文件 ${attempt.filename} 被服务端接受${attempt.location ? '，并返回/可访问上传位置' : ''}。`,
      evidence: dangerous.map(item => `${item.label}: ${item.filename} status=${item.status ?? 'n/a'} location=${item.location || 'n/a'} fetched_content_type=${item.fetched_content_type || 'n/a'}`),
    };
  }

  const anyAccepted = attempts.some(attempt => attempt.label !== 'normal' && attempt.accepted);
  if (anyAccepted) {
    return {
      verdict: 'inconclusive',
      confidence: 0.55,
      severity: 'low',
      title: `文件上传点 ${endpointPath} 接受部分异常文件`,
      reason: '异常文件被接受，但当前证据不足以确认文件是否可访问或是否具备可利用影响。',
      evidence: attempts.filter(item => item.label !== 'normal' && item.accepted).map(item => `${item.label}: ${item.filename} status=${item.status ?? 'n/a'}`),
    };
  }

  return {
    verdict: 'not_vulnerable',
    confidence: 0.7,
    severity: 'low',
    title: `文件上传点 ${endpointPath} 未发现明显文件上传漏洞`,
    reason: '当前 payload 均未被接受，或未形成可访问的危险文件证据。',
    evidence: attempts.map(item => `${item.label}: ${item.filename} accepted=${item.accepted} status=${item.status ?? 'n/a'} error=${item.error || ''}`),
  };
}

function parseJudgeJson(text: string): UploadJudgeResult | null {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;
  return {
    verdict: normalizeJudgeVerdict(parsed),
    confidence: normalizeJudgeConfidence(parsed.confidence),
    severity: normalizeJudgeSeverity(parsed.severity),
    title: String(parsed.title || parsed.summary || 'AI upload judgement'),
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

export async function judgeUploadAttempts(db: DbProvider, endpointPath: string, attempts: UploadAttemptEvidence[]): Promise<UploadJudgeResult> {
  const fallback: UploadJudgeResult = { ...heuristicJudge(endpointPath, attempts), source: 'heuristic_fallback' };
  const provider = await getDefaultProvider(db).catch(() => null);
  if (!provider) return fallback;

  try {
    const client = new AIClient(provider);
    const prompt = `You are judging a web security file upload test before writing a finding. Compare the normal upload and mutated upload evidence. Return one compact JSON object only with this schema: {"verdict":"vulnerable|not_vulnerable|inconclusive","confidence":0.0,"severity":"critical|high|medium|low","title":"...","reason":"max 500 chars","evidence":["max 4 short evidence strings"]}. Do not mark a vulnerability unless the upload was accepted and there is exploitable impact evidence.\n\nEndpoint: ${endpointPath}\n\nAttempts:\n${attempts.map(attempt => `---\nlabel=${attempt.label}\nfilename=${attempt.filename}\ncontent_type=${attempt.content_type}\naccepted=${attempt.accepted}\nstatus=${attempt.status}\nheaders=${headersToText(attempt.response_headers)}\nresponse=${attempt.response_body_preview || ''}\nlocation=${attempt.location || ''}\nfetch_status=${attempt.fetch_status || ''}\nfetched_content_type=${attempt.fetched_content_type || ''}\nfetched_body=${attempt.fetched_body_preview || ''}\nerror=${attempt.error || ''}`).join('\n').slice(0, 10000)}`;
    const request = {
      model: provider.model,
      messages: [
        { role: 'system' as const, content: 'Return strict JSON only. No markdown. No prose.' },
        { role: 'user' as const, content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 1600,
      response_format: { type: 'json_object' as const },
      timeout_ms: 60000,
      max_retries: 1,
    };
    const response = await client.chat(request);
    const firstText = choiceText(response);
    let parsed = parseJudgeJson(firstText);
    let retryResponse: any | null = null;
    if (!parsed) {
      retryResponse = await client.chat({
        ...request,
        messages: [
          { role: 'system', content: 'Return exactly one valid JSON object. No markdown. No prose.' },
          {
            role: 'user',
            content: `${prompt}\n\nThe previous provider response was not valid parseable JSON. Re-judge from the evidence above and return only the required compact JSON object. Previous response excerpt:\n${firstText.slice(0, 4000)}`,
          },
        ],
        max_tokens: 1200,
        max_retries: 0,
      });
      parsed = parseJudgeJson(choiceText(retryResponse));
    }
    if (!parsed) {
      throw new AIProviderUploadJudgementError(
        'AI provider returned non-JSON or unparsable upload judgement; task paused instead of heuristic fallback.',
        provider,
        undefined,
        { first_response: responseSummary(response), retry_response: retryResponse ? responseSummary(retryResponse) : null }
      );
    }
    return { ...parsed, source: 'ai_provider', provider_id: provider.id, model: provider.model };
  } catch (error) {
    if (error instanceof AIProviderUploadJudgementError) throw error;
    throw new AIProviderUploadJudgementError('AI provider upload judgement failed; task paused instead of heuristic fallback.', provider, error);
  }
}
