import { useState } from 'react';
import { Plus, Edit2, Trash2, Power, PowerOff } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button, Input, Select, TextArea, Checkbox } from './ui/Form';
import { Table } from './ui/Table';
import { suppressionRulesService } from '../lib/api-service';
import type { FindingSuppressionRule } from '../types';

interface SuppressionRulesManagerProps {
  rules: FindingSuppressionRule[];
  onUpdate: () => void;
}

export function SuppressionRulesManager({ rules, onUpdate }: SuppressionRulesManagerProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<FindingSuppressionRule | null>(null);
  const [formData, setFormData] = useState<Partial<FindingSuppressionRule>>({
    name: '',
    description: '',
    is_enabled: true,
    applies_to: 'both',
    match_method: 'ANY',
    match_type: 'prefix',
    match_path: '',
    match_service_id: '',
  });

  const handleCreate = () => {
    setEditingRule(null);
    setFormData({
      name: '',
      description: '',
      is_enabled: true,
      applies_to: 'both',
      match_method: 'ANY',
      match_type: 'prefix',
      match_path: '',
      match_service_id: '',
    });
    setIsModalOpen(true);
  };

  const handleEdit = (rule: FindingSuppressionRule) => {
    setEditingRule(rule);
    setFormData(rule);
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    try {
      if (editingRule) {
        await suppressionRulesService.update(editingRule.id, formData);
      } else {
        await suppressionRulesService.create(formData as Omit<FindingSuppressionRule, 'id' | 'created_at' | 'updated_at'>);
      }
      setIsModalOpen(false);
      onUpdate();
    } catch (error) {
      console.error('Failed to save rule:', error);
      alert('Failed to save rule');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this suppression rule?')) return;
    try {
      await suppressionRulesService.delete(id);
      onUpdate();
    } catch (error) {
      console.error('Failed to delete rule:', error);
      alert('Failed to delete rule');
    }
  };

  const handleToggleEnabled = async (rule: FindingSuppressionRule) => {
    try {
      await suppressionRulesService.update(rule.id, { is_enabled: !rule.is_enabled });
      onUpdate();
    } catch (error) {
      console.error('Failed to toggle rule:', error);
      alert('Failed to toggle rule');
    }
  };

  const columns = [
    {
      key: 'name' as const,
      label: 'Name',
      render: (value: string) => <span className="font-medium">{value}</span>,
    },
    {
      key: 'is_enabled' as const,
      label: 'Status',
      render: (value: boolean) => (
        <span className={`px-2 py-1 text-xs font-medium rounded ${
          value ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
        }`}>
          {value ? 'Enabled' : 'Disabled'}
        </span>
      ),
    },
    {
      key: 'applies_to' as const,
      label: 'Applies To',
      render: (value: string) => (
        <span className="text-sm capitalize">{value.replace('_', ' ')}</span>
      ),
    },
    {
      key: 'match_type' as const,
      label: 'Match Type',
      render: (value: string) => (
        <span className="text-sm capitalize">{value}</span>
      ),
    },
    {
      key: 'match_path' as const,
      label: 'Path',
      render: (value: string) => value || '-',
    },
    {
      key: 'match_service_id' as const,
      label: 'Service ID',
      render: (value: string) => value || '-',
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: FindingSuppressionRule) => (
        <div className="flex gap-2">
          <button
            onClick={() => handleToggleEnabled(row)}
            className={`p-1 rounded ${
              row.is_enabled
                ? 'hover:bg-orange-100 text-orange-600'
                : 'hover:bg-green-100 text-green-600'
            }`}
            title={row.is_enabled ? 'Disable' : 'Enable'}
          >
            {row.is_enabled ? <PowerOff size={16} /> : <Power size={16} />}
          </button>
          <button
            onClick={() => handleEdit(row)}
            className="p-1 hover:bg-blue-100 rounded text-blue-600"
          >
            <Edit2 size={16} />
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

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Suppression Rules</h3>
          <p className="text-sm text-gray-600">
            Configure rules to automatically suppress noisy findings
          </p>
        </div>
        <Button onClick={handleCreate}>
          <Plus size={16} className="mr-2" />
          New Rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg">
          <p className="text-gray-600">No suppression rules configured yet</p>
          <Button onClick={handleCreate} variant="secondary" size="sm" className="mt-4">
            Create First Rule
          </Button>
        </div>
      ) : (
        <Table columns={columns} data={rules} />
      )}

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingRule ? 'Edit Suppression Rule' : 'Create Suppression Rule'}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave}>
              {editingRule ? 'Update' : 'Create'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Rule Name"
            value={formData.name || ''}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="e.g., Suppress health-check noise"
            required
          />

          <TextArea
            label="Description"
            value={formData.description || ''}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder="Optional description"
            rows={2}
          />

          <div className="flex items-center gap-4">
            <Checkbox
              label="Enabled"
              checked={formData.is_enabled}
              onChange={(e) => setFormData({ ...formData, is_enabled: e.target.checked })}
            />
          </div>

          <Select
            label="Applies To"
            value={formData.applies_to || 'both'}
            onChange={(e) => setFormData({ ...formData, applies_to: e.target.value as any })}
          >
            <option value="both">Both API & Workflow</option>
            <option value="test_run">API Findings Only</option>
            <option value="workflow">Workflow Findings Only</option>
          </Select>

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="HTTP Method"
              value={formData.match_method || 'ANY'}
              onChange={(e) => setFormData({ ...formData, match_method: e.target.value })}
            >
              <option value="ANY">ANY</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
              <option value="PATCH">PATCH</option>
            </Select>

            <Select
              label="Match Type"
              value={formData.match_type || 'prefix'}
              onChange={(e) => setFormData({ ...formData, match_type: e.target.value as any })}
            >
              <option value="exact">Exact Match</option>
              <option value="prefix">Prefix Match</option>
              <option value="contains">Contains</option>
              <option value="regex">Regex</option>
            </Select>
          </div>

          <Input
            label="Path Pattern"
            value={formData.match_path || ''}
            onChange={(e) => setFormData({ ...formData, match_path: e.target.value })}
            placeholder="e.g., /api/v1/health"
          />

          <Input
            label="Service ID"
            value={formData.match_service_id || ''}
            onChange={(e) => setFormData({ ...formData, match_service_id: e.target.value })}
            placeholder="e.g., order-service"
          />

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800">
              <strong>Note:</strong> Enabled rules will automatically suppress findings that match
              the configured criteria. Suppressed findings are hidden by default but can be viewed
              by toggling "Show suppressed" on the Findings page.
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
