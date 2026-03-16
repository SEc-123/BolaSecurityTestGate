import { useEffect, useState, useCallback } from 'react';
import { Play, Eye, Trash2, RefreshCw, CheckCircle, XCircle, Clock, AlertTriangle, GitBranch, FileText, AlertCircle, Package } from 'lucide-react';
import { Table } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { Button, Input, Select } from '../components/ui/Form';
import {
  testRunsService,
  apiTemplatesService,
  accountsService,
  environmentsService,
  workflowsService,
  executionService,
  securitySuitesService,
} from '../lib/api-service';
import type { TestRun, ApiTemplate, Account, Environment, Workflow } from '../types';
import type { SecuritySuite, SecuritySuiteBundle } from '../lib/api-client';

interface TestRunProgressExtended {
  total: number;
  completed: number;
  findings: number;
  current_template?: string;
  current_variable?: string;
  current_step?: number;
}

interface TestRunWithDetails extends TestRun {
  progress?: TestRunProgressExtended;
  error_message?: string;
  errors_count?: number;
  has_execution_error?: boolean;
}

type ExecutionMode = 'template' | 'workflow';

interface TestRunsProps {
  focusRunId?: string;
  onRunFocusHandled?: () => void;
  onNavigateToFindings?: (params?: {
    tab?: 'test_run' | 'workflow';
    test_run_id?: string;
    template_id?: string;
    workflow_id?: string;
  }) => void;
}

