import { useEffect, useState } from 'react';
import { AlertTriangle, Eye, Trash2, CheckCircle, XCircle, RefreshCw, Copy, Check, Filter, Settings, X, Users, Target, GitCompare } from 'lucide-react';
import { Table } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { Button, TextArea, Input, Select } from '../components/ui/Form';
import { SuppressionRulesManager } from '../components/SuppressionRulesManager';
import { findingsService, suppressionRulesService, apiTemplatesService, workflowsService, testRunsService } from '../lib/api-service';
import type { Finding, FindingSuppressionRule, ApiTemplate, Workflow, TestRun } from '../types';

type FindingTab = 'test_run' | 'workflow';

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
  const [suppressionRules, setSuppressionRules] = useState<FindingSuppressionRule[]>([]);
  const [apiTemplates, setApiTemplates] = useState<ApiTemplate[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [testRuns, setTestRuns] = useState<TestRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isSuppressionModalOpen, setIsSuppressionModalOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [activeTab, setActiveTab] = useState<FindingTab>('test_run');
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [testRunFilters, setTestRunFilters] = useState<TestRunFilters>({});
  const [workflowFilters, setWorkflowFilters] = useState<WorkflowFilters>({});
  const [baselineViewTab, setBaselineViewTab] = useState<BaselineViewTab['type']>('diff');

  useEffect(() => {
    loadFindings();
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

    if (tab && (tab === 'test_run' || tab === 'workflow')) {
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
    } catch (error) {
      console.error('Failed to load findings:', error);
    } finally {
      setLoading(false);
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
    if (!confirm('Delete this finding?')) return;
    try {
      await findingsService.delete(id);
      setFindings(findings.filter((f) => f.id !== id));
    } catch (error) {
      console.error('Failed to delete finding:', error);
    }
  };

  const handleViewDetails = (finding: Finding) => {
    setSelectedFinding(finding);
    setNotes(finding.notes || '');
    setIsDetailModalOpen(true);
  };

  const handleUpdateStatus = async (id: string, status: Finding['status']) => {
    try {
      const updated = await findingsService.update(id, { status, notes });
      setFindings(findings.map((f) => (f.id === id ? updated : f)));
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
    } catch (error) {
      console.error('Failed to save notes:', error);
    }
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
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

    if (activeTab === 'test_run') {
      return applyTestRunFilters(f);
    } else {
      return applyWorkflowFilters(f);
    }
  });

  const clearFilters = () => {
    if (activeTab === 'test_run') {
      setTestRunFilters({});
    } else {
      setWorkflowFilters({});
    }
  };

  const hasActiveFilters = () => {
    if (activeTab === 'test_run') {
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
            onClick={() => handleViewDetails(row)}
            className="p-1 hover:bg-blue-100 rounded text-blue-600"
          >
            <Eye size={16} />
          </button>
          <button
            onClick={() => handleDelete(row.id)}
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
            onClick={() => handleViewDetails(row)}
            className="p-1 hover:bg-blue-100 rounded text-blue-600"
          >
            <Eye size={16} />
          </button>
          <button
            onClick={() => handleDelete(row.id)}
            className="p-1 hover:bg-red-100 rounded text-red-600"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  const newFindings = filteredFindings.filter(f => f.status === 'new');
  const confirmedFindings = filteredFindings.filter(f => f.status === 'confirmed');

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Findings</h1>
          <p className="text-gray-600 mt-1">Review discovered security vulnerabilities</p>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex gap-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-blue-600">{newFindings.length}</p>
              <p className="text-xs text-gray-600">New</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-red-600">{confirmedFindings.length}</p>
              <p className="text-xs text-gray-600">Confirmed</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-400">{filteredFindings.length}</p>
              <p className="text-xs text-gray-600">Total</p>
            </div>
          </div>
          <Button variant="secondary" onClick={loadFindings}>
            <RefreshCw size={18} className="mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex gap-2 border-b border-gray-200">
          <button
            onClick={() => setActiveTab('test_run')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'test_run'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            API Findings
            <span className="ml-2 px-2 py-0.5 text-xs bg-gray-100 rounded">
              {findings.filter(f => f.source_type === 'test_run' && (!f.is_suppressed || showSuppressed)).length}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('workflow')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'workflow'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Workflow Findings
            <span className="ml-2 px-2 py-0.5 text-xs bg-gray-100 rounded">
              {findings.filter(f => f.source_type === 'workflow' && (!f.is_suppressed || showSuppressed)).length}
            </span>
          </button>
        </div>

        <div className="flex items-center gap-4">
          <Button variant="secondary" size="sm" onClick={() => setShowFilters(!showFilters)}>
            <Filter size={16} className="mr-2" />
            Filters {hasActiveFilters() && `(${Object.keys(activeTab === 'test_run' ? testRunFilters : workflowFilters).length})`}
          </Button>
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showSuppressed}
              onChange={(e) => setShowSuppressed(e.target.checked)}
              className="rounded"
            />
            Show suppressed ({findings.filter(f => f.is_suppressed).length})
          </label>
          <Button variant="secondary" size="sm" onClick={() => setIsSuppressionModalOpen(true)}>
            <Settings size={16} className="mr-2" />
            Suppression Rules ({suppressionRules.filter(r => r.is_enabled).length} active)
          </Button>
        </div>
      </div>

      {showFilters && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-semibold text-gray-900">
              {activeTab === 'test_run' ? 'API Findings Filters' : 'Workflow Findings Filters'}
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
            <div className="grid grid-cols-4 gap-4">
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
          ) : (
            <div className="grid grid-cols-4 gap-4">
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
          )}
        </div>
      )}

      {filteredFindings.length === 0 && !loading && (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <AlertTriangle size={48} className="mx-auto text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            No {activeTab === 'test_run' ? 'API' : 'Workflow'} Findings Yet
          </h3>
          <p className="text-gray-600">
            Run {activeTab === 'test_run' ? 'API template tests' : 'workflow tests'} to discover potential vulnerabilities.
          </p>
        </div>
      )}

      {filteredFindings.length > 0 && (
        <Table
          columns={activeTab === 'test_run' ? testRunColumns : workflowColumns}
          data={filteredFindings}
          loading={loading}
          onRowClick={handleViewDetails}
        />
      )}

      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title="Finding Details"
        size="xl"
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
                <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                  selectedFinding.source_type === 'test_run'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-purple-100 text-purple-700'
                }`}>
                  {selectedFinding.source_type === 'test_run' ? 'API Finding' : 'Workflow Finding'}
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
