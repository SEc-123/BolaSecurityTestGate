import { useState, useEffect } from 'react';
import {
  Plus,
  Edit2,
  Trash2,
  Shield,
  Play,
  Power,
  PowerOff,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Modal } from '../components/ui/Modal';
import { Button, Input, Select, TextArea } from '../components/ui/Form';
import { Table } from '../components/ui/Table';
import {
  gatePoliciesService,
  securityRunsService,
  apiTemplatesService,
  workflowsService,
  environmentsService,
  accountsService,
} from '../lib/api-service';
import type {
  CICDGatePolicy,
  SecurityRun,
  ApiTemplate,
  Workflow,
  Environment,
  Account,
  GateThresholdRule,
  ThresholdOperator,
  GateAction,
} from '../types';

const DEFAULT_TEST_RULES: GateThresholdRule[] = [
  { operator: '>=', threshold: 5, action: 'BLOCK' },
  { operator: '>=', threshold: 1, action: 'WARN' },
  { operator: '<', threshold: 1, action: 'PASS' },
];

const DEFAULT_WORKFLOW_RULES: GateThresholdRule[] = [
  { operator: '>=', threshold: 5, action: 'BLOCK' },
  { operator: '>=', threshold: 1, action: 'WARN' },
  { operator: '<', threshold: 1, action: 'PASS' },
];

const OPERATORS: { value: ThresholdOperator; label: string }[] = [
  { value: '>=', label: '>= (greater than or equal)' },
  { value: '>', label: '> (greater than)' },
  { value: '<=', label: '<= (less than or equal)' },
  { value: '<', label: '< (less than)' },
  { value: '==', label: '== (equal)' },
  { value: '!=', label: '!= (not equal)' },
];

const ACTIONS: { value: GateAction; label: string; color: string }[] = [
  { value: 'BLOCK', label: 'BLOCK (Exit 2)', color: 'text-red-600' },
  { value: 'WARN', label: 'WARN (Exit 0)', color: 'text-amber-600' },
  { value: 'PASS', label: 'PASS (Exit 0)', color: 'text-green-600' },
];

interface RuleEditorProps {
  rules: GateThresholdRule[];
  onChange: (rules: GateThresholdRule[]) => void;
  label: string;
  weight: number;
}

