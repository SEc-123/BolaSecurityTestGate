import { useEffect, useState } from 'react';
import {
  Activity,
  Globe,
  Users,
  FileText,
  List,
  ShieldAlert,
  Play,
  AlertTriangle,
  GitBranch,
  Shield,
  Settings2,
  BookOpen,
  Bug,
  Brain,
  FileSpreadsheet,
  Package,
  KeyRound,
  Crosshair,
  ClipboardCheck,
  ScanLine,
} from 'lucide-react';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Environments } from './pages/Environments';
import { Accounts } from './pages/Accounts';
import { ApiTemplates } from './pages/ApiTemplates';
import { Checklists } from './pages/Checklists';
import { SecurityRules } from './pages/SecurityRules';
import { Workflows } from './pages/Workflows';
import { TestRuns } from './pages/TestRuns';
import { PreconfiguredRuns } from './pages/PreconfiguredRuns';
import { Findings } from './pages/Findings';
import { TemplateVariableManager } from './pages/TemplateVariableManager';
import { CIGatePolicies } from './pages/CIGatePolicies';
import { SecuritySuites } from './pages/SecuritySuites';
import { Recordings } from './pages/Recordings';
import { RecordingDetail } from './pages/RecordingDetail';
import { FindingsGovernance } from './pages/FindingsGovernance';
import DictionaryManager from './pages/DictionaryManager';
import { DebugPanel } from './pages/DebugPanel';
import AIProviders from './pages/AIProviders';
import AIAnalysis from './pages/AIAnalysis';
import AIReports from './pages/AIReports';
import { AIScans } from './pages/AIScans';
import { recordingsService } from './lib/api-service';
import type { RecordingRolloutConfig } from './lib/api-client';

type PageId =
  | 'dashboard'
  | 'environments'
  | 'accounts'
  | 'templates'
  | 'template-variables'
  | 'checklists'
  | 'rules'
  | 'workflows'
  | 'recordings'
  | 'recording-detail'
  | 'preconfigured-runs'
  | 'dictionary'
  | 'runs'
  | 'findings'
  | 'governance'
  | 'cigate'
  | 'security-suites'
  | 'debug'
  | 'ai-providers'
  | 'ai-scans'
  | 'ai-analysis'
  | 'ai-reports';

const PAGE_PATHS: Record<PageId, string> = {
  dashboard: '/dashboard',
  environments: '/environments',
  accounts: '/accounts',
  templates: '/templates',
  'template-variables': '/template-variables',
  checklists: '/checklists',
  rules: '/rules',
  workflows: '/workflows',
  recordings: '/recordings',
  'recording-detail': '/recordings/detail',
  'preconfigured-runs': '/preconfigured-runs',
  dictionary: '/dictionary',
  runs: '/runs',
  findings: '/findings',
  governance: '/governance',
  cigate: '/cigate',
  'security-suites': '/security-suites',
  debug: '/debug',
  'ai-providers': '/ai-providers',
  'ai-scans': '/',
  'ai-analysis': '/review',
  'ai-reports': '/reports',
};

const PATH_PAGES: Record<string, PageId> = Object.entries(PAGE_PATHS).reduce((acc, [page, path]) => {
  acc[path] = page as PageId;
  return acc;
}, {} as Record<string, PageId>);

function pageFromPath(pathname: string): PageId {
  return PATH_PAGES[pathname.replace(/\/+$/, '') || '/'] || 'ai-scans';
}

