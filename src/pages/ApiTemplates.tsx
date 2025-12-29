import { useEffect, useState } from 'react';
import { Plus, Edit2, Trash2, AlertCircle, X, Settings2, Info } from 'lucide-react';
import { Table } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { Button, Input, TextArea } from '../components/ui/Form';
import { apiTemplatesService, checklistsService, accountsService, securityRulesService } from '../lib/api-service';
import type { ApiTemplate, Checklist, Account, SecurityRule } from '../types';

const HEADERS_TO_REMOVE = [
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'accept-encoding',
  'proxy-connection',
  'upgrade',
  'te',
];

const DEFAULT_IGNORE_FIELDS = [
  'timestamp',
  'requestId',
  'traceId',
  'spanId',
  'serverTime',
  'cost',
  'elapsed',
  'nonce',
  'signature',
];

function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter((value, index, self) => self.indexOf(value) === index);
}

interface SanitizationResult {
  headers: Record<string, string>;
  removedHeaders: string[];
}

interface ApiTemplatesProps {
  onNavigateToVariableManager?: () => void;
}

interface VariableConfig {
  id: string;
  name: string;
  json_path: string;
  operation_type: 'replace' | 'append';
  original_value: string;
  data_source?: 'checklist' | 'account_field' | 'security_rule';
  checklist_id?: string;
  security_rule_id?: string;
  account_field_name?: string;
  is_attacker_field?: boolean;
}

type AccountBindingStrategy = 'independent' | 'per_account' | 'anchor_attacker';

interface FailurePattern {
  type: 'response_code' | 'response_message' | 'http_status' | 'response_header';
  path?: string;
  operator: 'equals' | 'contains' | 'regex' | 'not_equals' | 'not_contains';
  value: string;
}

interface ValidationError {
  field: string;
  message: string;
}

