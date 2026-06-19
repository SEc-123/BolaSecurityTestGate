import { useState } from 'react';
import { ChevronDown, Menu, PanelLeftClose, PanelLeftOpen, Shield } from 'lucide-react';

interface NavItem {
  id: string;
  label: string;
  description?: string;
  section?: 'primary' | 'secondary';
  icon: React.ReactNode;
  onClick: () => void;
}

interface LayoutProps {
  navItems: NavItem[];
  currentPage: string;
  children: React.ReactNode;
}

export function Layout({ navItems, currentPage, children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const primaryItems = navItems.filter((item) => item.section !== 'secondary');
  const secondaryItems = navItems.filter((item) => item.section === 'secondary');
  const secondaryActive = secondaryItems.some((item) => item.id === currentPage);
  const showSecondaryItems = !sidebarOpen || skillsOpen || secondaryActive;

  const renderNavItem = (item: NavItem) => {
    const active = currentPage === item.id;

    return (
      <button
        key={item.id}
        onClick={item.onClick}
        className={`group flex w-full items-center gap-3 rounded px-3 py-2 text-left transition-colors ${
          active
            ? 'bg-[#111827] text-white'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
        }`}
        title={!sidebarOpen ? item.label : undefined}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center">{item.icon}</span>
        {sidebarOpen && (
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{item.label}</span>
            {item.description && (
              <span className={`block truncate text-xs ${active ? 'text-slate-300' : 'text-slate-400'}`}>
                {item.description}
              </span>
            )}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-screen bg-[#f4f5f4] text-slate-950">
      <div
        className={`${
          sidebarOpen ? 'w-[264px]' : 'w-16'
        } flex shrink-0 flex-col border-r border-slate-200 bg-white transition-all duration-300`}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          {sidebarOpen && (
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[#111827] text-white">
                <Shield size={16} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold tracking-tight">Bola Security</div>
                <div className="truncate text-xs text-slate-500">Assessment operations</div>
              </div>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-950"
            aria-label={sidebarOpen ? 'Collapse navigation' : 'Expand navigation'}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <Menu size={18} />}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="space-y-1">{primaryItems.map(renderNavItem)}</div>

          {secondaryItems.length > 0 && (
            <div className="mt-6 border-t border-slate-200 pt-4">
              {sidebarOpen ? (
                <button
                  onClick={() => setSkillsOpen((open) => !open)}
                  className={`mb-2 flex w-full items-center justify-between rounded px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.14em] ${
                    secondaryActive ? 'bg-slate-100 text-slate-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
                  }`}
                >
                  <span>System tools</span>
                  <ChevronDown
                    size={14}
                    className={`transition-transform ${showSecondaryItems ? 'rotate-180' : ''}`}
                  />
                </button>
              ) : (
                <div className="mb-2 flex justify-center text-slate-400">
                  <ChevronDown size={16} />
                </div>
              )}
              {showSecondaryItems && <div className="space-y-1">{secondaryItems.map(renderNavItem)}</div>}
            </div>
          )}
        </nav>

        <div className="border-t border-slate-200 p-4 text-xs text-slate-500">
          {sidebarOpen ? (
            <div className="flex items-center justify-between gap-3">
              <span>Runtime</span>
              <span className="rounded bg-emerald-50 px-2 py-1 font-medium text-emerald-700">Ready</span>
            </div>
          ) : (
            <PanelLeftOpen size={18} />
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-auto">
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}
