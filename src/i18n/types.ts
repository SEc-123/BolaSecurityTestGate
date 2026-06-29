export type Language = 'en' | 'zh';

export const SUPPORTED_LANGUAGES: readonly Language[] = ['en', 'zh'];

export function isSupportedLanguage(value: string | null | undefined): value is Language {
  return value === 'en' || value === 'zh';
}