function App() {
  const [currentPage, setCurrentPage] = useState<PageId>(() => pageFromPath(window.location.pathname));
  const [recordingDetailSessionId, setRecordingDetailSessionId] = useState('');
  const [focusedWorkflowId, setFocusedWorkflowId] = useState<string | undefined>(undefined);
  const [focusedDraftId, setFocusedDraftId] = useState<string | undefined>(undefined);
  const [focusedPresetId, setFocusedPresetId] = useState<string | undefined>(undefined);
  const [focusedRunId, setFocusedRunId] = useState<string | undefined>(undefined);
  const [recordingRolloutConfig, setRecordingRolloutConfig] = useState<RecordingRolloutConfig>({
    phase: 'formal',
    recording_center_visible: true,
    workflow_mode_enabled: true,
    api_mode_enabled: true,
    publish_enabled: true,
    allowed_account_ids: [],
    notes: '',
  });
  const navigateToPage = (page: PageId, search = '') => {
    setCurrentPage(page);
    const path = PAGE_PATHS[page] || '/';
    const nextUrl = `${path}${search}`;
    if (window.location.pathname + window.location.search !== nextUrl) {
      window.history.pushState({}, '', nextUrl);
    }
  };

  const handlePageNavigate = (page: string) => navigateToPage(page as PageId);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPage(pageFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void recordingsService.getRolloutConfig()
      .then(config => {
        if (!cancelled) {
          setRecordingRolloutConfig(config);
        }
      })
      .catch(error => {
        console.error('Failed to load recording rollout config:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (recordingRolloutConfig.recording_center_visible) {
      return;
    }

    if (currentPage === 'recordings' || currentPage === 'recording-detail' || currentPage === 'preconfigured-runs') {
      navigateToPage('ai-scans');
    }
  }, [currentPage, recordingRolloutConfig.recording_center_visible]);

  const handleOpenRecordingDetail = (sessionId: string) => {
    setRecordingDetailSessionId(sessionId);
    navigateToPage('recording-detail');
  };

  const handleBackToRecordingList = () => {
    navigateToPage('recordings');
  };

  const handleOpenWorkflowEditor = (workflowId: string) => {
    setFocusedWorkflowId(workflowId);
    navigateToPage('workflows');
  };

  const handleOpenPreconfiguredRuns = (params?: {
    draftId?: string;
    presetId?: string;
  }) => {
    setFocusedDraftId(params?.draftId);
    setFocusedPresetId(params?.presetId);
    navigateToPage('preconfigured-runs');
  };

  const handleOpenTestRuns = (runId?: string) => {
    setFocusedRunId(runId);
    navigateToPage('runs');
  };

  const navigateToFindings = (params?: {
    tab?: 'test_run' | 'workflow';
    test_run_id?: string;
    template_id?: string;
    workflow_id?: string;
  }) => {
    if (params) {
      const searchParams = new URLSearchParams();
      if (params.tab) searchParams.set('tab', params.tab);
      if (params.test_run_id) searchParams.set('test_run_id', params.test_run_id);
      if (params.template_id) searchParams.set('template_id', params.template_id);
      if (params.workflow_id) searchParams.set('workflow_id', params.workflow_id);

      navigateToPage('findings', `?${searchParams.toString()}`);
      return;
    }
    navigateToPage('findings');
  };

  const navItems = [
    {
      id: 'ai-scans',
      label: 'Assessment',
      description: 'Live browser run',
      icon: <ScanLine size={18} />,
      onClick: () => navigateToPage('ai-scans'),
    },
    {
      id: 'findings',
      label: 'Findings',
      description: 'Validated evidence',
      icon: <AlertTriangle size={18} />,
      onClick: () => navigateToPage('findings'),
    },
    {
      id: 'runs',
      label: 'Run History',
      description: 'Execution trail',
      icon: <Play size={18} />,
      onClick: () => navigateToPage('runs'),
    },
    {
      id: 'ai-analysis',
      label: 'Review',
      description: 'Evidence triage',
      icon: <ClipboardCheck size={18} />,
      onClick: () => navigateToPage('ai-analysis'),
    },
    {
      id: 'ai-reports',
      label: 'Reports',
      description: 'Export ready',
      icon: <FileSpreadsheet size={18} />,
      onClick: () => navigateToPage('ai-reports'),
    },
    {
      id: 'dashboard',
      label: 'System Overview',
      description: 'Service health',
      section: 'secondary' as const,
      icon: <Activity size={18} />,
      onClick: () => navigateToPage('dashboard'),
    },
    {
      id: 'environments',
      label: 'Targets',
      description: 'Base URLs',
      section: 'secondary' as const,
      icon: <Globe size={18} />,
      onClick: () => navigateToPage('environments'),
    },
    {
      id: 'accounts',
      label: 'Identities',
      description: 'Account material',
      section: 'secondary' as const,
      icon: <Users size={18} />,
      onClick: () => navigateToPage('accounts'),
    },
    {
      id: 'templates',
      label: 'Request Library',
      description: 'Templates',
      section: 'secondary' as const,
      icon: <FileText size={18} />,
      onClick: () => navigateToPage('templates'),
    },
    {
      id: 'template-variables',
      label: 'Variable Pool',
      description: 'Runtime values',
      section: 'secondary' as const,
      icon: <KeyRound size={18} />,
      onClick: () => navigateToPage('template-variables'),
    },
    {
      id: 'checklists',
      label: 'Checklists',
      description: 'Policy packs',
      section: 'secondary' as const,
      icon: <List size={18} />,
      onClick: () => navigateToPage('checklists'),
    },
    {
      id: 'rules',
      label: 'Rule Engine',
      description: 'Detection logic',
      section: 'secondary' as const,
      icon: <ShieldAlert size={18} />,
      onClick: () => navigateToPage('rules'),
    },
    {
      id: 'workflows',
      label: 'Workflow Builder',
      description: 'Flow logic',
      section: 'secondary' as const,
      icon: <GitBranch size={18} />,
      onClick: () => navigateToPage('workflows'),
    },
    {
      id: 'recordings',
      label: 'Recorder',
      description: 'Captured flows',
      section: 'secondary' as const,
      icon: <FileText size={18} />,
      onClick: () => navigateToPage('recordings'),
    },
    {
      id: 'preconfigured-runs',
      label: 'Run Presets',
      description: 'Saved launch plans',
      section: 'secondary' as const,
      icon: <Crosshair size={18} />,
      onClick: () => navigateToPage('preconfigured-runs'),
    },
    {
      id: 'dictionary',
      label: 'Field Memory',
      description: 'Agent vocabulary',
      section: 'secondary' as const,
      icon: <BookOpen size={18} />,
      onClick: () => navigateToPage('dictionary'),
    },
    {
      id: 'governance',
      label: 'Governance',
      description: 'Suppression rules',
      section: 'secondary' as const,
      icon: <Settings2 size={18} />,
      onClick: () => navigateToPage('governance'),
    },
    {
      id: 'cigate',
      label: 'CI Gate',
      description: 'Release policy',
      section: 'secondary' as const,
      icon: <Shield size={18} />,
      onClick: () => navigateToPage('cigate'),
    },
    {
      id: 'security-suites',
      label: 'Security Suites',
      description: 'Suite packs',
      section: 'secondary' as const,
      icon: <Package size={18} />,
      onClick: () => navigateToPage('security-suites'),
    },
    {
      id: 'ai-providers',
      label: 'Model Providers',
      description: 'LLM routing',
      section: 'secondary' as const,
      icon: <Brain size={18} />,
      onClick: () => navigateToPage('ai-providers'),
    },
    {
      id: 'debug',
      label: 'Debug Trace',
      description: 'Diagnostics',
      section: 'secondary' as const,
      icon: <Bug size={18} />,
      onClick: () => navigateToPage('debug'),
    },
  ].filter(item => {
    if (!recordingRolloutConfig.recording_center_visible && (item.id === 'recordings' || item.id === 'preconfigured-runs')) {
      return false;
    }
    return true;
  });

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard':
        return <Dashboard onNavigate={handlePageNavigate} onNavigateToFindings={navigateToFindings} />;
      case 'environments':
        return <Environments />;
      case 'accounts':
        return <Accounts />;
      case 'templates':
        return <ApiTemplates onNavigateToVariableManager={() => navigateToPage('template-variables')} />;
      case 'template-variables':
        return <TemplateVariableManager />;
      case 'checklists':
        return <Checklists />;
      case 'rules':
        return <SecurityRules />;
      case 'workflows':
        return (
          <Workflows
            focusWorkflowId={focusedWorkflowId}
            onWorkflowFocusHandled={() => setFocusedWorkflowId(undefined)}
          />
        );
      case 'recordings':
        return <Recordings onOpenDetail={handleOpenRecordingDetail} rolloutConfig={recordingRolloutConfig} />;
      case 'recording-detail':
        return (
          <RecordingDetail
            sessionId={recordingDetailSessionId}
            onBack={handleBackToRecordingList}
            onOpenWorkflow={handleOpenWorkflowEditor}
            onOpenPreconfiguredRuns={handleOpenPreconfiguredRuns}
            onOpenTestRuns={handleOpenTestRuns}
            rolloutConfig={recordingRolloutConfig}
          />
        );
      case 'preconfigured-runs':
        return (
          <PreconfiguredRuns
            focusDraftId={focusedDraftId}
            focusPresetId={focusedPresetId}
            onDraftFocusHandled={() => setFocusedDraftId(undefined)}
            onPresetFocusHandled={() => setFocusedPresetId(undefined)}
            onOpenRecordingDetail={handleOpenRecordingDetail}
            onOpenTemplates={() => navigateToPage('templates')}
            onOpenTestRuns={handleOpenTestRuns}
            rolloutConfig={recordingRolloutConfig}
          />
        );
      case 'dictionary':
        return <DictionaryManager />;
      case 'runs':
        return (
          <TestRuns
            focusRunId={focusedRunId}
            onRunFocusHandled={() => setFocusedRunId(undefined)}
            onNavigateToFindings={navigateToFindings}
          />
        );
      case 'findings':
        return <Findings />;
      case 'governance':
        return <FindingsGovernance />;
      case 'cigate':
        return <CIGatePolicies />;
      case 'security-suites':
        return <SecuritySuites />;
      case 'debug':
        return <DebugPanel />;
      case 'ai-providers':
        return <AIProviders />;
      case 'ai-scans':
        return <AIScans />;
      case 'ai-analysis':
        return <AIAnalysis />;
      case 'ai-reports':
        return <AIReports />;
      default:
        return <Dashboard onNavigate={handlePageNavigate} onNavigateToFindings={navigateToFindings} />;
    }
  };

  return (
    <Layout navItems={navItems} currentPage={currentPage === 'recording-detail' ? 'recordings' : currentPage}>
      {renderPage()}
    </Layout>
  );
}

export default App;
