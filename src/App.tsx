import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  FileSpreadsheet,
  ScanLine,
} from 'lucide-react';
import { Layout } from './components/Layout';
import { Findings } from './pages/Findings';
import AIReports from './pages/AIReports';
import { AIScans } from './pages/AIScans';

type PageId = 'assessment' | 'findings' | 'reports';

const PAGE_PATHS: Record<PageId, string> = {
  assessment: '/',
  findings: '/findings',
  reports: '/reports',
};

const PATH_PAGES: Record<string, PageId> = Object.entries(PAGE_PATHS).reduce((acc, [page, path]) => {
  acc[path] = page as PageId;
  return acc;
}, {} as Record<string, PageId>);

function pageFromPath(pathname: string): PageId {
  return PATH_PAGES[pathname.replace(/\/+$/, '') || '/'] || 'assessment';
}

function App() {
  const [currentPage, setCurrentPage] = useState<PageId>(() => pageFromPath(window.location.pathname));

  const navigateToPage = (page: PageId) => {
    setCurrentPage(page);
    const path = PAGE_PATHS[page] || '/';
    if (window.location.pathname !== path || window.location.search) {
      window.history.pushState({}, '', path);
    }
  };

  useEffect(() => {
    const handlePopState = () => setCurrentPage(pageFromPath(window.location.pathname));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navItems = [
    {
      id: 'assessment',
      label: '业务测试',
      description: '功能测试与风险验证',
      icon: <ScanLine size={18} />,
      onClick: () => navigateToPage('assessment'),
    },
    {
      id: 'findings',
      label: '发现问题',
      description: '已验证风险与证据',
      icon: <AlertTriangle size={18} />,
      onClick: () => navigateToPage('findings'),
    },
    {
      id: 'reports',
      label: '测试报告',
      description: '交付报告',
      icon: <FileSpreadsheet size={18} />,
      onClick: () => navigateToPage('reports'),
    },
  ];

  const renderPage = () => {
    switch (currentPage) {
      case 'findings':
        return <Findings />;
      case 'reports':
        return <AIReports />;
      case 'assessment':
      default:
        return <AIScans />;
    }
  };

  return (
    <Layout navItems={navItems} currentPage={currentPage}>
      {renderPage()}
    </Layout>
  );
}

export default App;
