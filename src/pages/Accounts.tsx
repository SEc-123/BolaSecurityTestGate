import { useEffect, useState } from 'react';
import { Plus, Edit2, Trash2, X } from 'lucide-react';
import { Table } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { Button, Input, TextArea } from '../components/ui/Form';
import { accountsService } from '../lib/api-service';
import type { Account } from '../types';

const ACCOUNT_STATUSES = ['active', 'frozen', 'blacklisted'];

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<Partial<Account>>({ status: 'active', fields: {} });
  const [newFieldKey, setNewFieldKey] = useState('');
  const [newFieldValue, setNewFieldValue] = useState('');

  useEffect(() => {
    accountsService.list().then(setAccounts).catch(console.error).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!formData.name) { alert('Account name required'); return; }
    try {
      const result = editingId ? await accountsService.update(editingId, formData) : await accountsService.create(formData as any);
      setAccounts(editingId ? accounts.map(a => a.id === editingId ? result : a) : [result, ...accounts]);
      setIsModalOpen(false);
      setEditingId(null);
      setFormData({ status: 'active', fields: {} });
      setNewFieldKey('');
      setNewFieldValue('');
    } catch (error) { console.error(error); alert('Failed to save account'); }
  };

  const handleAddField = () => {
    if (!newFieldKey || !newFieldValue) {
      alert('Both field name and value are required');
      return;
    }
    const fields = formData.fields || {};
    if (fields[newFieldKey]) {
      alert('Field already exists');
      return;
    }
    setFormData({
      ...formData,
      fields: { ...fields, [newFieldKey]: newFieldValue }
    });
    setNewFieldKey('');
    setNewFieldValue('');
  };

  const handleRemoveField = (key: string) => {
    const fields = { ...(formData.fields || {}) };
    delete fields[key];
    setFormData({ ...formData, fields });
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete?')) return;
    try { await accountsService.delete(id); setAccounts(accounts.filter(a => a.id !== id)); } catch (e) { console.error(e); }
  };

  const columns = [
    { key: 'name' as const, label: 'Account Name', render: (v: string) => v || '(Unnamed)' },
    { key: 'status' as const, label: 'Status', render: (v: string) => <span className={`px-2 py-1 text-xs rounded ${v === 'active' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{v}</span> },
    { key: 'fields' as const, label: 'Fields', render: (fields: Record<string, any>) => {
      const fieldCount = Object.keys(fields || {}).length;
      return <span className="text-sm text-gray-600">{fieldCount} field{fieldCount !== 1 ? 's' : ''}</span>;
    }},
    { key: 'id' as const, label: 'Actions', render: (_: string, row: Account) => (
      <div className="flex gap-2">
        <button onClick={() => { setEditingId(row.id); setFormData(row); setIsModalOpen(true); }} className="p-1 hover:bg-blue-100 rounded text-blue-600"><Edit2 size={16} /></button>
        <button onClick={() => handleDelete(row.id)} className="p-1 hover:bg-red-100 rounded text-red-600"><Trash2 size={16} /></button>
      </div>
    )}
  ];

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <div><h1 className="text-3xl font-bold">Test Accounts</h1><p className="text-gray-600 mt-1">Manage test accounts with custom fields</p></div>
        <Button onClick={() => { setEditingId(null); setFormData({ status: 'active', fields: {} }); setNewFieldKey(''); setNewFieldValue(''); setIsModalOpen(true); }} size="lg"><Plus size={20} className="mr-2" />New Account</Button>
      </div>
      <Table columns={columns} data={accounts} loading={loading} />
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? 'Edit Account' : 'Create Account'}
        footer={<><Button variant="secondary" onClick={() => setIsModalOpen(false)}>Cancel</Button><Button onClick={handleSave}>Save</Button></>}>
        <Input label="Account Name" value={formData.name || ''} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="e.g., User A, Test Account 1" />
        <div className="mb-4"><label className="block text-sm font-medium mb-1">Status</label>
          <select value={formData.status || 'active'} onChange={e => setFormData({ ...formData, status: e.target.value })} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
            {ACCOUNT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">Custom Fields</label>
          <div className="border rounded-lg p-3 bg-gray-50 space-y-2">
            {Object.entries(formData.fields || {}).map(([key, value]) => (
              <div key={key} className="flex items-center gap-2 bg-white p-2 rounded border">
                <span className="text-sm font-medium text-gray-700 min-w-[120px]">{key}:</span>
                <span className="text-sm text-gray-600 flex-1 truncate">{String(value)}</span>
                <button onClick={() => handleRemoveField(key)} className="text-red-600 hover:bg-red-50 p-1 rounded">
                  <X size={16} />
                </button>
              </div>
            ))}
            {Object.keys(formData.fields || {}).length === 0 && (
              <p className="text-sm text-gray-500 text-center py-2">No fields added yet</p>
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <Input label="" placeholder="Field name (e.g., userId)" value={newFieldKey} onChange={e => setNewFieldKey(e.target.value)} />
            <Input label="" placeholder="Field value" value={newFieldValue} onChange={e => setNewFieldValue(e.target.value)} />
            <Button onClick={handleAddField} size="sm" className="mt-0 whitespace-nowrap">
              <Plus size={16} className="mr-1" />Add
            </Button>
          </div>
          <p className="text-xs text-gray-500 mt-1">Common fields: userId, sessionId, deviceId, tenantId, orgId, phoneNumber</p>
        </div>

        <TextArea label="Notes" value={formData.notes || ''} onChange={e => setFormData({ ...formData, notes: e.target.value })} rows={3} />
      </Modal>
    </div>
  );
}
