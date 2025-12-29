import { useEffect, useState, useCallback } from 'react';
import { Play, Eye, Trash2, RefreshCw, CheckCircle, XCircle, Clock, AlertTriangle, GitBranch, FileText, AlertCircle } from 'lucide-react';
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
} from '../lib/api-service';
import type { TestRun, ApiTemplate, Account, Environment, Workflow } from '../types';

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
  onNavigateToFindings?: (params?: {
    tab?: 'test_run' | 'workflow';
    test_run_id?: string;
    template_id?: string;
    workflow_id?: string;
  }) => void;
}

export function TestRuns({ onNavigateToFindings }: TestRunsProps) {
  const [testRuns, setTestRuns] = useState<TestRunWithDetails[]>([]);
  const [templates, setTemplates] = useState<ApiTemplate[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<TestRunWithDetails | null>(null);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('template');

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
      const [runsData, templatesData, accountsData, envsData, workflowsData] = await Promise.all([
        testRunsService.list(),
        apiTemplatesService.list(),
        accountsService.list(),
        environmentsService.list(),
        workflowsService.list(),
      ]);
      setTestRuns(runsData as TestRunWithDetails[]);
      setTemplates(templatesData);
      setAccounts(accountsData);
      setEnvironments(envsData);
      setWorkflows(workflowsData);
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
    setIsModalOpen(true);
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

  const handleExecute = () => {
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
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: TestRunWithDetails) => (
        <div className="flex gap-2">
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
          <p className="text-gray-600 mt-1">Execute security tests and monitor results</p>
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
            <Button onClick={handleExecute} disabled={executing}>
              {executing ? (
                <>
                  <RefreshCw size={18} className="mr-2 animate-spin" />
                  Executing...
                </>
              ) : (
                <>
                  <Play size={18} className="mr-2" />
                  Start Test
                </>
              )}
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          <div className="flex gap-2 p-1 bg-gray-100 rounded-lg">
            <button
              onClick={() => setExecutionMode('template')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                executionMode === 'template'
                  ? 'bg-white text-blue-600 shadow'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              <FileText size={18} />
              Template Test
            </button>
            <button
              onClick={() => setExecutionMode('workflow')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                executionMode === 'workflow'
                  ? 'bg-white text-purple-600 shadow'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
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
                    <span className="text-gray-500 font-normal ml-2">
                      ({templatesWithPatterns.length} with failure patterns)
                    </span>
                  )}
                </label>
                <div className="border border-gray-300 rounded-lg p-3 max-h-48 overflow-y-auto">
                  {templates.length === 0 ? (
                    <p className="text-gray-500 text-sm">No API templates available</p>
                  ) : (
                    templates.map((template) => {
                      const hasPatterns = template.failure_patterns?.length > 0;
                      const variables = template.variables || [];
                      const method = template.parsed_structure?.method || 'GET';
                      return (
                        <label
                          key={template.id}
                          className={`flex items-start mb-3 p-2 rounded ${hasPatterns ? 'bg-green-50' : 'bg-gray-50'}`}
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
                            className="w-4 h-4 text-blue-600 rounded mt-0.5"
                          />
                          <div className="ml-3">
                            <span className="text-sm font-medium">{template.name}</span>
                            <span className="text-xs text-gray-500 ml-2">({method})</span>
                            <div className="flex gap-2 mt-1">
                              {hasPatterns && (
                                <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded">
                                  {template.failure_patterns.length} patterns
                                </span>
                              )}
                              {variables.length > 0 && (
                                <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">
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
                <div className="border border-gray-300 rounded-lg p-3 max-h-48 overflow-y-auto">
                  {accounts.length === 0 ? (
                    <p className="text-gray-500 text-sm">No accounts available</p>
                  ) : (
                    accounts.map((account) => {
                      const fields = account.fields || {};
                      const fieldCount = Object.keys(fields).length;
                      return (
                        <label key={account.id} className="flex items-start mb-2 p-2 hover:bg-gray-50 rounded">
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
                            className="w-4 h-4 text-blue-600 rounded mt-0.5"
                          />
                          <div className="ml-3">
                            <span className="text-sm">{account.username || account.display_name}</span>
                            {fieldCount > 0 && (
                              <span className="text-xs text-gray-500 ml-2">
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

              <div className="p-4 bg-blue-50 rounded-lg">
                <h4 className="font-medium text-blue-800 mb-2">How Template Testing Works</h4>
                <ul className="text-sm text-blue-700 space-y-1">
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
                  ...activeWorkflows.map((w) => ({
                    value: w.id,
                    label: w.name,
                  })),
                ]}
              />

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select Test Accounts (for variable substitution)
                </label>
                <div className="border border-gray-300 rounded-lg p-3 max-h-48 overflow-y-auto">
                  {accounts.length === 0 ? (
                    <p className="text-gray-500 text-sm">No accounts available</p>
                  ) : (
                    accounts.map((account) => {
                      const fields = account.fields || {};
                      const fieldCount = Object.keys(fields).length;
                      return (
                        <label key={account.id} className="flex items-start mb-2 p-2 hover:bg-gray-50 rounded">
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
                            className="w-4 h-4 text-blue-600 rounded mt-0.5"
                          />
                          <div className="ml-3">
                            <span className="text-sm">{account.username || account.display_name}</span>
                            {fieldCount > 0 && (
                              <span className="text-xs text-gray-500 ml-2">
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

              <div className="p-4 bg-purple-50 rounded-lg">
                <h4 className="font-medium text-purple-800 mb-2">How Workflow Testing Works</h4>
                <ul className="text-sm text-purple-700 space-y-1">
                  <li>1. All steps in the workflow execute sequentially as a unit</li>
                  <li>2. Variables are shared across all steps in the workflow</li>
                  <li>3. Each variable value combination runs through ALL steps</li>
                  <li>4. Responses at any step can trigger a finding</li>
                </ul>
              </div>
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
