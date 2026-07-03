import { i18nConfirm } from '../i18n/feedback';
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Bot, Check, CheckCircle, Copy, Eye, Filter, GitCompare, Layers, MessageSquare, RefreshCw, Settings, ShieldCheck, Target, Trash2, Users, X, XCircle } from 'lucide-react';
import { Table } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { Button, TextArea, Input, Select } from '../components/ui/Form';
import { SuppressionRulesManager } from '../components/SuppressionRulesManager';
import { findingsService, suppressionRulesService, apiTemplatesService, workflowsService, testRunsService } from '../lib/api-service';
import type { Finding, FindingAssistantResult, FindingEvidenceView, FindingIssue, FindingSuppressionRule, ApiTemplate, Workflow, TestRun } from '../types';

type FindingTab = 'test_run' | 'workflow' | 'ai_scan';
type AIScanViewMode = 'issues' | 'raw';
type AssistantMode = 'explain' | 'false_positive' | 'attack_path' | 'remediation' | 'custom_question';

interface TestRunFilters {
  template_id?: string;
  service_id?: string;
  path_keyword?: string;
  test_run_id?: string;
  date_from?: string;
  date_to?: string;
  status?: string;
}

interface BaselineViewTab {
  type: 'baseline' | 'mutated' | 'diff';
}

interface WorkflowFilters {
  workflow_id?: string;
  test_run_id?: string;
  date_from?: string;
  date_to?: string;
  status?: string;
}

interface SourceTabConfig {
  label: string;
  emptyTitle: string;
  emptyDescription: string;
}

const SOURCE_TAB_CONFIG: Record<FindingTab, SourceTabConfig> = {
  test_run: {
    label: 'API Findings',
    emptyTitle: 'No API Findings Yet',
    emptyDescription: 'Run API template tests to discover potential vulnerabilities.',
  },
  workflow: {
    label: 'Workflow Findings',
    emptyTitle: 'No Workflow Findings Yet',
    emptyDescription: 'Run workflow tests to discover potential vulnerabilities.',
  },
  ai_scan: {
    label: 'AI Scan Findings',
    emptyTitle: 'No AI Scan Findings Yet',
    emptyDescription: 'Run an AI assessment to discover validated AI Scan findings.',
  },
};

function findingSourceLabel(sourceType: Finding['source_type']): string {
  if (sourceType === 'test_run') return 'API Finding';
  if (sourceType === 'workflow') return 'Workflow Finding';
  if (sourceType === 'ai_scan') return 'AI Scan Finding';
  return 'Finding';
}

function findingSourceClass(sourceType: Finding['source_type']): string {
  if (sourceType === 'test_run') return 'bg-blue-100 text-blue-700';
  if (sourceType === 'workflow') return 'bg-purple-100 text-purple-700';
  if (sourceType === 'ai_scan') return 'bg-emerald-100 text-emerald-700';
  return 'bg-gray-100 text-gray-700';
}

function severityBadgeClass(value: string): string {
  if (value === 'critical') return 'bg-red-100 text-red-800';
  if (value === 'high') return 'bg-orange-100 text-orange-800';
  if (value === 'medium') return 'bg-yellow-100 text-yellow-800';
  if (value === 'low') return 'bg-blue-100 text-blue-800';
  return 'bg-slate-100 text-slate-700';
}

