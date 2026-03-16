import { useState, useEffect } from 'react';
import { Play, Loader, AlertTriangle, CheckCircle, XCircle, ChevronDown, ChevronUp } from 'lucide-react';
import {
  aiService,
  testRunsService,
  type AIProvider,
  type AIAnalysis,
  type AIVerdict,
  type AIVerdictV2,
  type AnalysisError,
  type AnalysisSkipped
} from '../lib/api-service';

function isAnalysisError(result: any): result is AnalysisError {
  return result && typeof result.error === 'string';
}

function isAnalysisSkipped(result: any): result is AnalysisSkipped {
  return result && result.skipped === true;
}

function isAIVerdict(result: any): result is AIVerdict {
  return result && typeof result.is_vulnerability === 'boolean';
}

function isAIVerdictV2(result: any): result is AIVerdictV2 {
  return isAIVerdict(result) && Array.isArray((result as any).evidence_citations);
}

const SETTINGS_KEY = 'ai_analysis_advanced_settings';

interface AdvancedSettings {
  prompt_max_body_chars_test_run: number;
  prompt_max_body_chars_workflow_step: number;
  prompt_max_headers_chars_test_run: number;
  prompt_max_headers_chars_workflow_step: number;
  require_baseline: boolean;
  include_all_steps: boolean;
  key_steps_only: boolean;
  max_steps: number;
  redaction_enabled: boolean;
}

const DEFAULT_SETTINGS: AdvancedSettings = {
  prompt_max_body_chars_test_run: 50000,
  prompt_max_body_chars_workflow_step: 10000,
  prompt_max_headers_chars_test_run: 50000,
  prompt_max_headers_chars_workflow_step: 20000,
  require_baseline: false,
  include_all_steps: true,
  key_steps_only: false,
  max_steps: 0,
  redaction_enabled: false,
};

function loadSettings(): AdvancedSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: AdvancedSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

