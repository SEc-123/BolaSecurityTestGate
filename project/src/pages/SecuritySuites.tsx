import { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, ArrowLeft, Save, X } from 'lucide-react';
import { Button, Input, Select, Checkbox } from '../components/ui/Form';
import { Modal } from '../components/ui/Modal';
import {
  environmentsService,
  apiTemplatesService,
  workflowsService,
  gatePoliciesService,
  securitySuitesService,
} from '../lib/api-service';
import type { SecuritySuite } from '../lib/api-client';
import type { Environment, ApiTemplate, Workflow, CICDGatePolicy } from '../types';

export function SecuritySuites() {
  const [suites, setSuites] = useState<SecuritySuite[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [templates, setTemplates] = useState<ApiTemplate[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [policies, setPolicies] = useState<CICDGatePolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSuite, setEditingSuite] = useState<SecuritySuite | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    environment_id: '',
    policy_id: '',
    template_ids: [] as string[],
    workflow_ids: [] as string[],
    is_enabled: true,
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [suitesData, envsData, templatesData, workflowsData, policiesData] = await Promise.all([
        securitySuitesService.list(),
        environmentsService.list(),
        apiTemplatesService.list(),
        workflowsService.list(),
        gatePoliciesService.list(),
      ]);
      setSuites(suitesData);
      setEnvironments(envsData);
      setTemplates(templatesData);
      setWorkflows(workflowsData);
      setPolicies(policiesData);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  };

  const openCreateModal = () => {
    setEditingSuite(null);
    setFormData({
      name: '',
      description: '',
      environment_id: '',
      policy_id: '',
      template_ids: [],
      workflow_ids: [],
      is_enabled: true,
    });
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
      is_enabled: suite.is_enabled,
    });
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    try {
      if (editingSuite) {
        await securitySuitesService.update(editingSuite.id, formData);
      } else {
        await securitySuitesService.create(formData as any);
      }
      setIsModalOpen(false);
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

  const toggleTemplate = (templateId: string) => {
    setFormData(prev => ({
      ...prev,
      template_ids: prev.template_ids.includes(templateId)
        ? prev.template_ids.filter(id => id !== templateId)
        : [...prev.template_ids, templateId],
    }));
  };

  const toggleWorkflow = (workflowId: string) => {
    setFormData(prev => ({
      ...prev,
      workflow_ids: prev.workflow_ids.includes(workflowId)
        ? prev.workflow_ids.filter(id => id !== workflowId)
        : [...prev.workflow_ids, workflowId],
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

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Security Suites</h1>
          <p className="text-gray-600 mt-1">Configure test suites for CI/CD gate checks</p>
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
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {suites.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
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
              placeholder="e.g., P0, P1, regression"
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
                    onChange={() => toggleTemplate(template.id)}
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
                    onChange={() => toggleWorkflow(workflow.id)}
                  />
                  <span className="text-sm text-gray-700">{workflow.name}</span>
                </label>
              ))}
            </div>
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
