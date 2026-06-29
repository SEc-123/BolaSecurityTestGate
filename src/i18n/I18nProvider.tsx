import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { translateMessage } from './catalog';
import { isSupportedLanguage, type Language } from './types';

const STORAGE_KEY = 'bstg.language';

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  toggleLanguage: () => void;
  t: (value: string | undefined) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function languageFromUrl(): Language | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('lang') || params.get('locale');
  return isSupportedLanguage(value) ? value : null;
}

function languageFromStorage(): Language | null {
  const value = window.localStorage.getItem(STORAGE_KEY);
  return isSupportedLanguage(value) ? value : null;
}

function languageFromBrowser(): Language {
  return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function initialLanguage(): Language {
  return languageFromUrl() || languageFromStorage() || languageFromBrowser();
}

function syncUrlLanguage(language: Language) {
  const url = new URL(window.location.href);
  if (url.searchParams.get('lang') === language) return;
  url.searchParams.set('lang', language);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function emitLanguageChange(language: Language) {
  window.dispatchEvent(new CustomEvent('bstg:i18n-change', { detail: { language } }));
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  const setLanguage = useCallback((nextLanguage: Language) => {
    setLanguageState(nextLanguage);
    window.localStorage.setItem(STORAGE_KEY, nextLanguage);
    syncUrlLanguage(nextLanguage);
    emitLanguageChange(nextLanguage);
  }, []);

  const toggleLanguage = useCallback(() => {
    setLanguage(language === 'en' ? 'zh' : 'en');
  }, [language, setLanguage]);

  const t = useCallback((value: string | undefined) => translateMessage(value, language), [language]);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.documentElement.dataset.language = language;
    window.localStorage.setItem(STORAGE_KEY, language);
    syncUrlLanguage(language);
    emitLanguageChange(language);
  }, [language]);

  useEffect(() => {
    const handlePopState = () => {
      const nextLanguage = languageFromUrl();
      if (nextLanguage) {
        setLanguageState(nextLanguage);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const commandModifier = event.metaKey || event.ctrlKey;
      if (!commandModifier || !event.shiftKey || event.key.toLowerCase() !== 'l') return;
      event.preventDefault();
      toggleLanguage();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleLanguage]);

  const value = useMemo<I18nContextValue>(() => ({
    language,
    setLanguage,
    toggleLanguage,
    t,
  }), [language, setLanguage, toggleLanguage, t]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n must be used inside I18nProvider');
  }
  return value;
}
