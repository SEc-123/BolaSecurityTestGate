import { useState } from 'react';
import { Search, CheckSquare, Square, RefreshCw, Eye, Save, ArrowLeft } from 'lucide-react';
import { Button, Input, Select, Checkbox } from '../components/ui/Form';
import { Modal } from '../components/ui/Modal';
import { templateVariableService, checklistsService, securityRulesService, accountsService } from '../lib/api-service';
import type { VariableSearchMatch, Checklist, SecurityRule, Account } from '../types';
import { useEffect } from 'react';

type SearchType = 'jsonpath' | 'keyword' | 'header_key' | 'query_param';
type VariableScope = 'body' | 'header' | 'query' | 'path';

interface UpdatePreview {
  template_id: string;
  template_name: string;
  variable_name: string;
  json_path: string;
  before: Record<string, any>;
  after: Record<string, any>;
  raw_request_updated?: boolean;
}

export function TemplateVariableManager() {
  const [searchType, setSearchType] = useState<SearchType>('keyword');
  const [searchPattern, setSearchPattern] = useState('');
  const [matchMode, setMatchMode] = useState<'exact' | 'contains'>('contains');
  const [scopes, setScopes] = useState<VariableScope[]>(['body', 'header', 'query', 'path']);
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<VariableSearchMatch[]>([]);
  const [selectedMatches, setSelectedMatches] = useState<Set<string>>(new Set());

  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [securityRules, setSecurityRules] = useState<SecurityRule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const [updateMode, setUpdateMode] = useState<'value' | 'source'>('source');
  const [patchDefaultValue, setPatchDefaultValue] = useState('');
  const [patchDataSource, setPatchDataSource] = useState<'checklist' | 'account_field' | 'security_rule' | 'workflow_context' | ''>('');
  const [patchOperationType, setPatchOperationType] = useState<'replace' | 'append' | ''>('');
  const [patchChecklistId, setPatchChecklistId] = useState('');
  const [patchAccountFieldName, setPatchAccountFieldName] = useState('');
  const [patchSecurityRuleId, setPatchSecurityRuleId] = useState('');

  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
  const [previewData, setPreviewData] = useState<UpdatePreview[]>([]);
  const [previewWarnings, setPreviewWarnings] = useState<any[]>([]);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    loadReferenceData();
  }, []);

  const loadReferenceData = async () => {
    try {
      const [checklistsData, rulesData, accountsData] = await Promise.all([
        checklistsService.list(),
        securityRulesService.list(),
        accountsService.list(),
      ]);
      setChecklists(checklistsData);
      setSecurityRules(rulesData);
      setAccounts(accountsData);
    } catch (error) {
      console.error('Failed to load reference data:', error);
    }
  };

  const getAccountFields = (): string[] => {
    const fields = new Set<string>();
    accounts.forEach(account => {
      if (account.fields) {
        Object.keys(account.fields).forEach(key => fields.add(key));
      }
    });
    return Array.from(fields);
  };

  const handleSearch = async () => {
    if (!searchPattern.trim()) {
      alert('Please enter a search pattern');
      return;
    }

    setSearching(true);
    setMatches([]);
    setSelectedMatches(new Set());

    try {
      const result = await templateVariableService.search({
        search_type: searchType,
        pattern: searchPattern.trim(),
        scopes,
        match_mode: matchMode,
      });
      setMatches(result.matches);
    } catch (error: any) {
      console.error('Search failed:', error);
      alert(`Search failed: ${error.message || 'Unknown error'}`);
    } finally {
      setSearching(false);
    }
  };

  const toggleScope = (scope: VariableScope) => {
    if (scopes.includes(scope)) {
      setScopes(scopes.filter(s => s !== scope));
    } else {
      setScopes([...scopes, scope]);
    }
  };

  const getMatchKey = (match: VariableSearchMatch) =>
    `${match.template_id}:${match.variable_name}:${match.json_path}`;

  const toggleMatch = (match: VariableSearchMatch) => {
    const key = getMatchKey(match);
    const newSelected = new Set(selectedMatches);
    if (newSelected.has(key)) {
      newSelected.delete(key);
    } else {
      newSelected.add(key);
    }
    setSelectedMatches(newSelected);
  };

  const selectAll = () => {
    if (selectedMatches.size === matches.length) {
      setSelectedMatches(new Set());
    } else {
      setSelectedMatches(new Set(matches.map(getMatchKey)));
    }
  };

  const getSelectedMatchesData = () => {
    return matches.filter(m => selectedMatches.has(getMatchKey(m))).map(m => ({
      template_id: m.template_id,
      variable_name: m.variable_name,
      variable_type: m.variable_type,
      json_path: m.json_path,
    }));
  };

  const buildPatch = () => {
    const patch: Record<string, any> = {};

    if (updateMode === 'value') {
      if (patchDefaultValue) {
        patch.default_value = patchDefaultValue;
      }
    } else {
      if (patchOperationType) patch.operation_type = patchOperationType;
      if (patchDataSource) {
        patch.data_source = patchDataSource;
        if (patchDataSource === 'checklist') patch.checklist_id = patchChecklistId || undefined;
        if (patchDataSource === 'account_field') patch.account_field_name = patchAccountFieldName || undefined;
        if (patchDataSource === 'security_rule') patch.security_rule_id = patchSecurityRuleId || undefined;
      }
    }
    return patch;
  };

  const handlePreview = async () => {
    const selectedData = getSelectedMatchesData();
    if (selectedData.length === 0) {
      alert('Please select at least one variable to update');
      return;
    }

    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      alert('Please configure at least one field to update');
      return;
    }

    setApplying(true);
    try {
      const result = await templateVariableService.bulkUpdate({
        selected_matches: selectedData,
        patch,
        dry_run: true,
      });
      setPreviewData(result.updates || []);
      setPreviewWarnings(result.warnings || []);
      setIsPreviewModalOpen(true);
    } catch (error: any) {
      console.error('Preview failed:', error);
      alert(`Preview failed: ${error.message || 'Unknown error'}`);
    } finally {
      setApplying(false);
    }
  };

  const handleApply = async () => {
    const selectedData = getSelectedMatchesData();
    const patch = buildPatch();

    setApplying(true);
    try {
      const result = await templateVariableService.bulkUpdate({
        selected_matches: selectedData,
        patch,
        dry_run: false,
      });
      alert(`Successfully updated ${result.affected_count} variables across ${result.updated_templates} templates`);
      setIsPreviewModalOpen(false);
      setSelectedMatches(new Set());
      handleSearch();
    } catch (error: any) {
      console.error('Update failed:', error);
      alert(`Update failed: ${error.message || 'Unknown error'}`);
    } finally {
      setApplying(false);
    }
  };

  const formatConfigSummary = (config: VariableSearchMatch['current_config']) => {
    const parts: string[] = [];
    if (config.data_source) parts.push(config.data_source);
    if (config.operation_type) parts.push(config.operation_type);
    return parts.join(' / ') || 'original';
  };

  const getChecklistName = (id?: string) => {
    if (!id) return '-';
    const checklist = checklists.find(c => c.id === id);
    return checklist?.name || id;
  };

  const getSecurityRuleName = (id?: string) => {
    if (!id) return '-';
    const rule = securityRules.find(r => r.id === id);
    return rule?.name || id;
  };

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Template Variable Manager</h1>
          <p className="text-gray-600 mt-1">Search and bulk update variable configurations across all templates</p>
        </div>
        <Button variant="secondary" onClick={() => window.history.back()}>
          <ArrowLeft size={18} className="mr-2" />
          Back
        </Button>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Search Variables</h3>

        <div className="grid grid-cols-4 gap-4 mb-4">
          <Select
            label="Search Type"
            value={searchType}
            onChange={(e) => setSearchType(e.target.value as SearchType)}
            options={[
              { value: 'keyword', label: 'Keyword (field name)' },
              { value: 'jsonpath', label: 'JSONPath' },
              { value: 'header_key', label: 'Header Key' },
              { value: 'query_param', label: 'Query Parameter' },
            ]}
          />
          <div className="col-span-2">
            <Input
              label="Search Pattern"
              value={searchPattern}
              onChange={(e) => setSearchPattern(e.target.value)}
              placeholder={searchType === 'jsonpath' ? '$.content.sessionId' : 'sessionId'}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
          </div>
          <Select
            label="Match Mode"
            value={matchMode}
            onChange={(e) => setMatchMode(e.target.value as 'exact' | 'contains')}
            options={[
              { value: 'contains', label: 'Contains' },
              { value: 'exact', label: 'Exact Match' },
            ]}
          />
        </div>

        <div className="flex items-center gap-4 mb-4">
          <span className="text-sm font-medium text-gray-700">Search in:</span>
          {(['body', 'header', 'query', 'path'] as VariableScope[]).map((scope) => (
            <label key={scope} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() => toggleScope(scope)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-600 capitalize">{scope}</span>
            </label>
          ))}
        </div>

        <Button onClick={handleSearch} disabled={searching}>
          {searching ? (
            <>
              <RefreshCw size={18} className="mr-2 animate-spin" />
              Searching...
            </>
          ) : (
            <>
              <Search size={18} className="mr-2" />
              Search
            </>
          )}
        </Button>
      </div>

      {matches.length > 0 && (
        <>
          <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900">
                Search Results ({matches.length} matches)
              </h3>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={selectAll}>
                  {selectedMatches.size === matches.length ? (
                    <>
                      <Square size={16} className="mr-1" />
                      Deselect All
                    </>
                  ) : (
                    <>
                      <CheckSquare size={16} className="mr-1" />
                      Select All
                    </>
                  )}
                </Button>
                <span className="text-sm text-gray-500 flex items-center">
                  {selectedMatches.size} selected
                </span>
              </div>
            </div>

            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="w-10 px-4 py-3"></th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Template</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Variable / Path</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Current Config</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Snippet</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {matches.map((match) => {
                    const key = getMatchKey(match);
                    const isSelected = selectedMatches.has(key);
                    return (
                      <tr
                        key={key}
                        className={`cursor-pointer transition-colors ${isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                        onClick={() => toggleMatch(match)}
                      >
                        <td className="px-4 py-3">
                          <Checkbox
                            checked={isSelected}
                            onChange={() => {}}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{match.template_name}</div>
                          {match.group_name && (
                            <div className="text-xs text-gray-500">{match.group_name}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 text-xs rounded ${
                            match.variable_type === 'body' ? 'bg-green-100 text-green-700' :
                            match.variable_type === 'header' ? 'bg-blue-100 text-blue-700' :
                            match.variable_type === 'query' ? 'bg-amber-100 text-amber-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>
                            {match.variable_type}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{match.variable_name}</div>
                          <code className="text-xs text-gray-500">{match.json_path}</code>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-sm text-gray-600">
                            {formatConfigSummary(match.current_config)}
                          </span>
                          {match.current_config.checklist_id && (
                            <div className="text-xs text-gray-500">
                              Checklist: {getChecklistName(match.current_config.checklist_id)}
                            </div>
                          )}
                          {match.current_config.account_field_name && (
                            <div className="text-xs text-gray-500">
                              Field: {match.current_config.account_field_name}
                            </div>
                          )}
                          {match.current_config.security_rule_id && (
                            <div className="text-xs text-gray-500">
                              Rule: {getSecurityRuleName(match.current_config.security_rule_id)}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {match.raw_snippet && (
                            <code className="text-xs text-gray-500 bg-gray-50 px-2 py-1 rounded block max-w-xs truncate">
                              {match.raw_snippet}
                            </code>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {selectedMatches.size > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Bulk Update Configuration</h3>
              <p className="text-sm text-gray-500 mb-4">
                Configure the changes to apply to the {selectedMatches.size} selected variable(s)
              </p>

              <div className="mb-6 flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={updateMode === 'value'}
                    onChange={() => setUpdateMode('value')}
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span className="font-medium text-gray-700">Value Mode</span>
                  <span className="text-xs text-gray-500">(Update default_value only)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={updateMode === 'source'}
                    onChange={() => setUpdateMode('source')}
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span className="font-medium text-gray-700">Source/Rule Mode</span>
                  <span className="text-xs text-gray-500">(Update data source & configuration)</span>
                </label>
              </div>

              {updateMode === 'value' ? (
                <div className="grid grid-cols-1 gap-4">
                  <Input
                    label="Default Value"
                    value={patchDefaultValue}
                    onChange={(e) => setPatchDefaultValue(e.target.value)}
                    placeholder="Enter new default value"
                  />
                  <p className="text-xs text-gray-500">
                    This will replace the default_value for all selected variables
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <Select
                      label="Operation Type"
                      value={patchOperationType}
                      onChange={(e) => setPatchOperationType(e.target.value as 'replace' | 'append' | '')}
                      options={[
                        { value: '', label: 'No change' },
                        { value: 'replace', label: 'Replace' },
                        { value: 'append', label: 'Append' },
                      ]}
                    />
                  </div>

                  <div>
                    <Select
                      label="Data Source"
                      value={patchDataSource}
                      onChange={(e) => {
                        setPatchDataSource(e.target.value as 'checklist' | 'account_field' | 'security_rule' | 'workflow_context' | '');
                        setPatchChecklistId('');
                        setPatchAccountFieldName('');
                        setPatchSecurityRuleId('');
                      }}
                      options={[
                        { value: '', label: 'No change' },
                        { value: 'checklist', label: 'Checklist' },
                        { value: 'account_field', label: 'Account Field' },
                        { value: 'security_rule', label: 'Security Rule' },
                        { value: 'workflow_context', label: 'Workflow Context' },
                      ]}
                    />
                  </div>

                {patchDataSource === 'checklist' && (
                  <div className="col-span-2">
                    <Select
                      label="Select Checklist"
                      value={patchChecklistId}
                      onChange={(e) => setPatchChecklistId(e.target.value)}
                      options={[
                        { value: '', label: 'Select...' },
                        ...checklists.map(c => ({
                          value: c.id,
                          label: `${c.name} (${c.config.values.length} values)`,
                        })),
                      ]}
                    />
                  </div>
                )}

                {patchDataSource === 'account_field' && (
                  <div className="col-span-2">
                    <Select
                      label="Select Account Field"
                      value={patchAccountFieldName}
                      onChange={(e) => setPatchAccountFieldName(e.target.value)}
                      options={[
                        { value: '', label: 'Select...' },
                        ...getAccountFields().map(f => ({ value: f, label: f })),
                      ]}
                    />
                  </div>
                )}

                  {patchDataSource === 'security_rule' && (
                    <div className="col-span-2">
                      <Select
                        label="Select Security Rule"
                        value={patchSecurityRuleId}
                        onChange={(e) => setPatchSecurityRuleId(e.target.value)}
                        options={[
                          { value: '', label: 'Select...' },
                          ...securityRules.map(r => ({
                            value: r.id,
                            label: `${r.name} (${r.payloads.length} payloads)`,
                          })),
                        ]}
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-3 mt-6">
                <Button variant="secondary" onClick={handlePreview} disabled={applying}>
                  <Eye size={18} className="mr-2" />
                  Preview Changes
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {matches.length === 0 && !searching && searchPattern && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-12 text-center">
          <Search size={48} className="mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No matches found</h3>
          <p className="text-gray-500">Try adjusting your search pattern or scopes</p>
        </div>
      )}

      <Modal
        isOpen={isPreviewModalOpen}
        onClose={() => setIsPreviewModalOpen(false)}
        title="Preview Changes"
        size="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsPreviewModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleApply} disabled={applying}>
              {applying ? (
                <>
                  <RefreshCw size={18} className="mr-2 animate-spin" />
                  Applying...
                </>
              ) : (
                <>
                  <Save size={18} className="mr-2" />
                  Apply Changes
                </>
              )}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {previewWarnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <h4 className="font-medium text-amber-800 mb-2">Warnings ({previewWarnings.length})</h4>
              <ul className="text-sm text-amber-700 space-y-1">
                {previewWarnings.map((warning, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <span className="text-amber-600">⚠</span>
                    <span>
                      {warning.template_name && (
                        <span className="font-medium">{warning.template_name}: </span>
                      )}
                      {warning.variable_name && (
                        <span>{warning.variable_name} - </span>
                      )}
                      {warning.message || warning.reason || 'Unknown issue'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-sm text-gray-600 mb-4">
            The following {previewData.length} variable(s) will be updated:
          </div>

          <div className="border border-gray-200 rounded-lg overflow-hidden max-h-96 overflow-y-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Template</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Variable</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Before</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">After</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {previewData.map((item, index) => {
                  const hasValueChange = item.before.original_value !== item.after.original_value;
                  const isBodyVariable = item.json_path && item.json_path.trim() !== '';

                  return (
                    <tr key={index}>
                      <td className="px-4 py-3 text-sm text-gray-900">{item.template_name}</td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-gray-900">{item.variable_name}</div>
                        {item.json_path && (
                          <code className="text-xs text-gray-500">{item.json_path}</code>
                        )}
                        {hasValueChange && isBodyVariable && (
                          <div className="mt-1">
                            {item.raw_request_updated === false ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-800">
                                ⚠ raw_request not synced
                              </span>
                            ) : item.raw_request_updated === true ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-green-100 text-green-800">
                                ✓ raw_request synced
                              </span>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs space-y-1">
                          {item.before.default_value !== undefined && (
                            <div>Value: <code className="text-gray-600 bg-gray-50 px-1 rounded">{String(item.before.default_value)}</code></div>
                          )}
                          {item.before.original_value !== undefined && item.before.original_value !== item.before.default_value && (
                            <div>Original: <code className="text-gray-600 bg-gray-50 px-1 rounded">{String(item.before.original_value)}</code></div>
                          )}
                          {item.before.data_source && (
                            <div>Source: <span className="text-gray-600">{item.before.data_source}</span></div>
                          )}
                          {item.before.operation_type && (
                            <div>Op: <span className="text-gray-600">{item.before.operation_type}</span></div>
                          )}
                          {item.before.checklist_id && (
                            <div>Checklist: <span className="text-gray-600">{getChecklistName(item.before.checklist_id)}</span></div>
                          )}
                          {item.before.account_field_name && (
                            <div>Field: <span className="text-gray-600">{item.before.account_field_name}</span></div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs space-y-1">
                          {item.after.default_value !== undefined && (
                            <div>Value: <code className="text-green-600 font-medium bg-green-50 px-1 rounded">{String(item.after.default_value)}</code></div>
                          )}
                          {item.after.original_value !== undefined && item.after.original_value !== item.after.default_value && (
                            <div>Original: <code className="text-green-600 font-medium bg-green-50 px-1 rounded">{String(item.after.original_value)}</code></div>
                          )}
                          {item.after.data_source && (
                            <div>Source: <span className="text-green-600 font-medium">{item.after.data_source}</span></div>
                          )}
                          {item.after.operation_type && (
                            <div>Op: <span className="text-green-600 font-medium">{item.after.operation_type}</span></div>
                          )}
                          {item.after.checklist_id && (
                            <div>Checklist: <span className="text-green-600 font-medium">{getChecklistName(item.after.checklist_id)}</span></div>
                          )}
                          {item.after.account_field_name && (
                            <div>Field: <span className="text-green-600 font-medium">{item.after.account_field_name}</span></div>
                          )}
                          {item.after.security_rule_id && (
                            <div>Rule: <span className="text-green-600 font-medium">{getSecurityRuleName(item.after.security_rule_id)}</span></div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>
    </div>
  );
}
