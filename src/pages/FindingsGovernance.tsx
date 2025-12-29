import { useEffect, useState } from 'react';
import { Shield, Trash2, Plus, Edit2, Power, AlertTriangle, Settings, Clock, RefreshCw, Play, Search } from 'lucide-react';
import { Table } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { Button, Input, Select, TextArea } from '../components/ui/Form';
import { dropRulesService, governanceService, apiTemplatesService, workflowsService } from '../lib/api-service';
import type { FindingDropRule, GovernanceSettings, ApiTemplate, Workflow } from '../types';

type ActiveTab = 'drop_rules' | 'rate_limit' | 'retention';

const DEFAULT_SETTINGS: GovernanceSettings = {
  rate_limit_enabled: true,
  rate_limit_default: 3,
  retention_days_effective: 90,
  retention_days_suppressed_rule: 14,
  retention_days_suppressed_rate_limit: 7,
  retention_days_evidence: 7,
  vacuum_mode: 'full_weekly',
  cleanup_interval_hours: 4320,
};

export function FindingsGovernance() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('drop_rules');
  const [dropRules, setDropRules] = useState<FindingDropRule[]>([]);
  const [templates, setTemplates] = useState<ApiTemplate[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [settings, setSettings] = useState<GovernanceSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<any>(null);
  const [originalSettings, setOriginalSettings] = useState<GovernanceSettings | null>(null);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'info'; text: string } | null>(null);

  const [isRuleModalOpen, setIsRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<FindingDropRule | null>(null);
  const [ruleForm, setRuleForm] = useState<Partial<FindingDropRule>>({
    name: '',
    description: '',
    is_enabled: true,
    priority: 100,
    applies_to: 'both',
    match_method: 'ANY',
    match_type: 'contains',
    match_path: '',
    match_service_id: '',
    match_template_id: '',
    match_workflow_id: '',
  });

  const [previewResult, setPreviewResult] = useState<{ dropped: boolean; ruleName?: string } | null>(null);
  const [previewForm, setPreviewForm] = useState({
    method: 'GET',
    path: '/',
    service_id: '',
    source_type: 'test_run' as 'test_run' | 'workflow',
    template_id: '',
    workflow_id: '',
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [rulesData, settingsData, templatesData, workflowsData] = await Promise.all([
        dropRulesService.list(),
        governanceService.getSettings(),
        apiTemplatesService.list(),
        workflowsService.list(),
      ]);
      setDropRules(rulesData);
      setSettings(settingsData);
      setOriginalSettings(settingsData);
      setTemplates(templatesData);
      setWorkflows(workflowsData);
    } catch (error) {
      console.error('Failed to load governance data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateRule = () => {
    setEditingRule(null);
    setRuleForm({
      name: '',
      description: '',
      is_enabled: true,
      priority: 100,
      applies_to: 'both',
      match_method: 'ANY',
      match_type: 'contains',
      match_path: '',
      match_service_id: '',
      match_template_id: '',
      match_workflow_id: '',
    });
    setIsRuleModalOpen(true);
  };

  const handleEditRule = (rule: FindingDropRule) => {
    setEditingRule(rule);
    setRuleForm({
      name: rule.name,
      description: rule.description || '',
      is_enabled: rule.is_enabled,
      priority: rule.priority,
      applies_to: rule.applies_to,
      match_method: rule.match_method,
      match_type: rule.match_type,
      match_path: rule.match_path || '',
      match_service_id: rule.match_service_id || '',
      match_template_id: rule.match_template_id || '',
      match_workflow_id: rule.match_workflow_id || '',
    });
    setIsRuleModalOpen(true);
  };

  const handleSaveRule = async () => {
    setSaving(true);
    try {
      const ruleData = {
        name: ruleForm.name || '',
        description: ruleForm.description || undefined,
        is_enabled: ruleForm.is_enabled ?? true,
        priority: ruleForm.priority ?? 100,
        applies_to: ruleForm.applies_to as 'test_run' | 'workflow' | 'both',
        match_method: ruleForm.match_method || 'ANY',
        match_type: ruleForm.match_type as 'exact' | 'prefix' | 'contains' | 'regex',
        match_path: ruleForm.match_path || undefined,
        match_service_id: ruleForm.match_service_id || undefined,
        match_template_id: ruleForm.match_template_id || undefined,
        match_workflow_id: ruleForm.match_workflow_id || undefined,
      };

      if (editingRule) {
        await dropRulesService.update(editingRule.id, ruleData);
      } else {
        await dropRulesService.create(ruleData);
      }

      await loadData();
      setIsRuleModalOpen(false);
    } catch (error) {
      console.error('Failed to save rule:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (!confirm('Delete this drop rule?')) return;
    try {
      await dropRulesService.delete(id);
      setDropRules(dropRules.filter(r => r.id !== id));
    } catch (error) {
      console.error('Failed to delete rule:', error);
    }
  };

  const handleToggleRule = async (rule: FindingDropRule) => {
    try {
      await dropRulesService.update(rule.id, { is_enabled: !rule.is_enabled });
      setDropRules(dropRules.map(r =>
        r.id === rule.id ? { ...r, is_enabled: !r.is_enabled } : r
      ));
    } catch (error) {
      console.error('Failed to toggle rule:', error);
    }
  };

  const handlePreview = async () => {
    try {
      const result = await dropRulesService.preview({
        method: previewForm.method,
        path: previewForm.path,
        service_id: previewForm.service_id || undefined,
        source_type: previewForm.source_type,
        template_id: previewForm.template_id || undefined,
        workflow_id: previewForm.workflow_id || undefined,
      });
      setPreviewResult(result);
    } catch (error) {
      console.error('Preview failed:', error);
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const updated = await governanceService.updateSettings(settings);
      setSettings(updated);
      setOriginalSettings(updated);

      const cleanupIntervalChanged = originalSettings &&
        originalSettings.cleanup_interval_hours !== settings.cleanup_interval_hours;

      if (cleanupIntervalChanged) {
        setSaveMessage({
          type: 'info',
          text: `Settings saved. Cleanup schedule updated to every ${settings.cleanup_interval_hours} hour(s).`
        });
      } else {
        setSaveMessage({
          type: 'success',
          text: 'Settings saved successfully.'
        });
      }

      setTimeout(() => setSaveMessage(null), 4000);
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSaveMessage({
        type: 'success',
        text: 'Failed to save settings. Please try again.'
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRunCleanup = async () => {
    if (!confirm('Run cleanup now? This will permanently delete old findings based on retention settings.')) return;
    setCleaningUp(true);
    setCleanupResult(null);
    try {
      const result = await governanceService.runCleanup();
      setCleanupResult(result);
      await loadData();
    } catch (error) {
      console.error('Cleanup failed:', error);
    } finally {
      setCleaningUp(false);
    }
  };

  const dropRuleColumns = [
    {
      key: 'priority' as const,
      label: 'Priority',
      render: (value: number) => (
        <span className="font-mono text-sm">{value}</span>
      ),
    },
    { key: 'name' as const, label: 'Name' },
    {
      key: 'applies_to' as const,
      label: 'Applies To',
      render: (value: string) => (
        <span className={`px-2 py-1 text-xs font-medium rounded ${
          value === 'both' ? 'bg-blue-100 text-blue-800' :
          value === 'test_run' ? 'bg-green-100 text-green-800' :
          'bg-purple-100 text-purple-800'
        }`}>
          {value === 'test_run' ? 'API Tests' : value === 'workflow' ? 'Workflows' : 'Both'}
        </span>
      ),
    },
    {
      key: 'match_method' as const,
      label: 'Method',
      render: (value: string) => (
        <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded">
          {value}
        </span>
      ),
    },
    {
      key: 'match_path' as const,
      label: 'Path Match',
      render: (value: string, row: FindingDropRule) => value ? (
        <span className="text-sm">
          <span className="text-gray-500">{row.match_type}:</span> {value}
        </span>
      ) : '-',
    },
    {
      key: 'is_enabled' as const,
      label: 'Status',
      render: (value: boolean) => (
        <span className={`px-2 py-1 text-xs font-medium rounded ${
          value ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
        }`}>
          {value ? 'Enabled' : 'Disabled'}
        </span>
      ),
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: FindingDropRule) => (
        <div className="flex gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); handleToggleRule(row); }}
            className={`p-1 rounded ${row.is_enabled ? 'hover:bg-orange-100 text-orange-600' : 'hover:bg-green-100 text-green-600'}`}
            title={row.is_enabled ? 'Disable' : 'Enable'}
          >
            <Power size={16} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleEditRule(row); }}
            className="p-1 hover:bg-blue-100 rounded text-blue-600"
          >
            <Edit2 size={16} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleDeleteRule(row.id); }}
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
          <h1 className="text-3xl font-bold text-gray-900">Findings Governance</h1>
          <p className="text-gray-600 mt-1">Manage drop rules, rate limiting, and data retention</p>
        </div>
        <Button variant="secondary" onClick={loadData} disabled={loading}>
          <RefreshCw size={18} className={`mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="mb-6 flex gap-2 border-b border-gray-200">
        <button
          onClick={() => setActiveTab('drop_rules')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'drop_rules'
              ? 'text-blue-600 border-b-2 border-blue-600'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <Shield size={16} className="inline mr-2" />
          Drop Rules
          <span className="ml-2 px-2 py-0.5 text-xs bg-gray-100 rounded">
            {dropRules.filter(r => r.is_enabled).length} active
          </span>
        </button>
        <button
          onClick={() => setActiveTab('rate_limit')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'rate_limit'
              ? 'text-blue-600 border-b-2 border-blue-600'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <Settings size={16} className="inline mr-2" />
          Rate Limiting
        </button>
        <button
          onClick={() => setActiveTab('retention')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'retention'
              ? 'text-blue-600 border-b-2 border-blue-600'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <Clock size={16} className="inline mr-2" />
          Retention Policy
        </button>
      </div>

      {activeTab === 'drop_rules' && (
        <div className="space-y-6">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="text-amber-600 mt-0.5" size={20} />
              <div>
                <h4 className="font-medium text-amber-800">Pre-Finding Drop Filter</h4>
                <p className="text-sm text-amber-700 mt-1">
                  Findings matching these rules will be completely dropped before storage.
                  They will not appear in reports or affect CI gate calculations.
                  Use with caution - dropped findings cannot be recovered.
                </p>
              </div>
            </div>
          </div>

          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold">Drop Rules</h3>
            <Button variant="primary" onClick={handleCreateRule}>
              <Plus size={18} className="mr-2" />
              Add Rule
            </Button>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <h4 className="font-medium mb-3 flex items-center gap-2">
              <Search size={16} />
              Test Match Preview
            </h4>
            <div className="grid grid-cols-6 gap-4 mb-4">
              <Select
                label="Source Type"
                value={previewForm.source_type}
                onChange={(e) => setPreviewForm({ ...previewForm, source_type: e.target.value as 'test_run' | 'workflow', template_id: '', workflow_id: '' })}
              >
                <option value="test_run">API Test</option>
                <option value="workflow">Workflow</option>
              </Select>
              {previewForm.source_type === 'test_run' ? (
                <Select
                  label="Template"
                  value={previewForm.template_id}
                  onChange={(e) => setPreviewForm({ ...previewForm, template_id: e.target.value })}
                >
                  <option value="">Any Template</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </Select>
              ) : (
                <Select
                  label="Workflow"
                  value={previewForm.workflow_id}
                  onChange={(e) => setPreviewForm({ ...previewForm, workflow_id: e.target.value })}
                >
                  <option value="">Any Workflow</option>
                  {workflows.map(w => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </Select>
              )}
              <Select
                label="Method"
                value={previewForm.method}
                onChange={(e) => setPreviewForm({ ...previewForm, method: e.target.value })}
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
                <option value="PATCH">PATCH</option>
              </Select>
              <Input
                label="Path"
                value={previewForm.path}
                onChange={(e) => setPreviewForm({ ...previewForm, path: e.target.value })}
                placeholder="/api/users/123"
              />
              <Input
                label="Service ID"
                value={previewForm.service_id}
                onChange={(e) => setPreviewForm({ ...previewForm, service_id: e.target.value })}
                placeholder="Optional"
              />
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={handlePreview}>
                Test Match
              </Button>
            </div>
            {previewResult && (
              <div className={`mt-3 p-3 rounded ${
                previewResult.dropped ? 'bg-red-50 text-red-800' : 'bg-green-50 text-green-800'
              }`}>
                {previewResult.dropped
                  ? `Would be DROPPED by rule: "${previewResult.ruleName}"`
                  : 'Would NOT be dropped (no matching rule)'
                }
              </div>
            )}
          </div>

          {dropRules.length === 0 ? (
            <div className="text-center py-12 bg-gray-50 rounded-lg">
              <Shield size={48} className="mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No Drop Rules</h3>
              <p className="text-gray-600 mb-4">
                Create drop rules to filter out known-noisy findings before they enter the database.
              </p>
              <Button variant="primary" onClick={handleCreateRule}>
                <Plus size={18} className="mr-2" />
                Create First Rule
              </Button>
            </div>
          ) : (
            <Table
              columns={dropRuleColumns}
              data={dropRules.sort((a, b) => a.priority - b.priority)}
              loading={loading}
            />
          )}
        </div>
      )}

      {activeTab === 'rate_limit' && (
        <div className="space-y-6">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Settings className="text-blue-600 mt-0.5" size={20} />
              <div>
                <h4 className="font-medium text-blue-800">Test Run Rate Limiting</h4>
                <p className="text-sm text-blue-700 mt-1">
                  Limits the number of findings from a single template that count toward CI gate calculations.
                  Findings beyond the limit are still stored but marked as rate-limited.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h3 className="text-lg font-semibold mb-4">Global Rate Limit Settings</h3>

            <div className="space-y-4 max-w-md">
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.rate_limit_enabled}
                    onChange={(e) => setSettings({ ...settings, rate_limit_enabled: e.target.checked })}
                    className="rounded"
                  />
                  <span className="font-medium">Enable Rate Limiting</span>
                </label>
              </div>

              <Input
                label="Default Limit (N)"
                type="number"
                min={1}
                value={settings.rate_limit_default}
                onChange={(e) => setSettings({ ...settings, rate_limit_default: parseInt(e.target.value) || 3 })}
                disabled={!settings.rate_limit_enabled}
              />

              <p className="text-sm text-gray-600">
                For each template in a Test Run, only the first {settings.rate_limit_default} findings
                will count toward CI gate. Additional findings are stored but marked as rate-limited.
              </p>

              <div className="pt-4">
                <Button variant="primary" onClick={handleSaveSettings} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Settings'}
                </Button>
              </div>
            </div>
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-6">
            <h3 className="text-lg font-semibold mb-4">Template-Level Overrides</h3>
            <p className="text-gray-600">
              You can override the global rate limit for specific templates in the API Templates editor.
              Templates with a custom limit will use that value instead of the global default.
            </p>
          </div>
        </div>
      )}

      {activeTab === 'retention' && (
        <div className="space-y-6">
          <div className="bg-teal-50 border border-teal-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Clock className="text-teal-600 mt-0.5" size={20} />
              <div>
                <h4 className="font-medium text-teal-800">Data Retention Policy</h4>
                <p className="text-sm text-teal-700 mt-1">
                  Configure how long different types of data are retained.
                  Old data is permanently deleted during cleanup runs.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h3 className="text-lg font-semibold mb-4">Retention Settings</h3>

            <div className="grid grid-cols-2 gap-6 max-w-2xl">
              <Input
                label="Effective Findings (days)"
                type="number"
                min={1}
                value={settings.retention_days_effective}
                onChange={(e) => setSettings({ ...settings, retention_days_effective: parseInt(e.target.value) || 90 })}
              />
              <Input
                label="Rule-Suppressed Findings (days)"
                type="number"
                min={1}
                value={settings.retention_days_suppressed_rule}
                onChange={(e) => setSettings({ ...settings, retention_days_suppressed_rule: parseInt(e.target.value) || 14 })}
              />
              <Input
                label="Rate-Limited Findings (days)"
                type="number"
                min={1}
                value={settings.retention_days_suppressed_rate_limit}
                onChange={(e) => setSettings({ ...settings, retention_days_suppressed_rate_limit: parseInt(e.target.value) || 7 })}
              />
              <Input
                label="Evidence / Old Runs (days)"
                type="number"
                min={1}
                value={settings.retention_days_evidence}
                onChange={(e) => setSettings({ ...settings, retention_days_evidence: parseInt(e.target.value) || 7 })}
              />

              <Select
                label="Vacuum Mode (SQLite)"
                value={settings.vacuum_mode}
                onChange={(e) => setSettings({ ...settings, vacuum_mode: e.target.value as GovernanceSettings['vacuum_mode'] })}
              >
                <option value="none">None</option>
                <option value="incremental">Incremental</option>
                <option value="full_weekly">Full (Weekly)</option>
              </Select>

              <Input
                label="Cleanup Interval (hours)"
                type="number"
                min={1}
                value={settings.cleanup_interval_hours}
                onChange={(e) => setSettings({ ...settings, cleanup_interval_hours: parseInt(e.target.value) || 4320 })}
              />
            </div>

            <p className="text-sm text-gray-600 mt-4">
              Cleanup runs automatically every {settings.cleanup_interval_hours} hour(s) (approx. {(settings.cleanup_interval_hours / 24).toFixed(1)} days).
            </p>

            <div className="mt-6 pt-4 border-t border-gray-200">
              <Button variant="primary" onClick={handleSaveSettings} disabled={saving}>
                {saving ? 'Saving...' : 'Save Settings'}
              </Button>
              {saveMessage && (
                <div className={`mt-3 p-3 rounded text-sm ${
                  saveMessage.type === 'success'
                    ? 'bg-green-50 text-green-800'
                    : 'bg-blue-50 text-blue-800'
                }`}>
                  {saveMessage.text}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-lg font-semibold">Manual Cleanup</h3>
                <p className="text-gray-600 text-sm mt-1">
                  Run the retention cleanup manually to delete old data now.
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={handleRunCleanup}
                disabled={cleaningUp}
              >
                <Play size={16} className={`mr-2 ${cleaningUp ? 'animate-spin' : ''}`} />
                {cleaningUp ? 'Running...' : 'Run Cleanup Now'}
              </Button>
            </div>

            {settings.last_cleanup_at && (
              <div className="text-sm text-gray-600 mb-4">
                Last cleanup: {new Date(settings.last_cleanup_at).toLocaleString()}
              </div>
            )}

            {cleanupResult && (
              <div className={`p-4 rounded-lg ${cleanupResult.success ? 'bg-green-50' : 'bg-red-50'}`}>
                <h4 className={`font-medium ${cleanupResult.success ? 'text-green-800' : 'text-red-800'}`}>
                  {cleanupResult.success ? 'Cleanup Completed' : 'Cleanup Failed'}
                </h4>
                {cleanupResult.success ? (
                  <div className="mt-2 text-sm text-green-700 space-y-1">
                    <p>Deleted effective findings: {cleanupResult.deleted_effective}</p>
                    <p>Deleted rule-suppressed: {cleanupResult.deleted_suppressed_rule}</p>
                    <p>Deleted rate-limited: {cleanupResult.deleted_suppressed_rate_limit}</p>
                    <p>Deleted old test runs: {cleanupResult.deleted_test_runs}</p>
                    <p>Vacuumed: {cleanupResult.vacuumed ? 'Yes' : 'No'}</p>
                    <p>Duration: {cleanupResult.duration_ms}ms</p>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-red-700">{cleanupResult.error}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <Modal
        isOpen={isRuleModalOpen}
        onClose={() => setIsRuleModalOpen(false)}
        title={editingRule ? 'Edit Drop Rule' : 'Create Drop Rule'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setIsRuleModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSaveRule} disabled={saving || !ruleForm.name}>
              {saving ? 'Saving...' : editingRule ? 'Update' : 'Create'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={ruleForm.name}
            onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })}
            placeholder="e.g., Drop health check endpoints"
            required
          />

          <TextArea
            label="Description"
            value={ruleForm.description}
            onChange={(e) => setRuleForm({ ...ruleForm, description: e.target.value })}
            placeholder="Describe what this rule filters out"
            rows={2}
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Priority"
              type="number"
              value={ruleForm.priority}
              onChange={(e) => setRuleForm({ ...ruleForm, priority: parseInt(e.target.value) || 100 })}
            />

            <Select
              label="Applies To"
              value={ruleForm.applies_to}
              onChange={(e) => setRuleForm({ ...ruleForm, applies_to: e.target.value as FindingDropRule['applies_to'] })}
            >
              <option value="both">Both (API & Workflows)</option>
              <option value="test_run">API Tests Only</option>
              <option value="workflow">Workflows Only</option>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="HTTP Method"
              value={ruleForm.match_method}
              onChange={(e) => setRuleForm({ ...ruleForm, match_method: e.target.value })}
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
              value={ruleForm.match_type}
              onChange={(e) => setRuleForm({ ...ruleForm, match_type: e.target.value as FindingDropRule['match_type'] })}
            >
              <option value="exact">Exact</option>
              <option value="prefix">Prefix</option>
              <option value="contains">Contains</option>
              <option value="regex">Regex</option>
            </Select>
          </div>

          <Input
            label="Path Pattern"
            value={ruleForm.match_path}
            onChange={(e) => setRuleForm({ ...ruleForm, match_path: e.target.value })}
            placeholder={ruleForm.match_type === 'regex' ? '^/api/health.*$' : '/api/health'}
          />

          <Input
            label="Service ID (optional)"
            value={ruleForm.match_service_id}
            onChange={(e) => setRuleForm({ ...ruleForm, match_service_id: e.target.value })}
            placeholder="Filter by service identifier in request"
          />

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Template (optional)"
              value={ruleForm.match_template_id || ''}
              onChange={(e) => setRuleForm({ ...ruleForm, match_template_id: e.target.value || undefined })}
            >
              <option value="">Any Template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>

            <Select
              label="Workflow (optional)"
              value={ruleForm.match_workflow_id || ''}
              onChange={(e) => setRuleForm({ ...ruleForm, match_workflow_id: e.target.value || undefined })}
            >
              <option value="">Any Workflow</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </Select>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={ruleForm.is_enabled}
              onChange={(e) => setRuleForm({ ...ruleForm, is_enabled: e.target.checked })}
              className="rounded"
            />
            <span>Enable this rule</span>
          </label>
        </div>
      </Modal>
    </div>
  );
}
