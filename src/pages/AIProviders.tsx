import { useState, useEffect } from 'react';
import { Plus, Trash2, Edit, CheckCircle, XCircle, Loader } from 'lucide-react';
import { aiService, type AIProvider } from '../lib/api-service';
import { Modal } from '../components/ui/Modal';

export default function AIProviders() {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingProvider, setEditingProvider] = useState<AIProvider | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; latency?: number; error?: string }>>({});
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  const [formData, setFormData] = useState({
    name: '',
    provider_type: 'openai' as AIProvider['provider_type'],
    base_url: '',
    api_key: '',
    model: '',
    is_enabled: true,
    is_default: false
  });

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      setLoading(true);
      const data = await aiService.listProviders();
      setProviders(data);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setEditingProvider(null);
    setFormData({
      name: '',
      provider_type: 'openai',
      base_url: '',
      api_key: '',
      model: '',
      is_enabled: true,
      is_default: false
    });
    setShowModal(true);
  };

  const handleEdit = (provider: AIProvider) => {
    setEditingProvider(provider);
    setFormData({
      name: provider.name,
      provider_type: provider.provider_type,
      base_url: provider.base_url || '',
      api_key: '',
      model: provider.model,
      is_enabled: provider.is_enabled,
      is_default: provider.is_default
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const payload: any = {
        name: formData.name,
        provider_type: formData.provider_type,
        base_url: formData.base_url || undefined,
        model: formData.model,
        is_enabled: formData.is_enabled,
        is_default: formData.is_default
      };

      if (formData.api_key) {
        payload.api_key = formData.api_key;
      }

      if (editingProvider) {
        await aiService.updateProvider(editingProvider.id, payload);
      } else {
        if (!formData.api_key) {
          setError('API key is required for new providers');
          return;
        }
        payload.api_key = formData.api_key;
        await aiService.createProvider(payload);
      }

      setShowModal(false);
      await loadProviders();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this provider?')) return;

    try {
      await aiService.deleteProvider(id);
      await loadProviders();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleTest = async (id: string) => {
    setTestingIds(prev => new Set(prev).add(id));
    try {
      const result = await aiService.testConnection(id);
      setTestResults(prev => ({ ...prev, [id]: result }));
    } catch (err: any) {
      setTestResults(prev => ({ ...prev, [id]: { ok: false, error: err.message } }));
    } finally {
      setTestingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const getProviderTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      openai: 'OpenAI',
      deepseek: 'DeepSeek',
      qwen: 'Qwen (Alibaba)',
      llama: 'Llama',
      openai_compat: 'OpenAI Compatible'
    };
    return labels[type] || type;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI Providers</h1>
          <p className="mt-1 text-sm text-gray-600">
            Configure AI models for vulnerability analysis
          </p>
        </div>
        <button
          onClick={handleCreate}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          <Plus className="w-4 h-4" />
          Add Provider
        </button>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          {error}
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Provider Type
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Model
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Connection
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {providers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                  No providers configured. Click "Add Provider" to get started.
                </td>
              </tr>
            ) : (
              providers.map((provider) => {
                const testResult = testResults[provider.id];
                const isTesting = testingIds.has(provider.id);

                return (
                  <tr key={provider.id}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="text-sm font-medium text-gray-900">
                          {provider.name}
                        </div>
                        {provider.is_default && (
                          <span className="ml-2 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded">
                            Default
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {getProviderTypeLabel(provider.provider_type)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {provider.model}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {provider.is_enabled ? (
                        <span className="px-2 py-1 text-xs bg-green-100 text-green-800 rounded">
                          Enabled
                        </span>
                      ) : (
                        <span className="px-2 py-1 text-xs bg-gray-100 text-gray-800 rounded">
                          Disabled
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleTest(provider.id)}
                          disabled={isTesting}
                          className="text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400"
                        >
                          {isTesting ? 'Testing...' : 'Test'}
                        </button>
                        {testResult && (
                          <div className="flex items-center gap-1">
                            {testResult.ok ? (
                              <>
                                <CheckCircle className="w-4 h-4 text-green-600" />
                                <span className="text-xs text-gray-600">
                                  {testResult.latency}ms
                                </span>
                              </>
                            ) : (
                              <>
                                <XCircle className="w-4 h-4 text-red-600" />
                                <span className="text-xs text-red-600" title={testResult.error}>
                                  Failed
                                </span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => handleEdit(provider)}
                        className="text-blue-600 hover:text-blue-900 mr-4"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(provider.id)}
                        className="text-red-600 hover:text-red-900"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editingProvider ? 'Edit Provider' : 'Add Provider'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Provider Type *
            </label>
            <select
              value={formData.provider_type}
              onChange={(e) => setFormData({ ...formData, provider_type: e.target.value as any })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            >
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="qwen">Qwen (Alibaba)</option>
              <option value="llama">Llama</option>
              <option value="openai_compat">OpenAI Compatible</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Base URL {formData.provider_type === 'openai_compat' && '*'}
            </label>
            <input
              type="text"
              value={formData.base_url}
              onChange={(e) => setFormData({ ...formData, base_url: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              placeholder="https://api.example.com/v1"
              required={formData.provider_type === 'openai_compat'}
            />
            <p className="mt-1 text-xs text-gray-500">
              Leave empty to use default provider endpoint
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              API Key {!editingProvider && '*'}
            </label>
            <input
              type="password"
              value={formData.api_key}
              onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              placeholder={editingProvider ? 'Leave empty to keep existing' : ''}
              required={!editingProvider}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Model *
            </label>
            <input
              type="text"
              value={formData.model}
              onChange={(e) => setFormData({ ...formData, model: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              placeholder="e.g., gpt-4, deepseek-chat, qwen-max"
              required
            />
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.is_enabled}
                onChange={(e) => setFormData({ ...formData, is_enabled: e.target.checked })}
                className="rounded border-gray-300"
              />
              <span className="text-sm text-gray-700">Enabled</span>
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.is_default}
                onChange={(e) => setFormData({ ...formData, is_default: e.target.checked })}
                className="rounded border-gray-300"
              />
              <span className="text-sm text-gray-700">Set as default</span>
            </label>
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={() => setShowModal(false)}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              {editingProvider ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
