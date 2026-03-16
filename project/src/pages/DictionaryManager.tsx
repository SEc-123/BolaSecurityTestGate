import { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Search, ToggleLeft, ToggleRight, AlertCircle } from 'lucide-react';
import { dictionaryService, type DictionaryRule } from '../lib/api-client';

const CATEGORY_COLORS: Record<string, string> = {
  IDENTITY: 'bg-red-100 text-red-800',
  FLOW_TICKET: 'bg-amber-100 text-amber-800',
  OBJECT_ID: 'bg-blue-100 text-blue-800',
  NOISE: 'bg-gray-100 text-gray-600',
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  IDENTITY: 'Authentication tokens, session IDs, API keys',
  FLOW_TICKET: 'CSRF tokens, nonces, challenge IDs',
  OBJECT_ID: 'User IDs, order IDs, UUIDs',
  NOISE: 'Timestamps, status codes, request IDs',
};

export default function DictionaryManager() {
  const [rules, setRules] = useState<DictionaryRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState<DictionaryRule | null>(null);
  const [testInput, setTestInput] = useState('');
  const [testResult, setTestResult] = useState<{ match: boolean; rule?: DictionaryRule } | null>(null);

  const [formData, setFormData] = useState({
    pattern: '',
    category: 'GENERIC' as DictionaryRule['category'],
    priority: 50,
    is_enabled: true,
    notes: '',
    scope: 'global' as 'global' | 'project',
  });

  useEffect(() => {
    loadRules();
  }, []);

  async function loadRules() {
    try {
      setLoading(true);
      const data = await dictionaryService.list();
      setRules(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function openCreateModal() {
    setEditingRule(null);
    setFormData({
      pattern: '',
      category: 'OBJECT_ID',
      priority: 50,
      is_enabled: true,
      notes: '',
      scope: 'global',
    });
    setShowModal(true);
  }

  function openEditModal(rule: DictionaryRule) {
    setEditingRule(rule);
    setFormData({
      pattern: rule.pattern,
      category: rule.category,
      priority: rule.priority,
      is_enabled: Boolean(rule.is_enabled),
      notes: rule.notes || '',
      scope: rule.scope,
    });
    setShowModal(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editingRule) {
        await dictionaryService.update(editingRule.id, formData);
      } else {
        await dictionaryService.create(formData);
      }
      setShowModal(false);
      loadRules();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this rule?')) return;
    try {
      await dictionaryService.delete(id);
      loadRules();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleToggleEnabled(rule: DictionaryRule) {
    try {
      await dictionaryService.update(rule.id, { is_enabled: !rule.is_enabled });
      loadRules();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function testPattern() {
    if (!testInput.trim()) {
      setTestResult(null);
      return;
    }

    const enabledRules = rules
      .filter(r => r.is_enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const rule of enabledRules) {
      try {
        const regex = new RegExp(rule.pattern);
        if (regex.test(testInput)) {
          setTestResult({ match: true, rule });
          return;
        }
      } catch {}
    }

    setTestResult({ match: false });
  }

  const filteredRules = rules.filter(rule => {
    const matchesSearch = rule.pattern.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          (rule.notes?.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesCategory = categoryFilter === 'all' || rule.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Field Dictionary</h1>
          <p className="mt-1 text-sm text-gray-500">
            Define patterns to classify fields during workflow learning
          </p>
        </div>
        <button
          onClick={openCreateModal}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Rule
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 flex items-start">
          <AlertCircle className="h-5 w-5 text-red-500 mr-3 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="bg-white shadow rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-700 mb-3">Test Field Name</h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={testInput}
            onChange={e => setTestInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && testPattern()}
            placeholder="Enter a field name to test (e.g., access_token, user_id)"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
          />
          <button
            onClick={testPattern}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md text-sm hover:bg-gray-200"
          >
            Test
          </button>
        </div>
        {testResult && (
          <div className={`mt-3 p-3 rounded-md text-sm ${testResult.match ? 'bg-green-50 text-green-800' : 'bg-gray-50 text-gray-600'}`}>
            {testResult.match ? (
              <>
                <span className="font-medium">Match found!</span>
                {testResult.rule && (
                  <span className="ml-2">
                    Category: <span className={`px-2 py-0.5 rounded text-xs font-medium ${CATEGORY_COLORS[testResult.rule.category]}`}>
                      {testResult.rule.category}
                    </span>
                    <span className="ml-2 text-gray-500">Pattern: {testResult.rule.pattern}</span>
                  </span>
                )}
              </>
            ) : (
              <span>No matching rule found. Field would be classified as GENERIC.</span>
            )}
          </div>
        )}
      </div>

      <div className="bg-white shadow rounded-lg">
        <div className="p-4 border-b border-gray-200">
          <div className="flex gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="Search patterns..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="all">All Categories</option>
              <option value="IDENTITY">Identity</option>
              <option value="FLOW_TICKET">Flow Ticket</option>
              <option value="OBJECT_ID">Object ID</option>
              <option value="NOISE">Noise</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pattern</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Priority</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Notes</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredRules.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                    {rules.length === 0 ? 'No rules defined yet' : 'No rules match your filters'}
                  </td>
                </tr>
              ) : (
                filteredRules.map(rule => (
                  <tr key={rule.id} className={!rule.is_enabled ? 'bg-gray-50 opacity-60' : ''}>
                    <td className="px-6 py-4">
                      <code className="text-sm font-mono bg-gray-100 px-2 py-1 rounded">{rule.pattern}</code>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 text-xs font-medium rounded ${CATEGORY_COLORS[rule.category]}`}>
                        {rule.category}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">{rule.priority}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">{rule.notes || '-'}</td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => handleToggleEnabled(rule)}
                        className="text-gray-500 hover:text-gray-700"
                        title={rule.is_enabled ? 'Disable' : 'Enable'}
                      >
                        {rule.is_enabled ? (
                          <ToggleRight className="h-5 w-5 text-green-600" />
                        ) : (
                          <ToggleLeft className="h-5 w-5 text-gray-400" />
                        )}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => openEditModal(rule)}
                        className="text-blue-600 hover:text-blue-800 mr-3"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(rule.id)}
                        className="text-red-600 hover:text-red-800"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white shadow rounded-lg p-6">
        <h3 className="text-sm font-medium text-gray-900 mb-4">Category Reference</h3>
        <div className="grid grid-cols-2 gap-4">
          {Object.entries(CATEGORY_DESCRIPTIONS).map(([category, description]) => (
            <div key={category} className="flex items-start space-x-3">
              <span className={`px-2 py-1 text-xs font-medium rounded ${CATEGORY_COLORS[category]}`}>
                {category}
              </span>
              <span className="text-sm text-gray-600">{description}</span>
            </div>
          ))}
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-medium text-gray-900">
                {editingRule ? 'Edit Rule' : 'Add New Rule'}
              </h3>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="px-6 py-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Pattern (Regex)
                  </label>
                  <input
                    type="text"
                    value={formData.pattern}
                    onChange={e => setFormData(prev => ({ ...prev, pattern: e.target.value }))}
                    placeholder="(?i)^(token|jwt|session)$"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:ring-blue-500 focus:border-blue-500"
                    required
                  />
                  <p className="mt-1 text-xs text-gray-500">Use (?i) for case-insensitive matching</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Category
                  </label>
                  <select
                    value={formData.category}
                    onChange={e => setFormData(prev => ({ ...prev, category: e.target.value as DictionaryRule['category'] }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="IDENTITY">Identity (tokens, sessions)</option>
                    <option value="FLOW_TICKET">Flow Ticket (CSRF, nonce)</option>
                    <option value="OBJECT_ID">Object ID (user_id, order_id)</option>
                    <option value="NOISE">Noise (timestamp, status)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Priority (0-100)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={formData.priority}
                    onChange={e => setFormData(prev => ({ ...prev, priority: parseInt(e.target.value) || 0 }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="mt-1 text-xs text-gray-500">Higher priority rules are evaluated first</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Notes
                  </label>
                  <textarea
                    value={formData.notes}
                    onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder="Description of what this pattern matches"
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="is_enabled"
                    checked={formData.is_enabled}
                    onChange={e => setFormData(prev => ({ ...prev, is_enabled: e.target.checked }))}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="is_enabled" className="ml-2 text-sm text-gray-700">
                    Enable this rule
                  </label>
                </div>
              </div>
              <div className="px-6 py-4 border-t border-gray-200 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700"
                >
                  {editingRule ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
