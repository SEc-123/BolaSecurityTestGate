import { useEffect, useState } from 'react';
import { Plus, Edit2, Trash2 } from 'lucide-react';
import { Table } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { Button, Input, TextArea } from '../components/ui/Form';
import { securityRulesService } from '../lib/api-service';
import type { SecurityRule } from '../types';

export function SecurityRules() {
  const [rules, setRules] = useState<SecurityRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<Partial<SecurityRule>>({
    payloads: []
  });
  const [payloadsText, setPayloadsText] = useState('');

  useEffect(() => {
    securityRulesService.list().then(setRules).catch(console.error).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!formData.name) {
      alert('Rule name is required');
      return;
    }

    const payloads = payloadsText
      .split('\n')
      .map(v => v.trim())
      .filter(v => v.length > 0);

    if (payloads.length === 0) {
      alert('Please enter at least one payload');
      return;
    }

    try {
      const ruleData = {
        ...formData,
        payloads
      };

      const result = editingId
        ? await securityRulesService.update(editingId, ruleData)
        : await securityRulesService.create(ruleData as any);

      setRules(editingId ? rules.map(r => r.id === editingId ? result : r) : [result, ...rules]);
      handleCloseModal();
    } catch (error) {
      console.error(error);
      alert('Failed to save security rule');
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
    setFormData({ payloads: [] });
    setPayloadsText('');
  };

  const handleEdit = (rule: SecurityRule) => {
    setEditingId(rule.id);
    setFormData(rule);
    setPayloadsText(rule.payloads.join('\n'));
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this security rule?')) return;
    try {
      await securityRulesService.delete(id);
      setRules(rules.filter(r => r.id !== id));
    } catch (e) {
      console.error(e);
      alert('Failed to delete');
    }
  };

  const columns = [
    { key: 'name' as const, label: 'Name' },
    {
      key: 'payloads' as const,
      label: 'Payloads',
      render: (payloads: string[]) => {
        const count = payloads?.length || 0;
        return (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">{count} payload{count !== 1 ? 's' : ''}</span>
            {count > 0 && (
              <div className="flex gap-1">
                {payloads.slice(0, 2).map((val, idx) => (
                  <span key={idx} className="px-2 py-0.5 bg-red-50 text-xs rounded font-mono text-red-700">
                    {val.length > 20 ? val.substring(0, 20) + '...' : val}
                  </span>
                ))}
                {count > 2 && (
                  <span className="px-2 py-0.5 text-xs text-gray-500">
                    +{count - 2} more
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
      render: (_: string, row: SecurityRule) => (
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
          <h1 className="text-3xl font-bold">Security Rules</h1>
          <p className="text-gray-600 mt-1">Security test payloads for fuzzing (SQL injection, XSS, etc.)</p>
        </div>
        <Button
          onClick={() => {
            handleCloseModal();
            setIsModalOpen(true);
          }}
          size="lg"
        >
          <Plus size={20} className="mr-2" />
          New Security Rule
        </Button>
      </div>
      <Table columns={columns} data={rules} loading={loading} />

      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={editingId ? 'Edit Security Rule' : 'Create Security Rule'}
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
          label="Rule Name"
          value={formData.name || ''}
          onChange={e => setFormData({ ...formData, name: e.target.value })}
          placeholder="e.g., SQL Injection, XSS, Command Injection"
        />

        <TextArea
          label="Payloads (one per line)"
          value={payloadsText}
          onChange={e => setPayloadsText(e.target.value)}
          rows={15}
          placeholder={`' OR '1'='1\n' OR 1=1--\nadmin'--\n<script>alert(1)</script>\n; ls -la\n../../../etc/passwd`}
        />
        <p className="text-xs text-gray-500 -mt-2">
          These payloads will be appended to original values during testing
        </p>

        <TextArea
          label="Description (optional)"
          value={formData.description || ''}
          onChange={e => setFormData({ ...formData, description: e.target.value })}
          rows={2}
          placeholder="e.g., Common SQL injection attack patterns"
        />

        {payloadsText && (
          <div className="p-3 bg-red-50 rounded-lg border border-red-200">
            <div className="text-sm font-medium mb-1 text-red-900">Preview</div>
            <div className="text-xs text-red-700">
              {payloadsText.split('\n').filter(v => v.trim()).length} payloads will be saved
            </div>
            <div className="text-xs text-red-600 mt-1">
              These will be appended to field values during security testing
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
