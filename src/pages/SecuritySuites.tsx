import { useEffect, useState } from 'react';
import { Plus, Edit2, Trash2, ArrowLeft, Save, X } from 'lucide-react';
import { Button, Input, Select, Checkbox } from '../components/ui/Form';
import { Modal } from '../components/ui/Modal';
import {
  environmentsService,
  apiTemplatesService,
  workflowsService,
  gatePoliciesService,
  securitySuitesService,
  accountsService,
  checklistsService,
  securityRulesService,
} from '../lib/api-service';
import type { SecuritySuite } from '../lib/api-client';
import type {
  Environment,
  ApiTemplate,
  Workflow,
  CICDGatePolicy,
  Account,
  Checklist,
  SecurityRule,
} from '../types';

type SuiteFormData = {
  name: string;
  description: string;
  environment_id: string;
  policy_id: string;
  template_ids: string[];
  workflow_ids: string[];
  account_ids: string[];
  checklist_ids: string[];
  security_rule_ids: string[];
  is_enabled: boolean;
};

type SelectableAssetKey =
  | 'template_ids'
  | 'workflow_ids'
  | 'account_ids'
  | 'checklist_ids'
  | 'security_rule_ids';

const EMPTY_FORM: SuiteFormData = {
  name: '',
  description: '',
  environment_id: '',
  policy_id: '',
  template_ids: [],
  workflow_ids: [],
  account_ids: [],
  checklist_ids: [],
  security_rule_ids: [],
  is_enabled: true,
};

