export type Language = 'en' | 'zh';

export const SUPPORTED_LANGUAGES: readonly Language[] = ['en', 'zh'];
export const I18N_STORAGE_KEY = 'bstg.language';

export const LOCALE_BY_LANGUAGE: Record<Language, string> = {
  en: 'en-US',
  zh: 'zh-CN',
};

export const OUTPUT_LANGUAGE_LABEL: Record<Language, string> = {
  en: 'English',
  zh: 'Simplified Chinese',
};

export function isSupportedLanguage(value: string | null | undefined): value is Language {
  return value === 'en' || value === 'zh';
}

export function normalizeLanguage(value: string | null | undefined, fallback: Language = 'en'): Language {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized.startsWith('zh_')) return 'zh';
  if (normalized === 'en' || normalized === 'en-us' || normalized.startsWith('en_')) return 'en';
  return fallback;
}