export function TestRuns({ focusRunId, onRunFocusHandled, onNavigateToFindings }: TestRunsProps) {
  const [testRuns, setTestRuns] = useState<TestRunWithDetails[]>([]);
  const [templates, setTemplates] = useState<ApiTemplate[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [securitySuites, setSecuritySuites] = useState<SecuritySuite[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<TestRunWithDetails | null>(null);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('template');
  const [selectedSuiteId, setSelectedSuiteId] = useState('');
  const [selectedSuiteBundle, setSelectedSuiteBundle] = useState<SecuritySuiteBundle | null>(null);
  const [selectedSuiteWorkflowId, setSelectedSuiteWorkflowId] = useState('');
  const [suiteLoading, setSuiteLoading] = useState(false);
  const [suiteError, setSuiteError] = useState<string | null>(null);

  const [formData, setFormData] = useState<{
    name: string;
    template_ids: string[];
    account_ids: string[];
    environment_id: string;
    workflow_id: string;
  }>({
    name: '',
    template_ids: [],
    account_ids: [],
    environment_id: '',
    workflow_id: '',
  });

  const loadData = useCallback(async () => {
    try {
      const [runsData, templatesData, accountsData, envsData, workflowsData, suitesData] = await Promise.all([
        testRunsService.list(),
        apiTemplatesService.list(),
        accountsService.list(),
        environmentsService.list(),
        workflowsService.list(),
        securitySuitesService.list(),
      ]);
      setTestRuns(runsData as TestRunWithDetails[]);
      setTemplates(templatesData);
      setAccounts(accountsData);
      setEnvironments(envsData);
      setWorkflows(workflowsData);
      setSecuritySuites((suitesData || []).filter(suite => suite.is_enabled));
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!focusRunId || testRuns.length === 0) {
      return;
    }

    const targetRun = testRuns.find((run) => run.id === focusRunId);
    if (!targetRun) {
      return;
    }

    setSelectedRun(targetRun);
    setIsDetailModalOpen(true);
    onRunFocusHandled?.();
  }, [focusRunId, onRunFocusHandled, testRuns]);

  useEffect(() => {
    const runningRuns = testRuns.filter(r => r.status === 'running');
    if (runningRuns.length === 0) return;

    const interval = setInterval(async () => {
      const updatedRuns = await testRunsService.list();
      setTestRuns(updatedRuns as TestRunWithDetails[]);

      const stillRunning = updatedRuns.some(r => r.status === 'running');
      if (!stillRunning) {
        clearInterval(interval);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [testRuns]);

  const handleOpenModal = () => {
    const activeEnv = environments.find(e => e.is_active);
    const defaultEnv = activeEnv || environments[0];
    setFormData({
      name: '',
      template_ids: [],
      account_ids: [],
      environment_id: defaultEnv?.id || '',
      workflow_id: '',
    });
    setSelectedSuiteId('');
    setSelectedSuiteBundle(null);
    setSelectedSuiteWorkflowId('');
    setSuiteLoading(false);
    setSuiteError(null);
    setIsModalOpen(true);
  };

  const handleSuiteSelection = async (suiteId: string) => {
    setSelectedSuiteId(suiteId);
    setSelectedSuiteBundle(null);
    setSelectedSuiteWorkflowId('');
    setSuiteError(null);

    if (!suiteId) {
      return;
    }

    setSuiteLoading(true);
    try {
      const bundle = await securitySuitesService.getBundle(suiteId);
      setSelectedSuiteBundle(bundle);

      if (!bundle.summary.available_execution_modes.includes(executionMode)) {
        setExecutionMode(bundle.summary.available_execution_modes[0] || 'template');
      }

      if (bundle.workflows.length === 1) {
        setSelectedSuiteWorkflowId(bundle.workflows[0].id);
      }
    } catch (error: any) {
      console.error('Failed to load suite bundle:', error);
      setSuiteError(error.message || 'Failed to load suite bundle');
    } finally {
      setSuiteLoading(false);
    }
  };

  const handleExecuteTemplateTest = async () => {
    if (formData.template_ids.length === 0) {
      alert('Please select at least one API template');
      return;
    }

    if (!formData.environment_id) {
      alert('Please select an environment. Environment is required to avoid misconfigured test runs.');
      return;
    }

    setExecuting(true);
    try {
      const newRun = await testRunsService.create({
        name: formData.name || `Test Run ${new Date().toLocaleString()}`,
        status: 'pending',
        execution_type: 'template',
        template_ids: formData.template_ids,
        account_ids: formData.account_ids,
        environment_id: formData.environment_id || undefined,
        rule_ids: [],
        execution_params: {},
        progress_percent: 0,
        started_at: new Date().toISOString(),
      });

      setTestRuns([newRun as TestRunWithDetails, ...testRuns]);
      setIsModalOpen(false);
      resetForm();

      await executionService.executeTemplate({
        test_run_id: newRun.id,
        template_ids: formData.template_ids,
        account_ids: formData.account_ids.length > 0 ? formData.account_ids : undefined,
        environment_id: formData.environment_id || undefined,
      });

      await loadData();
    } catch (error: any) {
      console.error('Test execution failed:', error);
      alert(`Test execution failed: ${error.message}`);
    } finally {
      setExecuting(false);
    }
  };

  const handleExecuteWorkflowTest = async () => {
    if (!formData.workflow_id) {
      alert('Please select a workflow');
      return;
    }

    if (!formData.environment_id) {
      alert('Please select an environment. Environment is required to avoid misconfigured test runs.');
      return;
    }

    setExecuting(true);
    try {
      const workflow = workflows.find(w => w.id === formData.workflow_id);

      const newRun = await testRunsService.create({
        name: formData.name || `Workflow: ${workflow?.name || 'Unknown'} - ${new Date().toLocaleString()}`,
        status: 'pending',
        execution_type: 'workflow',
        workflow_id: formData.workflow_id,
        template_ids: [],
        account_ids: formData.account_ids,
        environment_id: formData.environment_id || undefined,
        rule_ids: [],
        execution_params: {},
        progress_percent: 0,
        started_at: new Date().toISOString(),
      });

      setTestRuns([newRun as TestRunWithDetails, ...testRuns]);
      setIsModalOpen(false);
      resetForm();

      await executionService.executeWorkflow({
        test_run_id: newRun.id,
        workflow_id: formData.workflow_id,
        account_ids: formData.account_ids.length > 0 ? formData.account_ids : undefined,
        environment_id: formData.environment_id || undefined,
      });

      await loadData();
    } catch (error: any) {
      console.error('Workflow execution failed:', error);
      alert(`Workflow execution failed: ${error.message}`);
    } finally {
      setExecuting(false);
    }
  };

  const handleExecuteSuite = async () => {
    if (!selectedSuiteId) return;

    if (!selectedSuiteBundle) {
      alert('Suite details are still loading. Please wait a moment and try again.');
      return;
    }

    if (!selectedSuiteBundle.environment?.id) {
      alert('This suite does not have a valid environment configured.');
      return;
    }

    if (executionMode === 'workflow' && selectedSuiteBundle.workflows.length > 1 && !selectedSuiteWorkflowId) {
      alert('Please select which workflow from the suite should run.');
      return;
    }

    setExecuting(true);
    try {
      await executionService.executeSuite({
        suite_id: selectedSuiteId,
        execution_mode: executionMode,
        workflow_id: executionMode === 'workflow' ? selectedSuiteWorkflowId || undefined : undefined,
        name: formData.name || undefined,
      });

      setIsModalOpen(false);
      resetForm();
      setSelectedSuiteId('');
      setSelectedSuiteBundle(null);
      setSelectedSuiteWorkflowId('');
      setSuiteError(null);
      await loadData();
    } catch (error: any) {
      console.error('Suite execution failed:', error);
      alert(`Suite execution failed: ${error.message}`);
    } finally {
      setExecuting(false);
    }
  };

  const handleExecute = () => {
    if (selectedSuiteId) {
      handleExecuteSuite();
      return;
    }

    if (executionMode === 'template') {
      handleExecuteTemplateTest();
    } else {
      handleExecuteWorkflowTest();
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this test run?')) return;
    try {
      await testRunsService.delete(id);
      setTestRuns(testRuns.filter((r) => r.id !== id));
    } catch (error) {
      console.error('Failed to delete test run:', error);
    }
  };

  const handleViewDetails = (run: TestRunWithDetails) => {
    setSelectedRun(run);
    setIsDetailModalOpen(true);
  };

  const handleRunExisting = async (run: TestRunWithDetails) => {
    if (run.status === 'running') {
      return;
    }

    setExecuting(true);
    try {
      if ((run.execution_type || 'template') === 'workflow' && run.workflow_id) {
        await executionService.executeWorkflow({
          test_run_id: run.id,
          workflow_id: run.workflow_id,
          account_ids: run.account_ids?.length ? run.account_ids : undefined,
          environment_id: run.environment_id,
        });
      } else {
        const templateIds = run.template_ids || [];
        if (templateIds.length === 0) {
          throw new Error('This test run does not have any templates attached.');
        }

        await executionService.executeTemplate({
          test_run_id: run.id,
          template_ids: templateIds,
          account_ids: run.account_ids?.length ? run.account_ids : undefined,
          environment_id: run.environment_id,
        });
      }

      await loadData();
      alert(`Test run "${run.name || run.id}" has started.`);
    } catch (error: any) {
      console.error('Failed to execute formal test run:', error);
      alert(`Failed to execute formal test run: ${error.message || 'Unknown error'}`);
    } finally {
      setExecuting(false);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      template_ids: [],
      account_ids: [],
      environment_id: '',
      workflow_id: '',
    });
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle size={16} className="text-green-500" />;
      case 'running':
        return <RefreshCw size={16} className="text-blue-500 animate-spin" />;
      case 'failed':
        return <XCircle size={16} className="text-red-500" />;
      default:
        return <Clock size={16} className="text-gray-400" />;
    }
  };

  const templatesWithPatterns = templates.filter(t =>
    t.failure_patterns && Array.isArray(t.failure_patterns) && t.failure_patterns.length > 0
  );

  const activeWorkflows = workflows.filter(w => w.is_active);
  const suiteSupportsTemplate = !selectedSuiteBundle || selectedSuiteBundle.summary.available_execution_modes.includes('template');
  const suiteSupportsWorkflow = !selectedSuiteBundle || selectedSuiteBundle.summary.available_execution_modes.includes('workflow');
  const selectedSuiteInfo = selectedRun?.execution_params?.security_suite;
  const selectedRecordingPromotion = selectedRun?.execution_params?.recording_promotion;
  const canStartSuiteRun = !selectedSuiteId || (
    !!selectedSuiteBundle &&
    !!selectedSuiteBundle.environment?.id &&
    !suiteLoading &&
    !suiteError &&
    selectedSuiteBundle.summary.available_execution_modes.includes(executionMode) &&
    (executionMode !== 'workflow' || selectedSuiteBundle.workflows.length <= 1 || !!selectedSuiteWorkflowId)
  );

  const columns = [
    {
      key: 'name' as const,
      label: 'Name',
      render: (value: string) => value || 'Unnamed Run',
    },
    {
      key: 'execution_type' as const,
      label: 'Type',
      render: (value: string) => (
        <span className={`px-2 py-1 text-xs font-medium rounded ${
          value === 'workflow' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
        }`}>
          {value === 'workflow' ? 'Workflow' : 'Template'}
        </span>
      ),
    },
    {
      key: 'status' as const,
      label: 'Status',
      render: (value: string) => (
        <div className="flex items-center gap-2">
          {getStatusIcon(value)}
          <span
            className={`px-2 py-1 text-xs font-medium rounded ${
              value === 'completed'
                ? 'bg-green-100 text-green-800'
                : value === 'running'
                  ? 'bg-blue-100 text-blue-800'
                  : value === 'failed'
                    ? 'bg-red-100 text-red-800'
                    : 'bg-gray-100 text-gray-800'
            }`}
          >
            {value}
          </span>
        </div>
      ),
    },
    {
      key: 'progress_percent' as const,
      label: 'Progress',
      render: (value: number) => (
        <div className="flex items-center gap-2">
          <div className="w-24 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${value}%` }}
            />
          </div>
          <span className="text-sm text-gray-600">{value}%</span>
        </div>
      ),
    },
    {
      key: 'progress' as const,
      label: 'Findings',
      render: (value: TestRunProgressExtended | undefined) => (
        <div className="flex items-center gap-1">
          {value?.findings && value.findings > 0 ? (
            <>
              <AlertTriangle size={14} className="text-amber-500" />
              <span className="text-amber-600 font-medium">{value.findings}</span>
            </>
          ) : (
            <span className="text-gray-400">-</span>
          )}
        </div>
      ),
    },
    {
      key: 'errors_count' as const,
      label: 'Errors',
      render: (_: number | undefined, row: TestRunWithDetails) => {
        const errCount = row.errors_count || 0;
        const hasExecError = row.has_execution_error;

        if (errCount > 0 || hasExecError) {
          return (
            <div className="flex items-center gap-1">
              <AlertCircle size={14} className="text-red-500" />
              <span className="text-red-600 font-medium">
                {errCount > 0 ? errCount : 'Error'}
              </span>
            </div>
          );
        }
        return <span className="text-gray-400">-</span>;
      },
    },
    {
      key: 'created_at' as const,
      label: 'Created',
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      key: 'source_recording_session_id' as const,
      label: 'Origin',
      render: (_: string | undefined, row: TestRunWithDetails) => {
        const recordingId =
          row.source_recording_session_id ||
          row.execution_params?.recording_promotion?.source_recording_session_id;
        const draftId = row.execution_params?.recording_promotion?.source_draft_id;

        if (!recordingId && !draftId) {
          return <span className="text-gray-400">Manual</span>;
        }

        return (
          <div className="space-y-1 text-xs">
            {recordingId && <div className="font-medium text-indigo-700">Recording {recordingId}</div>}
            {draftId && <div className="text-gray-500">Draft {draftId}</div>}
          </div>
        );
      },
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: TestRunWithDetails) => (
        <div className="flex gap-2">
          {row.status === 'pending' && (
            <button
              onClick={() => void handleRunExisting(row)}
              className="p-1 hover:bg-emerald-100 rounded text-emerald-600"
              title="Run Test"
            >
              <Play size={16} />
            </button>
          )}
          <button
            onClick={() => handleViewDetails(row)}
            className="p-1 hover:bg-blue-100 rounded text-blue-600"
            title="View Details"
          >
            <Eye size={16} />
          </button>
          <button
            onClick={() => handleDelete(row.id)}
            className="p-1 hover:bg-red-100 rounded text-red-600"
            disabled={row.status === 'running'}
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Test Runs</h1>
          <p className="text-gray-600 mt-1">Execute formal template and workflow runs, then monitor execution results here.</p>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={loadData}>
            <RefreshCw size={18} className="mr-2" />
            Refresh
          </Button>
          <Button onClick={handleOpenModal} size="lg">
            <Play size={20} className="mr-2" />
            New Test Run
          </Button>
        </div>
      </div>

      {templatesWithPatterns.length === 0 && templates.length > 0 && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-amber-500 mt-0.5" size={20} />
            <div>
              <p className="font-medium text-amber-800">No API Templates with Failure Patterns</p>
              <p className="text-sm text-amber-700 mt-1">
                Configure failure patterns in your API Templates to enable vulnerability detection.
              </p>
            </div>
          </div>
        </div>
      )}

      <Table columns={columns} data={testRuns} loading={loading} />

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Create Test Run"
        size="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleExecute} disabled={executing || !canStartSuiteRun}>
              {executing ? (
                <>
                  <RefreshCw size={18} className="mr-2 animate-spin" />
                  Executing...
                </>
              ) : (
                <>
                  <Play size={18} className="mr-2" />
                  {selectedSuiteId ? 'Start Suite Run' : 'Start Test'}
                </>
              )}
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          <Select
            label="Security Suite (Optional)"
            value={selectedSuiteId}
            onChange={(e) => handleSuiteSelection(e.target.value)}
            options={[
              { value: '', label: 'Manual configuration (no suite)' },
              ...securitySuites.map((suite) => ({
                value: suite.id,
                label: suite.name,
              })),
            ]}
          />

          {suiteLoading && (
            <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-700">
              <RefreshCw size={16} className="animate-spin" />
              Loading suite bundle...
            </div>
          )}

          {suiteError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {suiteError}
            </div>
          )}

          {selectedSuiteBundle && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-indigo-900">
                    <Package size={18} />
                    <h3 className="font-semibold">{selectedSuiteBundle.suite.name}</h3>
                  </div>
                  <p className="mt-1 text-sm text-indigo-700">
                    Reuse the full saved bundle directly, including test accounts, checklists, and security rules.
                  </p>
                </div>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-indigo-700">
                  {selectedSuiteBundle.environment?.name || 'Environment missing'}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
                <div className="rounded-lg border border-indigo-100 bg-white p-3">
                  <p className="text-gray-500">Templates</p>
                  <p className="mt-1 font-semibold text-gray-900">{selectedSuiteBundle.summary.template_count}</p>
                </div>
                <div className="rounded-lg border border-indigo-100 bg-white p-3">
                  <p className="text-gray-500">Workflows</p>
                  <p className="mt-1 font-semibold text-gray-900">{selectedSuiteBundle.summary.workflow_count}</p>
                </div>
                <div className="rounded-lg border border-indigo-100 bg-white p-3">
                  <p className="text-gray-500">Accounts</p>
                  <p className="mt-1 font-semibold text-gray-900">{selectedSuiteBundle.summary.account_count}</p>
                </div>
                <div className="rounded-lg border border-indigo-100 bg-white p-3">
                  <p className="text-gray-500">Checklists</p>
                  <p className="mt-1 font-semibold text-gray-900">{selectedSuiteBundle.summary.checklist_count}</p>
                </div>
                <div className="rounded-lg border border-indigo-100 bg-white p-3">
                  <p className="text-gray-500">Security Rules</p>
                  <p className="mt-1 font-semibold text-gray-900">{selectedSuiteBundle.summary.security_rule_count}</p>
                </div>
              </div>

              {selectedSuiteBundle.warnings.length > 0 && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <p className="font-medium text-amber-800">Suite warnings</p>
                  <ul className="mt-2 space-y-1 text-sm text-amber-700">
                    {selectedSuiteBundle.warnings.map((warning) => (
                      <li key={warning}>- {warning}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 rounded-lg bg-gray-100 p-1">
            <button
              onClick={() => suiteSupportsTemplate && setExecutionMode('template')}
              disabled={!suiteSupportsTemplate}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                executionMode === 'template'
                  ? 'bg-white text-blue-600 shadow'
                  : 'text-gray-600 hover:text-gray-900'
              } ${!suiteSupportsTemplate ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <FileText size={18} />
              Template Test
            </button>
            <button
              onClick={() => suiteSupportsWorkflow && setExecutionMode('workflow')}
              disabled={!suiteSupportsWorkflow}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                executionMode === 'workflow'
                  ? 'bg-white text-purple-600 shadow'
                  : 'text-gray-600 hover:text-gray-900'
              } ${!suiteSupportsWorkflow ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <GitBranch size={18} />
              Workflow Test
            </button>
          </div>

          <Input
            label="Run Name (Optional)"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder={executionMode === 'template' ? 'e.g., IDOR Test - User APIs' : 'e.g., Login Flow Test'}
          />

          {selectedSuiteBundle ? (
            <>
              {executionMode === 'template' ? (
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <h4 className="mb-3 font-medium text-gray-900">Suite Templates</h4>
                  <div className="max-h-48 space-y-2 overflow-y-auto">
                    {selectedSuiteBundle.templates.map((template) => (
                      <div key={template.id} className="flex items-center justify-between rounded border border-gray-100 bg-gray-50 px-3 py-2 text-sm">
                        <span className="font-medium text-gray-800">{template.name}</span>
                        <span className="text-gray-500">{template.failure_patterns?.length || 0} patterns</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <Select
                    label="Suite Workflow"
                    value={selectedSuiteWorkflowId}
                    onChange={(e) => setSelectedSuiteWorkflowId(e.target.value)}
                    options={[
                      { value: '', label: selectedSuiteBundle.workflows.length > 1 ? 'Select workflow from suite...' : 'Suite workflow' },
                      ...selectedSuiteBundle.workflows.map((workflow) => ({
                        value: workflow.id,
                        label: workflow.name,
                      })),
                    ]}
                  />

                  <div className="rounded-lg border border-gray-200 bg-white p-4">
                    <h4 className="mb-3 font-medium text-gray-900">Suite Workflows</h4>
                    <div className="space-y-2">
                      {selectedSuiteBundle.workflows.map((workflow) => (
                        <div key={workflow.id} className="flex items-center justify-between rounded border border-gray-100 bg-gray-50 px-3 py-2 text-sm">
                          <span className="font-medium text-gray-800">{workflow.name}</span>
                          <span className="text-gray-500">{workflow.is_active ? 'Active' : 'Inactive'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                <h4 className="mb-2 font-medium text-blue-800">Suite Execution Context</h4>
                <div className="space-y-1 text-sm text-blue-700">
                  <p>Environment: {selectedSuiteBundle.environment?.name || 'Missing'}</p>
                  <p>Accounts: {selectedSuiteBundle.accounts.map(account => account.name).join(', ') || 'None'}</p>
                  <p>Checklists: {selectedSuiteBundle.checklists.map(checklist => checklist.name).join(', ') || 'None'}</p>
                  <p>Security Rules: {selectedSuiteBundle.security_rules.map(rule => rule.name).join(', ') || 'None'}</p>
                </div>
              </div>
            </>
          ) : (
            <>
              <Select
                label="Environment (Required)"
                value={formData.environment_id}
                onChange={(e) => setFormData({ ...formData, environment_id: e.target.value })}
                options={[
                  { value: '', label: environments.length > 0 ? 'Select environment... (required)' : 'No environments available' },
                  ...environments.filter(e => e.is_active).map((env) => ({
                    value: env.id,
                    label: `${env.name} (${env.base_url})`,
                  })),
                ]}
              />

              {executionMode === 'template' ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Select API Templates
                      {templatesWithPatterns.length > 0 && (
                        <span className="ml-2 font-normal text-gray-500">
                          ({templatesWithPatterns.length} with failure patterns)
                        </span>
                      )}
                    </label>
                    <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-300 p-3">
                      {templates.length === 0 ? (
                        <p className="text-sm text-gray-500">No API templates available</p>
                      ) : (
                        templates.map((template) => {
                          const hasPatterns = template.failure_patterns?.length > 0;
                          const variables = template.variables || [];
                          const method = template.parsed_structure?.method || 'GET';
                          return (
                            <label
                              key={template.id}
                              className={`mb-3 flex items-start rounded p-2 ${hasPatterns ? 'bg-green-50' : 'bg-gray-50'}`}
                            >
                              <input
                                type="checkbox"
                                checked={formData.template_ids.includes(template.id)}
                                onChange={(e) => {
                                  const ids = formData.template_ids;
                                  setFormData({
                                    ...formData,
                                    template_ids: e.target.checked
                                      ? [...ids, template.id]
                                      : ids.filter((id) => id !== template.id),
                                  });
                                }}
                                className="mt-0.5 h-4 w-4 rounded text-blue-600"
                              />
                              <div className="ml-3">
                                <span className="text-sm font-medium">{template.name}</span>
                                <span className="ml-2 text-xs text-gray-500">({method})</span>
                                <div className="mt-1 flex gap-2">
                                  {hasPatterns && (
                                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700">
                                      {template.failure_patterns.length} patterns
                                    </span>
                                  )}
                                  {variables.length > 0 && (
                                    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
                                      {variables.length} variables
                                    </span>
                                  )}
                                </div>
                              </div>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Select Test Accounts (for variable substitution)
                    </label>
                    <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-300 p-3">
                      {accounts.length === 0 ? (
                        <p className="text-sm text-gray-500">No accounts available</p>
                      ) : (
                        accounts.map((account) => {
                          const fields = account.fields || {};
                          const fieldCount = Object.keys(fields).length;
                          return (
                            <label key={account.id} className="mb-2 flex items-start rounded p-2 hover:bg-gray-50">
                              <input
                                type="checkbox"
                                checked={formData.account_ids.includes(account.id)}
                                onChange={(e) => {
                                  const ids = formData.account_ids;
                                  setFormData({
                                    ...formData,
                                    account_ids: e.target.checked
                                      ? [...ids, account.id]
                                      : ids.filter((id) => id !== account.id),
                                  });
                                }}
                                className="mt-0.5 h-4 w-4 rounded text-blue-600"
                              />
                              <div className="ml-3">
                                <span className="text-sm">{account.username || account.display_name}</span>
                                {fieldCount > 0 && (
                                  <span className="ml-2 text-xs text-gray-500">
                                    ({fieldCount} fields)
                                  </span>
                                )}
                              </div>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg bg-blue-50 p-4">
                    <h4 className="mb-2 font-medium text-blue-800">How Template Testing Works</h4>
                    <ul className="space-y-1 text-sm text-blue-700">
                      <li>1. Each template is tested independently</li>
                      <li>2. Variables are substituted from checklists or account fields</li>
                      <li>3. Responses are matched against failure patterns</li>
                      <li>4. Non-matching responses indicate potential vulnerabilities</li>
                    </ul>
                  </div>
                </>
              ) : (
                <>
                  <Select
                    label="Select Workflow"
                    value={formData.workflow_id}
                    onChange={(e) => setFormData({ ...formData, workflow_id: e.target.value })}
                    options={[
                      { value: '', label: 'Select workflow...' },
                      ...activeWorkflows.map((workflow) => ({
                        value: workflow.id,
                        label: workflow.name,
                      })),
                    ]}
                  />

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Select Test Accounts (for variable substitution)
                    </label>
                    <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-300 p-3">
                      {accounts.length === 0 ? (
                        <p className="text-sm text-gray-500">No accounts available</p>
                      ) : (
                        accounts.map((account) => {
                          const fields = account.fields || {};
                          const fieldCount = Object.keys(fields).length;
                          return (
                            <label key={account.id} className="mb-2 flex items-start rounded p-2 hover:bg-gray-50">
                              <input
                                type="checkbox"
                                checked={formData.account_ids.includes(account.id)}
                                onChange={(e) => {
                                  const ids = formData.account_ids;
                                  setFormData({
                                    ...formData,
                                    account_ids: e.target.checked
                                      ? [...ids, account.id]
                                      : ids.filter((id) => id !== account.id),
                                  });
                                }}
                                className="mt-0.5 h-4 w-4 rounded text-blue-600"
                              />
                              <div className="ml-3">
                                <span className="text-sm">{account.username || account.display_name}</span>
                                {fieldCount > 0 && (
                                  <span className="ml-2 text-xs text-gray-500">
                                    ({fieldCount} fields)
                                  </span>
                                )}
                              </div>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg bg-purple-50 p-4">
                    <h4 className="mb-2 font-medium text-purple-800">How Workflow Testing Works</h4>
                    <ul className="space-y-1 text-sm text-purple-700">
                      <li>1. All steps in the workflow execute sequentially as a unit</li>
                      <li>2. Variables are shared across all steps in the workflow</li>
                      <li>3. Each variable value combination runs through ALL steps</li>
                      <li>4. Responses at any step can trigger a finding</li>
                    </ul>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title={`Test Run: ${selectedRun?.name || 'Details'}`}
        size="xl"
      >
        {selectedRun && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-500">Status</p>
                <div className="flex items-center gap-2 mt-1">
                  {getStatusIcon(selectedRun.status)}
                  <span className="font-medium capitalize">{selectedRun.status}</span>
                </div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-500">Type</p>
                <p className="font-medium mt-1 capitalize">{selectedRun.execution_type || 'template'}</p>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-500">Progress</p>
                <p className="font-medium mt-1">{selectedRun.progress_percent}%</p>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-500">Findings</p>
                <p className="font-medium mt-1 text-amber-600">
                  {selectedRun.progress?.findings || 0}
                </p>
              </div>
              <div className={`p-4 rounded-lg ${(selectedRun.errors_count || 0) > 0 || selectedRun.has_execution_error ? 'bg-red-50' : 'bg-gray-50'}`}>
                <p className="text-sm text-gray-500">Errors</p>
                <p className={`font-medium mt-1 ${(selectedRun.errors_count || 0) > 0 || selectedRun.has_execution_error ? 'text-red-600' : 'text-gray-600'}`}>
                  {selectedRun.errors_count || 0}
                </p>
              </div>
              <div className={`p-4 rounded-lg ${selectedRun.has_execution_error ? 'bg-red-50' : 'bg-gray-50'}`}>
                <p className="text-sm text-gray-500">Exec Status</p>
                <p className={`font-medium mt-1 text-sm ${selectedRun.has_execution_error ? 'text-red-600' : 'text-green-600'}`}>
                  {selectedRun.has_execution_error ? 'Failed' : 'Success'}
                </p>
              </div>
            </div>

            <div className="p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-500 mb-2">Timeline</p>
              <div className="space-y-2 text-sm">
                <p>
                  <span className="text-gray-500">Created:</span>{' '}
                  {new Date(selectedRun.created_at).toLocaleString()}
                </p>
                {selectedRun.started_at && (
                  <p>
                    <span className="text-gray-500">Started:</span>{' '}
                    {new Date(selectedRun.started_at).toLocaleString()}
                  </p>
                )}
                {selectedRun.completed_at && (
                  <p>
                    <span className="text-gray-500">Completed:</span>{' '}
                    {new Date(selectedRun.completed_at).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            {(selectedRun.source_recording_session_id || selectedRecordingPromotion) && (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
                <div className="flex items-center gap-2 text-indigo-800">
                  <FileText size={18} />
                  <span className="font-medium">Recording Promotion Source</span>
                </div>
                <div className="mt-2 space-y-1 text-sm text-indigo-700">
                  <p>Recording Session: {selectedRun.source_recording_session_id || selectedRecordingPromotion?.source_recording_session_id}</p>
                  {selectedRecordingPromotion?.source_draft_id && (
                    <p>Source Draft: {selectedRecordingPromotion.source_draft_id}</p>
                  )}
                  {selectedRecordingPromotion?.source_event_id && (
                    <p>Source Event: {selectedRecordingPromotion.source_event_id}</p>
                  )}
                  {selectedRecordingPromotion?.template_id && (
                    <p>Promoted Template: {selectedRecordingPromotion.template_id}</p>
                  )}
                </div>
              </div>
            )}

            {selectedSuiteInfo && (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
                <div className="flex items-center gap-2 text-indigo-800">
                  <Package size={18} />
                  <span className="font-medium">Security Suite Source</span>
                </div>
                <div className="mt-2 space-y-1 text-sm text-indigo-700">
                  <p>Suite: {selectedSuiteInfo.name}</p>
                  <p>Checklists: {(selectedSuiteInfo.checklist_ids || []).length}</p>
                  <p>Security Rules: {(selectedSuiteInfo.security_rule_ids || []).length}</p>
                  {selectedSuiteInfo.selected_workflow_id && (
                    <p>Selected Workflow: {selectedSuiteInfo.selected_workflow_id}</p>
                  )}
                </div>
              </div>
            )}

            {selectedRun.status === 'running' && selectedRun.progress?.current_template && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-center gap-2 text-blue-800">
                  <RefreshCw size={18} className="animate-spin" />
                  <span className="font-medium">Currently Testing</span>
                </div>
                <div className="mt-2 text-sm text-blue-700">
                  {selectedRun.progress.current_step && (
                    <p>Step: {selectedRun.progress.current_step}</p>
                  )}
                  <p>Template: {selectedRun.progress.current_template}</p>
                  {selectedRun.progress.current_variable && (
                    <p className="mt-1 font-mono text-xs bg-blue-100 p-2 rounded">
                      {selectedRun.progress.current_variable}
                    </p>
                  )}
                  <p className="mt-2">
                    Progress: {selectedRun.progress.completed} / {selectedRun.progress.total} tests
                  </p>
                </div>
              </div>
            )}

            {selectedRun.status === 'failed' && selectedRun.error_message && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center gap-2 text-red-800">
                  <XCircle size={18} />
                  <span className="font-medium">Test Run Failed</span>
                </div>
                <p className="text-sm text-red-700 mt-2">{selectedRun.error_message}</p>
              </div>
            )}

            {(selectedRun.has_execution_error || (selectedRun.errors_count && selectedRun.errors_count > 0)) && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center gap-2 text-red-800 mb-2">
                  <AlertCircle size={18} />
                  <span className="font-medium">Execution Errors Detected</span>
                </div>
                {selectedRun.errors_count && selectedRun.errors_count > 0 && (
                  <p className="text-sm text-red-700">
                    <span className="font-medium">{selectedRun.errors_count}</span> error{selectedRun.errors_count > 1 ? 's' : ''} occurred during execution.
                  </p>
                )}
                {selectedRun.error_message && !selectedRun.status?.includes('failed') && (
                  <p className="text-sm text-red-700 mt-2">{selectedRun.error_message}</p>
                )}
                <p className="text-xs text-red-600 mt-2">
                  Execution errors cause CI/CD gate to fail (BLOCK). Check logs for details.
                </p>
              </div>
            )}

            {(selectedRun.dropped_count !== undefined || selectedRun.suppressed_count_rule !== undefined ||
              selectedRun.suppressed_count_rate_limit !== undefined || selectedRun.findings_count_effective !== undefined) && (
              <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
                <p className="text-sm text-gray-500 mb-3 font-medium">Findings Governance Statistics</p>
                <div className="grid grid-cols-4 gap-3">
                  <div className="text-center p-2 bg-white rounded border">
                    <p className="text-xs text-gray-500">Effective (CI)</p>
                    <p className="text-lg font-bold text-green-600">{selectedRun.findings_count_effective || 0}</p>
                  </div>
                  <div className="text-center p-2 bg-white rounded border">
                    <p className="text-xs text-gray-500">Rule Suppressed</p>
                    <p className="text-lg font-bold text-gray-600">{selectedRun.suppressed_count_rule || 0}</p>
                  </div>
                  <div className="text-center p-2 bg-white rounded border">
                    <p className="text-xs text-gray-500">Rate Limited</p>
                    <p className="text-lg font-bold text-orange-600">{selectedRun.suppressed_count_rate_limit || 0}</p>
                  </div>
                  <div className="text-center p-2 bg-white rounded border">
                    <p className="text-xs text-gray-500">Dropped</p>
                    <p className="text-lg font-bold text-red-600">{selectedRun.dropped_count || 0}</p>
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Only "Effective" findings count toward CI gate calculations.
                </p>
              </div>
            )}

            {selectedRun.progress?.findings && selectedRun.progress.findings > 0 && (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-amber-800">
                    <AlertTriangle size={18} />
                    <span className="font-medium">
                      {selectedRun.progress.findings} potential vulnerabilities found
                    </span>
                  </div>
                  {onNavigateToFindings && (
                    <Button
                      size="sm"
                      onClick={() => {
                        const executionType = selectedRun.execution_type || 'template';
                        const params: any = {
                          tab: executionType === 'workflow' ? 'workflow' : 'test_run',
                          test_run_id: selectedRun.id,
                        };
                        if (executionType === 'workflow' && selectedRun.workflow_id) {
                          params.workflow_id = selectedRun.workflow_id;
                        }
                        onNavigateToFindings(params);
                        setIsDetailModalOpen(false);
                      }}
                    >
                      View Findings
                    </Button>
                  )}
                </div>
                <p className="text-sm text-amber-700 mt-2">
                  Review the findings in the Findings page to investigate and triage.
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
