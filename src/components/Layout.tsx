import { useEffect, useState } from 'react';
import {
  Languages,
  Menu,
  PanelLeftClose,
  Shield,
  ShieldCheck,
} from 'lucide-react';
import { useI18n, type Language } from '../i18n';

interface NavItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  onClick: () => void;
}

interface LayoutProps {
  navItems: NavItem[];
  currentPage: string;
  children: React.ReactNode;
}

export function Layout({ navItems, currentPage, children }: LayoutProps) {
  const { language, setLanguage, t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const currentItem = navItems.find((item) => item.id === currentPage);

  const renderNavItem = (item: NavItem) => {
    const active = currentPage === item.id;

    return (
      <button
        key={item.id}
        onClick={() => {
          item.onClick();
          if (window.innerWidth < 768) setSidebarOpen(false);
        }}
        className={`group flex w-full items-center gap-3 rounded px-3 py-2 text-left transition-colors ${
          active ? 'bg-[#1268d6] text-white' : 'text-slate-300 hover:bg-white/8 hover:text-white'
        }`}
        title={!sidebarOpen ? t(item.label) : undefined}
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded ${active ? 'bg-white/12' : 'text-slate-400 group-hover:text-white'}`}>
          {item.icon}
        </span>
        {sidebarOpen && (
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{t(item.label)}</span>
            {item.description && (
              <span className={`block truncate text-xs ${active ? 'text-blue-100' : 'text-slate-500 group-hover:text-slate-300'}`}>
                {t(item.description)}
              </span>
            )}
          </span>
        )}
      </button>
    );
  };

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768) setSidebarOpen(false);
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const renderLanguageButton = (targetLanguage: Language, label: string) => {
    const active = language === targetLanguage;
    return (
      <button
        type="button"
        onClick={() => setLanguage(targetLanguage)}
        className={`h-8 rounded px-2.5 text-xs font-semibold transition-colors ${
          active ? 'bg-slate-950 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-950'
        }`}
        aria-pressed={active}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="bstg-app flex h-screen bg-[#eef2f5] text-slate-950">
      <div className={`${sidebarOpen ? 'w-[264px]' : 'w-16'} flex shrink-0 flex-col border-r border-[#172234] bg-[#07111f] transition-all duration-300`}>
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          {sidebarOpen && (
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[#1268d6] text-white">
                <Shield size={18} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-lg font-semibold tracking-tight text-white">BSTG</div>
                <div className="truncate text-xs text-slate-400">{t('业务安全测试')}</div>
              </div>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded p-2 text-slate-400 hover:bg-white/10 hover:text-white"
            aria-label={sidebarOpen ? t('Collapse navigation') : t('Expand navigation')}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <Menu size={18} />}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {sidebarOpen && (
            <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              {t('测试中心')}
            </div>
          )}
          <div className="space-y-1">{navItems.map(renderNavItem)}</div>
        </nav>

        <div className="border-t border-white/10 p-4 text-xs leading-5 text-slate-400">
          {sidebarOpen ? '运行状态以当前测试实际回报为准。' : <ShieldCheck size={16}/>}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="bstg-topbar flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              <ShieldCheck size={14} />
              {t('业务安全测试')}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <h2 className="truncate text-base font-semibold text-slate-950">{t(currentItem?.label || 'Assessment')}</h2>
              {currentItem?.description && <span className="hidden truncate text-sm text-slate-500 md:inline">{t(currentItem.description)}</span>}
            </div>
          </div>
          <div
            className="flex shrink-0 items-center gap-2 rounded border border-slate-200 bg-white p-1"
            data-i18n-ignore
            data-testid="language-switch"
            title={t('Switch language')}
            aria-label={t('Language')}
          >
            <Languages size={15} className="ml-1 text-slate-500" aria-hidden="true" />
            {renderLanguageButton('en', 'EN')}
            {renderLanguageButton('zh', '中文')}
          </div>
        </header>
        <main className="bstg-main flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