function RuleEditor({ rules, onChange, label, weight }: RuleEditorProps) {
  const [expanded, setExpanded] = useState(true);

  const addRule = () => {
    onChange([...rules, { operator: '>=', threshold: 1, action: 'WARN' }]);
  };

  const updateRule = (index: number, field: keyof GateThresholdRule, value: any) => {
    const updated = [...rules];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  };

  const removeRule = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
  };

  const moveRule = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= rules.length) return;
    const updated = [...rules];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    onChange(updated);
  };

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900">{label}</span>
          <span className="text-sm text-gray-500">({weight}% weight)</span>
          <span className="text-xs text-gray-400">{rules.length} rules</span>
        </div>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {expanded && (
        <div className="p-3 space-y-2">
          {weight === 0 ? (
            <p className="text-sm text-gray-500 italic">Weight is 0%, rules will not affect the result.</p>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-2">
                Rules are evaluated in order. First matching rule determines the action.
                Score = ceil(findings * {weight}%)
              </p>
              {rules.map((rule, index) => (
                <div key={index} className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                  <span className="text-xs text-gray-400 w-6">#{index + 1}</span>
                  <Select
                    value={rule.operator}
                    onChange={(e) => updateRule(index, 'operator', e.target.value)}
                    className="w-32"
                  >
                    {OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>{op.value}</option>
                    ))}
                  </Select>
                  <Input
                    type="number"
                    min={0}
                    value={rule.threshold}
                    onChange={(e) => updateRule(index, 'threshold', parseInt(e.target.value) || 0)}
                    className="w-20"
                  />
                  <span className="text-gray-500">=</span>
                  <Select
                    value={rule.action}
                    onChange={(e) => updateRule(index, 'action', e.target.value)}
                    className={`w-28 ${ACTIONS.find(a => a.value === rule.action)?.color}`}
                  >
                    {ACTIONS.map((action) => (
                      <option key={action.value} value={action.value}>{action.value}</option>
                    ))}
                  </Select>
                  <div className="flex gap-1 ml-auto">
                    <button
                      type="button"
                      onClick={() => moveRule(index, 'up')}
                      disabled={index === 0}
                      className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveRule(index, 'down')}
                      disabled={index === rules.length - 1}
                      className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                    >
                      <ChevronDown size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRule(index)}
                      className="p-1 hover:bg-red-100 rounded text-red-600"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={addRule}
                className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
              >
                <Plus size={14} /> Add Rule
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function CIGatePolicies() {
  const [policies, setPolicies] = useState<CICDGatePolicy[]>([]);
  const [securityRuns, setSecurityRuns] = useState<SecurityRun[]>([]);
  const [templates, setTemplates] = useState<ApiTemplate[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'policies' | 'runs'>('policies');

  const [isPolicyModalOpen, setIsPolicyModalOpen] = useState(false);
  const [isRunModalOpen, setIsRunModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<SecurityRun | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<CICDGatePolicy | null>(null);
  const [runInProgress, setRunInProgress] = useState(false);

  const [policyForm, setPolicyForm] = useState({
    name: '',
    description: '',
    is_enabled: true,
    weight_test: 100,
    combine_operator: 'OR' as 'OR' | 'AND',
    rules_test: DEFAULT_TEST_RULES,
    rules_workflow: DEFAULT_WORKFLOW_RULES,
  });

  const [runForm, setRunForm] = useState({
    policy_id: '',
    template_ids: [] as string[],
    workflow_ids: [] as string[],
    account_ids: [] as string[],
    environment_id: '',
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [policiesData, runsData, templatesData, workflowsData, envsData, accountsData] = await Promise.all([
        gatePoliciesService.list(),
        securityRunsService.list(),
        apiTemplatesService.list(),
        workflowsService.list(),
        environmentsService.list(),
        accountsService.list(),
      ]);
      setPolicies(policiesData);
      setSecurityRuns(runsData);
      setTemplates(templatesData);
      setWorkflows(workflowsData);
      setEnvironments(envsData);
      setAccounts(accountsData);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreatePolicy = () => {
    setEditingPolicy(null);
    setPolicyForm({
      name: '',
      description: '',
      is_enabled: true,
      weight_test: 100,
      combine_operator: 'OR',
      rules_test: [...DEFAULT_TEST_RULES],
      rules_workflow: [...DEFAULT_WORKFLOW_RULES],
    });
    setIsPolicyModalOpen(true);
  };

  const handleEditPolicy = (policy: CICDGatePolicy) => {
    setEditingPolicy(policy);
    setPolicyForm({
      name: policy.name,
      description: policy.description || '',
      is_enabled: policy.is_enabled,
      weight_test: policy.weight_test,
      combine_operator: policy.combine_operator,
      rules_test: policy.rules_test || [...DEFAULT_TEST_RULES],
      rules_workflow: policy.rules_workflow || [...DEFAULT_WORKFLOW_RULES],
    });
    setIsPolicyModalOpen(true);
  };

  const handleSavePolicy = async () => {
    if (!policyForm.name.trim()) {
      alert('Policy name is required');
      return;
    }

    try {
      const policyData = {
        name: policyForm.name,
        description: policyForm.description || undefined,
        is_enabled: policyForm.is_enabled,
        weight_test: policyForm.weight_test,
        weight_workflow: 100 - policyForm.weight_test,
        combine_operator: policyForm.combine_operator,
        rules_test: policyForm.rules_test,
        rules_workflow: policyForm.rules_workflow,
      };

      if (editingPolicy) {
        await gatePoliciesService.update(editingPolicy.id, policyData);
      } else {
        await gatePoliciesService.create(policyData as any);
      }
      setIsPolicyModalOpen(false);
      loadData();
    } catch (error: any) {
      console.error('Failed to save policy:', error);
      alert(`Failed to save policy: ${error.message}`);
    }
  };

  const handleDeletePolicy = async (id: string) => {
    if (!confirm('Delete this gate policy?')) return;
    try {
      await gatePoliciesService.delete(id);
      loadData();
    } catch (error) {
      console.error('Failed to delete policy:', error);
      alert('Failed to delete policy');
    }
  };

  const handleTogglePolicy = async (policy: CICDGatePolicy) => {
    try {
      await gatePoliciesService.update(policy.id, { is_enabled: !policy.is_enabled });
      loadData();
    } catch (error) {
      console.error('Failed to toggle policy:', error);
    }
  };

  const handleOpenRunModal = () => {
    setRunForm({
      policy_id: policies.find(p => p.is_enabled)?.id || '',
      template_ids: [],
      workflow_ids: [],
      account_ids: [],
      environment_id: '',
    });
    setIsRunModalOpen(true);
  };

  const handleTriggerRun = async () => {
    if (runForm.template_ids.length === 0 && runForm.workflow_ids.length === 0) {
      alert('Please select at least one template or workflow');
      return;
    }

    setRunInProgress(true);
    try {
      const result = await securityRunsService.triggerSecurityRun({
        policy_id: runForm.policy_id || undefined,
        template_ids: runForm.template_ids,
        workflow_ids: runForm.workflow_ids,
        account_ids: runForm.account_ids,
        environment_id: runForm.environment_id || undefined,
      });

      setIsRunModalOpen(false);
      loadData();

      const details = result.details as any;
      const message = `Security Run Complete

Result: ${result.gate_result}
Exit Code: ${result.exit_code}

Test Findings: ${result.test_findings_count} (weighted: ${details?.test_weighted_score || 0}) -> ${details?.test_action || 'N/A'}
Workflow Findings: ${result.workflow_findings_count} (weighted: ${details?.workflow_weighted_score || 0}) -> ${details?.workflow_action || 'N/A'}

Combine Operator: ${details?.combine_operator || 'OR'}
Final Action: ${details?.final_action || result.gate_result}`;
      alert(message);
    } catch (error: any) {
      console.error('Failed to trigger security run:', error);
      alert(`Failed to trigger security run: ${error.message}`);
    } finally {
      setRunInProgress(false);
    }
  };

  const handleViewRunDetails = (run: SecurityRun) => {
    setSelectedRun(run);
    setIsDetailModalOpen(true);
  };

  const getGateResultBadge = (result?: string) => {
    switch (result) {
      case 'PASS':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-green-100 text-green-800">
            <CheckCircle size={12} /> PASS
          </span>
        );
      case 'WARN':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-amber-100 text-amber-800">
            <AlertTriangle size={12} /> WARN
          </span>
        );
      case 'BLOCK':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-red-100 text-red-800">
            <XCircle size={12} /> BLOCK
          </span>
        );
      default:
        return <span className="text-gray-400">-</span>;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <span className="px-2 py-1 text-xs font-medium rounded bg-green-100 text-green-800">Completed</span>;
      case 'running':
        return <span className="px-2 py-1 text-xs font-medium rounded bg-blue-100 text-blue-800">Running</span>;
      case 'failed':
        return <span className="px-2 py-1 text-xs font-medium rounded bg-red-100 text-red-800">Failed</span>;
      case 'pending':
        return <span className="px-2 py-1 text-xs font-medium rounded bg-gray-100 text-gray-800">Pending</span>;
      default:
        return <span className="px-2 py-1 text-xs font-medium rounded bg-gray-100 text-gray-800">{status}</span>;
    }
  };

  const formatRules = (rules: GateThresholdRule[]) => {
    if (!rules || rules.length === 0) return 'No rules';
    return rules.map(r => `${r.operator}${r.threshold}=${r.action}`).join(', ');
  };

  const policyColumns = [
    {
      key: 'name' as const,
      label: 'Name',
      render: (value: string, row: CICDGatePolicy) => (
        <div>
          <span className="font-medium">{value}</span>
          {row.description && <p className="text-xs text-gray-500 mt-0.5">{row.description}</p>}
        </div>
      ),
    },
    {
      key: 'is_enabled' as const,
      label: 'Status',
      render: (value: boolean) => (
        <span className={`px-2 py-1 text-xs font-medium rounded ${value ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
          {value ? 'Enabled' : 'Disabled'}
        </span>
      ),
    },
    {
      key: 'weight_test' as const,
      label: 'Weights',
      render: (value: number, row: CICDGatePolicy) => (
        <div className="text-sm">
          <div>Test: {value}%</div>
          <div>Workflow: {row.weight_workflow}%</div>
        </div>
      ),
    },
    {
      key: 'combine_operator' as const,
      label: 'Combine',
      render: (value: string) => (
        <span className="px-2 py-1 text-xs font-medium rounded bg-blue-100 text-blue-800">{value}</span>
      ),
    },
    {
      key: 'rules_test' as const,
      label: 'Test Rules',
      render: (value: GateThresholdRule[]) => (
        <span className="text-xs text-gray-600 font-mono">{formatRules(value)}</span>
      ),
    },
    {
      key: 'rules_workflow' as const,
      label: 'Workflow Rules',
      render: (value: GateThresholdRule[]) => (
        <span className="text-xs text-gray-600 font-mono">{formatRules(value)}</span>
      ),
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: CICDGatePolicy) => (
        <div className="flex gap-2">
          <button
            onClick={() => handleTogglePolicy(row)}
            className={`p-1 rounded ${row.is_enabled ? 'hover:bg-orange-100 text-orange-600' : 'hover:bg-green-100 text-green-600'}`}
            title={row.is_enabled ? 'Disable' : 'Enable'}
          >
            {row.is_enabled ? <PowerOff size={16} /> : <Power size={16} />}
          </button>
          <button onClick={() => handleEditPolicy(row)} className="p-1 hover:bg-blue-100 rounded text-blue-600">
            <Edit2 size={16} />
          </button>
          <button onClick={() => handleDeletePolicy(row.id)} className="p-1 hover:bg-red-100 rounded text-red-600">
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  const runColumns = [
    {
      key: 'created_at' as const,
      label: 'Time',
      render: (value: string) => (
        <div className="text-sm">
          <div>{new Date(value).toLocaleDateString()}</div>
          <div className="text-gray-500">{new Date(value).toLocaleTimeString()}</div>
        </div>
      ),
    },
    {
      key: 'status' as const,
      label: 'Status',
      render: (value: string) => getStatusBadge(value),
    },
    {
      key: 'gate_result' as const,
      label: 'Gate Result',
      render: (value?: string) => getGateResultBadge(value),
    },
    {
      key: 'exit_code' as const,
      label: 'Exit Code',
      render: (value?: number) => (
        <span className={`font-mono text-sm ${value === 0 ? 'text-green-600' : value === 2 ? 'text-red-600' : 'text-amber-600'}`}>
          {value ?? '-'}
        </span>
      ),
    },
    {
      key: 'test_findings_count' as const,
      label: 'Test',
      render: (value: number, row: SecurityRun) => {
        const details = row.metadata?.gate_details;
        return (
          <div className="text-sm">
            <span className="font-medium">{value}</span>
            {details && (
              <span className="text-gray-500 ml-1">
                ({details.test_weighted_score} {'->'} {details.test_action})
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'workflow_findings_count' as const,
      label: 'Workflow',
      render: (value: number, row: SecurityRun) => {
        const details = row.metadata?.gate_details;
        return (
          <div className="text-sm">
            <span className="font-medium">{value}</span>
            {details && (
              <span className="text-gray-500 ml-1">
                ({details.workflow_weighted_score} {'->'} {details.workflow_action})
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'policy_id' as const,
      label: 'Policy',
      render: (_: string, row: SecurityRun) => (
        <span className="text-sm">{row.policy?.name || 'Default'}</span>
      ),
    },
    {
      key: 'id' as const,
      label: '',
      render: (_: string, row: SecurityRun) => (
        <button
          onClick={() => handleViewRunDetails(row)}
          className="text-xs text-blue-600 hover:underline"
        >
          Details
        </button>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-gray-400" size={32} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="text-teal-600" size={28} />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">CI/CD Gate</h1>
            <p className="text-gray-600">Configure security gate policies for CI/CD pipelines</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleOpenRunModal} variant="secondary">
            <Play size={16} className="mr-2" />
            Run Security Gate
          </Button>
          {activeTab === 'policies' && (
            <Button onClick={handleCreatePolicy}>
              <Plus size={16} className="mr-2" />
              New Policy
            </Button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="border-b border-gray-200">
          <nav className="flex">
            <button
              onClick={() => setActiveTab('policies')}
              className={`px-6 py-4 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'policies'
                  ? 'border-teal-500 text-teal-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Gate Policies ({policies.length})
            </button>
            <button
              onClick={() => setActiveTab('runs')}
              className={`px-6 py-4 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'runs'
                  ? 'border-teal-500 text-teal-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <div className="flex items-center gap-2">
                <Clock size={14} />
                Security Runs ({securityRuns.length})
              </div>
            </button>
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'policies' && (
            policies.length === 0 ? (
              <div className="text-center py-12">
                <Shield className="mx-auto text-gray-300 mb-4" size={48} />
                <p className="text-gray-600 mb-4">No gate policies configured yet</p>
                <Button onClick={handleCreatePolicy}>Create First Policy</Button>
              </div>
            ) : (
              <Table columns={policyColumns} data={policies} />
            )
          )}

          {activeTab === 'runs' && (
            securityRuns.length === 0 ? (
              <div className="text-center py-12">
                <Clock className="mx-auto text-gray-300 mb-4" size={48} />
                <p className="text-gray-600 mb-4">No security runs yet</p>
                <Button onClick={handleOpenRunModal}>
                  <Play size={16} className="mr-2" />
                  Run Security Gate
                </Button>
              </div>
            ) : (
              <Table columns={runColumns} data={securityRuns} />
            )
          )}
        </div>
      </div>

      <Modal
        isOpen={isPolicyModalOpen}
        onClose={() => setIsPolicyModalOpen(false)}
        title={editingPolicy ? 'Edit Gate Policy' : 'Create Gate Policy'}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setIsPolicyModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSavePolicy}>{editingPolicy ? 'Update' : 'Create'}</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Policy Name"
            value={policyForm.name}
            onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })}
            placeholder="e.g., Production Gate"
            required
          />

          <TextArea
            label="Description"
            value={policyForm.description}
            onChange={(e) => setPolicyForm({ ...policyForm, description: e.target.value })}
            placeholder="Optional description"
            rows={2}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Weight Distribution (must sum to 100%)
            </label>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="flex justify-between text-sm mb-1">
                  <span>Test Runs: {policyForm.weight_test}%</span>
                  <span>Workflows: {100 - policyForm.weight_test}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={policyForm.weight_test}
                  onChange={(e) => setPolicyForm({ ...policyForm, weight_test: parseInt(e.target.value) })}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>

          <Select
            label="Combine Operator"
            value={policyForm.combine_operator}
            onChange={(e) => setPolicyForm({ ...policyForm, combine_operator: e.target.value as 'OR' | 'AND' })}
          >
            <option value="OR">OR - Take the higher severity action (max)</option>
            <option value="AND">AND - Take the lower severity action (min)</option>
          </Select>

          <RuleEditor
            label="Test Run Rules"
            weight={policyForm.weight_test}
            rules={policyForm.rules_test}
            onChange={(rules) => setPolicyForm({ ...policyForm, rules_test: rules })}
          />

          <RuleEditor
            label="Workflow Rules"
            weight={100 - policyForm.weight_test}
            rules={policyForm.rules_workflow}
            onChange={(rules) => setPolicyForm({ ...policyForm, rules_workflow: rules })}
          />

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800">
              <strong>How it works:</strong><br />
              1. Calculate weighted score: ceil(findings * weight%)<br />
              2. Apply rules in order for each category to get an action<br />
              3. Combine actions: OR takes max severity, AND takes min severity<br />
              4. Exit codes: PASS/WARN = 0, BLOCK = 2
            </p>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isRunModalOpen}
        onClose={() => setIsRunModalOpen(false)}
        title="Run Security Gate"
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setIsRunModalOpen(false)}>Cancel</Button>
            <Button onClick={handleTriggerRun} disabled={runInProgress}>
              {runInProgress ? (
                <>
                  <RefreshCw size={16} className="mr-2 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Play size={16} className="mr-2" />
                  Run Gate
                </>
              )}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Select
            label="Gate Policy"
            value={runForm.policy_id}
            onChange={(e) => setRunForm({ ...runForm, policy_id: e.target.value })}
          >
            <option value="">Default Policy</option>
            {policies.filter(p => p.is_enabled).map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>

          <Select
            label="Environment"
            value={runForm.environment_id}
            onChange={(e) => setRunForm({ ...runForm, environment_id: e.target.value })}
          >
            <option value="">Select Environment</option>
            {environments.filter(e => e.is_active).map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </Select>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">API Templates</label>
            <div className="max-h-40 overflow-y-auto border rounded-lg p-2 space-y-1">
              {templates.filter(t => t.is_active).map(t => (
                <label key={t.id} className="flex items-center gap-2 p-1 hover:bg-gray-50 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={runForm.template_ids.includes(t.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setRunForm({ ...runForm, template_ids: [...runForm.template_ids, t.id] });
                      } else {
                        setRunForm({ ...runForm, template_ids: runForm.template_ids.filter(id => id !== t.id) });
                      }
                    }}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm">{t.name}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Workflows</label>
            <div className="max-h-40 overflow-y-auto border rounded-lg p-2 space-y-1">
              {workflows.filter(w => w.is_active).map(w => (
                <label key={w.id} className="flex items-center gap-2 p-1 hover:bg-gray-50 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={runForm.workflow_ids.includes(w.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setRunForm({ ...runForm, workflow_ids: [...runForm.workflow_ids, w.id] });
                      } else {
                        setRunForm({ ...runForm, workflow_ids: runForm.workflow_ids.filter(id => id !== w.id) });
                      }
                    }}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm">{w.name}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Test Accounts</label>
            <div className="max-h-32 overflow-y-auto border rounded-lg p-2 space-y-1">
              {accounts.map(a => (
                <label key={a.id} className="flex items-center gap-2 p-1 hover:bg-gray-50 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={runForm.account_ids.includes(a.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setRunForm({ ...runForm, account_ids: [...runForm.account_ids, a.id] });
                      } else {
                        setRunForm({ ...runForm, account_ids: runForm.account_ids.filter(id => id !== a.id) });
                      }
                    }}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm">{a.name}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title="Security Run Details"
        size="lg"
      >
        {selectedRun && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-gray-500">Status</label>
                <div>{getStatusBadge(selectedRun.status)}</div>
              </div>
              <div>
                <label className="text-sm text-gray-500">Gate Result</label>
                <div>{getGateResultBadge(selectedRun.gate_result)}</div>
              </div>
              <div>
                <label className="text-sm text-gray-500">Exit Code</label>
                <div className="font-mono">{selectedRun.exit_code ?? '-'}</div>
              </div>
              <div>
                <label className="text-sm text-gray-500">Policy</label>
                <div>{selectedRun.policy?.name || 'Default'}</div>
              </div>
            </div>

            {selectedRun.metadata?.gate_details && (
              <div className="border rounded-lg p-4 space-y-3">
                <h4 className="font-medium">Gate Calculation Details</h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="space-y-2">
                    <div className="font-medium text-gray-700">Test Runs</div>
                    <div>Findings: {selectedRun.metadata.gate_details.test_findings_count}</div>
                    <div>Weighted Score: {selectedRun.metadata.gate_details.test_weighted_score}</div>
                    <div>Action: {getGateResultBadge(selectedRun.metadata.gate_details.test_action)}</div>
                  </div>
                  <div className="space-y-2">
                    <div className="font-medium text-gray-700">Workflows</div>
                    <div>Findings: {selectedRun.metadata.gate_details.workflow_findings_count}</div>
                    <div>Weighted Score: {selectedRun.metadata.gate_details.workflow_weighted_score}</div>
                    <div>Action: {getGateResultBadge(selectedRun.metadata.gate_details.workflow_action)}</div>
                  </div>
                </div>
                <div className="pt-2 border-t">
                  <div>Combine Operator: <strong>{selectedRun.metadata.gate_details.combine_operator}</strong></div>
                  <div>Final Action: {getGateResultBadge(selectedRun.metadata.gate_details.final_action)}</div>
                </div>
              </div>
            )}

            {selectedRun.error_message && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <div className="text-sm text-red-800">{selectedRun.error_message}</div>
              </div>
            )}

            <div className="text-sm text-gray-500">
              <div>Started: {selectedRun.metadata?.started_at ? new Date(selectedRun.metadata.started_at).toLocaleString() : '-'}</div>
              <div>Completed: {selectedRun.metadata?.completed_at ? new Date(selectedRun.metadata.completed_at).toLocaleString() : '-'}</div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
