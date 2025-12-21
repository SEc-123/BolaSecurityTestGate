import { useState, useMemo } from 'react';
import { Check, X, ChevronDown, ChevronRight, AlertTriangle, ArrowRight } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button, Select, Checkbox } from './ui/Form';
import type {
  MappingCandidate,
  CandidateField,
  WorkflowVariable,
  LearningResult,
} from '../lib/api-client';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  result: LearningResult | null;
  workflowSteps: { stepOrder: number; name: string }[];
  onApply: (
    acceptedCandidates: MappingCandidate[],
    variables: Partial<WorkflowVariable>[]
  ) => Promise<void>;
}

const TYPE_COLORS: Record<string, string> = {
  IDENTITY: 'bg-red-100 text-red-800 border-red-200',
  FLOW_TICKET: 'bg-amber-100 text-amber-800 border-amber-200',
  OBJECT_ID: 'bg-blue-100 text-blue-800 border-blue-200',
  GENERIC: 'bg-gray-100 text-gray-600 border-gray-200',
  NOISE: 'bg-gray-50 text-gray-400 border-gray-100',
};

export function LearningResultsModal({ isOpen, onClose, result, workflowSteps, onApply }: Props) {
  const [selectedMappings, setSelectedMappings] = useState<Set<string>>(new Set());
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  const [variableOverrides, setVariableOverrides] = useState<Record<string, Partial<WorkflowVariable>>>({});
  const [applying, setApplying] = useState(false);

  useMemo(() => {
    if (result?.mappingCandidates) {
      const highConfidence = result.mappingCandidates
        .filter(m => m.confidence >= 0.7)
        .map(m => getMappingKey(m));
      setSelectedMappings(new Set(highConfidence));

      const allSteps = new Set(result.mappingCandidates.map(m => m.fromStepOrder));
      setExpandedSteps(allSteps);
    }
  }, [result]);

  function getMappingKey(m: MappingCandidate): string {
    return `${m.fromStepOrder}:${m.fromPath}->${m.toStepOrder}:${m.toPath}`;
  }

  function toggleMapping(mapping: MappingCandidate) {
    const key = getMappingKey(mapping);
    const newSet = new Set(selectedMappings);
    if (newSet.has(key)) {
      newSet.delete(key);
    } else {
      newSet.add(key);
    }
    setSelectedMappings(newSet);
  }

  function toggleStep(stepOrder: number) {
    const newSet = new Set(expandedSteps);
    if (newSet.has(stepOrder)) {
      newSet.delete(stepOrder);
    } else {
      newSet.add(stepOrder);
    }
    setExpandedSteps(newSet);
  }

  function updateVariableOverride(variableName: string, updates: Partial<WorkflowVariable>) {
    setVariableOverrides(prev => ({
      ...prev,
      [variableName]: { ...prev[variableName], ...updates },
    }));
  }

  function selectAllHighConfidence() {
    if (!result) return;
    const highConfidence = result.mappingCandidates
      .filter(m => m.confidence >= 0.7)
      .map(m => getMappingKey(m));
    setSelectedMappings(new Set(highConfidence));
  }

  function selectNone() {
    setSelectedMappings(new Set());
  }

  async function handleApply() {
    if (!result) return;

    setApplying(true);
    try {
      const acceptedCandidates = result.mappingCandidates.filter(m =>
        selectedMappings.has(getMappingKey(m))
      );

      const variableNames = new Set(acceptedCandidates.map(m => m.variableName));
      const variables: Partial<WorkflowVariable>[] = Array.from(variableNames).map(name => {
        const mapping = acceptedCandidates.find(m => m.variableName === name);
        const override = variableOverrides[name] || {};
        return {
          name,
          type: override.type || mapping?.predictedType || 'GENERIC',
          source: 'extracted' as const,
          write_policy: override.write_policy || 'overwrite' as const,
          is_locked: override.is_locked || false,
          description: `Auto-learned from Step ${mapping?.fromStepOrder}`,
        };
      });

      await onApply(acceptedCandidates, variables);
      onClose();
    } catch (error) {
      console.error('Failed to apply mappings:', error);
    } finally {
      setApplying(false);
    }
  }

  const getStepName = (stepOrder: number) => {
    const step = workflowSteps.find(s => s.stepOrder === stepOrder);
    return step?.name || `Step ${stepOrder}`;
  };

  const groupedMappings = useMemo(() => {
    if (!result) return {};
    const groups: Record<number, MappingCandidate[]> = {};
    result.mappingCandidates.forEach(m => {
      if (!groups[m.fromStepOrder]) {
        groups[m.fromStepOrder] = [];
      }
      groups[m.fromStepOrder].push(m);
    });
    return groups;
  }, [result]);

  if (!result) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Learning Results"
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleApply} disabled={selectedMappings.size === 0 || applying}>
            {applying ? 'Applying...' : `Apply ${selectedMappings.size} Mapping(s)`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
          <div className="text-sm text-gray-600">
            Found <span className="font-semibold text-gray-900">{result.mappingCandidates.length}</span> potential mappings
          </div>
          <div className="flex gap-2">
            <button
              onClick={selectAllHighConfidence}
              className="text-sm text-blue-600 hover:underline"
            >
              Select High Confidence
            </button>
            <span className="text-gray-300">|</span>
            <button
              onClick={selectNone}
              className="text-sm text-gray-600 hover:underline"
            >
              Clear All
            </button>
          </div>
        </div>

        {result.mappingCandidates.length === 0 ? (
          <div className="p-8 text-center">
            <AlertTriangle className="mx-auto h-12 w-12 text-amber-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No Mappings Found</h3>
            <p className="text-gray-500">
              The learning algorithm couldn't find any field mappings between steps.
              This might be because:
            </p>
            <ul className="mt-3 text-sm text-gray-500 text-left max-w-md mx-auto">
              <li>- Response bodies don't contain recognizable fields</li>
              <li>- Field names don't match between steps</li>
              <li>- No values are shared between responses and requests</li>
            </ul>
          </div>
        ) : (
          <div className="space-y-3 max-h-[500px] overflow-y-auto">
            {Object.entries(groupedMappings).map(([stepOrderStr, mappings]) => {
              const stepOrder = parseInt(stepOrderStr);
              const isExpanded = expandedSteps.has(stepOrder);
              const selectedCount = mappings.filter(m => selectedMappings.has(getMappingKey(m))).length;

              return (
                <div key={stepOrder} className="border border-gray-200 rounded-lg">
                  <button
                    onClick={() => toggleStep(stepOrder)}
                    className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 rounded-t-lg"
                  >
                    <div className="flex items-center gap-2">
                      {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      <span className="font-medium">Step {stepOrder}: {getStepName(stepOrder)}</span>
                      <span className="text-sm text-gray-500">({mappings.length} mappings)</span>
                    </div>
                    {selectedCount > 0 && (
                      <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded">
                        {selectedCount} selected
                      </span>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="divide-y divide-gray-100">
                      {mappings.map((mapping, idx) => {
                        const key = getMappingKey(mapping);
                        const isSelected = selectedMappings.has(key);
                        const override = variableOverrides[mapping.variableName] || {};

                        return (
                          <div
                            key={idx}
                            className={`p-3 ${isSelected ? 'bg-blue-50' : 'bg-white'}`}
                          >
                            <div className="flex items-start gap-3">
                              <Checkbox
                                checked={isSelected}
                                onChange={() => toggleMapping(mapping)}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className={`px-2 py-0.5 text-xs rounded border ${TYPE_COLORS[mapping.predictedType]}`}>
                                    {mapping.predictedType}
                                  </span>
                                  <code className="text-sm font-mono bg-gray-100 px-2 py-0.5 rounded truncate">
                                    {mapping.variableName}
                                  </code>
                                  <span className={`text-xs px-2 py-0.5 rounded ${
                                    mapping.confidence >= 0.8 ? 'bg-green-100 text-green-700' :
                                    mapping.confidence >= 0.5 ? 'bg-amber-100 text-amber-700' :
                                    'bg-gray-100 text-gray-600'
                                  }`}>
                                    {(mapping.confidence * 100).toFixed(0)}% confidence
                                  </span>
                                  <span className="text-xs text-gray-500">
                                    ({mapping.reason})
                                  </span>
                                </div>

                                <div className="mt-2 flex items-center gap-2 text-sm">
                                  <div className="flex-1 p-2 bg-gray-50 rounded">
                                    <div className="text-xs text-gray-500 mb-1">From: {mapping.fromLocation}</div>
                                    <code className="text-xs font-mono">{mapping.fromPath}</code>
                                    <div className="text-xs text-gray-400 mt-1 truncate">
                                      Value: {mapping.fromValuePreview}
                                    </div>
                                  </div>
                                  <ArrowRight size={16} className="text-gray-400 flex-shrink-0" />
                                  <div className="flex-1 p-2 bg-gray-50 rounded">
                                    <div className="text-xs text-gray-500 mb-1">
                                      To Step {mapping.toStepOrder}: {mapping.toLocation}
                                    </div>
                                    <code className="text-xs font-mono">{mapping.toPath}</code>
                                  </div>
                                </div>

                                {isSelected && (
                                  <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 gap-3">
                                    <Select
                                      label="Override Type"
                                      value={override.type || mapping.predictedType}
                                      onChange={(e) => updateVariableOverride(mapping.variableName, {
                                        type: e.target.value as WorkflowVariable['type']
                                      })}
                                      options={[
                                        { value: 'IDENTITY', label: 'Identity (auth tokens)' },
                                        { value: 'FLOW_TICKET', label: 'Flow Ticket (CSRF, nonce)' },
                                        { value: 'OBJECT_ID', label: 'Object ID (user_id, etc)' },
                                        { value: 'GENERIC', label: 'Generic' },
                                      ]}
                                    />
                                    <Select
                                      label="Write Policy"
                                      value={override.write_policy || 'overwrite'}
                                      onChange={(e) => updateVariableOverride(mapping.variableName, {
                                        write_policy: e.target.value as WorkflowVariable['write_policy']
                                      })}
                                      options={[
                                        { value: 'first', label: 'First (keep first value)' },
                                        { value: 'overwrite', label: 'Overwrite (use latest)' },
                                        { value: 'on_success_only', label: 'On Success Only' },
                                      ]}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              <strong>Note:</strong> Applying will replace any existing variables and mappings for this workflow.
              Review the selected mappings carefully before applying.
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
