export type NormalizedJudgeVerdict = 'vulnerable' | 'not_vulnerable' | 'inconclusive';
export type NormalizedJudgeSeverity = 'critical' | 'high' | 'medium' | 'low';

export function extractJsonObject(text: string): any | null {
  const source = String(text || '');
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = source.slice(start, index + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
          start = -1;
        }
      }
    }
  }

  return null;
}

export function normalizeJudgeVerdict(parsed: any): NormalizedJudgeVerdict {
  const rawValue = parsed?.verdict ?? parsed?.result ?? parsed?.status ?? parsed?.decision ?? parsed?.finding;
  const value = String(rawValue ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

  if (typeof parsed?.is_vulnerability === 'boolean') return parsed.is_vulnerability ? 'vulnerable' : 'not_vulnerable';
  if (typeof parsed?.vulnerable === 'boolean') return parsed.vulnerable ? 'vulnerable' : 'not_vulnerable';
  if (typeof parsed?.vulnerability === 'boolean') return parsed.vulnerability ? 'vulnerable' : 'not_vulnerable';

  if ([
    'vulnerable',
    'vulnerability',
    'vulnerability_found',
    'vuln',
    'vuln_found',
    'confirmed',
    'positive',
    'true',
    'yes',
    'exploitable',
    'affected',
  ].includes(value)) {
    return 'vulnerable';
  }

  if ([
    'not_vulnerable',
    'not_vulnerability',
    'no_vulnerability',
    'no_vuln',
    'not_found',
    'negative',
    'safe',
    'false',
    'no',
    'unaffected',
  ].includes(value)) {
    return 'not_vulnerable';
  }

  return 'inconclusive';
}

export function normalizeJudgeConfidence(value: any): number {
  if (typeof value === 'number' && Number.isFinite(value)) return clampConfidence(value);
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return 0.5;

  const percent = text.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (percent) return clampConfidence(Number(percent[1]) / 100);

  const numeric = Number(text);
  if (Number.isFinite(numeric)) return clampConfidence(numeric > 1 ? numeric / 100 : numeric);

  if (/(very\s*)?high|strong/.test(text)) return 0.88;
  if (/medium|moderate/.test(text)) return 0.65;
  if (/low|weak/.test(text)) return 0.42;
  return 0.5;
}

export function normalizeJudgeSeverity(value: any): NormalizedJudgeSeverity {
  const text = String(value ?? '').trim().toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(text)) return text as NormalizedJudgeSeverity;
  if (['info', 'informational', 'none'].includes(text)) return 'low';
  return 'medium';
}

export function normalizeJudgeEvidence(value: any): string[] {
  if (Array.isArray(value)) return value.map(item => stringifyEvidence(item)).filter(Boolean);
  const item = stringifyEvidence(value);
  return item ? [item] : [];
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function stringifyEvidence(value: any): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
