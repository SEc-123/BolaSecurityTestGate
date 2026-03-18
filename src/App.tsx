import { useEffect, useState } from 'react';
import {
  Home,
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
  Sparkles,
  FileSpreadsheet,
  Package,
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
  | 'ai-analysis'
  | 'ai-reports';

function App() {
  const [currentPage, setCurrentPage] = useState<PageId>('dashboard');
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
  const handlePageNavigate = (page: string) => setCurrentPage(page as PageId);

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
      setCurrentPage('dashboard');
    }
  }, [currentPage, recordingRolloutConfig.recording_center_visible]);

  const handleOpenRecordingDetail = (sessionId: string) => {
    setRecordingDetailSessionId(sessionId);
    setCurrentPage('recording-detail');
  };

  const handleBackToRecordingList = () => {
    setCurrentPage('recordings');
  };

  const handleOpenWorkflowEditor = (workflowId: string) => {
    setFocusedWorkflowId(workflowId);
    setCurrentPage('workflows');
  };

  const handleOpenPreconfiguredRuns = (params?: {
    draftId?: string;
    presetId?: string;
  }) => {
    setFocusedDraftId(params?.draftId);
    setFocusedPresetId(params?.presetId);
    setCurrentPage('preconfigured-runs');
  };

  const handleOpenTestRuns = (runId?: string) => {
    setFocusedRunId(runId);
    setCurrentPage('runs');
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

      const url = `${window.location.pathname}?${searchParams.toString()}`;
      window.history.pushState({}, '', url);
    }
    setCurrentPage('findings');
  };

  const navItems = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      icon: <Home size={20} />,
      onClick: () => setCurrentPage('dashboard'),
    },
    {
      id: 'environments',
      label: 'Environments',
      icon: <Globe size={20} />,
      onClick: () => setCurrentPage('environments'),
    },
    {
      id: 'accounts',
      label: 'Test Accounts',
      icon: <Users size={20} />,
      onClick: () => setCurrentPage('accounts'),
    },
    {
      id: 'templates',
      label: 'API Templates',
      icon: <FileText size={20} />,
      onClick: () => setCurrentPage('templates'),
    },
    {
      id: 'checklists',
      label: 'Checklists',
      icon: <List size={20} />,
      onClick: () => setCurrentPage('checklists'),
    },
    {
      id: 'rules',
      label: 'Security Rules',
      icon: <ShieldAlert size={20} />,
      onClick: () => setCurrentPage('rules'),
    },
    {
      id: 'workflows',
      label: 'Workflows',
      icon: <GitBranch size={20} />,
      onClick: () => setCurrentPage('workflows'),
    },
    {
      id: 'recordings',
      label: 'Recording Center',
      icon: <FileText size={20} />,
      onClick: () => setCurrentPage('recordings'),
    },
    {
      id: 'dictionary',
      label: 'Field Dictionary',
      icon: <BookOpen size={20} />,
      onClick: () => setCurrentPage('dictionary'),
    },
    {
      id: 'runs',
      label: 'Test Runs',
      icon: <Play size={20} />,
      onClick: () => setCurrentPage('runs'),
    },
    {
      id: 'preconfigured-runs',
      label: 'Preconfigured Runs',
      icon: <FileText size={20} />,
      onClick: () => setCurrentPage('preconfigured-runs'),
    },
    {
      id: 'findings',
      label: 'Findings',
      icon: <AlertTriangle size={20} />,
      onClick: () => setCurrentPage('findings'),
    },
    {
      id: 'governance',
      label: 'Governance',
      icon: <Settings2 size={20} />,
      onClick: () => setCurrentPage('governance'),
    },
    {
      id: 'cigate',
      label: 'CI Gate',
      icon: <Shield size={20} />,
      onClick: () => setCurrentPage('cigate'),
    },
    {
      id: 'security-suites',
      label: 'Security Suites',
      icon: <Package size={20} />,
      onClick: () => setCurrentPage('security-suites'),
    },
    {
      id: 'debug',
      label: 'Debug Trace',
      icon: <Bug size={20} />,
      onClick: () => setCurrentPage('debug'),
    },
    {
      id: 'ai-providers',
      label: 'AI Providers',
      icon: <Brain size={20} />,
      onClick: () => setCurrentPage('ai-providers'),
    },
    {
      id: 'ai-analysis',
      label: 'AI Analysis',
      icon: <Sparkles size={20} />,
      onClick: () => setCurrentPage('ai-analysis'),
    },
    {
      id: 'ai-reports',
      label: 'AI Reports',
      icon: <FileSpreadsheet size={20} />,
      onClick: () => setCurrentPage('ai-reports'),
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
        return <ApiTemplates onNavigateToVariableManager={() => setCurrentPage('template-variables')} />;
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
            onOpenTemplates={() => setCurrentPage('templates')}
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
