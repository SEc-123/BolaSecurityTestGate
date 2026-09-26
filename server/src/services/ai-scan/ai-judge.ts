import { assertScanActive } from './run-control.js';
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
  request_artifact_id?: string;
  response_body_sha256?: string;
  fetched_body_sha256?: string;
  uploaded_bytes_verified?: boolean;
  impact_verified?: boolean;
  impact_proof?: Record<string,any>;
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

/** A filename, accepted status or source-code reflection cannot prove execution. */
function heuristicJudge(endpointPath:string,attempts:UploadAttemptEvidence[],language:OutputLanguage):UploadJudgeResult{
  const baseline=attempts.find(a=>a.label==='normal'),mutations=attempts.filter(a=>!['normal','normal_control'].includes(a.label));
  const ready=baseline?.accepted&&baseline.uploaded_bytes_verified&&!baseline.error;
  const impact=mutations.find(a=>a.accepted&&a.impact_verified&&!a.error);
  const control=attempts.find(a=>a.label==='normal_control');
  const allRejected=control?.accepted&&control.uploaded_bytes_verified&&!control.error&&mutations.length>0&&mutations.every(a=>!a.error&&!a.accepted&&[400,413,415,422].includes(a.status||0));
  const verdict=ready&&impact?'vulnerable':ready&&allRejected?'not_vulnerable':'inconclusive';
  return {verdict,confidence:verdict==='vulnerable'?0.98:verdict==='not_vulnerable'?0.75:0.4,severity:impact?.impact_proof?.kind==='server_side_marker_execution'?'high':impact?'medium':'low',
    title:localText(language,`Upload assessment: ${endpointPath}`,`文件上传检查：${endpointPath}`),
    reason:verdict==='vulnerable'?localText(language,'Normal upload and readback succeeded; the mutated upload produced a unique execution marker.','正常文件上传及回访成功，变体文件产生了唯一的实际执行标记。'):
      verdict==='not_vulnerable'?localText(language,'The normal upload succeeded; this payload set was explicitly rejected.','正常文件上传成功，本组变体请求被明确拒绝。'):
      localText(language,'Normal upload, complete mutation execution or exploitable impact evidence is missing. Accepted files alone do not prove a vulnerability.','正常上传、完整变体执行或可利用影响证据不足。仅接受文件不能证明漏洞。'),
    evidence:attempts.map(a=>`${a.label}: status=${a.status||'n/a'} readback=${a.uploaded_bytes_verified===true} impact=${a.impact_verified===true} request=${a.request_artifact_id||'n/a'}`)};
}
function downgradeUnsupportedUploadVerdict(endpointPath:string,attempts:UploadAttemptEvidence[],judge:UploadJudgeResult,language:OutputLanguage):UploadJudgeResult{
  const local=heuristicJudge(endpointPath,attempts,language);
  if(judge.verdict===local.verdict)return {...judge,severity:local.verdict==='vulnerable'?local.severity:judge.severity};
  // Deterministic proof controls the conclusion; provider prose cannot promote acceptance or errors.
  return {...judge,...local,source:judge.source,provider_id:judge.provider_id,model:judge.model};
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
  assertScanActive();
  const fallback: UploadJudgeResult = { ...heuristicJudge(endpointPath, attempts, language), source: 'heuristic_fallback' };
  const provider = await getDefaultProvider(db).catch(() => null);
  assertScanActive();
  if (!provider) return fallback;

  try {
    const client = new AIClient(provider);
    const safeAttempts = sanitizeForAIModel(attempts);
    const prompt = `You are judging a web security file upload test before writing a finding. Compare the normal upload and mutated upload evidence. Return one compact JSON object only with this schema: {"verdict":"vulnerable|not_vulnerable|inconclusive","confidence":0.0,"severity":"critical|high|medium|low","title":"...","reason":"max 500 chars","evidence":["max 4 short evidence strings"]}. Keep JSON keys and enum values stable; write title, reason, and evidence strings in the requested output language. Do not mark a vulnerability unless the upload was accepted and there is exploitable impact evidence.\n\n${outputLanguageInstruction(language)}\n\nEndpoint: ${endpointPath}\n\nAttempts:\n${safeAttempts.map(attempt => `---\nlabel=${attempt.label}\nfilename=${attempt.filename}\ncontent_type=${attempt.content_type}\naccepted=${attempt.accepted}\nstatus=${attempt.status}\nheaders=${headersToText(attempt.response_headers)}\nresponse=${attempt.response_body_preview || ''}\nlocation=${attempt.location || ''}\nfetch_status=${attempt.fetch_status || ''}\nfetched_content_type=${attempt.fetched_content_type || ''}\nfetched_body=${attempt.fetched_body_preview || ''}\nreadback_verified=${attempt.uploaded_bytes_verified===true}\nimpact_verified=${attempt.impact_verified===true}\nimpact_proof=${JSON.stringify(attempt.impact_proof||{})}\nerror=${attempt.error || ''}`).join('\n').slice(0, 10000)}`;
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
    assertScanActive();
    if (error instanceof AIProviderUploadJudgementError) throw error;
    throw new AIProviderUploadJudgementError('AI provider upload judgement failed; task paused instead of heuristic fallback.', provider, error);
  }
}