export default function AIAnalysis() {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [testRuns, setTestRuns] = useState<any[]>([]);
  const [analyses, setAnalyses] = useState<AIAnalysis[]>([]);
  const [selectedRun, setSelectedRun] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [onlyUnsuppressed, setOnlyUnsuppressed] = useState(true);
  const [maxFindings, setMaxFindings] = useState(200);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [filterVulnOnly, setFilterVulnOnly] = useState(false);
  const [filterSeverity, setFilterSeverity] = useState<string[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [advancedSettings, setAdvancedSettings] = useState<AdvancedSettings>(loadSettings());
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (selectedRun) {
      loadAnalyses();
    }
  }, [selectedRun]);

  const loadData = async () => {
    try {
      const [providersData, runsData] = await Promise.all([
        aiService.listProviders(),
        testRunsService.list()
      ]);

      const enabledProviders = providersData.filter(p => p.is_enabled);
      setProviders(enabledProviders);

      if (enabledProviders.length > 0 && !selectedProvider) {
        const defaultProvider = enabledProviders.find(p => p.is_default) || enabledProviders[0];
        setSelectedProvider(defaultProvider.id);
      }

      setTestRuns(runsData.slice(0, 50));

      if (runsData.length > 0 && !selectedRun) {
        setSelectedRun(runsData[0].id);
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const loadAnalyses = async () => {
    if (!selectedRun) return;

    try {
      setLoading(true);
      const data = await aiService.listAnalyses(selectedRun);
      setAnalyses(data);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAnalyze = async () => {
    if (!selectedRun || !selectedProvider) {
      setError('Please select a run and provider');
      return;
    }

    try {
      setAnalyzing(true);
      setError('');

      const result = await aiService.analyzeRun(selectedRun, selectedProvider, {
        only_unsuppressed: onlyUnsuppressed,
        max_findings: maxFindings,
        ...advancedSettings
      });

      alert(`Analysis complete!\nCompleted: ${result.completed}\nFailed: ${result.failed}\nSkipped: ${result.skipped}`);

      await loadAnalyses();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const updateSetting = (key: keyof AdvancedSettings, value: any) => {
    const newSettings = { ...advancedSettings, [key]: value };
    setAdvancedSettings(newSettings);
    saveSettings(newSettings);
  };

  const resetSettings = () => {
    setAdvancedSettings(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
  };

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const getSeverityColor = (severity: string) => {
    const colors: Record<string, string> = {
      CRITICAL: 'bg-red-100 text-red-800 border-red-200',
      HIGH: 'bg-orange-100 text-orange-800 border-orange-200',
      MEDIUM: 'bg-yellow-100 text-yellow-800 border-yellow-200',
      LOW: 'bg-blue-100 text-blue-800 border-blue-200',
      INFO: 'bg-gray-100 text-gray-800 border-gray-200'
    };
    return colors[severity] || colors.INFO;
  };

  const filteredAnalyses = analyses.filter(a => {
    const result = a.result_json;

    if (isAnalysisError(result) || isAnalysisSkipped(result)) {
      return !filterVulnOnly;
    }

    if (!isAIVerdict(result)) {
      return false;
    }

    if (filterVulnOnly && !result.is_vulnerability) return false;

    if (filterSeverity.length > 0 && !filterSeverity.includes(result.severity)) {
      return false;
    }

    return true;
  });

  const stats = {
    total: analyses.length,
    vulnerabilities: analyses.filter(a => {
      const result = a.result_json;
      return isAIVerdict(result) && result.is_vulnerability;
    }).length,
    severities: analyses.reduce((acc, a) => {
      const result = a.result_json;
      if (isAIVerdict(result) && result.is_vulnerability) {
        acc[result.severity] = (acc[result.severity] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>)
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">AI Analysis</h1>
        <p className="mt-1 text-sm text-gray-600">
          Analyze findings with AI to identify vulnerabilities
        </p>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          {error}
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Run Analysis</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Test Run
            </label>
            <select
              value={selectedRun}
              onChange={(e) => setSelectedRun(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            >
              <option value="">Select a run...</option>
              {testRuns.map(run => (
                <option key={run.id} value={run.id}>
                  {run.test_name || run.id} - {new Date(run.created_at).toLocaleString()}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              AI Provider
            </label>
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            >
              <option value="">Select a provider...</option>
              {providers.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.model})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={onlyUnsuppressed}
              onChange={(e) => setOnlyUnsuppressed(e.target.checked)}
              className="rounded border-gray-300"
            />
            <span className="text-sm text-gray-700">Only unsuppressed findings</span>
          </label>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Max Findings
            </label>
            <input
              type="number"
              value={maxFindings}
              onChange={(e) => setMaxFindings(parseInt(e.target.value))}
              min={1}
              max={1000}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>
        </div>

        <div className="mb-4">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
          >
            {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            Advanced Settings
          </button>

          {showAdvanced && (
            <div className="mt-4 p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-900">Prompt Configuration</h3>
                <button
                  onClick={resetSettings}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  Reset to Defaults
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Test Run Max Body Chars
                  </label>
                  <input
                    type="number"
                    value={advancedSettings.prompt_max_body_chars_test_run}
                    onChange={(e) => updateSetting('prompt_max_body_chars_test_run', parseInt(e.target.value))}
                    min={0}
                    max={2000000}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Workflow Step Max Body Chars
                  </label>
                  <input
                    type="number"
                    value={advancedSettings.prompt_max_body_chars_workflow_step}
                    onChange={(e) => updateSetting('prompt_max_body_chars_workflow_step', parseInt(e.target.value))}
                    min={0}
                    max={2000000}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Test Run Max Headers Chars
                  </label>
                  <input
                    type="number"
                    value={advancedSettings.prompt_max_headers_chars_test_run}
                    onChange={(e) => updateSetting('prompt_max_headers_chars_test_run', parseInt(e.target.value))}
                    min={0}
                    max={2000000}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Workflow Step Max Headers Chars
                  </label>
                  <input
                    type="number"
                    value={advancedSettings.prompt_max_headers_chars_workflow_step}
                    onChange={(e) => updateSetting('prompt_max_headers_chars_workflow_step', parseInt(e.target.value))}
                    min={0}
                    max={2000000}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Max Steps (0 = unlimited)
                  </label>
                  <input
                    type="number"
                    value={advancedSettings.max_steps}
                    onChange={(e) => updateSetting('max_steps', parseInt(e.target.value))}
                    min={0}
                    max={100}
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                  />
                </div>
              </div>

              <div className="border-t border-gray-300 pt-3 mt-3">
                <h4 className="text-xs font-medium text-gray-900 mb-2">Analysis Options</h4>
                <div className="space-y-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={advancedSettings.require_baseline}
                      onChange={(e) => updateSetting('require_baseline', e.target.checked)}
                      className="rounded border-gray-300"
                    />
                    <span className="text-xs text-gray-700">Require baseline (skip findings without baseline)</span>
                  </label>

                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={advancedSettings.include_all_steps}
                      onChange={(e) => updateSetting('include_all_steps', e.target.checked)}
                      className="rounded border-gray-300"
                    />
                    <span className="text-xs text-gray-700">Include all workflow steps</span>
                  </label>

                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={advancedSettings.key_steps_only}
                      onChange={(e) => updateSetting('key_steps_only', e.target.checked)}
                      className="rounded border-gray-300"
                    />
                    <span className="text-xs text-gray-700">Key steps only</span>
                  </label>

                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={advancedSettings.redaction_enabled}
                      onChange={(e) => updateSetting('redaction_enabled', e.target.checked)}
                      className="rounded border-gray-300"
                    />
                    <span className="text-xs text-gray-700">Enable sensitive data redaction</span>
                  </label>
                </div>
              </div>

              <div className="text-xs text-gray-500 mt-3">
                Settings are automatically saved to browser localStorage
              </div>
            </div>
          )}
        </div>

        <button
          onClick={handleAnalyze}
          disabled={analyzing || !selectedRun || !selectedProvider}
          className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400"
        >
          {analyzing ? (
            <>
              <Loader className="w-4 h-4 animate-spin" />
              Analyzing...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              Run Analysis
            </>
          )}
        </button>
      </div>

      {analyses.length > 0 && (
        <>
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4">Analysis Summary</h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div>
                <div className="text-sm text-gray-600">Total</div>
                <div className="text-2xl font-bold">{stats.total}</div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Vulnerabilities</div>
                <div className="text-2xl font-bold text-red-600">{stats.vulnerabilities}</div>
              </div>
              {Object.entries(stats.severities).map(([severity, count]) => (
                <div key={severity}>
                  <div className="text-sm text-gray-600">{severity}</div>
                  <div className="text-2xl font-bold">{count}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">Verdicts</h2>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={filterVulnOnly}
                    onChange={(e) => setFilterVulnOnly(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">Vulnerabilities only</span>
                </label>
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader className="w-8 h-8 animate-spin text-blue-500" />
              </div>
            ) : (
              <div className="space-y-3">
                {filteredAnalyses.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No analyses match the current filters
                  </div>
                ) : (
                  filteredAnalyses.map(analysis => {
                    const result = analysis.result_json;
                    const isExpanded = expandedIds.has(analysis.id);

                    if (isAnalysisError(result)) {
                      return (
                        <div key={analysis.id} className="border border-red-200 rounded-lg bg-red-50 p-4">
                          <div className="flex items-center gap-3">
                            <XCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
                            <div>
                              <div className="font-medium text-red-900">Analysis Failed</div>
                              <div className="text-sm text-red-700 mt-1">{result.error}</div>
                              <div className="text-xs text-red-600 mt-1">Finding ID: {analysis.finding_id}</div>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    if (isAnalysisSkipped(result)) {
                      return (
                        <div key={analysis.id} className="border border-gray-300 rounded-lg bg-gray-50 p-4">
                          <div className="flex items-center gap-3">
                            <AlertTriangle className="w-5 h-5 text-gray-600 flex-shrink-0" />
                            <div>
                              <div className="font-medium text-gray-900">Analysis Skipped</div>
                              <div className="text-sm text-gray-700 mt-1">{result.reason || 'No reason provided'}</div>
                              <div className="text-xs text-gray-600 mt-1">Finding ID: {analysis.finding_id}</div>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    if (!isAIVerdict(result)) {
                      return (
                        <div key={analysis.id} className="border border-yellow-200 rounded-lg bg-yellow-50 p-4">
                          <div className="flex items-center gap-3">
                            <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0" />
                            <div>
                              <div className="font-medium text-yellow-900">Unknown Result Format</div>
                              <div className="text-sm text-yellow-700 mt-1">Unable to parse analysis result</div>
                              <div className="text-xs text-yellow-600 mt-1">Finding ID: {analysis.finding_id}</div>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    const verdict = result;

                    return (
                      <div key={analysis.id} className="border rounded-lg">
                        <div
                          onClick={() => toggleExpand(analysis.id)}
                          className="p-4 cursor-pointer hover:bg-gray-50 flex items-center justify-between"
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2">
                              {verdict.is_vulnerability ? (
                                <AlertTriangle className="w-5 h-5 text-red-600" />
                              ) : (
                                <CheckCircle className="w-5 h-5 text-green-600" />
                              )}
                              <span className="font-medium text-gray-900">
                                {verdict.title || 'Untitled'}
                              </span>
                              <span className={`px-2 py-1 text-xs rounded border ${getSeverityColor(verdict.severity)}`}>
                                {verdict.severity}
                              </span>
                              <span className="text-sm text-gray-600">
                                {(verdict.confidence * 100).toFixed(0)}% confidence
                              </span>
                            </div>
                            <div className="text-sm text-gray-600">
                              {verdict.category}
                            </div>
                          </div>
                          {isExpanded ? (
                            <ChevronUp className="w-5 h-5 text-gray-400" />
                          ) : (
                            <ChevronDown className="w-5 h-5 text-gray-400" />
                          )}
                        </div>

                        {isExpanded && (
                          <div className="p-4 border-t bg-gray-50 space-y-4">
                            <div>
                              <h4 className="font-medium text-gray-900 mb-2">Risk Description</h4>
                              <p className="text-sm text-gray-700">{verdict.risk_description}</p>
                            </div>

                            {verdict.exploit_steps && verdict.exploit_steps.length > 0 && (
                              <div>
                                <h4 className="font-medium text-gray-900 mb-2">Exploit Steps</h4>
                                <ol className="list-decimal list-inside space-y-1">
                                  {verdict.exploit_steps.map((step, idx) => (
                                    <li key={idx} className="text-sm text-gray-700">{step}</li>
                                  ))}
                                </ol>
                              </div>
                            )}

                            <div>
                              <h4 className="font-medium text-gray-900 mb-2">Impact</h4>
                              <p className="text-sm text-gray-700">{verdict.impact}</p>
                            </div>

                            {verdict.mitigations && verdict.mitigations.length > 0 && (
                              <div>
                                <h4 className="font-medium text-gray-900 mb-2">Mitigations</h4>
                                <ul className="list-disc list-inside space-y-1">
                                  {verdict.mitigations.map((mit, idx) => (
                                    <li key={idx} className="text-sm text-gray-700">{mit}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {!verdict.is_vulnerability && verdict.false_positive_reason && (
                              <div>
                                <h4 className="font-medium text-gray-900 mb-2">False Positive Reason</h4>
                                <p className="text-sm text-gray-700">{verdict.false_positive_reason}</p>
                              </div>
                            )}

                            {verdict.key_signals && verdict.key_signals.length > 0 && (
                              <div>
                                <h4 className="font-medium text-gray-900 mb-2">Key Signals</h4>
                                <ul className="list-disc list-inside space-y-1">
                                  {verdict.key_signals.map((signal, idx) => (
                                    <li key={idx} className="text-sm text-gray-700">{signal}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            <div className="text-xs text-gray-500 pt-2 border-t">
                              Model: {analysis.model} | Latency: {analysis.latency_ms}ms
                              {analysis.tokens_in && ` | Tokens: ${analysis.tokens_in} in, ${analysis.tokens_out} out`}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
