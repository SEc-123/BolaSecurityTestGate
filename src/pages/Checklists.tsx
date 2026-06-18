import { useEffect, useState } from 'react';
import { Plus, Edit2, Trash2 } from 'lucide-react';
import { Table } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { Button, Input, TextArea } from '../components/ui/Form';
import { checklistsService } from '../lib/api-service';
import type { Checklist } from '../types';

export function Checklists() {
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<Partial<Checklist>>({
    config: { values: [] }
  });
  const [valuesText, setValuesText] = useState('');

  useEffect(() => {
    checklistsService.list().then(setChecklists).catch(console.error).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!formData.name) {
      alert('Checklist name is required');
      return;
    }

    const values = valuesText
      .split('\n')
      .map(v => v.trim())
      .filter(v => v.length > 0);

    if (values.length === 0) {
      alert('Please enter at least one value');
      return;
    }

    try {
      const checklistData = {
        ...formData,
        config: { values }
      };

      const result = editingId
        ? await checklistsService.update(editingId, checklistData)
        : await checklistsService.create(checklistData as any);

      setChecklists(editingId ? checklists.map(c => c.id === editingId ? result : c) : [result, ...checklists]);
      handleCloseModal();
    } catch (error) {
      console.error(error);
      alert('Failed to save checklist');
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
    setFormData({ config: { values: [] } });
    setValuesText('');
  };

  const handleEdit = (checklist: Checklist) => {
    setEditingId(checklist.id);
    setFormData(checklist);
    setValuesText(checklist.config.values.join('\n'));
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this checklist?')) return;
    try {
      await checklistsService.delete(id);
      setChecklists(checklists.filter(c => c.id !== id));
    } catch (e) {
      console.error(e);
      alert('Failed to delete');
    }
  };

  const columns = [
    { key: 'name' as const, label: 'Name' },
    {
      key: 'config' as const,
      label: 'Values',
      render: (config: { values: string[] }) => {
        const count = config.values?.length || 0;
        return (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">{count} value{count !== 1 ? 's' : ''}</span>
            {count > 0 && (
              <div className="flex gap-1">
                {config.values.slice(0, 3).map((val, idx) => (
                  <span key={idx} className="px-2 py-0.5 bg-gray-100 text-xs rounded">
                    {val}
                  </span>
                ))}
                {count > 3 && (
                  <span className="px-2 py-0.5 text-xs text-gray-500">
                    +{count - 3} more
                  </span>
                )}
              </div>
            )}
          </div>
        );
      }
    },
    {
      key: 'description' as const,
      label: 'Description',
      render: (v: string) => (
        <span className="text-sm text-gray-600">{v || '-'}</span>
      )
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: Checklist) => (
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
      )
    }
  ];

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">Checklists</h1>
          <p className="text-gray-600 mt-1">Manage value lists for variable fuzzing</p>
        </div>
        <Button
          onClick={() => {
            handleCloseModal();
            setIsModalOpen(true);
          }}
          size="lg"
        >
          <Plus size={20} className="mr-2" />
          New Checklist
        </Button>
      </div>
      <Table columns={columns} data={checklists} loading={loading} />

      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={editingId ? 'Edit Checklist' : 'Create Checklist'}
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseModal}>
              Cancel
            </Button>
            <Button onClick={handleSave}>Save</Button>
          </>
        }
      >
        <Input
          label="Checklist Name"
          value={formData.name || ''}
          onChange={e => setFormData({ ...formData, name: e.target.value })}
          placeholder="e.g., User IDs, Order IDs, Device IDs"
        />

        <TextArea
          label="Values (one per line)"
          value={valuesText}
          onChange={e => setValuesText(e.target.value)}
          rows={15}
          placeholder={`user_001\nuser_002\nuser_003\n...\n\nOr any other values:\norder_1001\norder_1002\norder_1003`}
        />
        <p className="text-xs text-gray-500 -mt-2">
          Each line will be treated as one value. Empty lines will be ignored.
        </p>

        <TextArea
          label="Description (optional)"
          value={formData.description || ''}
          onChange={e => setFormData({ ...formData, description: e.target.value })}
          rows={2}
          placeholder="e.g., IDs used for fuzzing / replay / access control tests"
        />

        {valuesText && (
          <div className="p-3 bg-gray-50 rounded-lg border">
            <div className="text-sm font-medium mb-1">Preview</div>
            <div className="text-xs text-gray-600">
              {valuesText.split('\n').filter(v => v.trim()).length} values will be saved
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
