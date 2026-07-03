export type OutputLanguage = 'en' | 'zh';

export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = 'en';

export function normalizeOutputLanguage(value: unknown, fallback: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE): OutputLanguage {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized.startsWith('zh_') || normalized.startsWith('zh-')) return 'zh';
  if (normalized === 'en' || normalized === 'en-us' || normalized.startsWith('en_') || normalized.startsWith('en-')) return 'en';
  return fallback;
}

export function outputLanguageName(language: OutputLanguage): string {
  return language === 'zh' ? 'Simplified Chinese (zh-CN)' : 'English (en-US)';
}

export function outputLanguageInstruction(language: OutputLanguage): string {
  return [
    `Output language: ${outputLanguageName(language)}.`,
    'All user-visible natural-language values, explanations, titles, summaries, report headings, report body text, remediation text, and generated files must use this language consistently.',
    'Keep machine-readable JSON keys, enum values, IDs, URLs, HTTP methods, headers, request/response bodies, code snippets, payloads, tokens, account names, and raw evidence exactly as provided.',
    'Before finalizing, check that every user-facing sentence follows the requested output language.',
  ].join('\n');
}

export function requestLanguage(input: {
  body?: Record<string, any> | null;
  query?: Record<string, any> | null;
  headers?: Record<string, any> | null;
}): OutputLanguage {
  const headerValue = input.headers?.['x-bstg-language'] || input.headers?.['X-BSTG-Language'] || input.headers?.['accept-language'];
  return normalizeOutputLanguage(
    input.body?.language || input.body?.locale || input.query?.language || input.query?.lang || headerValue,
  );
}

export function localText(language: OutputLanguage, en: string, zh: string): string {
  return language === 'zh' ? zh : en;
}
