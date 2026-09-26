import { i18nConfirm } from '../i18n/feedback';
import { useState, useEffect } from 'react';
import { Plus, Trash2, Edit, CheckCircle, XCircle, Loader, Brain, Activity, KeyRound } from 'lucide-react';
import { aiService, type AIProvider, type ConnectionTestResult } from '../lib/api-service';
import { Modal } from '../components/ui/Modal';

export default function AIProviders() {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingProvider, setEditingProvider] = useState<AIProvider | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestResult>>({});
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
    setError('');
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
    setError('');
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
    if (!i18nConfirm('Are you sure you want to delete this provider?')) return;

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
      setTestResults(prev => ({ ...prev, [id]: { ok: false, error_message: err.message } }));
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
    <div className="space-y-5 p-5">
      <section className="border border-slate-200 bg-white">
        <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded bg-blue-50 text-blue-700">
              <Brain size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Model routing</div>
              <h1 className="mt-1 text-2xl font-semibold text-slate-950">AI Providers</h1>
              <p className="mt-1 text-sm text-slate-600">
                Configure model endpoints used for vulnerability triage and evidence reports.
              </p>
            </div>
          </div>
          <button
            onClick={handleCreate}
            className="inline-flex h-9 items-center gap-2 rounded bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            Add Provider
          </button>
        </div>
        <div className="grid gap-px bg-slate-200 md:grid-cols-4">
          <div className="bg-white px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Providers</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{providers.length}</div>
          </div>
          <div className="bg-white px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Enabled</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-emerald-600">{providers.filter(provider => provider.is_enabled).length}</div>
          </div>
          <div className="bg-white px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Default</div>
            <div className="mt-2 truncate text-sm font-semibold text-slate-950">{providers.find(provider => provider.is_default)?.name || 'Not set'}</div>
          </div>
          <div className="bg-white px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Connection checks</div>
            <div className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-950">
              <Activity size={16} />
              {Object.keys(testResults).length} tested
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          {error}
        </div>
      )}

      <div className="overflow-hidden border border-slate-200 bg-white">
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
                                  {testResult.latency_ms ?? '—'}ms
                                </span>
                              </>
                            ) : (
                              <>
                                <XCircle className="w-4 h-4 text-red-600" />
                                <span className="text-xs text-red-600" title={testResult.error_message}>
                                  Failed
                                </span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      {testResult?.ok===false&&<p role="alert" className="mt-2 max-w-sm whitespace-normal break-words text-xs text-red-700">{testResult.error_message || '连接失败，请检查服务地址、凭据与模型。'}</p>}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => handleEdit(provider)}
                        aria-label={`Edit ${provider.name}`}
                        className="text-blue-600 hover:text-blue-900 mr-4"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(provider.id)}
                        aria-label={`Delete ${provider.name}`}
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
          {error&&<p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            <div className="flex items-center gap-2 font-semibold">
              <KeyRound size={16} />
              Provider secrets stay server-side
            </div>
            <div className="mt-1 text-xs text-blue-800">
              Leave the key empty when editing to preserve the current credential.
            </div>
          </div>
          <div>
            <label htmlFor="provider-name" className="block text-sm font-medium text-gray-700 mb-1">
              Name *
            </label>
            <input
              id="provider-name"
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              required
            />
          </div>

          <div>
            <label htmlFor="provider-type" className="block text-sm font-medium text-gray-700 mb-1">
              Provider Type *
            </label>
            <select
              id="provider-type"
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
            <label htmlFor="provider-url" className="block text-sm font-medium text-gray-700 mb-1">
              Base URL {formData.provider_type === 'openai_compat' && '*'}
            </label>
            <input
              id="provider-url"
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
            <label htmlFor="provider-key" className="block text-sm font-medium text-gray-700 mb-1">
              API Key {!editingProvider && '*'}
            </label>
            <input
              id="provider-key"
              type="password"
              value={formData.api_key}
              onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              placeholder={editingProvider ? 'Leave empty to keep existing' : ''}
              required={!editingProvider}
            />
          </div>

          <div>
            <label htmlFor="provider-model" className="block text-sm font-medium text-gray-700 mb-1">
              Model *
            </label>
            <input
              id="provider-model"
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
