import { useState, useEffect } from 'react';
import { FileText, Download, Loader, Plus, Eye } from 'lucide-react';
import { aiService, testRunsService, type AIProvider, type AIReport } from '../lib/api-service';
import { Modal } from '../components/ui/Modal';

export default function AIReports() {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [testRuns, setTestRuns] = useState<any[]>([]);
  const [reports, setReports] = useState<AIReport[]>([]);
  const [selectedRun, setSelectedRun] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('');
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
      const [providersData, runsData, reportsData] = await Promise.all([
        aiService.listProviders(),
        testRunsService.list(),
        aiService.listReports()
      ]);

      const enabledProviders = providersData.filter(p => p.is_enabled);
      setProviders(enabledProviders);

      if (enabledProviders.length > 0 && !selectedProvider) {
        const defaultProvider = enabledProviders.find(p => p.is_default) || enabledProviders[0];
        setSelectedProvider(defaultProvider.id);
      }

      setTestRuns(runsData.slice(0, 50));
      setReports(reportsData);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!selectedRun || !selectedProvider) {
      setError('Please select a run and provider');
      return;
    }

    try {
      setGenerating(true);
      setError('');

      const report = await aiService.generateReport(selectedRun, selectedProvider, {
        min_confidence: minConfidence,
        include_severities: includeSeverities
      });

      alert('Report generated successfully!');
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
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI Reports</h1>
          <p className="mt-1 text-sm text-gray-600">
            Generate and manage vulnerability reports
          </p>
        </div>
        <button
          onClick={() => setShowGenerateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          <Plus className="w-4 h-4" />
          Generate Report
        </button>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Run ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Provider
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
                      No reports generated yet. Click "Generate Report" to create one.
                    </td>
                  </tr>
                ) : (
                  reports.map(report => {
                    const provider = providers.find(p => p.id === report.provider_id);

                    return (
                      <tr key={report.id}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {new Date(report.created_at).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-600">
                          {report.run_id.substring(0, 8)}...
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {provider?.name || 'Unknown'}
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
                            className="text-blue-600 hover:text-blue-900 mr-4"
                            title="Preview"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDownload(report.id)}
                            className="text-green-600 hover:text-green-900"
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
              Test Run *
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
              disabled={generating || !selectedRun || !selectedProvider}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400"
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
