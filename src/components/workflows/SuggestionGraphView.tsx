import type { LearningSuggestionPayloadV2 } from '../../lib/api-client';

interface Props {
  payload: LearningSuggestionPayloadV2;
}

export function SuggestionGraphView({ payload }: Props) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Nodes</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900">{payload.summary.nodeCount}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Edges</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900">{payload.summary.edgeCount}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Mode</div>
          <div className="mt-2 text-lg font-semibold text-gray-900">{payload.sourceType.replace(/_/g, ' ')}</div>
        </div>
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="text-sm font-semibold text-gray-900">Value Flow Graph</div>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2">Variable</th>
                <th className="px-3 py-2">From</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payload.graph.edges.map((edge) => (
                <tr key={edge.id}>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700">{edge.variableName}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{edge.fromNodeId.replace(/^resp:/, '').replace(/^req:/, '')}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{edge.toNodeId.replace(/^resp:/, '').replace(/^req:/, '')}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{edge.source}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{Math.round(edge.confidence * 100)}%</td>
                </tr>
              ))}
              {payload.graph.edges.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-center text-sm text-gray-500" colSpan={5}>No graph edges were generated.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
