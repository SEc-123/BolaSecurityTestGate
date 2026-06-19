import { useState, useEffect } from 'react';
import { CheckCircle2, Download, Eye, FileText, Loader, Plus, ShieldCheck } from 'lucide-react';
import { aiScansService, aiService, findingsService, testRunsService, type AIProvider, type AIReport } from '../lib/api-service';
import { Modal } from '../components/ui/Modal';
import type { AIScanRun, FindingIssue } from '../types';

export default function AIReports() {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [testRuns, setTestRuns] = useState<any[]>([]);
  const [reports, setReports] = useState<AIReport[]>([]);
  const [aiScanRuns, setAIScanRuns] = useState<AIScanRun[]>([]);
  const [findingIssues, setFindingIssues] = useState<FindingIssue[]>([]);
  const [selectedRun, setSelectedRun] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [reportType, setReportType] = useState<'local_evidence' | 'ai'>('local_evidence');
  const [minConfidence, setMinConfidence] = useState(0.7);
  const [includeSeverities, setIncludeSeverities] = useState<string[]>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewReport, setPreviewReport] = useState<AIReport | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [providersData, runsData, reportsData, aiScanRunsData, issuesData] = await Promise.all([
        aiService.listProviders(),
        testRunsService.list(),
        aiService.listReports(),
        aiScansService.list(),
        findingsService.listIssues()
      ]);

      const enabledProviders = providersData.filter(p => p.is_enabled);
      setProviders(enabledProviders);

      if (enabledProviders.length > 0 && !selectedProvider) {
        const defaultProvider = enabledProviders.find(p => p.is_default) || enabledProviders[0];
        setSelectedProvider(defaultProvider.id);
      }

      setTestRuns(runsData.slice(0, 50));
      setReports(reportsData);
      setAIScanRuns(aiScanRunsData);
      setFindingIssues(issuesData);
      if (!selectedRun && aiScanRunsData.length > 0) {
        setSelectedRun(aiScanRunsData[0].id);
      } else if (!selectedRun && runsData.length > 0) {
        setSelectedRun(runsData[0].id);
      }
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!selectedRun) {
      setError('Please select a run');
      return;
    }
    if (reportType === 'ai' && !selectedProvider) {
      setError('Please select a provider or use the local evidence report');
      return;
    }

    try {
      setGenerating(true);
      setError('');

      await aiService.generateReport(selectedRun, reportType === 'ai' ? selectedProvider : undefined, {
        min_confidence: minConfidence,
        include_severities: includeSeverities,
        report_type: reportType
      });

      setShowGenerateModal(false);
      await loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handlePreview = (report: AIReport) => {
    setPreviewReport(report);
    setShowPreviewModal(true);
  };

  const handleDownload = (reportId: string) => {
    const url = aiService.exportReportUrl(reportId);
    window.open(url, '_blank');
  };

  const toggleSeverity = (severity: string) => {
    setIncludeSeverities(prev =>
      prev.includes(severity)
        ? prev.filter(s => s !== severity)
        : [...prev, severity]
    );
  };

  const severities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

  const getSeverityColor = (severity: string) => {
    const colors: Record<string, string> = {
      CRITICAL: 'bg-red-100 text-red-800',
      HIGH: 'bg-orange-100 text-orange-800',
      MEDIUM: 'bg-yellow-100 text-yellow-800',
      LOW: 'bg-blue-100 text-blue-800',
      INFO: 'bg-gray-100 text-gray-800'
    };
    return colors[severity] || colors.INFO;
  };

  return (
    <div className="min-h-full bg-slate-50 p-6 text-slate-950">
      <div className="mb-5 flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Reporting</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">Reports</h1>
          <p className="mt-1 text-sm text-slate-600">
            Generate a compact evidence report from validated findings.
          </p>
        </div>
        <button
          onClick={() => setShowGenerateModal(true)}
          className="inline-flex h-9 items-center gap-2 rounded bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          <Plus className="w-4 h-4" />
          Generate Simple Report
        </button>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          {error}
        </div>
      )}

      {aiScanRuns.length > 0 && (
        <div className="mb-5 border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-700" />
              <div>
                <div className="font-semibold text-emerald-950">Latest AI Scan is ready for reporting</div>
                <div className="mt-1 text-sm text-emerald-800">
                  {aiScanRuns[0].status} · {aiScanRuns[0].summary?.endpoints_total || 0} endpoints · {findingIssues.length} unique issues from {findingIssues.reduce((total, issue) => total + issue.raw_count, 0)} raw findings.
                </div>
              </div>
            </div>
            <button
              onClick={handleGenerate}
              disabled={generating || !selectedRun}
              className="inline-flex h-9 items-center justify-center gap-2 rounded border border-emerald-300 bg-white px-3 text-sm font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
            >
              {generating ? <Loader className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Generate evidence report
            </button>
          </div>
        </div>
      )}

      <div className="mb-5 grid gap-3 md:grid-cols-4">
        {[
          ['Reports', reports.length],
          ['Unique issues', findingIssues.length],
          ['Raw findings', findingIssues.reduce((total, issue) => total + issue.raw_count, 0)],
          ['Providers', providers.length],
        ].map(([label, value]) => (
          <div key={label} className="border border-slate-200 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{value}</div>
          </div>
        ))}
      </div>

      {providers.length === 0 && (
        <div className="mb-5 border border-slate-200 bg-white p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 text-slate-600" />
            <div>
              <div className="font-semibold text-slate-950">No AI provider configured. Local report mode is available.</div>
              <div className="mt-1 text-sm text-slate-600">
                The simple report uses parsed evidence and native gate results, so it can generate without calling a model.
              </div>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader className="w-8 h-8 animate-spin text-slate-500" />
        </div>
      ) : (
        <div className="border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Run ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Source
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Findings
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Vulnerabilities
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Severity Distribution
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {reports.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                      No reports generated yet. Generate a simple evidence report to create the first one.
                    </td>
                  </tr>
                ) : (
                  reports.map(report => {
                    const provider = providers.find(p => p.id === report.provider_id);
                    const source = report.prompt_version === 'local_evidence_report_v1' ? 'Local evidence' : provider?.name || 'AI provider';

                    return (
                      <tr key={report.id}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {new Date(report.created_at).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-600">
                          {report.run_id.substring(0, 8)}...
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {source}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {report.stats.total_findings}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="px-2 py-1 text-sm font-semibold text-red-800">
                            {report.stats.vulnerabilities_found}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex gap-1">
                            {Object.entries(report.stats.severity_distribution).map(([severity, count]) => (
                              <span
                                key={severity}
                                className={`px-2 py-1 text-xs rounded ${getSeverityColor(severity)}`}
                              >
                                {severity.charAt(0)}: {count}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                          <button
                            onClick={() => handlePreview(report)}
                            className="mr-4 text-slate-600 hover:text-slate-950"
                            title="Preview"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDownload(report.id)}
                            className="text-emerald-700 hover:text-emerald-900"
                            title="Download"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        isOpen={showGenerateModal}
        onClose={() => setShowGenerateModal(false)}
        title="Generate Report"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Run *
            </label>
            <select
              value={selectedRun}
              onChange={(e) => setSelectedRun(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            >
              <option value="">Select a run...</option>
              {aiScanRuns.map(run => (
                <option key={run.id} value={run.id}>
                  [AI Scan] {run.name || run.id} - {run.base_url}
                </option>
              ))}
              {testRuns.map(run => (
                <option key={run.id} value={run.id}>
                  [Test Run] {run.name || run.test_name || run.id} - {new Date(run.created_at).toLocaleString()}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Report Mode
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setReportType('local_evidence')}
                className={`rounded border px-3 py-2 text-left text-sm ${reportType === 'local_evidence' ? 'border-slate-950 bg-slate-950 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
              >
                Local evidence
              </button>
              <button
                type="button"
                onClick={() => setReportType('ai')}
                disabled={providers.length === 0}
                className={`rounded border px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${reportType === 'ai' ? 'border-slate-950 bg-slate-950 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
              >
                AI writer
              </button>
            </div>
          </div>

          {reportType === 'ai' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                AI Provider *
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
          )}

          {reportType === 'local_evidence' && (
            <div className="border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              Generates immediately from unique issues, parsed evidence, and native gate results. No model call required.
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Minimum Confidence: {(minConfidence * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={minConfidence}
              onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Include Severities
            </label>
            <div className="flex flex-wrap gap-2">
              {severities.map(severity => (
                <label
                  key={severity}
                  className="flex items-center gap-2 px-3 py-2 border rounded-lg cursor-pointer hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={includeSeverities.includes(severity)}
                    onChange={() => toggleSeverity(severity)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm">{severity}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={() => setShowGenerateModal(false)}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleGenerate}
              disabled={generating || !selectedRun || (reportType === 'ai' && !selectedProvider)}
              className="flex-1 px-4 py-2 bg-slate-950 text-white rounded-lg hover:bg-slate-800 disabled:bg-gray-400"
            >
              {generating ? 'Generating...' : 'Generate'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showPreviewModal}
        onClose={() => setShowPreviewModal(false)}
        title="Report Preview"
        size="xl"
      >
        {previewReport && (
          <div>
            <div className="mb-4 p-4 bg-gray-50 rounded-lg">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="font-medium">Created:</span> {new Date(previewReport.created_at).toLocaleString()}
                </div>
                <div>
                  <span className="font-medium">Model:</span> {previewReport.model}
                </div>
                <div>
                  <span className="font-medium">Total Findings:</span> {previewReport.stats.total_findings}
                </div>
                <div>
                  <span className="font-medium">Vulnerabilities:</span> {previewReport.stats.vulnerabilities_found}
                </div>
              </div>
            </div>

            <div className="prose prose-sm max-w-none max-h-96 overflow-y-auto bg-white p-6 border rounded-lg">
              <pre className="whitespace-pre-wrap text-sm">{previewReport.report_markdown}</pre>
            </div>

            <div className="flex gap-3 mt-4">
              <button
                onClick={() => setShowPreviewModal(false)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Close
              </button>
              <button
                onClick={() => handleDownload(previewReport.id)}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
