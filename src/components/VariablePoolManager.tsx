import { useState, useEffect } from 'react';
import { Plus, Trash2, Lock, Unlock, AlertCircle } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button, Input, Select, TextArea, Checkbox } from './ui/Form';
import {
  workflowVariablesService,
  workflowMappingsService,
  type WorkflowVariable,
  type WorkflowMapping,
} from '../lib/api-client';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  workflowId: string;
  workflowName: string;
  workflowSteps: { stepOrder: number; name: string }[];
}

const TYPE_COLORS: Record<string, string> = {
  IDENTITY: 'bg-red-100 text-red-800',
  FLOW_TICKET: 'bg-amber-100 text-amber-800',
  OBJECT_ID: 'bg-blue-100 text-blue-800',
  GENERIC: 'bg-gray-100 text-gray-600',
};

export function VariablePoolManager({ isOpen, onClose, workflowId, workflowName, workflowSteps }: Props) {
  const [variables, setVariables] = useState<WorkflowVariable[]>([]);
  const [mappings, setMappings] = useState<WorkflowMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'variables' | 'mappings'>('variables');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingVariable, setEditingVariable] = useState<WorkflowVariable | null>(null);
  const [showAddMappingModal, setShowAddMappingModal] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    type: 'GENERIC' as WorkflowVariable['type'],
    source: 'manual' as WorkflowVariable['source'],
    write_policy: 'overwrite' as WorkflowVariable['write_policy'],
    is_locked: false,
    description: '',
    current_value: '',
  });

  const [mappingFormData, setMappingFormData] = useState({
    from_step_order: 1,
    from_location: 'response.body',
    from_path: '',
    to_step_order: 2,
    to_location: 'request.body',
    to_path: '',
    variable_name: '',
    confidence: 1.0,
  });

  useEffect(() => {
    if (isOpen && workflowId) {
      loadData();
    }
  }, [isOpen, workflowId]);

  async function loadData() {
    try {
      setLoading(true);
      const [varsData, mapsData] = await Promise.all([
        workflowVariablesService.list(workflowId),
        workflowMappingsService.list(workflowId),
      ]);
      setVariables(varsData);
      setMappings(mapsData);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function openAddModal() {
    setEditingVariable(null);
    setFormData({
      name: '',
      type: 'GENERIC',
      source: 'manual',
      write_policy: 'overwrite',
      is_locked: false,
      description: '',
      current_value: '',
    });
    setShowAddModal(true);
  }

  function openEditModal(variable: WorkflowVariable) {
    setEditingVariable(variable);
    setFormData({
      name: variable.name,
      type: variable.type,
      source: variable.source,
      write_policy: variable.write_policy,
      is_locked: Boolean(variable.is_locked),
      description: variable.description || '',
      current_value: variable.current_value || '',
    });
    setShowAddModal(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editingVariable) {
        await workflowVariablesService.update(workflowId, editingVariable.id, formData);
      } else {
        await workflowVariablesService.create(workflowId, formData);
      }
      setShowAddModal(false);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleDeleteVariable(id: string) {
    if (!confirm('Delete this variable? Associated mappings will also be removed.')) return;
    try {
      await workflowVariablesService.delete(workflowId, id);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleToggleLock(variable: WorkflowVariable) {
    try {
      await workflowVariablesService.update(workflowId, variable.id, {
        is_locked: !variable.is_locked,
      });
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleToggleMappingEnabled(mapping: WorkflowMapping) {
    try {
      await workflowMappingsService.update(workflowId, mapping.id, {
        is_enabled: !mapping.is_enabled,
      });
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleDeleteMapping(id: string) {
    if (!confirm('Delete this mapping?')) return;
    try {
      await workflowMappingsService.delete(workflowId, id);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function openAddMappingModal() {
    setMappingFormData({
      from_step_order: 1,
      from_location: 'response.body',
      from_path: '',
      to_step_order: 2,
      to_location: 'request.body',
      to_path: '',
      variable_name: '',
      confidence: 1.0,
    });
    setShowAddMappingModal(true);
  }

  async function handleSubmitMapping(e: React.FormEvent) {
    e.preventDefault();
    if (!mappingFormData.from_path.trim() || !mappingFormData.to_path.trim() || !mappingFormData.variable_name.trim()) {
      alert('Please fill in all required fields');
      return;
    }

    try {
      await workflowMappingsService.create(workflowId, {
        from_step_order: mappingFormData.from_step_order,
        from_location: mappingFormData.from_location,
        from_path: mappingFormData.from_path.trim(),
        to_step_order: mappingFormData.to_step_order,
        to_location: mappingFormData.to_location,
        to_path: mappingFormData.to_path.trim(),
        variable_name: mappingFormData.variable_name.trim(),
        confidence: mappingFormData.confidence,
        reason: 'manual',
        is_enabled: true,
      });
      setShowAddMappingModal(false);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const getStepName = (stepOrder: number) => {
    const step = workflowSteps.find(s => s.stepOrder === stepOrder);
    return step?.name || `Step ${stepOrder}`;
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={`Variable Pool: ${workflowName}`}
        size="xl"
        footer={
          <Button variant="secondary" onClick={onClose}>Close</Button>
        }
      >
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
            <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <div className="mb-4 border-b border-gray-200">
          <nav className="-mb-px flex gap-4">
            <button
              onClick={() => setActiveTab('variables')}
              className={`pb-3 px-1 text-sm font-medium border-b-2 ${
                activeTab === 'variables'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Variables ({variables.length})
            </button>
            <button
              onClick={() => setActiveTab('mappings')}
              className={`pb-3 px-1 text-sm font-medium border-b-2 ${
                activeTab === 'mappings'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Mappings ({mappings.length})
            </button>
          </nav>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : activeTab === 'variables' ? (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button size="sm" onClick={openAddModal}>
                <Plus size={14} className="mr-1" />
                Add Variable
              </Button>
            </div>

            {variables.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No variables defined yet. Run learning mode or add variables manually.
              </div>
            ) : (
              <div className="space-y-2">
                {variables.map(variable => (
                  <div
                    key={variable.id}
                    className="p-3 border border-gray-200 rounded-lg hover:bg-gray-50"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 text-xs font-medium rounded ${TYPE_COLORS[variable.type]}`}>
                          {variable.type}
                        </span>
                        <code className="font-mono text-sm font-medium">{variable.name}</code>
                        {variable.is_locked && (
                          <Lock size={14} className="text-amber-500" />
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleToggleLock(variable)}
                          className={`p-1 rounded hover:bg-gray-200 ${variable.is_locked ? 'text-amber-500' : 'text-gray-400'}`}
                          title={variable.is_locked ? 'Unlock' : 'Lock'}
                        >
                          {variable.is_locked ? <Lock size={16} /> : <Unlock size={16} />}
                        </button>
                        <button
                          onClick={() => openEditModal(variable)}
                          className="p-1 hover:bg-blue-100 rounded text-blue-600"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteVariable(variable.id)}
                          className="p-1 hover:bg-red-100 rounded text-red-600"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-gray-500">
                      <div>Source: <span className="text-gray-700">{variable.source}</span></div>
                      <div>Write Policy: <span className="text-gray-700">{variable.write_policy}</span></div>
                      {variable.current_value && (
                        <div className="truncate">
                          Value: <span className="text-gray-700 font-mono">{variable.current_value}</span>
                        </div>
                      )}
                    </div>
                    {variable.description && (
                      <p className="mt-1 text-xs text-gray-500">{variable.description}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button size="sm" onClick={openAddMappingModal}>
                <Plus size={14} className="mr-1" />
                Add Mapping
              </Button>
            </div>

            {mappings.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No mappings defined yet. Run learning mode to discover mappings.
              </div>
            ) : (
              <div className="space-y-2">
                {mappings.map(mapping => (
                  <div
                    key={mapping.id}
                    className={`p-3 border rounded-lg ${mapping.is_enabled ? 'border-gray-200' : 'border-gray-100 bg-gray-50 opacity-60'}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <code className="font-mono text-sm font-medium text-blue-600">
                            {mapping.variable_name}
                          </code>
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            mapping.confidence >= 0.8 ? 'bg-green-100 text-green-700' :
                            mapping.confidence >= 0.5 ? 'bg-amber-100 text-amber-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {(mapping.confidence * 100).toFixed(0)}%
                          </span>
                          <span className="text-xs text-gray-500">({mapping.reason})</span>
                        </div>
                        <div className="text-sm flex items-center gap-2">
                          <div className="flex-1 p-2 bg-gray-50 rounded text-xs">
                            <div className="text-gray-500">
                              Step {mapping.from_step_order}: {getStepName(mapping.from_step_order)}
                            </div>
                            <code className="font-mono">{mapping.from_location} / {mapping.from_path}</code>
                          </div>
                          <span className="text-gray-400">→</span>
                          <div className="flex-1 p-2 bg-gray-50 rounded text-xs">
                            <div className="text-gray-500">
                              Step {mapping.to_step_order}: {getStepName(mapping.to_step_order)}
                            </div>
                            <code className="font-mono">{mapping.to_location} / {mapping.to_path}</code>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-3">
                        <Checkbox
                          checked={Boolean(mapping.is_enabled)}
                          onChange={() => handleToggleMappingEnabled(mapping)}
                          label=""
                        />
                        <button
                          onClick={() => handleDeleteMapping(mapping.id)}
                          className="p-1 hover:bg-red-100 rounded text-red-600"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title={editingVariable ? 'Edit Variable' : 'Add Variable'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowAddModal(false)}>Cancel</Button>
            <Button onClick={handleSubmit}>{editingVariable ? 'Update' : 'Create'}</Button>
          </>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Variable Name"
            value={formData.name}
            onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
            placeholder="e.g., auth.token, obj.userId"
            required
          />

          <Select
            label="Type"
            value={formData.type}
            onChange={e => setFormData(prev => ({ ...prev, type: e.target.value as WorkflowVariable['type'] }))}
            options={[
              { value: 'IDENTITY', label: 'Identity (auth tokens, sessions)' },
              { value: 'FLOW_TICKET', label: 'Flow Ticket (CSRF, nonce)' },
              { value: 'OBJECT_ID', label: 'Object ID (user_id, order_id)' },
              { value: 'GENERIC', label: 'Generic' },
            ]}
          />

          <Select
            label="Source"
            value={formData.source}
            onChange={e => setFormData(prev => ({ ...prev, source: e.target.value as WorkflowVariable['source'] }))}
            options={[
              { value: 'account_injected', label: 'Account Injected (from test account)' },
              { value: 'extracted', label: 'Extracted (from response)' },
              { value: 'manual', label: 'Manual (static value)' },
            ]}
          />

          <Select
            label="Write Policy"
            value={formData.write_policy}
            onChange={e => setFormData(prev => ({ ...prev, write_policy: e.target.value as WorkflowVariable['write_policy'] }))}
            options={[
              { value: 'first', label: 'First (keep first extracted value)' },
              { value: 'overwrite', label: 'Overwrite (use latest value)' },
              { value: 'on_success_only', label: 'On Success Only (update only on 2xx)' },
            ]}
          />

          <Input
            label="Current Value (optional)"
            value={formData.current_value}
            onChange={e => setFormData(prev => ({ ...prev, current_value: e.target.value }))}
            placeholder="Initial or manual value"
          />

          <TextArea
            label="Description"
            value={formData.description}
            onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
            placeholder="What is this variable used for?"
            rows={2}
          />

          <Checkbox
            label="Lock variable (prevent updates during execution)"
            checked={formData.is_locked}
            onChange={e => setFormData(prev => ({ ...prev, is_locked: e.target.checked }))}
          />
        </form>
      </Modal>

      <Modal
        isOpen={showAddMappingModal}
        onClose={() => setShowAddMappingModal(false)}
        title="Add Mapping"
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setShowAddMappingModal(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleSubmitMapping}>
              Create Mapping
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitMapping} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-700">From (Source)</h3>
              <Select
                label="From Step"
                value={mappingFormData.from_step_order.toString()}
                onChange={e => setMappingFormData(prev => ({ ...prev, from_step_order: parseInt(e.target.value) }))}
                options={workflowSteps.map(s => ({ value: s.stepOrder.toString(), label: `Step ${s.stepOrder}: ${s.name}` }))}
              />
              <Select
                label="From Location"
                value={mappingFormData.from_location}
                onChange={e => setMappingFormData(prev => ({ ...prev, from_location: e.target.value }))}
                options={[
                  { value: 'response.body', label: 'Response Body' },
                  { value: 'response.header', label: 'Response Header' },
                  { value: 'response.cookie', label: 'Response Cookie' },
                ]}
              />
              <Input
                label="From Path"
                value={mappingFormData.from_path}
                onChange={e => setMappingFormData(prev => ({ ...prev, from_path: e.target.value }))}
                placeholder="e.g., data.token or set-cookie.session"
                required
              />
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-700">To (Target)</h3>
              <Select
                label="To Step"
                value={mappingFormData.to_step_order.toString()}
                onChange={e => setMappingFormData(prev => ({ ...prev, to_step_order: parseInt(e.target.value) }))}
                options={workflowSteps.map(s => ({ value: s.stepOrder.toString(), label: `Step ${s.stepOrder}: ${s.name}` }))}
              />
              <Select
                label="To Location"
                value={mappingFormData.to_location}
                onChange={e => setMappingFormData(prev => ({ ...prev, to_location: e.target.value }))}
                options={[
                  { value: 'request.body', label: 'Request Body' },
                  { value: 'request.header', label: 'Request Header' },
                  { value: 'request.cookie', label: 'Request Cookie' },
                  { value: 'request.query', label: 'Request Query' },
                  { value: 'request.path', label: 'Request Path' },
                ]}
              />
              <Input
                label="To Path"
                value={mappingFormData.to_path}
                onChange={e => setMappingFormData(prev => ({ ...prev, to_path: e.target.value }))}
                placeholder="e.g., authorization or query.token"
                required
              />
            </div>
          </div>

          <Input
            label="Variable Name"
            value={mappingFormData.variable_name}
            onChange={e => setMappingFormData(prev => ({ ...prev, variable_name: e.target.value }))}
            placeholder="e.g., auth.token or user.id"
            required
            help="Name of the variable to store this mapping"
          />

          <div className="text-xs text-gray-500 bg-gray-50 p-3 rounded">
            This will create a manual mapping that extracts a value from the source location and injects it into the target location.
          </div>
        </form>
      </Modal>
    </>
  );
}
