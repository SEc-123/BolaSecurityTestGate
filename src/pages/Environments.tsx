import { useEffect, useState } from 'react';
import { Plus, Edit2, Trash2 } from 'lucide-react';
import { Table } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { Button, Input, TextArea, Checkbox } from '../components/ui/Form';
import { environmentsService } from '../lib/api-service';
import type { Environment } from '../types';

export function Environments() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<Partial<Environment>>({
    is_active: true,
  });

  useEffect(() => {
    loadEnvironments();
  }, []);

  const loadEnvironments = async () => {
    try {
      const data = await environmentsService.list();
      setEnvironments(data);
    } catch (error) {
      console.error('Failed to load environments:', error);
    } finally {
      setLoading(false);
    }
  };

  const validateUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  const validateForm = (): string[] => {
    const errors: string[] = [];

    if (!formData.name?.trim()) {
      errors.push('Name is required');
    }

    if (!formData.base_url?.trim()) {
      errors.push('Base URL is required');
    } else if (!validateUrl(formData.base_url)) {
      errors.push('Base URL must be a valid URL starting with http:// or https://');
    }

    return errors;
  };

  const handleCreate = async () => {
    const errors = validateForm();
    if (errors.length > 0) {
      alert('Validation errors:\n' + errors.map(e => `- ${e}`).join('\n'));
      return;
    }

    try {
      const newEnv = await environmentsService.create({
        name: formData.name!.trim(),
        base_url: formData.base_url!.trim().replace(/\/$/, ''),
        description: formData.description?.trim(),
        is_active: formData.is_active ?? true,
      });
      setEnvironments([newEnv, ...environments]);
      setIsModalOpen(false);
      resetForm();
    } catch (error: any) {
      console.error('Failed to create environment:', error);
      alert(`Failed to create environment: ${error.message || 'Unknown error'}`);
    }
  };

  const handleUpdate = async () => {
    if (!editingId) return;

    const errors = validateForm();
    if (errors.length > 0) {
      alert('Validation errors:\n' + errors.map(e => `- ${e}`).join('\n'));
      return;
    }

    try {
      const updated = await environmentsService.update(editingId, {
        name: formData.name?.trim(),
        base_url: formData.base_url?.trim().replace(/\/$/, ''),
        description: formData.description?.trim(),
        is_active: formData.is_active,
      });
      setEnvironments(environments.map((e) => (e.id === editingId ? updated : e)));
      setIsModalOpen(false);
      setEditingId(null);
      resetForm();
    } catch (error: any) {
      console.error('Failed to update environment:', error);
      alert(`Failed to update environment: ${error.message || 'Unknown error'}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure?')) return;

    try {
      await environmentsService.delete(id);
      setEnvironments(environments.filter((e) => e.id !== id));
    } catch (error) {
      console.error('Failed to delete environment:', error);
      alert('Failed to delete environment');
    }
  };

  const resetForm = () => {
    setFormData({ is_active: true });
  };

  const handleEdit = (env: Environment) => {
    setEditingId(env.id);
    setFormData(env);
    setIsModalOpen(true);
  };

  const handleOpenCreate = () => {
    setEditingId(null);
    resetForm();
    setIsModalOpen(true);
  };

  const columns = [
    { key: 'name' as const, label: 'Name' },
    { key: 'base_url' as const, label: 'Base URL' },
    { key: 'description' as const, label: 'Description' },
    {
      key: 'is_active' as const,
      label: 'Status',
      render: (value: boolean) => (
        <span
          className={`px-2 py-1 text-xs font-medium rounded ${
            value ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
          }`}
        >
          {value ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: Environment) => (
        <div className="flex gap-2">
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
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Environments</h1>
          <p className="text-gray-600 mt-1">Configure test environments</p>
        </div>
        <Button onClick={handleOpenCreate} size="lg">
          <Plus size={20} className="mr-2" />
          New Environment
        </Button>
      </div>

      <Table columns={columns} data={environments} loading={loading} onRowClick={handleEdit} />

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Environment' : 'Create Environment'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={editingId ? handleUpdate : handleCreate}>
              {editingId ? 'Update' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Environment Name"
            value={formData.name || ''}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="e.g., Test, Staging, Production"
          />

          <Input
            label="Base URL"
            value={formData.base_url || ''}
            onChange={(e) => setFormData({ ...formData, base_url: e.target.value })}
            placeholder="https://api.example.com"
          />

          <TextArea
            label="Description"
            value={formData.description || ''}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder="Describe this environment..."
          />

          <Checkbox
            label="Active"
            checked={formData.is_active}
            onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
          />
        </div>
      </Modal>
    </div>
  );
}
