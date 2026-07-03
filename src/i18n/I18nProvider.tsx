import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { translateMessage } from './catalog';
import { I18N_STORAGE_KEY, LOCALE_BY_LANGUAGE, isSupportedLanguage, type Language } from './types';

type TranslateParams = Record<string, string | number | boolean | null | undefined>;
type FeedbackItem = {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
};

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  toggleLanguage: () => void;
  t: (value: string | undefined, params?: TranslateParams) => string;
  formatDateTime: (value: string | number | Date | null | undefined) => string;
  formatNumber: (value: number | null | undefined, options?: Intl.NumberFormatOptions) => string;
  formatPercent: (value: number | null | undefined) => string;
  formatBytes: (value: number | null | undefined) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function languageFromUrl(): Language | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('lang') || params.get('locale');
  return isSupportedLanguage(value) ? value : null;
}

function languageFromStorage(): Language | null {
  const value = window.localStorage.getItem(I18N_STORAGE_KEY);
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

function interpolate(value: string, params?: TranslateParams): string {
  if (!params) return value;
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    const param = params[key];
    return param === null || param === undefined ? match : String(param);
  });
}

function FeedbackViewport({ items, onDismiss }: { items: FeedbackItem[]; onDismiss: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="fixed right-4 top-4 z-[100] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2" data-testid="i18n-feedback-viewport">
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          onClick={() => onDismiss(item.id)}
          className="rounded border border-slate-200 bg-white px-4 py-3 text-left text-sm text-slate-800 shadow-lg transition hover:border-slate-300"
        >
          {item.message}
        </button>
      ))}
    </div>
  );
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  const [feedbackItems, setFeedbackItems] = useState<FeedbackItem[]>([]);

  const setLanguage = useCallback((nextLanguage: Language) => {
    setLanguageState(nextLanguage);
    window.localStorage.setItem(I18N_STORAGE_KEY, nextLanguage);
    syncUrlLanguage(nextLanguage);
    emitLanguageChange(nextLanguage);
  }, []);

  const toggleLanguage = useCallback(() => {
    setLanguage(language === 'en' ? 'zh' : 'en');
  }, [language, setLanguage]);

  const t = useCallback((value: string | undefined, params?: TranslateParams) => {
    return interpolate(translateMessage(value, language), params);
  }, [language]);

  const formatDateTime = useCallback((value: string | number | Date | null | undefined) => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(LOCALE_BY_LANGUAGE[language], {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }, [language]);

  const formatNumber = useCallback((value: number | null | undefined, options?: Intl.NumberFormatOptions) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    return new Intl.NumberFormat(LOCALE_BY_LANGUAGE[language], options).format(value);
  }, [language]);

  const formatPercent = useCallback((value: number | null | undefined) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    return new Intl.NumberFormat(LOCALE_BY_LANGUAGE[language], {
      style: 'percent',
      maximumFractionDigits: 1,
    }).format(value);
  }, [language]);

  const formatBytes = useCallback((value: number | null | undefined) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(Math.abs(value)) / Math.log(1024)), units.length - 1);
    const amount = value / Math.pow(1024, index);
    return `${new Intl.NumberFormat(LOCALE_BY_LANGUAGE[language], {
      maximumFractionDigits: amount >= 10 ? 0 : 1,
    }).format(amount)} ${units[index]}`;
  }, [language]);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.documentElement.dataset.language = language;
    window.localStorage.setItem(I18N_STORAGE_KEY, language);
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

  useEffect(() => {
    const handleFeedback = (event: Event) => {
      const detail = (event as CustomEvent<Partial<FeedbackItem>>).detail || {};
      const message = typeof detail.message === 'string' ? detail.message.trim() : '';
      if (!message) return;
      const id = Date.now() + Math.floor(Math.random() * 1000);
      const kind = detail.kind || 'info';
      setFeedbackItems(items => [...items.slice(-3), { id, kind, message }]);
      window.setTimeout(() => {
        setFeedbackItems(items => items.filter(item => item.id !== id));
      }, 7000);
    };
    window.addEventListener('bstg:feedback', handleFeedback);
    return () => window.removeEventListener('bstg:feedback', handleFeedback);
  }, []);

  const dismissFeedback = useCallback((id: number) => {
    setFeedbackItems(items => items.filter(item => item.id !== id));
  }, []);

  const value = useMemo<I18nContextValue>(() => ({
    language,
    setLanguage,
    toggleLanguage,
    t,
    formatDateTime,
    formatNumber,
    formatPercent,
    formatBytes,
  }), [language, setLanguage, toggleLanguage, t, formatDateTime, formatNumber, formatPercent, formatBytes]);

  return (
    <I18nContext.Provider value={value}>
      {children}
      <FeedbackViewport items={feedbackItems} onDismiss={dismissFeedback} />
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