export function ApiTemplates({ onNavigateToVariableManager }: ApiTemplatesProps) {
  const [templates, setTemplates] = useState<ApiTemplate[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [securityRules, setSecurityRules] = useState<SecurityRule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(1);

  const [rawRequest, setRawRequest] = useState('');
  const [parsedRequest, setParsedRequest] = useState<any>(null);
  const [variables, setVariables] = useState<VariableConfig[]>([]);
  const [failurePatterns, setFailurePatterns] = useState<FailurePattern[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [groupName, setGroupName] = useState('');
  const [failureLogic, setFailureLogic] = useState<'OR' | 'AND'>('OR');
  const [isActive, setIsActive] = useState(true);
  const [bindingStrategy, setBindingStrategy] = useState<AccountBindingStrategy>('independent');
  const [attackerAccountId, setAttackerAccountId] = useState<string>('');
  const [enableBaseline, setEnableBaseline] = useState(false);
  const [rateLimitOverride, setRateLimitOverride] = useState<string>('');

  const [baselineComparisonMode, setBaselineComparisonMode] = useState<'status_and_body' | 'status_only' | 'body_only' | 'custom'>('status_and_body');
  const [baselineCompareStatus, setBaselineCompareStatus] = useState(true);
  const [baselineCompareBody, setBaselineCompareBody] = useState(true);
  const [baselineCompareBizCode, setBaselineCompareBizCode] = useState(false);
  const [baselineBizCodePath, setBaselineBizCodePath] = useState('');
  const [baselineIgnoreFieldsText, setBaselineIgnoreFieldsText] = useState('');
  const [baselineCriticalFieldsText, setBaselineCriticalFieldsText] = useState('');

  const [showOperationTypeModal, setShowOperationTypeModal] = useState(false);
  const [pendingVariable, setPendingVariable] = useState<{ jsonPath: string; value: string } | null>(null);
  const [, setSelectedOperationType] = useState<'replace' | 'append' | null>(null);

  const [showDataSourceModal, setShowDataSourceModal] = useState(false);
  const [showAccountFieldModal, setShowAccountFieldModal] = useState(false);
  const [accountFieldName, setAccountFieldName] = useState('');
  const [accountsWithField, setAccountsWithField] = useState<Account[]>([]);
  const [sanitizationNotice, setSanitizationNotice] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiTemplatesService.list(),
      checklistsService.list(),
      securityRulesService.list(),
      accountsService.list()
    ])
      .then(([t, c, s, a]) => {
        setTemplates(t);
        setChecklists(c);
        setSecurityRules(s);
        setAccounts(a);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const sanitizeHeaders = (headers: Record<string, string>): SanitizationResult => {
    const sanitized: Record<string, string> = {};
    const removed: string[] = [];

    for (const [key, value] of Object.entries(headers)) {
      if (HEADERS_TO_REMOVE.includes(key.toLowerCase())) {
        removed.push(key);
      } else {
        sanitized[key] = value;
      }
    }

    return { headers: sanitized, removedHeaders: removed };
  };

  const parseHttpRequest = (raw: string, applySanitization = false): { parsed: any; error?: string; removedHeaders?: string[] } => {
    try {
      const trimmed = raw.trim();
      if (!trimmed) {
        return { parsed: null, error: 'HTTP request cannot be empty' };
      }

      const lines = trimmed.split('\n');
      if (lines.length === 0) {
        return { parsed: null, error: 'Invalid HTTP request format' };
      }

      const requestLine = lines[0].trim();
      const requestParts = requestLine.split(' ');

      if (requestParts.length < 2) {
        return { parsed: null, error: 'Invalid request line. Expected: METHOD /path HTTP/1.1' };
      }

      const method = requestParts[0].toUpperCase();
      const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
      if (!validMethods.includes(method)) {
        return { parsed: null, error: `Invalid HTTP method: ${method}. Expected one of: ${validMethods.join(', ')}` };
      }

      const path = requestParts[1];
      if (!path.startsWith('/')) {
        return { parsed: null, error: 'Path must start with /' };
      }

      const protocol = requestParts[2] || 'HTTP/1.1';

      let headers: Record<string, string> = {};
      let bodyStartIndex = 0;
      const rest = lines.slice(1);

      for (let i = 0; i < rest.length; i++) {
        const line = rest[i].trim();
        if (line === '') {
          bodyStartIndex = i + 1;
          break;
        }
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim();
          const value = line.substring(colonIndex + 1).trim();
          if (key) {
            headers[key] = value;
          }
        }
      }

      let removedHeaders: string[] = [];
      if (applySanitization) {
        const result = sanitizeHeaders(headers);
        headers = result.headers;
        removedHeaders = result.removedHeaders;
      }

      const bodyLines = rest.slice(bodyStartIndex).filter(l => l.trim());
      let body = null;
      if (bodyLines.length > 0) {
        const bodyText = bodyLines.join('\n');
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = bodyText;
        }
      }

      return { parsed: { method, path, protocol, headers, body }, removedHeaders };
    } catch (e) {
      console.error('Parse error:', e);
      return { parsed: null, error: 'Failed to parse HTTP request' };
    }
  };

  const handleParseRequest = () => {
    const { parsed, error, removedHeaders } = parseHttpRequest(rawRequest, true);
    if (parsed) {
      setParsedRequest(parsed);
      if (removedHeaders && removedHeaders.length > 0) {
        setSanitizationNotice(`Auto-removed ${removedHeaders.length} header(s): ${removedHeaders.join(', ')}. These headers are managed by the HTTP client.`);
        setTimeout(() => setSanitizationNotice(null), 5000);
      }
      setCurrentStep(2);
    } else {
      alert(error || 'Failed to parse HTTP request. Please check the format.');
    }
  };

  const getJsonPath = (obj: any, path: string[] = []): string[][] => {
    const paths: string[][] = [];
    if (typeof obj === 'object' && obj !== null) {
      for (const key in obj) {
        const currentPath = [...path, key];
        paths.push(currentPath);
        if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
          paths.push(...getJsonPath(obj[key], currentPath));
        }
      }
    }
    return paths;
  };

  const handleAddVariable = (jsonPath: string, value: string) => {
    setPendingVariable({ jsonPath, value });
    setShowOperationTypeModal(true);
  };

  const handleConfirmOperationType = (operationType: 'replace' | 'append') => {
    setSelectedOperationType(operationType);
    setShowOperationTypeModal(false);

    if (operationType === 'replace') {
      setShowDataSourceModal(true);
    } else {
      const varId = `var_${Date.now()}`;
      const pathParts = pendingVariable!.jsonPath.split('.');
      const varName = pathParts[pathParts.length - 1];

      setVariables([
        ...variables,
        {
          id: varId,
          name: varName,
          json_path: pendingVariable!.jsonPath,
          operation_type: 'append',
          original_value: pendingVariable!.value
        }
      ]);
      setPendingVariable(null);
      setSelectedOperationType(null);
    }
  };

  const handleSelectDataSource = (source: 'checklist' | 'account_field') => {
    setShowDataSourceModal(false);

    if (source === 'checklist') {
      const varId = `var_${Date.now()}`;
      const pathParts = pendingVariable!.jsonPath.split('.');
      const varName = pathParts[pathParts.length - 1];

      setVariables([
        ...variables,
        {
          id: varId,
          name: varName,
          json_path: pendingVariable!.jsonPath,
          operation_type: 'replace',
          original_value: pendingVariable!.value,
          data_source: 'checklist'
        }
      ]);
      setPendingVariable(null);
      setSelectedOperationType(null);
    } else {
      setShowAccountFieldModal(true);
    }
  };

  const handleVerifyAccountField = () => {
    if (!accountFieldName.trim()) {
      alert('Please enter a field name');
      return;
    }

    const accountsWithThisField = accounts.filter(acc =>
      acc.fields && acc.fields[accountFieldName]
    );

    if (accountsWithThisField.length === 0) {
      alert(`No accounts have the field "${accountFieldName}"`);
      return;
    }

    setAccountsWithField(accountsWithThisField);
  };

  const handleConfirmAccountField = () => {
    const varId = `var_${Date.now()}`;
    const pathParts = pendingVariable!.jsonPath.split('.');
    const varName = pathParts[pathParts.length - 1];

    setVariables([
      ...variables,
      {
        id: varId,
        name: varName,
        json_path: pendingVariable!.jsonPath,
        operation_type: 'replace',
        original_value: pendingVariable!.value,
        data_source: 'account_field',
        account_field_name: accountFieldName
      }
    ]);

    setShowAccountFieldModal(false);
    setPendingVariable(null);
    setSelectedOperationType(null);
    setAccountFieldName('');
    setAccountsWithField([]);
  };

  const handleRemoveVariable = (varId: string) => {
    setVariables(variables.filter(v => v.id !== varId));
  };

  const handleUpdateVariable = (varId: string, updates: Partial<VariableConfig>) => {
    setVariables(variables.map(v => v.id === varId ? { ...v, ...updates } : v));
  };

  const handleAddFailurePattern = () => {
    setFailurePatterns([
      ...failurePatterns,
      {
        type: 'response_code',
        path: 'code',
        operator: 'equals',
        value: ''
      }
    ]);
  };

  const handleRemoveFailurePattern = (index: number) => {
    setFailurePatterns(failurePatterns.filter((_, i) => i !== index));
  };

  const handleUpdateFailurePattern = (index: number, updates: Partial<FailurePattern>) => {
    setFailurePatterns(failurePatterns.map((p, i) => i === index ? { ...p, ...updates } : p));
  };

  const validateJsonPath = (jsonPath: string, parsed: any): boolean => {
    if (!parsed) return false;

    if (jsonPath.startsWith('body.')) {
      if (!parsed.body) return false;
      const pathParts = jsonPath.replace('body.', '').split('.');
      let current = parsed.body;
      for (const part of pathParts) {
        if (current === null || current === undefined || typeof current !== 'object') {
          return false;
        }
        current = current[part];
      }
      return current !== undefined;
    }

    if (jsonPath.startsWith('headers.')) {
      const headerName = jsonPath.replace('headers.', '');
      return parsed.headers && headerName in parsed.headers;
    }

    if (jsonPath.startsWith('path.') || jsonPath.startsWith('query.')) {
      return true;
    }

    return false;
  };

  const validateTemplate = (): ValidationError[] => {
    const errors: ValidationError[] = [];

    if (!templateName.trim()) {
      errors.push({ field: 'templateName', message: 'Template name is required' });
    }

    let parsed: any = null;
    if (!rawRequest.trim()) {
      errors.push({ field: 'rawRequest', message: 'HTTP request is required' });
    } else {
      const result = parseHttpRequest(rawRequest);
      if (!result.parsed) {
        errors.push({ field: 'rawRequest', message: result.error || 'Invalid HTTP request format' });
      } else {
        parsed = result.parsed;
      }
    }

    for (const variable of variables) {
      if (variable.operation_type === 'replace' && variable.data_source === 'checklist' && !variable.checklist_id) {
        errors.push({ field: 'variables', message: `Variable "${variable.name}" requires a checklist selection` });
      }
      if (variable.operation_type === 'append' && !variable.security_rule_id) {
        errors.push({ field: 'variables', message: `Variable "${variable.name}" requires a security rule selection` });
      }
      if (parsed && !validateJsonPath(variable.json_path, parsed)) {
        errors.push({ field: 'variables', message: `Variable "${variable.name}" has invalid path: ${variable.json_path}` });
      }
    }

    for (let i = 0; i < failurePatterns.length; i++) {
      const pattern = failurePatterns[i];
      if (!pattern.value.trim()) {
        errors.push({ field: 'failurePatterns', message: `Pattern ${i + 1} requires a value` });
      }
      if (pattern.type !== 'http_status' && !pattern.path?.trim()) {
        errors.push({ field: 'failurePatterns', message: `Pattern ${i + 1} requires a path for ${pattern.type}` });
      }
      if (pattern.operator === 'regex') {
        try {
          new RegExp(pattern.value);
        } catch {
          errors.push({ field: 'failurePatterns', message: `Pattern ${i + 1} has invalid regex: ${pattern.value}` });
        }
      }
    }

    return errors;
  };

  const handleSave = async () => {
    const errors = validateTemplate();
    if (errors.length > 0) {
      alert('Validation errors:\n' + errors.map(e => `- ${e.message}`).join('\n'));
      return;
    }

    if (bindingStrategy === 'anchor_attacker' && enableBaseline && baselineCompareBizCode && !baselineBizCodePath.trim()) {
      alert('Business code path is required when "Compare business code" is enabled');
      return;
    }

    try {
      const { parsed: sanitizedParsed, removedHeaders } = parseHttpRequest(rawRequest, true);

      if (removedHeaders && removedHeaders.length > 0) {
        setSanitizationNotice(`Auto-removed ${removedHeaders.length} header(s): ${removedHeaders.join(', ')}`);
        setTimeout(() => setSanitizationNotice(null), 5000);
      }

      const templateData: any = {
        name: templateName.trim(),
        raw_request: rawRequest,
        parsed_structure: sanitizedParsed || parsedRequest,
        variables: variables,
        failure_patterns: failurePatterns,
        failure_logic: failureLogic,
        group_name: groupName.trim() || undefined,
        is_active: isActive,
        account_binding_strategy: bindingStrategy,
        attacker_account_id: bindingStrategy === 'anchor_attacker' ? attackerAccountId || undefined : undefined,
        enable_baseline: bindingStrategy === 'anchor_attacker' ? enableBaseline : false,
        rate_limit_override: rateLimitOverride ? parseInt(rateLimitOverride, 10) : undefined,
      };

      if (bindingStrategy === 'anchor_attacker' && enableBaseline) {
        templateData.baseline_config = {
          comparison_mode: baselineComparisonMode,
          rules: {
            compare_status: baselineCompareStatus,
            compare_body_structure: baselineCompareBody,
            compare_business_code: baselineCompareBizCode,
            business_code_path: baselineCompareBizCode ? baselineBizCodePath.trim() : undefined,
            ignore_fields: linesToArray(baselineIgnoreFieldsText),
            critical_fields: linesToArray(baselineCriticalFieldsText),
          },
        };
      } else {
        templateData.baseline_config = undefined;
      }

      const result = editingId
        ? await apiTemplatesService.update(editingId, templateData)
        : await apiTemplatesService.create(templateData as Omit<ApiTemplate, 'id' | 'created_at' | 'updated_at'>);

      setTemplates(editingId ? templates.map(t => t.id === editingId ? result : t) : [result, ...templates]);
      handleCloseModal();
    } catch (error: any) {
      console.error(error);
      alert(`Failed to save template: ${error.message || 'Unknown error'}`);
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
    setCurrentStep(1);
    setRawRequest('');
    setParsedRequest(null);
    setVariables([]);
    setFailurePatterns([]);
    setTemplateName('');
    setGroupName('');
    setFailureLogic('OR');
    setIsActive(true);
    setBindingStrategy('independent');
    setAttackerAccountId('');
    setEnableBaseline(false);
    setRateLimitOverride('');
    setSanitizationNotice(null);

    setBaselineComparisonMode('status_and_body');
    setBaselineCompareStatus(true);
    setBaselineCompareBody(true);
    setBaselineCompareBizCode(false);
    setBaselineBizCodePath('');
    setBaselineIgnoreFieldsText('');
    setBaselineCriticalFieldsText('');
  };

  const handleEdit = (template: ApiTemplate) => {
    setEditingId(template.id);
    setTemplateName(template.name || '');
    setGroupName(template.group_name || '');
    setRawRequest(template.raw_request || '');
    setParsedRequest(template.parsed_structure || null);
    setVariables(template.variables || []);
    setFailurePatterns(template.failure_patterns || []);
    setFailureLogic(template.failure_logic || 'OR');
    setIsActive(template.is_active ?? true);
    setBindingStrategy((template.account_binding_strategy as AccountBindingStrategy) || 'independent');
    setAttackerAccountId(template.attacker_account_id || '');
    setEnableBaseline(template.enable_baseline || false);
    setRateLimitOverride(template.rate_limit_override ? String(template.rate_limit_override) : '');

    if (template.baseline_config) {
      setBaselineComparisonMode(template.baseline_config.comparison_mode || 'status_and_body');
      setBaselineCompareStatus(template.baseline_config.rules?.compare_status ?? true);
      setBaselineCompareBody(template.baseline_config.rules?.compare_body_structure ?? true);
      setBaselineCompareBizCode(template.baseline_config.rules?.compare_business_code ?? false);
      setBaselineBizCodePath(template.baseline_config.rules?.business_code_path || '');
      setBaselineIgnoreFieldsText((template.baseline_config.rules?.ignore_fields || []).join('\n'));
      setBaselineCriticalFieldsText((template.baseline_config.rules?.critical_fields || []).join('\n'));
    } else {
      setBaselineComparisonMode('status_and_body');
      setBaselineCompareStatus(true);
      setBaselineCompareBody(true);
      setBaselineCompareBizCode(false);
      setBaselineBizCodePath('');
      setBaselineIgnoreFieldsText('');
      setBaselineCriticalFieldsText('');
    }

    setCurrentStep(template.raw_request ? 2 : 1);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this template?')) return;
    try {
      await apiTemplatesService.delete(id);
      setTemplates(templates.filter(t => t.id !== id));
    } catch (e) {
      console.error(e);
      alert('Failed to delete');
    }
  };

  const renderJsonTree = (obj: any, path: string[] = []): JSX.Element => {
    if (typeof obj !== 'object' || obj === null) {
      return <span className="text-gray-600">{String(obj)}</span>;
    }

    return (
      <div className="ml-4">
        {Object.entries(obj).map(([key, value]) => {
          const currentPath = [...path, key];
          const jsonPath = currentPath.join('.');
          const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
          const isInVariable = variables.some(v => v.json_path === jsonPath);

          return (
            <div key={jsonPath} className="my-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{key}:</span>
                {!isObject && (
                  <>
                    <span className="text-sm text-gray-600">{String(value)}</span>
                    {!isInVariable && (
                      <button
                        onClick={() => handleAddVariable(jsonPath, String(value))}
                        className="text-xs px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
                      >
                        Set as Variable
                      </button>
                    )}
                    {isInVariable && (
                      <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded">
                        Variable
                      </span>
                    )}
                  </>
                )}
              </div>
              {isObject && renderJsonTree(value, currentPath)}
            </div>
          );
        })}
      </div>
    );
  };

  const columns = [
    { key: 'name' as const, label: 'Name' },
    { key: 'group_name' as const, label: 'Group', render: (v: string) => v || '-' },
    {
      key: 'variables' as const,
      label: 'Variables',
      render: (vars: any[]) => <span className="text-sm text-gray-600">{vars?.length || 0}</span>
    },
    {
      key: 'failure_patterns' as const,
      label: 'Patterns',
      render: (patterns: any[]) => <span className="text-sm text-gray-600">{patterns?.length || 0}</span>
    },
    {
      key: 'is_active' as const,
      label: 'Status',
      render: (v: boolean) => (
        <span className={`px-2 py-1 text-xs rounded ${v ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
          {v ? 'Active' : 'Inactive'}
        </span>
      )
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: ApiTemplate) => (
        <div className="flex gap-2">
          <button
            onClick={() => handleEdit(row)}
            className="p-1 hover:bg-blue-100 rounded text-blue-600"
          >
            <Edit2 size={16} />
          </button>
          <button
            onClick={() => handleDelete(row.id)}
            className="p-1 hover:bg-red-100 rounded text-red-600"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )
    }
  ];

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">API Templates</h1>
          <p className="text-gray-600 mt-1">Manage API request templates with variables and failure patterns</p>
        </div>
        <div className="flex gap-3">
          {onNavigateToVariableManager && (
            <Button variant="secondary" onClick={onNavigateToVariableManager} size="lg">
              <Settings2 size={20} className="mr-2" />
              Variable Manager
            </Button>
          )}
          <Button
            onClick={() => {
              handleCloseModal();
              setIsModalOpen(true);
            }}
            size="lg"
          >
            <Plus size={20} className="mr-2" />
            New Template
          </Button>
        </div>
      </div>
      <Table columns={columns} data={templates} loading={loading} />

      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={editingId ? 'Edit API Template' : 'Create API Template'}
        size="xl"
        footer={
          <div className="flex justify-between w-full">
            <div>
              {currentStep > 1 && (
                <Button variant="secondary" onClick={() => setCurrentStep(currentStep - 1)}>
                  Previous
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={handleCloseModal}>
                Cancel
              </Button>
              {currentStep === 1 && (
                <Button onClick={handleParseRequest} disabled={!rawRequest}>
                  Parse & Continue
                </Button>
              )}
              {currentStep === 2 && (
                <Button onClick={() => setCurrentStep(3)}>
                  Continue to Failure Patterns
                </Button>
              )}
              {currentStep === 3 && (
                <Button onClick={() => setCurrentStep(4)}>
                  Continue to Settings
                </Button>
              )}
              {currentStep === 4 && (
                <Button onClick={handleSave}>
                  {editingId ? 'Update' : 'Create'} Template
                </Button>
              )}
            </div>
          </div>
        }
      >
        {sanitizationNotice && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-start gap-2">
            <Info size={18} className="text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-800">{sanitizationNotice}</div>
          </div>
        )}

        <div className="mb-4">
          <div className="flex gap-2">
            {[1, 2, 3, 4].map((step) => (
              <div
                key={step}
                className={`flex-1 h-2 rounded ${step <= currentStep ? 'bg-blue-500' : 'bg-gray-200'}`}
              />
            ))}
          </div>
          <div className="flex justify-between mt-2 text-xs text-gray-600">
            <span>1. Request</span>
            <span>2. Variables</span>
            <span>3. Patterns</span>
            <span>4. Settings</span>
          </div>
        </div>

        {currentStep === 1 && (
          <div>
            <h3 className="text-lg font-semibold mb-3">Step 1: Import HTTP Request</h3>
            <TextArea
              label="Raw HTTP Request"
              value={rawRequest}
              onChange={(e) => setRawRequest(e.target.value)}
              rows={15}
              placeholder={`POST /api/v1/orders HTTP/1.1
Host: api.example.com
Content-Type: application/json
Authorization: Bearer <token>
X-Request-Id: <uuid>

{"itemId":"SKU-123","quantity":1,"price":100,"userId":"user_001"}`}
            />
            <p className="text-sm text-gray-500 mt-2">
              Paste the complete HTTP request including headers and body
            </p>
          </div>
        )}

        {currentStep === 2 && parsedRequest && (
          <div>
            <h3 className="text-lg font-semibold mb-3">Step 2: Configure Variables</h3>

            <div className="mb-4 p-4 bg-gray-50 rounded-lg">
              <h4 className="font-medium mb-2">Request Structure</h4>
              <div className="text-sm">
                <div><strong>Method:</strong> {parsedRequest.method}</div>
                <div><strong>Path:</strong> {parsedRequest.path}</div>
                <div className="mt-2"><strong>Headers:</strong></div>
                {renderJsonTree(parsedRequest.headers, ['headers'])}
                {parsedRequest.body && (
                  <>
                    <div className="mt-2"><strong>Body:</strong></div>
                    {renderJsonTree(parsedRequest.body, ['body'])}
                  </>
                )}
              </div>
            </div>

            {variables.length > 0 && (
              <div className="mb-4">
                <h4 className="font-medium mb-2">Configured Variables</h4>
                <div className="space-y-2">
                  {variables.map((variable) => (
                    <div key={variable.id} className="border rounded-lg p-3 bg-white">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="text-sm font-medium">{variable.name}</div>
                          <div className="text-xs text-gray-500">{variable.json_path}</div>
                          <div className="text-xs text-gray-600">Original: {variable.original_value}</div>
                        </div>
                        <button
                          onClick={() => handleRemoveVariable(variable.id)}
                          className="text-red-600 hover:bg-red-50 p-1 rounded"
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="space-y-2">
                        <div>
                          <label className="block text-xs font-medium mb-1">Operation Type</label>
                          <div className="text-sm px-2 py-1 bg-gray-50 rounded border">
                            {variable.operation_type === 'replace' ? (
                              <span className="text-blue-700">Replace</span>
                            ) : (
                              <span className="text-red-700">Append</span>
                            )}
                          </div>
                        </div>
                        {variable.operation_type === 'replace' && variable.data_source === 'checklist' && (
                          <div>
                            <label className="block text-xs font-medium mb-1">Data Source: Checklist</label>
                            <select
                              value={variable.checklist_id || ''}
                              onChange={(e) => handleUpdateVariable(variable.id, { checklist_id: e.target.value })}
                              className="w-full px-2 py-1 text-sm border rounded"
                            >
                              <option value="">-- Select Checklist --</option>
                              {checklists.map((cl) => (
                                <option key={cl.id} value={cl.id}>
                                  {cl.name} ({cl.config.values.length} values)
                                </option>
                              ))}
                            </select>
                            <p className="text-xs text-gray-500 mt-1">Value will be replaced with checklist values</p>
                          </div>
                        )}
                        {variable.operation_type === 'replace' && variable.data_source === 'account_field' && (
                          <div>
                            <label className="block text-xs font-medium mb-1">Data Source: Test Accounts</label>
                            <div className="px-3 py-2 bg-green-50 border border-green-200 rounded text-sm">
                              <div className="font-medium text-green-900">Extract from field: <span className="font-mono">{variable.account_field_name}</span></div>
                              <p className="text-xs text-green-700 mt-1">
                                Will use values from {accounts.filter(a => a.fields?.[variable.account_field_name || '']).length} test account(s)
                              </p>
                            </div>
                          </div>
                        )}
                        {variable.operation_type === 'append' && (
                          <div>
                            <label className="block text-xs font-medium mb-1">Select Security Rule</label>
                            <select
                              value={variable.security_rule_id || ''}
                              onChange={(e) => handleUpdateVariable(variable.id, { security_rule_id: e.target.value })}
                              className="w-full px-2 py-1 text-sm border rounded"
                            >
                              <option value="">-- Select Security Rule --</option>
                              {securityRules.map((rule) => (
                                <option key={rule.id} value={rule.id}>
                                  {rule.name} ({rule.payloads.length} payloads)
                                </option>
                              ))}
                            </select>
                            <p className="text-xs text-gray-500 mt-1">Payloads will be appended to original value</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {currentStep === 3 && (
          <div>
            <h3 className="text-lg font-semibold mb-3">Step 3: Configure Failure Patterns</h3>
            <p className="text-sm text-gray-600 mb-4">
              Define patterns that indicate a failed request (no vulnerability). If response matches these patterns, it's considered a normal failure.
            </p>

            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">Failure Logic</label>
              <select
                value={failureLogic}
                onChange={(e) => setFailureLogic(e.target.value as 'OR' | 'AND')}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="OR">Match ANY pattern (OR)</option>
                <option value="AND">Match ALL patterns (AND)</option>
              </select>
            </div>

            <div className="mb-4">
              <div className="flex justify-between items-center mb-2">
                <h4 className="font-medium">Failure Patterns</h4>
                <Button size="sm" onClick={handleAddFailurePattern}>
                  <Plus size={16} className="mr-1" />Add Pattern
                </Button>
              </div>
              {failurePatterns.length === 0 && (
                <div className="text-sm text-gray-500 text-center py-4 border rounded-lg bg-gray-50">
                  No failure patterns defined yet
                </div>
              )}
              <div className="space-y-2">
                {failurePatterns.map((pattern, index) => (
                  <div key={index} className="border rounded-lg p-3 bg-white">
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-sm font-medium">Pattern {index + 1}</span>
                      <button
                        onClick={() => handleRemoveFailurePattern(index)}
                        className="text-red-600 hover:bg-red-50 p-1 rounded"
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-xs font-medium mb-1">Type</label>
                        <select
                          value={pattern.type}
                          onChange={(e) => handleUpdateFailurePattern(index, { type: e.target.value as any })}
                          className="w-full px-2 py-1 text-sm border rounded"
                        >
                          <option value="http_status">HTTP Status</option>
                          <option value="response_code">Response Code</option>
                          <option value="response_message">Response Message</option>
                        </select>
                      </div>
                      {pattern.type !== 'http_status' && (
                        <div>
                          <label className="block text-xs font-medium mb-1">JSON Path</label>
                          <Input
                            value={pattern.path || ''}
                            onChange={(e) => handleUpdateFailurePattern(index, { path: e.target.value })}
                            placeholder="e.g., code, msg"
                          />
                        </div>
                      )}
                      <div>
                        <label className="block text-xs font-medium mb-1">Operator</label>
                        <select
                          value={pattern.operator}
                          onChange={(e) => handleUpdateFailurePattern(index, { operator: e.target.value as any })}
                          className="w-full px-2 py-1 text-sm border rounded"
                        >
                          <option value="equals">Equals</option>
                          <option value="contains">Contains</option>
                          <option value="regex">Regex</option>
                        </select>
                      </div>
                      <div className={pattern.type === 'http_status' ? 'col-span-2' : 'col-span-3'}>
                        <label className="block text-xs font-medium mb-1">Value</label>
                        <Input
                          value={pattern.value}
                          onChange={(e) => handleUpdateFailurePattern(index, { value: e.target.value })}
                          placeholder={pattern.type === 'http_status' ? '403' : 'System error'}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-3 bg-blue-50 rounded-lg border border-blue-200 text-sm">
              <div className="flex gap-2">
                <AlertCircle size={16} className="text-blue-600 mt-0.5 flex-shrink-0" />
                <div>
                  <strong>Example:</strong> If you set "Response Code equals 030067", requests returning this code will be considered normal failures (not vulnerabilities).
                </div>
              </div>
            </div>
          </div>
        )}

        {currentStep === 4 && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold mb-3">Step 4: Template Settings</h3>
            <Input
              label="Template Name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="e.g., User Account Access Test"
            />
            <Input
              label="Group Name (optional)"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="e.g., Authentication, Payment"
            />
            <div className="flex items-center gap-2 mt-4">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4"
              />
              <label className="text-sm">Active (include in test runs)</label>
            </div>

            <div className="border-t pt-4 mt-4">
              <h4 className="font-medium text-gray-700 mb-3">Account Binding Strategy</h4>
              <select
                value={bindingStrategy}
                onChange={(e) => setBindingStrategy(e.target.value as AccountBindingStrategy)}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="independent">Independent (cartesian product of all account fields)</option>
                <option value="per_account">Per Account (all variables from same account)</option>
                <option value="anchor_attacker">Anchor Attacker (fixed attacker, rotating victims)</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {bindingStrategy === 'independent' && 'Each account field variable is independently combined with values from all accounts. May produce mixed combinations.'}
                {bindingStrategy === 'per_account' && 'All account field variables in a single test must come from the same account. Ensures consistent identity.'}
                {bindingStrategy === 'anchor_attacker' && 'Attacker identity stays fixed while victim resources rotate. Ideal for IDOR/privilege escalation testing.'}
              </p>
            </div>

            {bindingStrategy === 'anchor_attacker' && (
              <div className="space-y-3 bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Attacker Account</label>
                  <select
                    value={attackerAccountId}
                    onChange={(e) => setAttackerAccountId(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg"
                  >
                    <option value="">Select attacker account...</option>
                    {accounts.map(acc => (
                      <option key={acc.id} value={acc.id}>{acc.name} ({acc.status || 'user'})</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">The account whose credentials will be used for all requests</p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={enableBaseline}
                    onChange={(e) => setEnableBaseline(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <label className="text-sm font-medium">Enable Baseline Comparison</label>
                </div>
                {enableBaseline && (
                  <div className="ml-6 space-y-4 mt-3">
                    <p className="text-xs text-gray-600">
                      First runs attacker accessing their own resource (baseline), then compares with attacker accessing victim's resource. Only reports findings when responses differ significantly.
                    </p>

                    <div className="border-t border-amber-300 pt-3">
                      <h5 className="text-sm font-semibold text-gray-800 mb-3">Baseline Comparison Configuration</h5>

                      <div className="space-y-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">Comparison Mode</label>
                          <select
                            value={baselineComparisonMode}
                            onChange={(e) => setBaselineComparisonMode(e.target.value as any)}
                            className="w-full px-2 py-1.5 text-sm border rounded"
                          >
                            <option value="status_and_body">Status and Body</option>
                            <option value="status_only">Status Only</option>
                            <option value="body_only">Body Only</option>
                            <option value="custom">Custom</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-2">Comparison Rules</label>
                          <div className="space-y-1.5">
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={baselineCompareStatus}
                                onChange={(e) => setBaselineCompareStatus(e.target.checked)}
                                className="w-3.5 h-3.5"
                              />
                              <span className="text-xs">Compare HTTP status</span>
                            </label>
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={baselineCompareBody}
                                onChange={(e) => setBaselineCompareBody(e.target.checked)}
                                className="w-3.5 h-3.5"
                              />
                              <span className="text-xs">Compare body structure</span>
                            </label>
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={baselineCompareBizCode}
                                onChange={(e) => setBaselineCompareBizCode(e.target.checked)}
                                className="w-3.5 h-3.5"
                              />
                              <span className="text-xs">Compare business code</span>
                            </label>
                          </div>
                        </div>

                        {baselineCompareBizCode && (
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Business Code Path <span className="text-red-500">*</span>
                            </label>
                            <Input
                              value={baselineBizCodePath}
                              onChange={(e) => setBaselineBizCodePath(e.target.value)}
                              placeholder="e.g., code, data.code, meta.status"
                              className="text-sm"
                            />
                            <p className="text-xs text-gray-500 mt-1">Dot-separated path to business status code in response</p>
                          </div>
                        )}

                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-xs font-medium text-gray-700">Ignore Fields (one per line)</label>
                            <button
                              type="button"
                              onClick={() => {
                                const currentFields = linesToArray(baselineIgnoreFieldsText);
                                const allFields = [...new Set([...currentFields, ...DEFAULT_IGNORE_FIELDS])];
                                setBaselineIgnoreFieldsText(allFields.join('\n'));
                              }}
                              className="text-xs text-blue-600 hover:text-blue-700 underline"
                            >
                              Add Defaults
                            </button>
                          </div>
                          <textarea
                            value={baselineIgnoreFieldsText}
                            onChange={(e) => setBaselineIgnoreFieldsText(e.target.value)}
                            rows={4}
                            placeholder="timestamp&#10;requestId&#10;traceId&#10;data.timestamp"
                            className="w-full px-2 py-1.5 text-xs font-mono border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Dynamic fields to ignore during comparison (prevents false positives)
                          </p>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">Critical Fields (one per line)</label>
                          <textarea
                            value={baselineCriticalFieldsText}
                            onChange={(e) => setBaselineCriticalFieldsText(e.target.value)}
                            rows={3}
                            placeholder="data.userId&#10;data.balance&#10;permissions"
                            className="w-full px-2 py-1.5 text-xs font-mono border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Fields where changes indicate high-priority differences
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {variables.filter(v => v.data_source === 'account_field').length > 0 && (
                  <div className="mt-3">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Variable Roles</label>
                    <div className="space-y-2">
                      {variables.filter(v => v.data_source === 'account_field').map(v => (
                        <div key={v.id} className="flex items-center gap-3 text-sm">
                          <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded">{v.name}</span>
                          <select
                            value={v.is_attacker_field ? 'attacker' : 'victim'}
                            onChange={(e) => {
                              setVariables(variables.map(vv =>
                                vv.id === v.id ? { ...vv, is_attacker_field: e.target.value === 'attacker' } : vv
                              ));
                            }}
                            className="px-2 py-1 border rounded text-sm"
                          >
                            <option value="attacker">Attacker (fixed)</option>
                            <option value="victim">Victim (rotating)</option>
                          </select>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      Attacker fields stay constant, victim fields rotate through other accounts
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="pt-4 mt-4 border-t border-gray-200">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Rate Limit Override (CI Counting)
              </label>
              <Input
                type="number"
                min="0"
                value={rateLimitOverride}
                onChange={(e) => setRateLimitOverride(e.target.value)}
                placeholder="Leave empty to use global default"
              />
              <p className="text-xs text-gray-500 mt-1">
                Max number of effective findings from this template that count toward CI gate.
                Empty = use global default. Set to 0 to disable counting entirely.
              </p>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={showOperationTypeModal}
        onClose={() => {
          setShowOperationTypeModal(false);
          setPendingVariable(null);
        }}
        title="Select Operation Type"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            How would you like to use this variable in testing?
          </p>

          <button
            onClick={() => handleConfirmOperationType('replace')}
            className="w-full p-4 border-2 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-all text-left"
          >
            <div className="font-medium text-blue-900 mb-1">Replace</div>
            <div className="text-sm text-gray-600">
              Replace the original value with values from checklist or test accounts
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Example: <span className="font-mono">userId: "123"</span> → <span className="font-mono">userId: "user_001"</span>
            </div>
          </button>

          <button
            onClick={() => handleConfirmOperationType('append')}
            className="w-full p-4 border-2 rounded-lg hover:border-red-500 hover:bg-red-50 transition-all text-left"
          >
            <div className="font-medium text-red-900 mb-1">Append (Security Rule)</div>
            <div className="text-sm text-gray-600">
              Append security test payloads to the original value
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Example: <span className="font-mono">userId: "123"</span> → <span className="font-mono">userId: "123' OR 1=1--"</span>
            </div>
          </button>
        </div>
      </Modal>

      <Modal
        isOpen={showDataSourceModal}
        onClose={() => {
          setShowDataSourceModal(false);
          setPendingVariable(null);
          setSelectedOperationType(null);
        }}
        title="Select Data Source"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Where should the replacement values come from?
          </p>

          <button
            onClick={() => handleSelectDataSource('checklist')}
            className="w-full p-4 border-2 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-all text-left"
          >
            <div className="font-medium text-blue-900 mb-1">From Checklist</div>
            <div className="text-sm text-gray-600">
              Use values from a predefined checklist
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Example: Test with multiple user IDs from a checklist
            </div>
          </button>

          <button
            onClick={() => handleSelectDataSource('account_field')}
            className="w-full p-4 border-2 rounded-lg hover:border-green-500 hover:bg-green-50 transition-all text-left"
          >
            <div className="font-medium text-green-900 mb-1">From Test Accounts</div>
            <div className="text-sm text-gray-600">
              Extract values dynamically from test account fields
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Example: Use userId field from all test accounts
            </div>
          </button>
        </div>
      </Modal>

      <Modal
        isOpen={showAccountFieldModal}
        onClose={() => {
          setShowAccountFieldModal(false);
          setPendingVariable(null);
          setSelectedOperationType(null);
          setAccountFieldName('');
          setAccountsWithField([]);
        }}
        title="Extract from Test Accounts"
        size="md"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              Field Name
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={accountFieldName}
                onChange={(e) => setAccountFieldName(e.target.value)}
                placeholder="e.g., userId, phoneNumber, email"
                className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={handleVerifyAccountField}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Verify
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Enter the exact field name from account fields
            </p>
          </div>

          {accountsWithField.length > 0 && (
            <div className="border rounded-lg p-4 bg-gray-50">
              <h4 className="font-medium mb-2">
                Found {accountsWithField.length} account(s) with field "{accountFieldName}"
              </h4>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {accountsWithField.map(acc => (
                  <div key={acc.id} className="bg-white p-2 rounded border text-sm">
                    <div className="font-medium">{acc.name}</div>
                    <div className="text-gray-600">
                      {accountFieldName}: <span className="font-mono">{acc.fields?.[accountFieldName]}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => {
                    setShowAccountFieldModal(false);
                    setPendingVariable(null);
                    setSelectedOperationType(null);
                    setAccountFieldName('');
                    setAccountsWithField([]);
                  }}
                  className="px-4 py-2 border rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmAccountField}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  Confirm & Use These Accounts
                </button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
