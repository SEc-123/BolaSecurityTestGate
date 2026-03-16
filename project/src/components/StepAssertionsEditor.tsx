import { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button, Input, Select } from './ui/Form';
import type { StepAssertion, AssertionOperator, AssertionsMode, WorkflowVariableConfig } from '../types';

interface StepAssertionsEditorProps {
  stepOrder: number;
  stepName: string;
  assertions: StepAssertion[];
  assertionsMode: AssertionsMode;
  variableConfigs: WorkflowVariableConfig[];
  contextVariables: string[];
  onChange: (assertions: StepAssertion[], mode: AssertionsMode) => void;
}

const OPERATORS: { value: AssertionOperator; label: string }[] = [
  { value: 'equals', label: '==' },
  { value: 'not_equals', label: '!=' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: '!contains' },
  { value: 'regex', label: 'regex' },
];

export function StepAssertionsEditor({
  stepOrder,
  stepName,
  assertions,
  assertionsMode,
  variableConfigs,
  contextVariables,
  onChange,
}: StepAssertionsEditorProps) {
  const [expanded, setExpanded] = useState(assertions.length > 0);

  const handleAddAssertion = () => {
    const newAssertion: StepAssertion = {
      op: 'equals',
      left: { type: 'response', path: 'body.' },
      right: { type: 'literal', value: '' },
      missing_behavior: 'fail',
    };
    onChange([...assertions, newAssertion], assertionsMode);
  };

  const handleRemoveAssertion = (index: number) => {
    onChange(assertions.filter((_, i) => i !== index), assertionsMode);
  };

  const handleUpdateAssertion = (index: number, updates: Partial<StepAssertion>) => {
    onChange(
      assertions.map((a, i) => (i === index ? { ...a, ...updates } : a)),
      assertionsMode
    );
  };

  const handleUpdateLeft = (index: number, path: string) => {
    handleUpdateAssertion(index, { left: { type: 'response', path } });
  };

  const handleUpdateRight = (index: number, type: 'literal' | 'workflow_variable' | 'workflow_context', valueOrKey: string) => {
    const right = type === 'literal'
      ? { type, value: valueOrKey }
      : { type, key: valueOrKey };
    handleUpdateAssertion(index, { right: right as StepAssertion['right'] });
  };

  const workflowVarNames = variableConfigs.map(vc => vc.name);

  return (
    <div className="border border-gray-200 rounded-lg mt-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-gray-50 rounded-t-lg"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span className="font-medium text-sm">Step {stepOrder} Assertions</span>
          {assertions.length > 0 && (
            <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">
              {assertions.length} rule{assertions.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <span className="text-xs text-gray-500">{stepName}</span>
      </button>

      {expanded && (
        <div className="p-3 border-t border-gray-200 bg-gray-50/50 space-y-3">
          {assertions.length > 0 && (
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm text-gray-600">Mode:</span>
              <Select
                value={assertionsMode}
                onChange={(e) => onChange(assertions, e.target.value as AssertionsMode)}
                options={[
                  { value: 'all', label: 'ALL must pass (AND)' },
                  { value: 'any', label: 'ANY can pass (OR)' },
                ]}
                className="text-sm"
              />
            </div>
          )}

          {assertions.map((assertion, index) => (
            <div key={index} className="bg-white border border-gray-200 rounded p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-500">Assertion #{index + 1}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveAssertion(index)}
                  className="p-1 hover:bg-red-100 rounded text-red-600"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="space-y-2">
                <div className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-4">
                    <Input
                      label="Left (Response Path)"
                      value={assertion.left.path}
                      onChange={(e) => handleUpdateLeft(index, e.target.value)}
                      placeholder="body.phone or headers.x-token"
                    />
                  </div>

                  <div className="col-span-2">
                    <Select
                      label="Op"
                      value={assertion.op}
                      onChange={(e) => handleUpdateAssertion(index, { op: e.target.value as AssertionOperator })}
                      options={OPERATORS}
                    />
                  </div>

                  <div className="col-span-2">
                    <Select
                      label="Right Type"
                      value={assertion.right.type}
                      onChange={(e) => {
                        const newType = e.target.value as 'literal' | 'workflow_variable' | 'workflow_context';
                        handleUpdateRight(index, newType, '');
                      }}
                      options={[
                        { value: 'literal', label: 'Literal' },
                        { value: 'workflow_variable', label: 'Variable' },
                        { value: 'workflow_context', label: 'Context' },
                      ]}
                    />
                  </div>

                  <div className="col-span-4">
                    {assertion.right.type === 'literal' ? (
                      <Input
                        label="Value"
                        value={assertion.right.value || ''}
                        onChange={(e) => handleUpdateRight(index, 'literal', e.target.value)}
                        placeholder="Expected value"
                      />
                    ) : assertion.right.type === 'workflow_variable' ? (
                      <Select
                        label="Variable"
                        value={assertion.right.key || ''}
                        onChange={(e) => handleUpdateRight(index, 'workflow_variable', e.target.value)}
                        options={[
                          { value: '', label: 'Select...' },
                          ...workflowVarNames.map(n => ({ value: n, label: n })),
                        ]}
                      />
                    ) : (
                      <Select
                        label="Context Key"
                        value={assertion.right.key || ''}
                        onChange={(e) => handleUpdateRight(index, 'workflow_context', e.target.value)}
                        options={[
                          { value: '', label: 'Select...' },
                          ...contextVariables.map(n => ({ value: n, label: n })),
                        ]}
                      />
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-600">Missing field:</span>
                  <Select
                    value={assertion.missing_behavior || 'fail'}
                    onChange={(e) => handleUpdateAssertion(index, { missing_behavior: e.target.value as 'fail' | 'skip' })}
                    options={[
                      { value: 'fail', label: 'Fail (treat as assertion failure)' },
                      { value: 'skip', label: 'Skip (ignore this assertion)' },
                    ]}
                    className="text-xs flex-1"
                  />
                </div>
              </div>

              <p className="text-xs text-gray-500 mt-2">
                Check: response.{assertion.left.path} {assertion.op}{' '}
                {assertion.right.type === 'literal'
                  ? `"${assertion.right.value || ''}"`
                  : `$\{${assertion.right.key || '?'}\}`}
              </p>
            </div>
          ))}

          <Button size="sm" variant="secondary" onClick={handleAddAssertion}>
            <Plus size={14} className="mr-1" />
            Add Assertion
          </Button>

          <p className="text-xs text-gray-500 space-y-1">
            <span className="block">Assertions validate response values against workflow variables or literals.</span>
            <span className="block">Example: response.body.phone == sms_phone AND response.body.phone != login_phone</span>
            <span className="block font-medium text-blue-600">Missing field behavior: Use "Skip" when the response doesn't always return the field, otherwise it will incorrectly fail.</span>
          </p>
        </div>
      )}
    </div>
  );
}
