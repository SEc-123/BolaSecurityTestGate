import { useState, useEffect } from 'react';
import { RefreshCw, Download, Trash2, Search, ChevronDown, ChevronRight, Clock, AlertTriangle } from 'lucide-react';
import { debugService, type DebugTrace, type DebugRequestRecord } from '../lib/api-service';

export function DebugPanel() {
  const [kind, setKind] = useState<'workflow' | 'template'>('workflow');
  const [trace, setTrace] = useState<DebugTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRecords, setExpandedRecords] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  const loadTrace = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await debugService.getLast(kind);
      setTrace(result);
      setExpandedRecords(new Set());
    } catch (err: any) {
      setError(err.message || 'Failed to load trace');
    } finally {
      setLoading(false);
    }
  };

  const clearTrace = async () => {
    if (!confirm(`Clear ${kind} trace?`)) return;
    try {
      setLoading(true);
      setError(null);
      await debugService.clear(kind);
      setTrace(null);
      setExpandedRecords(new Set());
    } catch (err: any) {
      setError(err.message || 'Failed to clear trace');
    } finally {
      setLoading(false);
    }
  };

  const toggleRecord = (index: number) => {
    const newExpanded = new Set(expandedRecords);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedRecords(newExpanded);
  };

  const exportTrace = (format: 'json' | 'txt') => {
    const url = debugService.exportUrl(kind, format);
    window.open(url, '_blank');
  };

  useEffect(() => {
    loadTrace();
  }, [kind]);

  const filteredRecords = trace?.records?.filter(record => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      record.url.toLowerCase().includes(query) ||
      record.method.toLowerCase().includes(query) ||
      (record.meta?.template_name?.toLowerCase().includes(query)) ||
      (record.meta?.label?.toLowerCase().includes(query))
    );
  }) || [];

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Debug Trace</h1>
        <p className="text-gray-600">View complete request/response history from recent test runs</p>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Trace Type</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as 'workflow' | 'template')}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="workflow">Workflow</option>
              <option value="template">Template / Test Run</option>
            </select>
          </div>

          <div className="flex gap-2 mt-auto">
            <button
              onClick={loadTrace}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>

            <button
              onClick={clearTrace}
              disabled={loading || !trace}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              Clear
            </button>

            <button
              onClick={() => exportTrace('json')}
              disabled={!trace}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              Export JSON
            </button>

            <button
              onClick={() => exportTrace('txt')}
              disabled={!trace}
              className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              Export TXT
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2 text-red-800">
            <AlertTriangle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center h-64">
          <Clock className="w-8 h-8 text-blue-500 animate-spin" />
        </div>
      )}

      {!loading && !trace && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No trace available for {kind}. Run a {kind === 'workflow' ? 'workflow' : 'template test'} to generate trace data.</p>
        </div>
      )}

      {!loading && trace && (
        <>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Run Summary</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-gray-600">Run ID</p>
                <p className="text-lg font-medium text-gray-900 truncate" title={trace.run_meta.run_id}>
                  {trace.run_meta.run_id}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Total Requests</p>
                <p className="text-lg font-medium text-gray-900">{trace.summary.total_requests}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Errors</p>
                <p className="text-lg font-medium text-red-600">{trace.summary.errors_count}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Total Duration</p>
                <p className="text-lg font-medium text-gray-900">{trace.summary.total_duration_ms}ms</p>
              </div>
            </div>
            {trace.truncated && (
              <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-sm text-yellow-800">⚠️ Trace was truncated due to size limits</p>
              </div>
            )}
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="mb-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by URL, method, template, or label..."
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Requests ({filteredRecords.length})
            </h2>

            <div className="space-y-2">
              {filteredRecords.map((record, index) => (
                <div key={index} className="border border-gray-200 rounded-lg">
                  <button
                    onClick={() => toggleRecord(index)}
                    className="w-full p-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-4 text-left flex-1">
                      {expandedRecords.has(index) ? (
                        <ChevronDown className="w-5 h-5 text-gray-400 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-5 h-5 text-gray-400 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`px-2 py-1 text-xs font-semibold rounded ${
                            record.method === 'GET' ? 'bg-blue-100 text-blue-800' :
                            record.method === 'POST' ? 'bg-green-100 text-green-800' :
                            record.method === 'PUT' ? 'bg-yellow-100 text-yellow-800' :
                            record.method === 'DELETE' ? 'bg-red-100 text-red-800' :
                            'bg-gray-100 text-gray-800'
                          }`}>
                            {record.method}
                          </span>
                          <span className={`px-2 py-1 text-xs font-semibold rounded ${
                            record.error ? 'bg-red-100 text-red-800' :
                            record.response && record.response.status >= 200 && record.response.status < 300 ? 'bg-green-100 text-green-800' :
                            record.response && record.response.status >= 400 ? 'bg-red-100 text-red-800' :
                            'bg-gray-100 text-gray-800'
                          }`}>
                            {record.error ? 'ERROR' : record.response ? record.response.status : 'PENDING'}
                          </span>
                          <span className="text-sm text-gray-600">{record.duration_ms}ms</span>
                          {record.retry_attempt > 0 && (
                            <span className="px-2 py-1 text-xs bg-orange-100 text-orange-800 rounded">
                              Retry #{record.retry_attempt}
                            </span>
                          )}
                          {record.meta?.step_order !== undefined && (
                            <span className="text-xs text-gray-600">Step {record.meta.step_order}</span>
                          )}
                          {record.meta?.label && (
                            <span className="px-2 py-1 text-xs bg-purple-100 text-purple-800 rounded">
                              {record.meta.label}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-900 truncate font-mono">{record.url}</div>
                        {record.meta?.template_name && (
                          <div className="text-xs text-gray-600 mt-1">Template: {record.meta.template_name}</div>
                        )}
                      </div>
                    </div>
                  </button>

                  {expandedRecords.has(index) && (
                    <div className="border-t border-gray-200 p-4 bg-gray-50">
                      <div className="space-y-4">
                        <div>
                          <h4 className="font-semibold text-gray-900 mb-2">Request Headers</h4>
                          <pre className="bg-white p-3 rounded border border-gray-200 text-xs overflow-auto max-h-48">
                            {JSON.stringify(record.headers, null, 2)}
                          </pre>
                        </div>

                        {record.body && (
                          <div>
                            <h4 className="font-semibold text-gray-900 mb-2">
                              Request Body {record.truncated_body && <span className="text-xs text-orange-600">(truncated)</span>}
                            </h4>
                            <pre className="bg-white p-3 rounded border border-gray-200 text-xs overflow-auto max-h-64">
                              {record.body}
                            </pre>
                          </div>
                        )}

                        {record.error && (
                          <div>
                            <h4 className="font-semibold text-red-900 mb-2">Error</h4>
                            <pre className="bg-red-50 p-3 rounded border border-red-200 text-xs overflow-auto">
                              {record.error}
                            </pre>
                          </div>
                        )}

                        {record.response && (
                          <>
                            <div>
                              <h4 className="font-semibold text-gray-900 mb-2">Response Headers</h4>
                              <pre className="bg-white p-3 rounded border border-gray-200 text-xs overflow-auto max-h-48">
                                {JSON.stringify(record.response.headers, null, 2)}
                              </pre>
                            </div>

                            {record.response.body && (
                              <div>
                                <h4 className="font-semibold text-gray-900 mb-2">
                                  Response Body {record.response.truncated_body && <span className="text-xs text-orange-600">(truncated)</span>}
                                </h4>
                                <pre className="bg-white p-3 rounded border border-gray-200 text-xs overflow-auto max-h-64">
                                  {record.response.body}
                                </pre>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {filteredRecords.length === 0 && (
                <p className="text-center text-gray-600 py-8">No requests match your search</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
