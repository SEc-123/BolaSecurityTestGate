import type { DbProvider } from '../../types/index.js';
import { dbGet } from '../../db/sql-helpers.js';
import { AIClient } from '../ai/ai-client.js';
import type { AIProvider } from '../ai/types.js';

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
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      verdict: ['vulnerable', 'not_vulnerable', 'inconclusive'].includes(parsed.verdict) ? parsed.verdict : 'inconclusive',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      severity: ['critical', 'high', 'medium', 'low'].includes(parsed.severity) ? parsed.severity : 'medium',
      title: String(parsed.title || 'AI upload judgement'),
      reason: String(parsed.reason || ''),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
    };
  } catch {
    return null;
  }
}

export async function judgeUploadAttempts(db: DbProvider, endpointPath: string, attempts: UploadAttemptEvidence[]): Promise<UploadJudgeResult> {
  const fallback = heuristicJudge(endpointPath, attempts);
  const provider = await getDefaultProvider(db).catch(() => null);
  if (!provider) return fallback;

  try {
    const client = new AIClient(provider);
    const prompt = `You are judging a web security file upload test before writing a finding. Compare the normal upload and mutated upload evidence. Return strict JSON only with keys verdict, confidence, severity, title, reason, evidence. Verdict must be vulnerable, not_vulnerable, or inconclusive.\n\nEndpoint: ${endpointPath}\n\nAttempts:\n${attempts.map(attempt => `---\nlabel=${attempt.label}\nfilename=${attempt.filename}\ncontent_type=${attempt.content_type}\naccepted=${attempt.accepted}\nstatus=${attempt.status}\nheaders=${headersToText(attempt.response_headers)}\nresponse=${attempt.response_body_preview || ''}\nlocation=${attempt.location || ''}\nfetch_status=${attempt.fetch_status || ''}\nfetched_content_type=${attempt.fetched_content_type || ''}\nfetched_body=${attempt.fetched_body_preview || ''}\nerror=${attempt.error || ''}`).join('\n')}`;
    const response = await client.chat({
      model: provider.model,
      messages: [
        { role: 'system', content: 'Return strict JSON only. Do not add prose.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 1000,
    });
    const content = response.choices?.[0]?.message?.content || '';
    const parsed = parseJudgeJson(content);
    return parsed || fallback;
  } catch {
    return fallback;
  }
}
