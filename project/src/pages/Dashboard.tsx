import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Database,
  FileText,
  GitBranch,
  PlayCircle,
  Plus,
  Server,
  Shield,
  Target,
  TrendingUp,
  Users,
  Workflow,
  Layers,
  AlertOctagon,
} from 'lucide-react';
import { dashboardService } from '../lib/api-service';
import type { DashboardSummary } from '../types';

interface DashboardProps {
  onNavigate?: (page: string) => void;
  onNavigateToFindings?: (params?: any) => void;
}

export function Dashboard({ onNavigate, onNavigateToFindings }: DashboardProps) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      setLoading(true);
      const data = await dashboardService.summary();
      setSummary(data);
      setError(null);
    } catch (err: any) {
      console.error('Failed to load dashboard:', err);
      setError(err.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-center h-96">
          <div className="text-center">
            <Clock className="w-12 h-12 text-blue-500 animate-spin mx-auto mb-4" />
            <p className="text-gray-600">Loading dashboard...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-red-600 flex-shrink-0" />
            <div>
              <h3 className="text-lg font-semibold text-red-900">Failed to load dashboard</h3>
              <p className="text-red-700 mt-1">{error || 'Unknown error occurred'}</p>
              <button
                onClick={loadDashboard}
                className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isEmptyDatabase =
    summary.counts.environments.total === 0 &&
    summary.counts.accounts.total === 0 &&
    summary.counts.templates.total === 0 &&
    summary.counts.workflows.total === 0;

  if (isEmptyDatabase) {
    return (
      <div className="p-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Bola Security Test Gate</h1>
          <p className="text-gray-600">API / Workflow security testing and CI Gate</p>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-8">
          <div className="max-w-2xl mx-auto text-center">
            <Target className="w-16 h-16 text-blue-600 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Getting Started</h2>
            <p className="text-gray-600 mb-8">
              Welcome! Set up your security testing platform by following these steps:
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
              <div className="bg-white rounded-lg p-4 border border-blue-200">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                    1
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-1">Create Environment</h3>
                    <p className="text-sm text-gray-600">Define your API base URLs</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg p-4 border border-blue-200">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                    2
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-1">Add Test Accounts</h3>
                    <p className="text-sm text-gray-600">Configure user identities</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg p-4 border border-blue-200">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                    3
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-1">Import API Template</h3>
                    <p className="text-sm text-gray-600">Add your API requests</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg p-4 border border-blue-200">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                    4
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-1">Create Baseline Workflow</h3>
                    <p className="text-sm text-gray-600">Build API test flows</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg p-4 border border-blue-200">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                    5
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-1">Run Learning</h3>
                    <p className="text-sm text-gray-600">Train baseline behaviors</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg p-4 border border-blue-200">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                    6
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-1">Create Mutation & Run</h3>
                    <p className="text-sm text-gray-600">Test security scenarios</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8 flex gap-3 justify-center">
              <button
                onClick={() => onNavigate?.('environments')}
                className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                Start Setup
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const baselineCoverage =
    summary.counts.workflows.baseline > 0
      ? Math.round((summary.counts.workflows.baseline_learned / summary.counts.workflows.baseline) * 100)
      : 0;

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Bola Security Test Gate</h1>
        <p className="text-gray-600">API / Workflow security testing and CI Gate</p>
      </div>

      <div className="bg-white rounded-lg shadow border border-gray-200 p-4 mb-8">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${summary.db.connected ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <span className="text-sm font-medium text-gray-700">
                {summary.db.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <Database size={16} />
              <span>{summary.db.activeProfileName}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <Server size={16} />
              <span>Schema v{summary.db.schemaVersion}</span>
            </div>
          </div>
          {summary.db.runningRunsCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1 bg-blue-100 text-blue-700 rounded-full">
              <Activity size={16} className="animate-pulse" />
              <span className="text-sm font-medium">{summary.db.runningRunsCount} running</span>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-red-100 text-red-600 rounded-lg flex items-center justify-center">
              <AlertOctagon size={24} />
            </div>
            <div>
              <p className="text-sm text-gray-600">Open Findings</p>
              <p className="text-2xl font-bold text-gray-900">{summary.findings.open}</p>
            </div>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="px-2 py-1 bg-red-100 text-red-700 rounded">
              Critical: {summary.findings.bySeverity.critical}
            </span>
            <span className="px-2 py-1 bg-orange-100 text-orange-700 rounded">
              High: {summary.findings.bySeverity.high}
            </span>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center">
              <TrendingUp size={24} />
            </div>
            <div>
              <p className="text-sm text-gray-600">Baseline Coverage</p>
              <p className="text-2xl font-bold text-gray-900">{baselineCoverage}%</p>
            </div>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${baselineCoverage}%` }}
            ></div>
          </div>
          <p className="text-xs text-gray-600 mt-2">
            {summary.counts.workflows.baseline_learned} / {summary.counts.workflows.baseline} baselines learned
          </p>
        </div>

        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-purple-100 text-purple-600 rounded-lg flex items-center justify-center">
              <GitBranch size={24} />
            </div>
            <div>
              <p className="text-sm text-gray-600">Mutation Health</p>
              <p className="text-2xl font-bold text-gray-900">{summary.counts.workflows.mutation}</p>
            </div>
          </div>
          {summary.mutationHealth.versionMismatchCount > 0 ? (
            <div className="text-xs bg-yellow-50 border border-yellow-200 text-yellow-800 px-2 py-1 rounded">
              {summary.mutationHealth.versionMismatchCount} version mismatches
            </div>
          ) : (
            <div className="text-xs text-green-600">All mutations in sync</div>
          )}
        </div>

        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-green-100 text-green-600 rounded-lg flex items-center justify-center">
              <Activity size={24} />
            </div>
            <div>
              <p className="text-sm text-gray-600">Test Runs</p>
              <p className="text-2xl font-bold text-gray-900">{summary.runs.total}</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1 text-xs">
            <div className="text-center">
              <div className="font-semibold text-green-700">{summary.runs.completed}</div>
              <div className="text-gray-500">Done</div>
            </div>
            <div className="text-center">
              <div className="font-semibold text-red-700">{summary.runs.failed}</div>
              <div className="text-gray-500">Failed</div>
            </div>
            <div className="text-center">
              <div className="font-semibold text-yellow-700">{summary.runs.completed_with_errors}</div>
              <div className="text-gray-500">Errors</div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-orange-100 text-orange-600 rounded-lg flex items-center justify-center">
              <Layers size={24} />
            </div>
            <div>
              <p className="text-sm text-gray-600">Assets</p>
              <p className="text-2xl font-bold text-gray-900">
                {summary.counts.environments.total + summary.counts.accounts.total + summary.counts.templates.total}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1 text-xs">
            <div className="text-center">
              <div className="font-semibold text-gray-700">{summary.counts.templates.total}</div>
              <div className="text-gray-500">Templates</div>
            </div>
            <div className="text-center">
              <div className="font-semibold text-gray-700">{summary.counts.environments.total}</div>
              <div className="text-gray-500">Envs</div>
            </div>
            <div className="text-center">
              <div className="font-semibold text-gray-700">{summary.counts.accounts.total}</div>
              <div className="text-gray-500">Accounts</div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-slate-100 text-slate-600 rounded-lg flex items-center justify-center">
              <Shield size={24} />
            </div>
            <div>
              <p className="text-sm text-gray-600">CI Gate Policies</p>
              <p className="text-2xl font-bold text-gray-900">{summary.counts.gatePolicies.total}</p>
            </div>
          </div>
          <div className="text-xs text-gray-600">
            {summary.counts.gatePolicies.enabled} enabled
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow border border-gray-200 p-6 mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <PlayCircle size={20} />
          Quick Actions
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <button
            onClick={() => onNavigate?.('templates')}
            className="flex flex-col items-center gap-2 p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors group"
          >
            <div className="w-12 h-12 bg-gray-100 group-hover:bg-blue-100 text-gray-600 group-hover:text-blue-600 rounded-lg flex items-center justify-center transition-colors">
              <Plus size={24} />
            </div>
            <span className="text-sm font-medium text-gray-700 group-hover:text-blue-700">New Template</span>
          </button>

          <button
            onClick={() => onNavigate?.('workflows')}
            className="flex flex-col items-center gap-2 p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors group"
          >
            <div className="w-12 h-12 bg-gray-100 group-hover:bg-blue-100 text-gray-600 group-hover:text-blue-600 rounded-lg flex items-center justify-center transition-colors">
              <Workflow size={24} />
            </div>
            <span className="text-sm font-medium text-gray-700 group-hover:text-blue-700">New Baseline</span>
          </button>

          <button
            onClick={() => onNavigate?.('workflows')}
            className="flex flex-col items-center gap-2 p-4 border-2 border-gray-200 rounded-lg hover:border-green-500 hover:bg-green-50 transition-colors group"
          >
            <div className="w-12 h-12 bg-gray-100 group-hover:bg-green-100 text-gray-600 group-hover:text-green-600 rounded-lg flex items-center justify-center transition-colors">
              <TrendingUp size={24} />
            </div>
            <span className="text-sm font-medium text-gray-700 group-hover:text-green-700">Run Learning</span>
          </button>

          <button
            onClick={() => onNavigate?.('workflows')}
            className="flex flex-col items-center gap-2 p-4 border-2 border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition-colors group"
          >
            <div className="w-12 h-12 bg-gray-100 group-hover:bg-purple-100 text-gray-600 group-hover:text-purple-600 rounded-lg flex items-center justify-center transition-colors">
              <GitBranch size={24} />
            </div>
            <span className="text-sm font-medium text-gray-700 group-hover:text-purple-700">New Mutation</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Clock size={20} />
            Recent Runs
          </h2>
          {summary.recent.runs.length === 0 ? (
            <div className="text-center py-8 text-gray-500">No test runs yet</div>
          ) : (
            <div className="space-y-3">
              {summary.recent.runs.map((run) => (
                <div
                  key={run.id}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                  onClick={() => onNavigate?.('runs')}
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">{run.name || run.execution_type || 'Run'}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <p className="text-xs text-gray-500">{new Date(run.created_at).toLocaleString()}</p>
                      {run.findings_count_effective > 0 && (
                        <span className="text-xs text-red-600">
                          {run.findings_count_effective} findings
                        </span>
                      )}
                      {run.errors_count > 0 && (
                        <span className="text-xs text-yellow-600">
                          {run.errors_count} errors
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-medium flex-shrink-0 ml-2 ${
                      run.status === 'completed'
                        ? 'bg-green-100 text-green-800'
                        : run.status === 'running'
                        ? 'bg-blue-100 text-blue-800'
                        : run.status === 'failed'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}
                  >
                    {run.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <AlertTriangle size={20} />
            Recent Findings
          </h2>
          {summary.recent.findings.length === 0 ? (
            <div className="text-center py-8 text-gray-500">No findings yet</div>
          ) : (
            <div className="space-y-3">
              {summary.recent.findings.map((finding) => (
                <div
                  key={finding.id}
                  className={`flex items-start gap-3 p-3 bg-gray-50 rounded-lg border-l-4 hover:bg-gray-100 transition-colors cursor-pointer ${
                    finding.severity === 'critical'
                      ? 'border-red-500'
                      : finding.severity === 'high'
                      ? 'border-orange-500'
                      : finding.severity === 'medium'
                      ? 'border-yellow-500'
                      : 'border-blue-500'
                  }`}
                  onClick={() => onNavigateToFindings?.()}
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">{finding.title}</p>
                    <p className="text-xs text-gray-500 mt-1 line-clamp-2">{finding.description || finding.source_type}</p>
                  </div>
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium flex-shrink-0 ${
                      finding.severity === 'critical'
                        ? 'bg-red-100 text-red-800'
                        : finding.severity === 'high'
                        ? 'bg-orange-100 text-orange-800'
                        : finding.severity === 'medium'
                        ? 'bg-yellow-100 text-yellow-800'
                        : 'bg-blue-100 text-blue-800'
                    }`}
                  >
                    {finding.severity}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {summary.mutationHealth.versionMismatchCount > 0 && (
        <div className="mt-8 bg-yellow-50 border border-yellow-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-yellow-900 mb-4 flex items-center gap-2">
            <AlertTriangle size={20} />
            Mutation Version Mismatches
          </h3>
          <div className="space-y-2">
            {summary.mutationHealth.mismatches.map((mismatch, idx) => (
              <div key={idx} className="bg-white rounded p-3 border border-yellow-200">
                <p className="font-medium text-gray-900">{mismatch.mutation_name}</p>
                <p className="text-sm text-gray-600 mt-1">
                  Mutation version: {mismatch.mutation_version} | Baseline version: {mismatch.baseline_version}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