export function SecuritySuites() {
  const [suites, setSuites] = useState<SecuritySuite[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [templates, setTemplates] = useState<ApiTemplate[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [policies, setPolicies] = useState<CICDGatePolicy[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [securityRules, setSecurityRules] = useState<SecurityRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSuite, setEditingSuite] = useState<SecuritySuite | null>(null);

  const [formData, setFormData] = useState<SuiteFormData>(EMPTY_FORM);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [
        suitesData,
        envsData,
        templatesData,
        workflowsData,
        policiesData,
        accountsData,
        checklistsData,
        rulesData,
      ] = await Promise.all([
        securitySuitesService.list(),
        environmentsService.list(),
        apiTemplatesService.list(),
        workflowsService.list(),
        gatePoliciesService.list(),
        accountsService.list(),
        checklistsService.list(),
        securityRulesService.list(),
      ]);
      setSuites(suitesData);
      setEnvironments(envsData);
      setTemplates(templatesData);
      setWorkflows(workflowsData);
      setPolicies(policiesData);
      setAccounts(accountsData);
      setChecklists(checklistsData);
      setSecurityRules(rulesData);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  };

  const openCreateModal = () => {
    setEditingSuite(null);
    setFormData(EMPTY_FORM);
    setIsModalOpen(true);
  };

  const openEditModal = (suite: SecuritySuite) => {
    setEditingSuite(suite);
    setFormData({
      name: suite.name,
      description: suite.description || '',
      environment_id: suite.environment_id || '',
      policy_id: suite.policy_id || '',
      template_ids: suite.template_ids || [],
      workflow_ids: suite.workflow_ids || [],
      account_ids: suite.account_ids || [],
      checklist_ids: suite.checklist_ids || [],
      security_rule_ids: suite.security_rule_ids || [],
      is_enabled: suite.is_enabled,
    });
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    if (!formData.name.trim()) {
      alert('Suite name is required');
      return;
    }

    try {
      if (editingSuite) {
        await securitySuitesService.update(editingSuite.id, formData);
      } else {
        await securitySuitesService.create(formData as any);
      }
      setIsModalOpen(false);
      setFormData(EMPTY_FORM);
      loadData();
    } catch (error: any) {
      alert(`Failed to save: ${error.message || 'Unknown error'}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this suite?')) return;
    try {
      await securitySuitesService.delete(id);
      loadData();
    } catch (error: any) {
      alert(`Failed to delete: ${error.message || 'Unknown error'}`);
    }
  };

  const toggleSelection = (key: SelectableAssetKey, value: string) => {
    setFormData(prev => ({
      ...prev,
      [key]: prev[key].includes(value)
        ? prev[key].filter(id => id !== value)
        : [...prev[key], value],
    }));
  };

  const setSelections = (key: SelectableAssetKey, values: string[]) => {
    setFormData(prev => ({
      ...prev,
      [key]: values,
    }));
  };

  const getEnvironmentName = (envId?: string) => {
    if (!envId) return '-';
    const env = environments.find(e => e.id === envId);
    return env?.name || envId;
  };

  const getPolicyName = (policyId?: string) => {
    if (!policyId) return 'Default';
    const policy = policies.find(p => p.id === policyId);
    return policy?.name || policyId;
  };

  const getSelectedNames = <T extends { id: string; name: string }>(ids: string[], items: T[]) => {
    return ids
      .map(id => items.find(item => item.id === id)?.name || id)
      .filter(Boolean);
  };

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Security Suites</h1>
          <p className="text-gray-600 mt-1">Save and reuse complete test-run/workflow asset bundles</p>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => window.history.back()}>
            <ArrowLeft size={18} className="mr-2" />
            Back
          </Button>
          <Button onClick={openCreateModal}>
            <Plus size={18} className="mr-2" />
            New Suite
          </Button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Environment</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Policy</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Templates</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Workflows</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Accounts</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Checklists</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rules</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {suites.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-6 py-12 text-center text-gray-500">
                  No suites configured. Create one to get started.
                </td>
              </tr>
            ) : (
              suites.map(suite => (
                <tr key={suite.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="font-medium text-gray-900">{suite.name}</div>
                    {suite.description && (
                      <div className="text-sm text-gray-500">{suite.description}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">
                    {getEnvironmentName(suite.environment_id)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">
                    {getPolicyName(suite.policy_id)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">
                    {suite.template_ids.length} selected
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">
                    {suite.workflow_ids.length} selected
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">
                    {suite.account_ids?.length || 0} selected
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">
                    {suite.checklist_ids?.length || 0} selected
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">
                    {suite.security_rule_ids?.length || 0} selected
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 text-xs rounded ${
                      suite.is_enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                    }`}>
                      {suite.is_enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      <Button variant="secondary" size="sm" onClick={() => openEditModal(suite)}>
                        <Edit2 size={14} className="mr-1" />
                        Edit
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => handleDelete(suite.id)}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingSuite ? 'Edit Suite' : 'New Suite'}
        size="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              <X size={18} className="mr-2" />
              Cancel
            </Button>
            <Button onClick={handleSave}>
              <Save size={18} className="mr-2" />
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Suite Name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g., P0 regression / login flow / IDOR smoke"
              required
            />
            <Select
              label="Environment"
              value={formData.environment_id}
              onChange={(e) => setFormData({ ...formData, environment_id: e.target.value })}
              options={[
                { value: '', label: 'Select...' },
                ...environments.map(env => ({ value: env.id, label: env.name })),
              ]}
            />
          </div>

          <Input
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder="Optional description"
          />

          <Select
            label="Gate Policy"
            value={formData.policy_id}
            onChange={(e) => setFormData({ ...formData, policy_id: e.target.value })}
            options={[
              { value: '', label: 'Default Policy' },
              ...policies.map(p => ({ value: p.id, label: p.name })),
            ]}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              API Templates ({formData.template_ids.length} selected)
            </label>
            <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto p-3">
              {templates.map(template => (
                <label key={template.id} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-50 px-2 rounded">
                  <Checkbox
                    checked={formData.template_ids.includes(template.id)}
                    onChange={() => toggleSelection('template_ids', template.id)}
                  />
                  <span className="text-sm text-gray-700">{template.name}</span>
                  {template.group_name && (
                    <span className="text-xs text-gray-500">({template.group_name})</span>
                  )}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Workflows ({formData.workflow_ids.length} selected)
            </label>
            <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto p-3">
              {workflows.map(workflow => (
                <label key={workflow.id} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-50 px-2 rounded">
                  <Checkbox
                    checked={formData.workflow_ids.includes(workflow.id)}
                    onChange={() => toggleSelection('workflow_ids', workflow.id)}
                  />
                  <span className="text-sm text-gray-700">{workflow.name}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Test Accounts ({formData.account_ids.length} selected)
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSelections('account_ids', accounts.map(account => account.id))}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelections('account_ids', [])}
                  className="text-xs text-gray-600 hover:text-gray-800"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto p-3">
              {accounts.length === 0 ? (
                <p className="text-sm text-gray-500">No test accounts available.</p>
              ) : (
                accounts.map(account => (
                  <label key={account.id} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-50 px-2 rounded">
                    <Checkbox
                      checked={formData.account_ids.includes(account.id)}
                      onChange={() => toggleSelection('account_ids', account.id)}
                    />
                    <span className="text-sm text-gray-700">{account.name}</span>
                    <span className="text-xs text-gray-500">({account.status})</span>
                    <span className="text-xs text-gray-400 ml-auto">
                      {Object.keys(account.fields || {}).length} fields
                    </span>
                  </label>
                ))
              )}
            </div>
            {formData.account_ids.length > 0 && (
              <p className="mt-2 text-xs text-gray-500">
                Saved with suite: {getSelectedNames(formData.account_ids, accounts).join(', ')}
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Checklists ({formData.checklist_ids.length} selected)
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSelections('checklist_ids', checklists.map(checklist => checklist.id))}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelections('checklist_ids', [])}
                  className="text-xs text-gray-600 hover:text-gray-800"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto p-3">
              {checklists.length === 0 ? (
                <p className="text-sm text-gray-500">No checklists available.</p>
              ) : (
                checklists.map(checklist => (
                  <label key={checklist.id} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-50 px-2 rounded">
                    <Checkbox
                      checked={formData.checklist_ids.includes(checklist.id)}
                      onChange={() => toggleSelection('checklist_ids', checklist.id)}
                    />
                    <span className="text-sm text-gray-700">{checklist.name}</span>
                    <span className="text-xs text-gray-400 ml-auto">
                      {(checklist.config?.values || []).length} values
                    </span>
                  </label>
                ))
              )}
            </div>
            {formData.checklist_ids.length > 0 && (
              <p className="mt-2 text-xs text-gray-500">
                Saved with suite: {getSelectedNames(formData.checklist_ids, checklists).join(', ')}
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Security Rules ({formData.security_rule_ids.length} selected)
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSelections('security_rule_ids', securityRules.map(rule => rule.id))}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelections('security_rule_ids', [])}
                  className="text-xs text-gray-600 hover:text-gray-800"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto p-3">
              {securityRules.length === 0 ? (
                <p className="text-sm text-gray-500">No security rules available.</p>
              ) : (
                securityRules.map(rule => (
                  <label key={rule.id} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-50 px-2 rounded">
                    <Checkbox
                      checked={formData.security_rule_ids.includes(rule.id)}
                      onChange={() => toggleSelection('security_rule_ids', rule.id)}
                    />
                    <span className="text-sm text-gray-700">{rule.name}</span>
                    <span className="text-xs text-gray-400 ml-auto">
                      {(rule.payloads || []).length} payloads
                    </span>
                  </label>
                ))
              )}
            </div>
            {formData.security_rule_ids.length > 0 && (
              <p className="mt-2 text-xs text-gray-500">
                Saved with suite: {getSelectedNames(formData.security_rule_ids, securityRules).join(', ')}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
            <p className="font-medium">Suite completeness</p>
            <p className="mt-1">
              Templates and workflows may reference checklists or security rules internally. Those dependencies are auto-included on save,
              so the saved suite can be pulled back into Test Runs as one reusable package.
            </p>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={formData.is_enabled}
              onChange={(e) => setFormData({ ...formData, is_enabled: e.target.checked })}
            />
            <span className="text-sm font-medium text-gray-700">Enable Suite</span>
          </label>
        </div>
      </Modal>
    </div>
  );
}