function formatUnknown(value: any): string {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function endpointDisplay(view?: FindingEvidenceView | null, finding?: Finding | null): string {
  if (view?.endpoint?.path) {
    return `${view.endpoint.method || ''} ${view.endpoint.path}`.trim();
  }
  if (finding?.request_raw) return finding.request_raw.split('\n')[0] || finding.request_raw;
  return '-';
}

function CodeBlock({
  value,
  tone = 'green',
  maxHeight = 'max-h-64',
}: {
  value: any;
  tone?: 'green' | 'amber' | 'red' | 'slate';
  maxHeight?: string;
}) {
  const color = tone === 'amber' ? 'text-amber-300' : tone === 'red' ? 'text-red-300' : tone === 'slate' ? 'text-slate-200' : 'text-green-300';
  return (
    <pre className={`text-xs bg-gray-950 ${color} p-3 rounded overflow-x-auto ${maxHeight}`}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function BulletList({ items }: { items: string[] }) {
  if (!items?.length) return <p className="text-sm text-gray-500">No data captured.</p>;
  return (
    <ul className="space-y-2">
      {items.map((item, idx) => (
        <li key={`${item}-${idx}`} className="text-sm text-gray-700 flex gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-slate-400 shrink-0"></span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function EvidenceCard({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`border border-gray-200 rounded-lg p-4 bg-white ${className}`}>
      <h4 className="font-semibold text-gray-900 mb-3">{title}</h4>
      {children}
    </div>
  );
}

function checkHeadersTruncated(response: any): { truncated: boolean; reason?: string } {
  if (!response) return { truncated: false };

  if (response.request?._headers_truncated || response.response?._headers_truncated) {
    return {
      truncated: true,
      reason: response.request?._headers_truncated_reason || response.response?._headers_truncated_reason
    };
  }

  if (response.steps && Array.isArray(response.steps)) {
    for (const step of response.steps) {
      if (step.request?._headers_truncated || step.response?._headers_truncated) {
        return {
          truncated: true,
          reason: step.request?._headers_truncated_reason || step.response?._headers_truncated_reason
        };
      }
    }
  }

  return { truncated: false };
}

export function Findings() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [issues, setIssues] = useState<FindingIssue[]>([]);
  const [suppressionRules, setSuppressionRules] = useState<FindingSuppressionRule[]>([]);
  const [apiTemplates, setApiTemplates] = useState<ApiTemplate[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [testRuns, setTestRuns] = useState<TestRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [selectedEvidenceView, setSelectedEvidenceView] = useState<FindingEvidenceView | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isSuppressionModalOpen, setIsSuppressionModalOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [activeTab, setActiveTab] = useState<FindingTab>('test_run');
  const [aiScanViewMode, setAIScanViewMode] = useState<AIScanViewMode>('issues');
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [testRunFilters, setTestRunFilters] = useState<TestRunFilters>({});
  const [workflowFilters, setWorkflowFilters] = useState<WorkflowFilters>({});
  const [baselineViewTab, setBaselineViewTab] = useState<BaselineViewTab['type']>('diff');
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('explain');
  const [assistantQuestion, setAssistantQuestion] = useState('');
  const [assistantResult, setAssistantResult] = useState<FindingAssistantResult | null>(null);
  const [assistantLoading, setAssistantLoading] = useState(false);

  useEffect(() => {
    loadFindings();
    loadIssues();
    loadSuppressionRules();
    loadApiTemplates();
    loadWorkflows();
    loadTestRuns();
    parseUrlParameters();
  }, []);

  const parseUrlParameters = () => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab') as FindingTab;
    const testRunId = params.get('test_run_id');
    const templateId = params.get('template_id');
    const workflowId = params.get('workflow_id');

    if (tab && (tab === 'test_run' || tab === 'workflow' || tab === 'ai_scan')) {
      setActiveTab(tab);
    }

    if (tab === 'test_run' && (testRunId || templateId)) {
      setTestRunFilters({
        test_run_id: testRunId || undefined,
        template_id: templateId || undefined,
      });
    } else if (tab === 'workflow' && (testRunId || workflowId)) {
      setWorkflowFilters({
        test_run_id: testRunId || undefined,
        workflow_id: workflowId || undefined,
      });
    }
  };

  const loadFindings = async () => {
    setLoading(true);
    try {
      const data = await findingsService.list();
      setFindings(data);
      const tabParam = new URLSearchParams(window.location.search).get('tab');
      if (!tabParam && data.some(finding => finding.source_type === 'ai_scan') && !data.some(finding => finding.source_type === 'test_run')) {
        setActiveTab('ai_scan');
      }
    } catch (error) {
      console.error('Failed to load findings:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadIssues = async () => {
    setIssuesLoading(true);
    try {
      const data = await findingsService.listIssues();
      setIssues(data);
    } catch (error) {
      console.error('Failed to load finding issues:', error);
    } finally {
      setIssuesLoading(false);
    }
  };

  const loadSuppressionRules = async () => {
    try {
      const data = await suppressionRulesService.list();
      setSuppressionRules(data);
    } catch (error) {
      console.error('Failed to load suppression rules:', error);
    }
  };

  const loadApiTemplates = async () => {
    try {
      const data = await apiTemplatesService.list();
      setApiTemplates(data);
    } catch (error) {
      console.error('Failed to load API templates:', error);
    }
  };

  const loadWorkflows = async () => {
    try {
      const data = await workflowsService.list();
      setWorkflows(data);
    } catch (error) {
      console.error('Failed to load workflows:', error);
    }
  };

  const loadTestRuns = async () => {
    try {
      const data = await testRunsService.list();
      setTestRuns(data);
    } catch (error) {
      console.error('Failed to load test runs:', error);
    }
  };

  const handleDelete = async (id: string) => {
    if (!i18nConfirm('Delete this finding?')) return;
    try {
      await findingsService.delete(id);
      setFindings(findings.filter((f) => f.id !== id));
      loadIssues();
    } catch (error) {
      console.error('Failed to delete finding:', error);
    }
  };

  const loadEvidenceView = async (findingId: string) => {
    setEvidenceLoading(true);
    setSelectedEvidenceView(null);
    try {
      const data = await findingsService.getEvidenceView(findingId);
      setSelectedEvidenceView(data);
    } catch (error) {
      console.error('Failed to load evidence view:', error);
    } finally {
      setEvidenceLoading(false);
    }
  };

  const handleViewDetails = (finding: Finding) => {
    setSelectedFinding(finding);
    setNotes(finding.notes || '');
    setAssistantResult(null);
    setAssistantQuestion('');
    setAssistantMode('explain');
    setIsDetailModalOpen(true);
    loadEvidenceView(finding.id);
  };

  const handleViewIssue = (issue: FindingIssue) => {
    const representative = findings.find(f => f.id === issue.representative_finding_id)
      || findings.find(f => issue.finding_ids.includes(f.id));
    if (representative) {
      handleViewDetails(representative);
    }
  };

  const issueTestId = (id: string) => `issue-details-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  const handleUpdateStatus = async (id: string, status: Finding['status']) => {
    try {
      const updated = await findingsService.update(id, { status, notes });
      setFindings(findings.map((f) => (f.id === id ? updated : f)));
      loadIssues();
      if (selectedFinding?.id === id) {
        setSelectedFinding(updated);
      }
    } catch (error) {
      console.error('Failed to update finding:', error);
    }
  };

  const handleSaveNotes = async () => {
    if (!selectedFinding) return;
    try {
      const updated = await findingsService.update(selectedFinding.id, { notes });
      setFindings(findings.map((f) => (f.id === selectedFinding.id ? updated : f)));
      setSelectedFinding(updated);
      loadIssues();
    } catch (error) {
      console.error('Failed to save notes:', error);
    }
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const askAssistant = async (mode: AssistantMode = assistantMode) => {
    if (!selectedFinding) return;
    setAssistantLoading(true);
    setAssistantMode(mode);
    try {
      const result = await findingsService.askAssistant(selectedFinding.id, {
        mode,
        question: mode === 'custom_question' ? assistantQuestion : undefined,
      });
      setAssistantResult(result);
    } catch (error) {
      console.error('Failed to ask finding assistant:', error);
    } finally {
      setAssistantLoading(false);
    }
  };

  const applyTestRunFilters = (finding: Finding): boolean => {
    if (testRunFilters.test_run_id && finding.test_run_id !== testRunFilters.test_run_id) return false;
    if (testRunFilters.template_id && finding.template_id !== testRunFilters.template_id) return false;
    if (testRunFilters.status && finding.status !== testRunFilters.status) return false;
    if (testRunFilters.service_id && finding.request_raw && !finding.request_raw.includes(testRunFilters.service_id)) return false;
    if (testRunFilters.path_keyword && finding.request_raw && !finding.request_raw.toLowerCase().includes(testRunFilters.path_keyword.toLowerCase())) return false;
    if (testRunFilters.date_from) {
      const findingDate = finding.created_at.split('T')[0];
      if (findingDate < testRunFilters.date_from) return false;
    }
    if (testRunFilters.date_to) {
      const findingDate = finding.created_at.split('T')[0];
      if (findingDate > testRunFilters.date_to) return false;
    }
    return true;
  };

  const applyWorkflowFilters = (finding: Finding): boolean => {
    if (workflowFilters.workflow_id && finding.workflow_id !== workflowFilters.workflow_id) return false;
    if (workflowFilters.test_run_id && finding.test_run_id !== workflowFilters.test_run_id) return false;
    if (workflowFilters.status && finding.status !== workflowFilters.status) return false;
    if (workflowFilters.date_from) {
      const findingDate = finding.created_at.split('T')[0];
      if (findingDate < workflowFilters.date_from) return false;
    }
    if (workflowFilters.date_to) {
      const findingDate = finding.created_at.split('T')[0];
      if (findingDate > workflowFilters.date_to) return false;
    }
    return true;
  };

  const applyAIScanFilters = (finding: Finding): boolean => {
    if (testRunFilters.status && finding.status !== testRunFilters.status) return false;
    if (testRunFilters.path_keyword && finding.request_raw && !finding.request_raw.toLowerCase().includes(testRunFilters.path_keyword.toLowerCase())) return false;
    if (testRunFilters.date_from) {
      const findingDate = finding.created_at.split('T')[0];
      if (findingDate < testRunFilters.date_from) return false;
    }
    if (testRunFilters.date_to) {
      const findingDate = finding.created_at.split('T')[0];
      if (findingDate > testRunFilters.date_to) return false;
    }
    return true;
  };

  const formatJsonDiff = (diff: Record<string, any> | undefined): string => {
    if (!diff) return 'No differences detected';
    return JSON.stringify(diff, null, 2);
  };

  const hasBaselineComparison = (finding: Finding): boolean => {
    return !!(finding.baseline_response || finding.mutated_response || finding.response_diff);
  };

  const filteredFindings = findings.filter(f => {
    if (f.source_type !== activeTab) return false;
    if (!showSuppressed && f.is_suppressed) return false;

    if (activeTab === 'test_run') return applyTestRunFilters(f);
    if (activeTab === 'workflow') return applyWorkflowFilters(f);
    return applyAIScanFilters(f);
  });

  const filteredIssues = issues.filter(issue => {
    if (testRunFilters.status && issue.status !== testRunFilters.status) return false;
    if (testRunFilters.path_keyword) {
      const needle = testRunFilters.path_keyword.toLowerCase();
      const haystack = [
        issue.title,
        issue.root_cause,
        issue.summary,
        issue.judgement,
        ...issue.affected_endpoints,
      ].join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (testRunFilters.date_from && issue.latest_created_at) {
      const findingDate = issue.latest_created_at.split('T')[0];
      if (findingDate < testRunFilters.date_from) return false;
    }
    if (testRunFilters.date_to && issue.latest_created_at) {
      const findingDate = issue.latest_created_at.split('T')[0];
      if (findingDate > testRunFilters.date_to) return false;
    }
    return true;
  });

  const clearFilters = () => {
    if (activeTab === 'test_run' || activeTab === 'ai_scan') {
      setTestRunFilters({});
    } else {
      setWorkflowFilters({});
    }
  };

  const hasActiveFilters = () => {
    if (activeTab === 'test_run' || activeTab === 'ai_scan') {
      return Object.keys(testRunFilters).length > 0;
    } else {
      return Object.keys(workflowFilters).length > 0;
    }
  };

  const testRunColumns = [
    {
      key: 'severity' as const,
      label: 'Severity',
      render: (value: string) => (
        <span
          className={`px-2 py-1 text-xs font-medium rounded ${
            value === 'critical'
              ? 'bg-red-100 text-red-800'
              : value === 'high'
                ? 'bg-orange-100 text-orange-800'
                : value === 'medium'
                  ? 'bg-yellow-100 text-yellow-800'
                  : 'bg-blue-100 text-blue-800'
          }`}
        >
          {value}
        </span>
      ),
    },
    { key: 'title' as const, label: 'Title' },
    {
      key: 'template_name' as const,
      label: 'API Template',
      render: (value: string) => value || '-',
    },
    {
      key: 'response_status' as const,
      label: 'Response',
      render: (value: number) => (
        value ? (
          <span className={`px-2 py-1 text-xs font-medium rounded ${
            value >= 200 && value < 300
              ? 'bg-green-100 text-green-800'
              : value >= 400
                ? 'bg-red-100 text-red-800'
                : 'bg-gray-100 text-gray-800'
          }`}>
            {value}
          </span>
        ) : '-'
      ),
    },
    {
      key: 'status' as const,
      label: 'Status',
      render: (value: string) => (
        <span
          className={`px-2 py-1 text-xs font-medium rounded ${
            value === 'confirmed'
              ? 'bg-red-100 text-red-800'
              : value === 'fixed'
                ? 'bg-green-100 text-green-800'
                : value === 'false_positive'
                  ? 'bg-gray-100 text-gray-800'
                  : 'bg-blue-100 text-blue-800'
          }`}
        >
          {value.replace('_', ' ')}
        </span>
      ),
    },
    {
      key: 'created_at' as const,
      label: 'Discovered',
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: Finding) => (
        <div className="flex gap-2">
          <button
            aria-label="View finding details"
            onClick={(event) => {
              event.stopPropagation();
              handleViewDetails(row);
            }}
            className="p-1 hover:bg-blue-100 rounded text-blue-600"
          >
            <Eye size={16} />
          </button>
          <button
            aria-label="Delete finding"
            onClick={(event) => {
              event.stopPropagation();
              handleDelete(row.id);
            }}
            className="p-1 hover:bg-red-100 rounded text-red-600"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  const workflowColumns = [
    {
      key: 'severity' as const,
      label: 'Severity',
      render: (value: string) => (
        <span
          className={`px-2 py-1 text-xs font-medium rounded ${
            value === 'critical'
              ? 'bg-red-100 text-red-800'
              : value === 'high'
                ? 'bg-orange-100 text-orange-800'
                : value === 'medium'
                  ? 'bg-yellow-100 text-yellow-800'
                  : 'bg-blue-100 text-blue-800'
          }`}
        >
          {value}
        </span>
      ),
    },
    { key: 'title' as const, label: 'Title' },
    {
      key: 'template_name' as const,
      label: 'Workflow',
      render: (value: string) => value || '-',
    },
    {
      key: 'status' as const,
      label: 'Status',
      render: (value: string) => (
        <span
          className={`px-2 py-1 text-xs font-medium rounded ${
            value === 'confirmed'
              ? 'bg-red-100 text-red-800'
              : value === 'fixed'
                ? 'bg-green-100 text-green-800'
                : value === 'false_positive'
                  ? 'bg-gray-100 text-gray-800'
                  : 'bg-blue-100 text-blue-800'
          }`}
        >
          {value.replace('_', ' ')}
        </span>
      ),
    },
    {
      key: 'created_at' as const,
      label: 'Discovered',
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: Finding) => (
        <div className="flex gap-2">
          <button
            aria-label="View finding details"
            onClick={(event) => {
              event.stopPropagation();
              handleViewDetails(row);
            }}
            className="p-1 hover:bg-blue-100 rounded text-blue-600"
          >
            <Eye size={16} />
          </button>
          <button
            aria-label="Delete finding"
            onClick={(event) => {
              event.stopPropagation();
              handleDelete(row.id);
            }}
            className="p-1 hover:bg-red-100 rounded text-red-600"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  const aiScanColumns = [
    {
      key: 'severity' as const,
      label: 'Severity',
      render: (value: string) => (
        <span
          className={`px-2 py-1 text-xs font-medium rounded ${
            value === 'critical'
              ? 'bg-red-100 text-red-800'
              : value === 'high'
                ? 'bg-orange-100 text-orange-800'
                : value === 'medium'
                  ? 'bg-yellow-100 text-yellow-800'
                  : 'bg-blue-100 text-blue-800'
          }`}
        >
          {value}
        </span>
      ),
    },
    { key: 'title' as const, label: 'Title' },
    {
      key: 'request_raw' as const,
      label: 'Target',
      render: (value: string) => {
        if (!value) return '-';
        if (value.includes('; native_')) return value.split(';')[0];
        return value.split('\n')[0] || value;
      },
    },
    {
      key: 'status' as const,
      label: 'Status',
      render: (value: string) => (
        <span
          className={`px-2 py-1 text-xs font-medium rounded ${
            value === 'confirmed'
              ? 'bg-red-100 text-red-800'
              : value === 'fixed'
                ? 'bg-green-100 text-green-800'
                : value === 'false_positive'
                  ? 'bg-gray-100 text-gray-800'
                  : 'bg-blue-100 text-blue-800'
          }`}
        >
          {value.replace('_', ' ')}
        </span>
      ),
    },
    {
      key: 'created_at' as const,
      label: 'Discovered',
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: Finding) => (
        <div className="flex gap-2">
          <button
            aria-label="View finding details"
            onClick={(event) => {
              event.stopPropagation();
              handleViewDetails(row);
            }}
            className="p-1 hover:bg-blue-100 rounded text-blue-600"
          >
            <Eye size={16} />
          </button>
          <button
            aria-label="Delete finding"
            onClick={(event) => {
              event.stopPropagation();
              handleDelete(row.id);
            }}
            className="p-1 hover:bg-red-100 rounded text-red-600"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  const issueColumns = [
    {
      key: 'severity' as const,
      label: 'Severity',
      render: (value: string) => (
        <span className={`px-2 py-1 text-xs font-medium rounded ${severityBadgeClass(value)}`}>
          {value}
        </span>
      ),
    },
    {
      key: 'title' as const,
      label: 'Unique Issue',
      render: (value: string, row: FindingIssue) => (
        <div className="min-w-[260px]">
          <div className="font-medium text-gray-900">{value}</div>
          <div className="text-xs text-gray-500 mt-1 line-clamp-2">{row.root_cause}</div>
        </div>
      ),
    },
    {
      key: 'affected_endpoint_count' as const,
      label: 'Affected',
      render: (_: number, row: FindingIssue) => (
        <div className="space-y-1">
          <div className="text-sm font-medium">{row.affected_endpoint_count} endpoint{row.affected_endpoint_count === 1 ? '' : 's'}</div>
          <div className="text-xs text-gray-500 max-w-[260px] truncate">{row.affected_endpoints.slice(0, 2).join(', ')}</div>
        </div>
      ),
    },
    {
      key: 'raw_count' as const,
      label: 'Raw',
      render: (value: number) => (
        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-100 text-slate-700">
          <Layers size={13} />
          {value}
        </span>
      ),
    },
    {
      key: 'evidence_strength' as const,
      label: 'Evidence',
      render: (value: string, row: FindingIssue) => (
        <div className="space-y-1">
          <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded ${
            value === 'confirmed'
              ? 'bg-emerald-100 text-emerald-800'
              : value === 'needs_review'
                ? 'bg-yellow-100 text-yellow-800'
                : 'bg-blue-100 text-blue-800'
          }`}>
            <ShieldCheck size={13} />
            {value === 'confirmed' ? 'Native confirmed' : value === 'needs_review' ? 'Needs review' : 'AI only'}
          </span>
          {row.business_impact_review_required && (
            <div className="text-xs text-yellow-700">Business impact review</div>
          )}
        </div>
      ),
    },
    {
      key: 'judgement' as const,
      label: 'Judgement',
      render: (value: string) => <span className="text-sm text-gray-700">{value}</span>,
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: FindingIssue) => (
        <button
          aria-label={`View issue details: ${row.title}`}
          data-testid={issueTestId(row.id)}
          onClick={(event) => {
            event.stopPropagation();
            handleViewIssue(row);
          }}
          className="p-1 hover:bg-blue-100 rounded text-blue-600"
        >
          <Eye size={16} />
        </button>
      ),
    },
  ];

  const activeColumns = activeTab === 'test_run'
    ? testRunColumns
    : activeTab === 'workflow'
      ? workflowColumns
      : aiScanColumns;

  const visibleCount = activeTab === 'ai_scan' && aiScanViewMode === 'issues' ? filteredIssues.length : filteredFindings.length;
  const visibleNewCount = activeTab === 'ai_scan' && aiScanViewMode === 'issues'
    ? filteredIssues.filter(issue => issue.status === 'new').length
    : filteredFindings.filter(f => f.status === 'new').length;
  const visibleConfirmedCount = activeTab === 'ai_scan' && aiScanViewMode === 'issues'
    ? filteredIssues.filter(issue => issue.status === 'confirmed').length
    : filteredFindings.filter(f => f.status === 'confirmed').length;

  return (
    <div className="space-y-5 p-5">
      <section className="border border-slate-200 bg-white">
        <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Evidence workbench</div>
            <h1 className="mt-1 text-2xl font-semibold text-slate-950">Findings</h1>
            <p className="mt-1 text-sm text-slate-600">Review vulnerabilities, evidence, governance status, and release impact.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => { loadFindings(); loadIssues(); }}>
              <RefreshCw size={18} className="mr-2" />
              Refresh
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setShowFilters(!showFilters)}>
              <Filter size={16} className="mr-2" />
              Filters {hasActiveFilters() && `(${Object.keys(activeTab === 'workflow' ? workflowFilters : testRunFilters).length})`}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setIsSuppressionModalOpen(true)}>
              <Settings size={16} className="mr-2" />
              Suppression Rules ({suppressionRules.filter(r => r.is_enabled).length} active)
            </Button>
          </div>
        </div>

        <div className="grid gap-px bg-slate-200 md:grid-cols-4">
          <div className="bg-white px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Visible</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{visibleCount}</div>
            <div className="mt-1 text-xs text-slate-500">{SOURCE_TAB_CONFIG[activeTab].label}</div>
          </div>
          <div className="bg-white px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">New</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-blue-600">{visibleNewCount}</div>
            <div className="mt-1 text-xs text-slate-500">Needs triage</div>
          </div>
          <div className="bg-white px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Confirmed</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-red-600">{visibleConfirmedCount}</div>
            <div className="mt-1 text-xs text-slate-500">Release risk</div>
          </div>
          <div className="bg-white px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Suppressed</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{findings.filter(f => f.is_suppressed).length}</div>
            <label className="mt-1 flex items-center gap-2 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={showSuppressed}
                onChange={(e) => setShowSuppressed(e.target.checked)}
                className="rounded"
              />
              Show suppressed
            </label>
          </div>
        </div>

        <div className="flex flex-col gap-3 px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
          {(['test_run', 'workflow', 'ai_scan'] as FindingTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`rounded border px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'border-blue-600 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-950'
              }`}
            >
              {SOURCE_TAB_CONFIG[tab].label}
              <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs">
                {findings.filter(f => f.source_type === tab && (!f.is_suppressed || showSuppressed)).length}
              </span>
            </button>
          ))}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded border border-red-200 bg-red-50 px-2 py-1 font-medium text-red-700">Critical review</span>
            <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 font-medium text-amber-700">Governance queue</span>
            <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 font-medium text-emerald-700">Evidence ready</span>
          </div>
        </div>
      </section>

      {activeTab === 'ai_scan' && (
        <div className="flex items-center justify-between rounded border border-emerald-200 bg-emerald-50 p-3">
          <div>
            <div className="text-sm font-semibold text-emerald-900">AI Scan issue grouping</div>
            <div className="text-xs text-emerald-700">
              {filteredIssues.length} unique issues from {filteredFindings.length} raw findings
            </div>
          </div>
          <div className="inline-flex rounded border border-emerald-200 bg-white overflow-hidden">
            <button
              onClick={() => setAIScanViewMode('issues')}
              className={`px-3 py-1.5 text-sm font-medium ${aiScanViewMode === 'issues' ? 'bg-emerald-600 text-white' : 'text-emerald-800 hover:bg-emerald-50'}`}
            >
              Unique Issues
            </button>
            <button
              onClick={() => setAIScanViewMode('raw')}
              className={`px-3 py-1.5 text-sm font-medium ${aiScanViewMode === 'raw' ? 'bg-emerald-600 text-white' : 'text-emerald-800 hover:bg-emerald-50'}`}
            >
              Raw Findings
            </button>
          </div>
        </div>
      )}

      {showFilters && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-semibold text-gray-900">
              {SOURCE_TAB_CONFIG[activeTab].label} Filters
            </h3>
            <div className="flex gap-2">
              {hasActiveFilters() && (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  <X size={14} className="mr-1" />
                  Clear All
                </Button>
              )}
            </div>
          </div>

          {activeTab === 'test_run' ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Select
                label="Status"
                value={testRunFilters.status || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, status: e.target.value || undefined })}
              >
                <option value="">All Statuses</option>
                <option value="new">New</option>
                <option value="confirmed">Confirmed</option>
                <option value="false_positive">False Positive</option>
                <option value="fixed">Fixed</option>
              </Select>

              <Select
                label="Test Run"
                value={testRunFilters.test_run_id || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, test_run_id: e.target.value || undefined })}
              >
                <option value="">All Test Runs</option>
                {testRuns.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.name || run.id.substring(0, 8)} - {new Date(run.created_at).toLocaleDateString()}
                  </option>
                ))}
              </Select>

              <Select
                label="API Template"
                value={testRunFilters.template_id || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, template_id: e.target.value || undefined })}
              >
                <option value="">All Templates</option>
                {apiTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>

              <Input
                label="Service ID"
                value={testRunFilters.service_id || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, service_id: e.target.value || undefined })}
                placeholder="e.g., order-service"
              />

              <Input
                label="Path/Keyword"
                value={testRunFilters.path_keyword || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, path_keyword: e.target.value || undefined })}
                placeholder="Search in request path"
              />

              <Input
                type="date"
                label="Date From"
                value={testRunFilters.date_from || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, date_from: e.target.value || undefined })}
              />

              <Input
                type="date"
                label="Date To"
                value={testRunFilters.date_to || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, date_to: e.target.value || undefined })}
              />
            </div>
          ) : activeTab === 'workflow' ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Select
                label="Status"
                value={workflowFilters.status || ''}
                onChange={(e) => setWorkflowFilters({ ...workflowFilters, status: e.target.value || undefined })}
              >
                <option value="">All Statuses</option>
                <option value="new">New</option>
                <option value="confirmed">Confirmed</option>
                <option value="false_positive">False Positive</option>
                <option value="fixed">Fixed</option>
              </Select>

              <Select
                label="Test Run"
                value={workflowFilters.test_run_id || ''}
                onChange={(e) => setWorkflowFilters({ ...workflowFilters, test_run_id: e.target.value || undefined })}
              >
                <option value="">All Test Runs</option>
                {testRuns.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.name || run.id.substring(0, 8)} - {new Date(run.created_at).toLocaleDateString()}
                  </option>
                ))}
              </Select>

              <Select
                label="Workflow"
                value={workflowFilters.workflow_id || ''}
                onChange={(e) => setWorkflowFilters({ ...workflowFilters, workflow_id: e.target.value || undefined })}
              >
                <option value="">All Workflows</option>
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </Select>

              <Input
                type="date"
                label="Date From"
                value={workflowFilters.date_from || ''}
                onChange={(e) => setWorkflowFilters({ ...workflowFilters, date_from: e.target.value || undefined })}
              />

              <Input
                type="date"
                label="Date To"
                value={workflowFilters.date_to || ''}
                onChange={(e) => setWorkflowFilters({ ...workflowFilters, date_to: e.target.value || undefined })}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Select
                label="Status"
                value={testRunFilters.status || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, status: e.target.value || undefined })}
              >
                <option value="">All Statuses</option>
                <option value="new">New</option>
                <option value="confirmed">Confirmed</option>
                <option value="false_positive">False Positive</option>
                <option value="fixed">Fixed</option>
              </Select>

              <Input
                label="Target/Keyword"
                value={testRunFilters.path_keyword || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, path_keyword: e.target.value || undefined })}
                placeholder="Search in AI Scan target"
              />

              <Input
                type="date"
                label="Date From"
                value={testRunFilters.date_from || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, date_from: e.target.value || undefined })}
              />

              <Input
                type="date"
                label="Date To"
                value={testRunFilters.date_to || ''}
                onChange={(e) => setTestRunFilters({ ...testRunFilters, date_to: e.target.value || undefined })}
              />
            </div>
          )}
        </div>
      )}

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-4">
          {visibleCount === 0 && !loading && !issuesLoading && (
            <div className="border border-dashed border-slate-300 bg-white py-12 text-center">
              <AlertTriangle size={48} className="mx-auto mb-4 text-slate-400" />
              <h3 className="mb-2 text-lg font-medium text-slate-950">
                {SOURCE_TAB_CONFIG[activeTab].emptyTitle}
              </h3>
              <p className="text-slate-600">
                {SOURCE_TAB_CONFIG[activeTab].emptyDescription}
              </p>
            </div>
          )}

          {activeTab === 'ai_scan' && aiScanViewMode === 'issues' && filteredIssues.length > 0 && (
            <Table
              columns={issueColumns}
              data={filteredIssues}
              loading={issuesLoading}
              onRowClick={handleViewIssue}
            />
          )}

          {(activeTab !== 'ai_scan' || aiScanViewMode === 'raw') && filteredFindings.length > 0 && (
            <Table
              columns={activeColumns}
              data={filteredFindings}
              loading={loading}
              onRowClick={handleViewDetails}
            />
          )}
        </div>

        <aside className="space-y-4">
          <div className="border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Evidence inspector</div>
              <h2 className="mt-1 text-sm font-semibold text-slate-950">Review readiness</h2>
            </div>
            <div className="divide-y divide-slate-100">
              <div className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">Current queue</span>
                  <span className="font-mono text-sm font-semibold text-slate-950">{visibleCount}</span>
                </div>
                <div className="mt-2 h-1.5 bg-slate-100">
                  <div
                    className="h-full bg-blue-600"
                    style={{ width: `${visibleCount > 0 ? Math.min(100, Math.round((visibleConfirmedCount / visibleCount) * 100)) : 0}%` }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-px bg-slate-100">
                <div className="bg-white px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Needs triage</div>
                  <div className="mt-1 text-xl font-semibold text-blue-600">{visibleNewCount}</div>
                </div>
                <div className="bg-white px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Release impact</div>
                  <div className="mt-1 text-xl font-semibold text-red-600">{visibleConfirmedCount}</div>
                </div>
              </div>
              <div className="px-4 py-3 text-sm text-slate-600">
                Select a row to open the full evidence packet with request, response, baseline comparison, AI triage, and governance actions.
              </div>
            </div>
          </div>

          <div className="border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-950">Workbench tabs</h2>
            </div>
            <div className="divide-y divide-slate-100 text-sm">
              {['Evidence', 'Timeline', 'Triage', 'Governance', 'Impact', 'Notes'].map((item, index) => (
                <div key={item} className="flex items-center justify-between px-4 py-3">
                  <span className={index === 0 ? 'font-medium text-blue-700' : 'text-slate-600'}>{item}</span>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{index === 0 ? 'open' : 'ready'}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </section>

      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title="Finding Details"
        size="full"
        footer={
          selectedFinding && (
            <div className="flex justify-between w-full">
              <Button
                variant="secondary"
                onClick={() => handleUpdateStatus(selectedFinding.id, 'false_positive')}
              >
                <XCircle size={16} className="mr-2" />
                False Positive
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => handleUpdateStatus(selectedFinding.id, 'fixed')}
                >
                  <CheckCircle size={16} className="mr-2" />
                  Mark Fixed
                </Button>
                <Button
                  variant="primary"
                  onClick={() => handleUpdateStatus(selectedFinding.id, 'confirmed')}
                >
                  <AlertTriangle size={16} className="mr-2" />
                  Confirm Vulnerability
                </Button>
              </div>
            </div>
          )
        }
      >
        {selectedFinding && (
          <div className="space-y-6">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-lg font-semibold">{selectedFinding.title}</h3>
                <span className={`px-2 py-0.5 text-xs font-medium rounded ${findingSourceClass(selectedFinding.source_type)}`}>
                  {findingSourceLabel(selectedFinding.source_type)}
                </span>
                {selectedFinding.is_suppressed && (
                  <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                    selectedFinding.suppressed_reason === 'rate_limited'
                      ? 'bg-orange-100 text-orange-700'
                      : 'bg-gray-100 text-gray-700'
                  }`}>
                    {selectedFinding.suppressed_reason === 'rate_limited' ? 'Rate Limited' : 'Suppressed (Rule)'}
                  </span>
                )}
              </div>
              <p className="text-gray-700">{selectedFinding.description}</p>
            </div>

            {selectedFinding.source_type === 'ai_scan' && (
              <div className="space-y-4">
                {evidenceLoading && (
                  <div className="border border-emerald-200 rounded-lg p-4 bg-emerald-50 text-sm text-emerald-800">
                    Loading structured AI Scan evidence...
                  </div>
                )}

                {selectedEvidenceView && (
                  <>
                    <div className="border border-emerald-200 rounded-lg bg-emerald-50 p-4">
                      <h4 className="font-semibold text-emerald-950 mb-3">Evidence Summary</h4>
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-600 text-white text-xs font-medium">
                          <ShieldCheck size={13} />
                          {selectedEvidenceView.native_gate.verdict || 'native evidence'}
                        </span>
                        <span className="px-2 py-1 rounded bg-white text-emerald-800 text-xs font-medium">
                          {selectedEvidenceView.issue_title}
                        </span>
                        <span className="px-2 py-1 rounded bg-white text-emerald-800 text-xs font-medium">
                          {selectedEvidenceView.duplicate_count} raw finding{selectedEvidenceView.duplicate_count === 1 ? '' : 's'}
                        </span>
                        {selectedEvidenceView.summary.business_impact_review_required && (
                          <span className="px-2 py-1 rounded bg-yellow-100 text-yellow-800 text-xs font-medium">
                            Business impact review
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-emerald-950">{selectedEvidenceView.summary.what_happened}</p>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                      <EvidenceCard title="What Happened">
                        <div className="space-y-3 text-sm">
                          <div>
                            <div className="text-xs text-gray-500">Target</div>
                            <div className="font-mono text-gray-900">{endpointDisplay(selectedEvidenceView, selectedFinding)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Function / Agent</div>
                            <div className="text-gray-900">{selectedEvidenceView.task.function_name || selectedEvidenceView.task.title || '-'}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Vulnerability Type</div>
                            <div className="text-gray-900">{selectedEvidenceView.task.vuln_type || '-'}</div>
                          </div>
                        </div>
                      </EvidenceCard>

                      <EvidenceCard title="How It Was Found">
                        <BulletList items={selectedEvidenceView.summary.how_found} />
                      </EvidenceCard>

                      <EvidenceCard title="Why It Matters">
                        <BulletList items={selectedEvidenceView.summary.why_vulnerable} />
                      </EvidenceCard>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                      <EvidenceCard title="False Positive Checks">
                        <BulletList items={selectedEvidenceView.summary.false_positive_checks} />
                      </EvidenceCard>
                      <EvidenceCard title="Remediation">
                        <BulletList items={selectedEvidenceView.summary.remediation} />
                      </EvidenceCard>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                      <EvidenceCard title="Parsed Request">
                        <div className="grid grid-cols-2 gap-3 text-sm mb-3">
                          <div>
                            <div className="text-xs text-gray-500">Method</div>
                            <div className="font-mono">{selectedEvidenceView.parsed_request.method || '-'}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Path</div>
                            <div className="font-mono break-all">{selectedEvidenceView.parsed_request.path || selectedEvidenceView.parsed_request.target || '-'}</div>
                          </div>
                        </div>
                        {Object.keys(selectedEvidenceView.parsed_request.query || {}).length > 0 && (
                          <div className="mb-3">
                            <div className="text-xs text-gray-500 mb-1">Query Parameters</div>
                            <CodeBlock value={selectedEvidenceView.parsed_request.query} tone="slate" maxHeight="max-h-36" />
                          </div>
                        )}
                        {selectedEvidenceView.parsed_request.body && (
                          <div className="mb-3">
                            <div className="text-xs text-gray-500 mb-1">Body</div>
                            <CodeBlock value={selectedEvidenceView.parsed_request.body} tone="slate" maxHeight="max-h-36" />
                          </div>
                        )}
                        <div className="text-xs text-gray-500 mb-1">Raw Request</div>
                        <CodeBlock value={selectedEvidenceView.parsed_request.raw || selectedFinding.request_raw || '-'} tone="green" maxHeight="max-h-40" />
                      </EvidenceCard>

                      <EvidenceCard title="Parsed Response">
                        <div className="grid grid-cols-2 gap-3 text-sm mb-3">
                          <div>
                            <div className="text-xs text-gray-500">Status</div>
                            <div className="font-mono">{selectedEvidenceView.parsed_response.status || '-'}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Key Values</div>
                            <div className="font-mono text-xs break-all">{formatUnknown(selectedEvidenceView.parsed_response.key_values)}</div>
                          </div>
                        </div>
                        <CodeBlock
                          value={selectedEvidenceView.parsed_response.body ?? selectedEvidenceView.parsed_response.body_text ?? '-'}
                          tone="amber"
                          maxHeight="max-h-56"
                        />
                      </EvidenceCard>
                    </div>

                    <EvidenceCard title="Workflow / Native Evidence">
                      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
                        <div className="p-3 bg-gray-50 rounded border border-gray-200">
                          <div className="text-xs text-gray-500">Target Step</div>
                          <div className="font-medium">{selectedEvidenceView.workflow.target_step ? `Step ${selectedEvidenceView.workflow.target_step}` : '-'}</div>
                        </div>
                        <div className="p-3 bg-gray-50 rounded border border-gray-200">
                          <div className="text-xs text-gray-500">Native API Runs</div>
                          <div className="font-medium">{selectedEvidenceView.workflow.native_api_test_run_ids.length}</div>
                        </div>
                        <div className="p-3 bg-gray-50 rounded border border-gray-200">
                          <div className="text-xs text-gray-500">Native Workflows</div>
                          <div className="font-medium">{selectedEvidenceView.workflow.native_workflow_ids.length}</div>
                        </div>
                      </div>
                      {selectedEvidenceView.workflow.nodes.length > 0 ? (
                        <div className="space-y-2">
                          {selectedEvidenceView.workflow.nodes.map((node) => (
                            <div key={`${node.index}-${node.path}`} className={`p-3 rounded border ${node.is_target ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-semibold text-gray-500">Step {node.index}</span>
                                <span className="font-mono text-sm">{node.method} {node.path}</span>
                                {node.is_target && <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 text-xs">target action</span>}
                                {node.kind && <span className="px-2 py-0.5 rounded bg-white text-gray-600 text-xs">{node.kind}</span>}
                              </div>
                              {node.reason && <div className="text-xs text-gray-600 mt-1">{node.reason}</div>}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-gray-500">No workflow stages captured for this finding.</p>
                      )}
                    </EvidenceCard>

                    <EvidenceCard title="Finding Assistant">
                      <div className="flex flex-wrap gap-2 mb-4">
                        {([
                          ['explain', '为什么是漏洞'],
                          ['false_positive', '可能误报吗'],
                          ['attack_path', '攻击路径'],
                          ['remediation', '怎么修'],
                        ] as Array<[AssistantMode, string]>).map(([mode, label]) => (
                          <Button
                            key={mode}
                            size="sm"
                            variant={assistantMode === mode ? 'primary' : 'secondary'}
                            loading={assistantLoading && assistantMode === mode}
                            onClick={() => askAssistant(mode)}
                          >
                            <Bot size={14} className="mr-1" />
                            {label}
                          </Button>
                        ))}
                      </div>
                      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-2 mb-4">
                        <Input
                          value={assistantQuestion}
                          onChange={(e) => setAssistantQuestion(e.target.value)}
                          placeholder="Ask a custom question about this finding"
                          className="mb-0"
                        />
                        <Button
                          variant="secondary"
                          loading={assistantLoading && assistantMode === 'custom_question'}
                          onClick={() => askAssistant('custom_question')}
                          disabled={!assistantQuestion.trim()}
                        >
                          <MessageSquare size={16} className="mr-2" />
                          Ask
                        </Button>
                      </div>
                      {assistantResult ? (
                        <div className="space-y-4 border border-blue-200 bg-blue-50 rounded-lg p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-blue-950">AI Assistant</span>
                            {assistantResult.cached && <span className="text-xs bg-white text-blue-700 px-2 py-0.5 rounded">cached</span>}
                            {assistantResult.provider_used && <span className="text-xs bg-white text-blue-700 px-2 py-0.5 rounded">{assistantResult.provider_used.model}</span>}
                          </div>
                          <p className="text-sm text-blue-950">{assistantResult.answer.summary}</p>
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <div>
                              <div className="text-sm font-medium text-blue-950 mb-2">Why vulnerable</div>
                              <BulletList items={assistantResult.answer.why_vulnerable} />
                            </div>
                            <div>
                              <div className="text-sm font-medium text-blue-950 mb-2">False positive checks</div>
                              <BulletList items={assistantResult.answer.false_positive_checks} />
                            </div>
                            <div>
                              <div className="text-sm font-medium text-blue-950 mb-2">Attack path</div>
                              <BulletList items={assistantResult.answer.attack_path} />
                            </div>
                            <div>
                              <div className="text-sm font-medium text-blue-950 mb-2">Remediation</div>
                              <BulletList items={assistantResult.answer.remediation} />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-gray-500">Choose a prompt above to explain this finding in plain language. If no AI provider is available, the local evidence explanation is still returned.</p>
                      )}
                    </EvidenceCard>
                  </>
                )}
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <div className="p-3 bg-gray-50 rounded-lg">
                <span className="text-sm text-gray-500">Severity</span>
                <p className={`font-medium ${
                  selectedFinding.severity === 'critical' ? 'text-red-600' :
                  selectedFinding.severity === 'high' ? 'text-orange-600' :
                  selectedFinding.severity === 'medium' ? 'text-yellow-600' : 'text-blue-600'
                }`}>
                  {selectedFinding.severity}
                </p>
              </div>
              <div className="p-3 bg-gray-50 rounded-lg">
                <span className="text-sm text-gray-500">Status</span>
                <p className="font-medium">{selectedFinding.status.replace('_', ' ')}</p>
              </div>
              <div className="p-3 bg-gray-50 rounded-lg">
                <span className="text-sm text-gray-500">Response Code</span>
                <p className="font-medium">{selectedFinding.response_status || '-'}</p>
              </div>
            </div>

            {selectedFinding.variable_values && Object.keys(selectedFinding.variable_values).length > 0 && (
              <div className="border border-gray-200 rounded-lg p-4">
                <h4 className="font-semibold mb-3">Variable Values Used</h4>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(selectedFinding.variable_values).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                      <span className="text-sm font-medium text-gray-600">{key}:</span>
                      <span className="text-sm font-mono">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(selectedFinding.attacker_account_id || selectedFinding.victim_account_ids?.length) && (
              <div className="border border-amber-200 rounded-lg p-4 bg-amber-50/50">
                <h4 className="font-semibold mb-3 flex items-center gap-2 text-amber-800">
                  <Users size={18} />
                  Account Context (IDOR/Privilege Escalation Test)
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  {selectedFinding.attacker_account_id && (
                    <div className="p-3 bg-white rounded border border-amber-200">
                      <div className="flex items-center gap-2 mb-1">
                        <Target size={16} className="text-red-600" />
                        <span className="text-sm font-medium text-gray-700">Attacker Account</span>
                      </div>
                      <span className="text-sm font-mono text-gray-600">
                        {selectedFinding.attacker_account_id.substring(0, 8)}...
                      </span>
                    </div>
                  )}
                  {selectedFinding.victim_account_ids && selectedFinding.victim_account_ids.length > 0 && (
                    <div className="p-3 bg-white rounded border border-amber-200">
                      <div className="flex items-center gap-2 mb-1">
                        <Users size={16} className="text-blue-600" />
                        <span className="text-sm font-medium text-gray-700">Victim Account(s)</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {selectedFinding.victim_account_ids.map((id, i) => (
                          <span key={i} className="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded">
                            {id.substring(0, 8)}...
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {hasBaselineComparison(selectedFinding) && (
              <div className="border border-teal-200 rounded-lg overflow-hidden">
                <div className="bg-teal-50 p-3 border-b border-teal-200">
                  <h4 className="font-semibold flex items-center gap-2 text-teal-800">
                    <GitCompare size={18} />
                    Baseline Comparison
                  </h4>
                  <p className="text-xs text-teal-600 mt-1">
                    Compares attacker accessing own resources (baseline) vs attacker accessing victim resources (mutated)
                  </p>
                </div>
                <div className="flex border-b border-teal-200">
                  {(['baseline', 'mutated', 'diff'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setBaselineViewTab(tab)}
                      className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                        baselineViewTab === tab
                          ? 'bg-teal-100 text-teal-800 border-b-2 border-teal-600'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {tab === 'baseline' && 'Baseline (Own Data)'}
                      {tab === 'mutated' && 'Mutated (Victim Data)'}
                      {tab === 'diff' && 'Differences'}
                    </button>
                  ))}
                </div>
                <div className="p-4 bg-white">
                  {baselineViewTab === 'baseline' && (
                    <div>
                      {(() => {
                        const truncationCheck = checkHeadersTruncated(selectedFinding.baseline_response);
                        return (
                          <>
                            {truncationCheck.truncated && (
                              <div className="mb-3 p-2 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800">
                                <AlertTriangle size={14} className="inline mr-1" />
                                Headers truncated due to size limit
                                {truncationCheck.reason && ` (${truncationCheck.reason})`}
                              </div>
                            )}
                            {selectedFinding.baseline_response ? (
                              <pre className="text-xs bg-gray-900 text-green-400 p-3 rounded overflow-x-auto max-h-64">
                                {typeof selectedFinding.baseline_response === 'string'
                                  ? selectedFinding.baseline_response
                                  : JSON.stringify(selectedFinding.baseline_response, null, 2)}
                              </pre>
                            ) : (
                              <p className="text-gray-500 text-sm text-center py-4">No baseline response captured</p>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                  {baselineViewTab === 'mutated' && (
                    <div>
                      {(() => {
                        const truncationCheck = checkHeadersTruncated(selectedFinding.mutated_response);
                        return (
                          <>
                            {truncationCheck.truncated && (
                              <div className="mb-3 p-2 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800">
                                <AlertTriangle size={14} className="inline mr-1" />
                                Headers truncated due to size limit
                                {truncationCheck.reason && ` (${truncationCheck.reason})`}
                              </div>
                            )}
                            {selectedFinding.mutated_response ? (
                              <pre className="text-xs bg-gray-900 text-amber-400 p-3 rounded overflow-x-auto max-h-64">
                                {typeof selectedFinding.mutated_response === 'string'
                                  ? selectedFinding.mutated_response
                                  : JSON.stringify(selectedFinding.mutated_response, null, 2)}
                              </pre>
                            ) : (
                              <p className="text-gray-500 text-sm text-center py-4">No mutated response captured</p>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                  {baselineViewTab === 'diff' && (
                    <div>
                      {selectedFinding.response_diff ? (
                        <pre className="text-xs bg-gray-900 text-red-400 p-3 rounded overflow-x-auto max-h-64">
                          {formatJsonDiff(selectedFinding.response_diff)}
                        </pre>
                      ) : (
                        <p className="text-gray-500 text-sm text-center py-4">No differences detected or diff not computed</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {selectedFinding.source_type === 'workflow' && selectedFinding.mutated_response?.steps && (
              <div className="border border-gray-200 rounded-lg p-4">
                <h4 className="font-semibold mb-3">Workflow Steps</h4>
                <div className="space-y-2">
                  {selectedFinding.mutated_response.steps.map((step: any, idx: number) => (
                    <div key={idx} className="p-3 bg-gray-50 rounded-lg">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">Step {step.step_order}</span>
                        <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                          step.status >= 200 && step.status < 300
                            ? 'bg-green-100 text-green-800'
                            : step.status >= 400
                              ? 'bg-red-100 text-red-800'
                              : 'bg-gray-100 text-gray-800'
                        }`}>
                          {step.status}
                        </span>
                      </div>
                      <pre className="text-xs text-gray-600 mt-2 overflow-x-auto">
                        {step.body?.substring(0, 200)}...
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedFinding.request_raw && (
              <div className="border border-gray-200 rounded-lg p-4">
                <div className="flex justify-between items-center mb-3">
                  <h4 className="font-semibold">Request</h4>
                  <button
                    onClick={() => copyToClipboard(selectedFinding.request_raw!, 'request')}
                    className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
                  >
                    {copiedField === 'request' ? <Check size={14} /> : <Copy size={14} />}
                    {copiedField === 'request' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="text-xs bg-gray-900 text-green-400 p-3 rounded overflow-x-auto max-h-48">
                  {selectedFinding.request_raw}
                </pre>
              </div>
            )}

            {selectedFinding.response_body && (
              <div className="border border-gray-200 rounded-lg p-4">
                <div className="flex justify-between items-center mb-3">
                  <h4 className="font-semibold">Response Body</h4>
                  <button
                    onClick={() => copyToClipboard(selectedFinding.response_body!, 'response')}
                    className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
                  >
                    {copiedField === 'response' ? <Check size={14} /> : <Copy size={14} />}
                    {copiedField === 'response' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="text-xs bg-gray-900 text-green-400 p-3 rounded overflow-x-auto max-h-64">
                  {selectedFinding.response_body}
                </pre>
              </div>
            )}

            {selectedFinding.response_headers && Object.keys(selectedFinding.response_headers).length > 0 && (
              <div className="border border-gray-200 rounded-lg p-4">
                <h4 className="font-semibold mb-3">Response Headers</h4>
                <div className="text-xs bg-gray-50 p-3 rounded max-h-32 overflow-y-auto">
                  {Object.entries(selectedFinding.response_headers).map(([key, value]) => (
                    <div key={key} className="py-1">
                      <span className="font-medium text-gray-700">{key}:</span>{' '}
                      <span className="text-gray-600">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="border border-gray-200 rounded-lg p-4">
              <h4 className="font-semibold mb-3">Notes</h4>
              <TextArea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add investigation notes..."
                rows={3}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSaveNotes}
                className="mt-2"
              >
                Save Notes
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isSuppressionModalOpen}
        onClose={() => setIsSuppressionModalOpen(false)}
        title="Suppression Rules Management"
        size="xl"
      >
        <SuppressionRulesManager
          rules={suppressionRules}
          onUpdate={() => {
            loadSuppressionRules();
            loadFindings();
          }}
        />
      </Modal>
    </div>
  );
}
