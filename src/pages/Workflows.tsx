import { useEffect, useState } from 'react';
import { Plus, Edit2, Trash2, ChevronUp, ChevronDown, X, Layers, Settings, Zap, Cookie, Shield, Users, Target, AlertTriangle, Download, CheckCircle, Shuffle, Brain, Database, GitBranch, Beaker } from 'lucide-react';
import { Table } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { Button, Input, TextArea, Checkbox, Select } from '../components/ui/Form';
import { StepAssertionsEditor } from '../components/StepAssertionsEditor';
import { LearningResultsModal } from '../components/LearningResultsModal';
import { VariablePoolManager } from '../components/VariablePoolManager';
import {
  workflowsService,
  apiTemplatesService,
  checklistsService,
  securityRulesService,
  accountsService,
  environmentsService,
} from '../lib/api-service';
import {
  learningService,
  mutationsService,
  type LearningResult,
  type MappingCandidate,
  type WorkflowVariable,
} from '../lib/api-client';
import type {
  Workflow,
  ApiTemplate,
  Checklist,
  SecurityRule,
  Account,
  StepVariableMapping,
  ExtractorSource,
  SessionJarConfig,
  AccountBindingStrategy,
  VariableRole,
  StepAssertion,
  AssertionsMode,
} from '../types';

interface LocalVariableConfig {
  id: string;
  name: string;
  step_variable_mappings: StepVariableMapping[];
  data_source: 'checklist' | 'account_field' | 'security_rule' | 'workflow_context';
  checklist_id?: string;
  security_rule_id?: string;
  account_field_name?: string;
  role?: VariableRole;
}

interface LocalExtractor {
  id: string;
  step_order: number;
  name: string;
  source: ExtractorSource;
  expression: string;
  transform_type?: 'trim' | 'lower' | 'upper' | 'prefix' | 'suffix';
  transform_value?: string;
  required: boolean;
}

interface LocalStepAssertions {
  step_id: string;
  step_order: number;
  assertions: StepAssertion[];
  assertions_mode: AssertionsMode;
}

export function Workflows() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [templates, setTemplates] = useState<ApiTemplate[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [securityRules, setSecurityRules] = useState<SecurityRule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [isContextModalOpen, setIsContextModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    is_active: true,
  });
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([]);
  const [variableConfigs, setVariableConfigs] = useState<LocalVariableConfig[]>([]);
  const [configWorkflow, setConfigWorkflow] = useState<Workflow | null>(null);

  const [contextWorkflow, setContextWorkflow] = useState<Workflow | null>(null);
  const [enableExtractor, setEnableExtractor] = useState(false);
  const [enableSessionJar, setEnableSessionJar] = useState(false);
  const [extractors, setExtractors] = useState<LocalExtractor[]>([]);
  const [sessionJarConfig, setSessionJarConfig] = useState<SessionJarConfig>({
    cookie_mode: true,
    body_json_paths: [],
    header_keys: [],
  });
  const [newBodyPath, setNewBodyPath] = useState('');
  const [newHeaderKey, setNewHeaderKey] = useState('');
  const [bindingStrategy, setBindingStrategy] = useState<AccountBindingStrategy>('per_account');
  const [attackerAccountId, setAttackerAccountId] = useState<string>('');
  const [stepAssertions, setStepAssertions] = useState<LocalStepAssertions[]>([]);
  const [customPathInput, setCustomPathInput] = useState<Record<number, string>>({});
  const [enableBaseline, setEnableBaseline] = useState(false);
  const [baselineIgnoreFields, setBaselineIgnoreFields] = useState<string>('');
  const [baselineCriticalFields, setBaselineCriticalFields] = useState<string>('');

  const [learningWorkflow, setLearningWorkflow] = useState<Workflow | null>(null);
  const [learningResult, setLearningResult] = useState<LearningResult | null>(null);
  const [isLearningModalOpen, setIsLearningModalOpen] = useState(false);
  const [isVariablePoolOpen, setIsVariablePoolOpen] = useState(false);
  const [variablePoolWorkflow, setVariablePoolWorkflow] = useState<Workflow | null>(null);
  const [variablePoolSteps, setVariablePoolSteps] = useState<{ stepOrder: number; name: string }[]>([]);
  const [isLearning, setIsLearning] = useState(false);
  const [learningError, setLearningError] = useState<string | null>(null);
  const [isLearningSelectOpen, setIsLearningSelectOpen] = useState(false);
  const [learningAccountId, setLearningAccountId] = useState<string>('');
  const [learningEnvironmentId, setLearningEnvironmentId] = useState<string>('');
  const [environments, setEnvironments] = useState<any[]>([]);

  const [isMutationModalOpen, setIsMutationModalOpen] = useState(false);
  const [mutationName, setMutationName] = useState('');
  const [editingMutationWorkflowId, setEditingMutationWorkflowId] = useState<string | null>(null);
  const [editingMutationId, setEditingMutationId] = useState<string | null>(null);
  const [mutationProfile, setMutationProfile] = useState({
    skip_steps: [] as number[],
    swap_account_at_steps: {} as Record<number, string>,
    lock_variables: [] as string[],
    reuse_tickets: false,
    repeat_steps: {} as Record<number, number>,
    concurrent_replay: undefined as {
      step_order: number;
      concurrency: number;
      barrier?: boolean;
      timeout_ms?: number;
      pick_primary?: 'first_success' | 'first' | 'majority_success';
    } | undefined,
    parallel_groups: undefined as Array<{
      anchor_step_order: number;
      barrier?: boolean;
      timeout_ms?: number;
      extras: Array<{
        kind: 'extra';
        name: string;
        snapshot_template_id: string;
        snapshot_template_name: string;
        request_snapshot_raw: string;
      }>;
      pick_primary?: 'anchor_first_success' | 'anchor_first';
      writeback_policy?: 'primary_only' | 'none';
    }> | undefined,
  });
  const [mutationStepOptions, setMutationStepOptions] = useState<number[]>([]);
  const [concurrencyMode, setConcurrencyMode] = useState<'same_request' | 'multi_request' | 'none'>('none');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [workflowsData, templatesData, checklistsData, rulesData, accountsData, environsData] = await Promise.all([
        workflowsService.list(),
        apiTemplatesService.list(),
        checklistsService.list(),
        securityRulesService.list(),
        accountsService.list(),
        environmentsService.list(),
      ]);
      setWorkflows(workflowsData);
      setTemplates(templatesData);
      setChecklists(checklistsData);
      setSecurityRules(rulesData);
      setAccounts(accountsData);
      setEnvironments(environsData || []);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!formData.name.trim()) {
      alert('Name is required');
      return;
    }

    if (selectedTemplateIds.length < 2) {
      alert('A workflow needs at least 2 steps');
      return;
    }

    try {
      const newWorkflow = await workflowsService.create({
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        is_active: formData.is_active,
      });

      await workflowsService.setSteps(newWorkflow.id, selectedTemplateIds);
      setWorkflows([{ ...newWorkflow, steps: [] }, ...workflows]);
      handleCloseModal();
    } catch (error: any) {
      console.error('Failed to create workflow:', error);
      alert(`Failed to create workflow: ${error.message || 'Unknown error'}`);
    }
  };

  const handleUpdate = async () => {
    if (!editingId) return;

    if (!formData.name.trim()) {
      alert('Name is required');
      return;
    }

    if (selectedTemplateIds.length < 2) {
      alert('A workflow needs at least 2 steps');
      return;
    }

    try {
      const updated = await workflowsService.update(editingId, {
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        is_active: formData.is_active,
      });

      await workflowsService.setSteps(editingId, selectedTemplateIds);
      setWorkflows(workflows.map(w => w.id === editingId ? updated : w));
      handleCloseModal();
    } catch (error: any) {
      console.error('Failed to update workflow:', error);
      alert(`Failed to update workflow: ${error.message || 'Unknown error'}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this workflow?')) return;

    try {
      await workflowsService.delete(id);
      setWorkflows(workflows.filter(w => w.id !== id));
    } catch (error) {
      console.error('Failed to delete workflow:', error);
      alert('Failed to delete workflow');
    }
  };

  const handleRunLearning = (workflow: Workflow) => {
    if ((workflow as any).workflow_type === 'mutation') {
      alert('Cannot run learning mode on mutation workflows');
      return;
    }

    setLearningWorkflow(workflow);
    setLearningAccountId('');
    setLearningEnvironmentId('');
    setIsLearningSelectOpen(true);
  };

  const handleConfirmLearning = async () => {
    if (!learningWorkflow) return;

    if (!learningAccountId || !learningEnvironmentId) {
      alert('Please select both account and environment');
      return;
    }

    setIsLearningSelectOpen(false);
    setIsLearning(true);
    setLearningError(null);

    try {
      const result = await learningService.runLearning(learningWorkflow.id, {
        accountId: learningAccountId,
        environmentId: learningEnvironmentId,
      });
      setLearningResult(result);
      setIsLearningModalOpen(true);
    } catch (error: any) {
      setLearningError(error.message || 'Learning failed');
      console.error('Learning failed:', error);
    } finally {
      setIsLearning(false);
    }
  };

  const handleApplyMappings = async (
    acceptedCandidates: MappingCandidate[],
    variables: Partial<WorkflowVariable>[]
  ) => {
    if (!learningWorkflow || !learningResult) return;

    try {
      await learningService.applyMappings(learningWorkflow.id, {
        acceptedCandidates,
        variables,
        learningVersion: learningResult.learningVersion,
      });

      loadData();
      setIsLearningModalOpen(false);
      setLearningResult(null);
      setLearningWorkflow(null);
    } catch (error: any) {
      console.error('Failed to apply mappings:', error);
      alert('Failed to apply mappings: ' + error.message);
    }
  };

  const handleOpenVariablePool = async (workflow: Workflow) => {
    try {
      const details = await workflowsService.getWithDetails(workflow.id);
      const steps = (details.steps || [])
        .sort((a, b) => a.step_order - b.step_order)
        .map(s => ({ stepOrder: s.step_order, name: s.api_template?.name || `Step ${s.step_order}` }));

      setVariablePoolWorkflow(workflow);
      setVariablePoolSteps(steps);
      setIsVariablePoolOpen(true);
    } catch (error: any) {
      console.error('Failed to load workflow steps:', error);
      alert('Failed to load workflow steps: ' + error.message);
    }
  };

  const handleCreateMutation = async (workflow: Workflow) => {
    try {
      const details = await workflowsService.getWithDetails(workflow.id);
      const stepOrders = (details.steps || [])
        .sort((a, b) => a.step_order - b.step_order)
        .map(s => s.step_order);

      setEditingMutationWorkflowId(workflow.id);
      setMutationName(`${workflow.name} - Mutation`);
      setMutationProfile({
        skip_steps: [],
        swap_account_at_steps: {},
        lock_variables: [],
        reuse_tickets: false,
        repeat_steps: {},
        concurrent_replay: undefined,
        parallel_groups: undefined,
      });
      setMutationStepOptions(stepOrders);
      setConcurrencyMode('none');
      setIsMutationModalOpen(true);
    } catch (error: any) {
      console.error('Failed to open mutation editor:', error);
      alert('Failed to open mutation editor: ' + error.message);
    }
  };

  const handleEditMutation = async (workflow: Workflow) => {
    try {
      const baseWorkflowId = (workflow as any).base_workflow_id;
      if (!baseWorkflowId) {
        alert('Mutation baseline workflow not found');
        return;
      }

      const details = await workflowsService.getWithDetails(baseWorkflowId);
      const stepOrders = (details.steps || [])
        .sort((a, b) => a.step_order - b.step_order)
        .map(s => s.step_order);

      let profile = (workflow as any).mutation_profile;
      if (typeof profile === 'string') {
        try {
          profile = JSON.parse(profile);
        } catch {
          profile = {};
        }
      }

      setEditingMutationId(workflow.id);
      setEditingMutationWorkflowId(baseWorkflowId);
      setMutationName(workflow.name);
      setMutationProfile({
        skip_steps: profile?.skip_steps || [],
        swap_account_at_steps: profile?.swap_account_at_steps || {},
        lock_variables: profile?.lock_variables || [],
        reuse_tickets: profile?.reuse_tickets || false,
        repeat_steps: profile?.repeat_steps || {},
        concurrent_replay: profile?.concurrent_replay || undefined,
        parallel_groups: profile?.parallel_groups || undefined,
      });
      setMutationStepOptions(stepOrders);

      if (profile?.concurrent_replay) {
        setConcurrencyMode('same_request');
      } else if (profile?.parallel_groups && profile.parallel_groups.length > 0) {
        setConcurrencyMode('multi_request');
      } else {
        setConcurrencyMode('none');
      }

      setIsMutationModalOpen(true);
    } catch (error: any) {
      console.error('Failed to open mutation editor:', error);
      alert('Failed to open mutation editor: ' + error.message);
    }
  };

  const handleSaveMutation = async () => {
    if (!mutationName.trim()) return;

    try {
      if (editingMutationId) {
        await mutationsService.update(editingMutationId, {
          name: mutationName.trim(),
          mutation_profile: mutationProfile,
        });
      } else if (editingMutationWorkflowId) {
        await mutationsService.create(editingMutationWorkflowId, {
          name: mutationName.trim(),
          mutation_profile: mutationProfile,
        });
      } else {
        return;
      }

      setIsMutationModalOpen(false);
      setMutationName('');
      setEditingMutationWorkflowId(null);
      setEditingMutationId(null);
      setMutationProfile({
        skip_steps: [],
        swap_account_at_steps: {},
        lock_variables: [],
        reuse_tickets: false,
        repeat_steps: {},
        concurrent_replay: undefined,
        parallel_groups: undefined,
      });
      setMutationStepOptions([]);
      setConcurrencyMode('none');
      loadData();
    } catch (error: any) {
      console.error('Failed to save mutation:', error);
      alert('Failed to save mutation: ' + error.message);
    }
  };

  const handleEdit = async (workflow: Workflow) => {
    try {
      const details = await workflowsService.getWithDetails(workflow.id);
      setEditingId(workflow.id);
      setFormData({
        name: workflow.name,
        description: workflow.description || '',
        is_active: workflow.is_active,
      });
      setSelectedTemplateIds(
        (details.steps || [])
          .sort((a, b) => a.step_order - b.step_order)
          .map(s => s.api_template_id)
      );
      setIsModalOpen(true);
    } catch (error) {
      console.error('Failed to load workflow details:', error);
    }
  };

  const handleOpenConfig = async (workflow: Workflow) => {
    try {
      const details = await workflowsService.getWithDetails(workflow.id);
      setConfigWorkflow(details);
      setBindingStrategy((details.account_binding_strategy as AccountBindingStrategy) || 'per_account');
      setVariableConfigs(
        (details.variable_configs || []).map(vc => ({
          id: vc.id,
          name: vc.name,
          step_variable_mappings: vc.step_variable_mappings,
          data_source: vc.data_source as LocalVariableConfig['data_source'],
          checklist_id: vc.checklist_id,
          security_rule_id: vc.security_rule_id,
          account_field_name: vc.account_field_name,
          role: vc.role as VariableRole | undefined,
        }))
      );
      setStepAssertions(
        (details.steps || []).map(step => ({
          step_id: step.id,
          step_order: step.step_order,
          assertions: (step.step_assertions || []) as StepAssertion[],
          assertions_mode: (step.assertions_mode || 'all') as AssertionsMode,
        }))
      );
      setCustomPathInput({});
      setIsConfigModalOpen(true);
    } catch (error) {
      console.error('Failed to load workflow details:', error);
    }
  };

  const handleOpenContextSettings = async (workflow: Workflow) => {
    try {
      const details = await workflowsService.getWithDetails(workflow.id);
      const extractorData = await workflowsService.getExtractors(workflow.id);

      setContextWorkflow(details);
      setEnableExtractor(details.enable_extractor || false);
      setEnableSessionJar(details.enable_session_jar || false);
      setSessionJarConfig(details.session_jar_config || { cookie_mode: true, body_json_paths: [], header_keys: [] });
      setBindingStrategy((details.account_binding_strategy as AccountBindingStrategy) || 'per_account');
      setAttackerAccountId(details.attacker_account_id || '');
      setEnableBaseline(details.enable_baseline || false);
      const baselineConfig = details.baseline_config || {};
      setBaselineIgnoreFields((baselineConfig.ignore_paths || []).join('\n'));
      setBaselineCriticalFields((baselineConfig.critical_paths || []).join('\n'));
      setExtractors(
        extractorData.map(e => ({
          id: e.id,
          step_order: e.step_order,
          name: e.name,
          source: e.source,
          expression: e.expression,
          transform_type: e.transform?.type,
          transform_value: e.transform?.value,
          required: e.required,
        }))
      );
      setIsContextModalOpen(true);
    } catch (error) {
      console.error('Failed to load context settings:', error);
    }
  };

  const handleSaveContextSettings = async () => {
    if (!contextWorkflow) return;

    if (bindingStrategy === 'anchor_attacker' && !attackerAccountId) {
      alert('Please select an attacker account for the anchor_attacker strategy');
      return;
    }

    if (enableBaseline && bindingStrategy !== 'anchor_attacker') {
      alert('Baseline comparison only works with the "Anchor Attacker" strategy. It compares attacker accessing their own resource vs victim resource.');
      return;
    }

    try {
      const baselineConfig = enableBaseline ? {
        ignore_paths: baselineIgnoreFields.split('\n').map(s => s.trim()).filter(Boolean),
        critical_paths: baselineCriticalFields.split('\n').map(s => s.trim()).filter(Boolean),
        compare_mode: 'loose' as const,
      } : undefined;

      await workflowsService.update(contextWorkflow.id, {
        enable_extractor: enableExtractor,
        enable_session_jar: enableSessionJar,
        session_jar_config: sessionJarConfig,
        account_binding_strategy: bindingStrategy,
        attacker_account_id: bindingStrategy === 'anchor_attacker' ? attackerAccountId : undefined,
        enable_baseline: enableBaseline,
        baseline_config: baselineConfig,
      });

      if (enableExtractor) {
        const extractorsToSave = extractors.map(e => ({
          step_order: e.step_order,
          name: e.name,
          source: e.source,
          expression: e.expression,
          transform: e.transform_type ? { type: e.transform_type, value: e.transform_value } : undefined,
          required: e.required,
        }));
        await workflowsService.setExtractors(contextWorkflow.id, extractorsToSave as any);
      }

      setIsContextModalOpen(false);
      setContextWorkflow(null);
      loadData();
    } catch (error: any) {
      console.error('Failed to save context settings:', error);
      alert(`Failed to save: ${error.message || 'Unknown error'}`);
    }
  };

  const handleSaveConfig = async () => {
    if (!configWorkflow) return;

    const errors: string[] = [];
    variableConfigs.forEach((config, index) => {
      if (!config.name.trim()) {
        errors.push(`Variable ${index + 1} requires a name`);
      }
      if (config.step_variable_mappings.length === 0) {
        errors.push(`Variable "${config.name}" requires at least one step mapping`);
      }
      if (config.data_source === 'checklist' && !config.checklist_id) {
        errors.push(`Variable "${config.name}" requires a checklist selection`);
      }
      if (config.data_source === 'security_rule' && !config.security_rule_id) {
        errors.push(`Variable "${config.name}" requires a security rule selection`);
      }
      if (config.data_source === 'account_field' && !config.account_field_name) {
        errors.push(`Variable "${config.name}" requires an account field name`);
      }
    });

    if (errors.length > 0) {
      alert('Validation errors:\n' + errors.map(e => `- ${e}`).join('\n'));
      return;
    }

    try {
      await workflowsService.setVariableConfigs(
        configWorkflow.id,
        variableConfigs.map(vc => ({
          name: vc.name,
          step_variable_mappings: vc.step_variable_mappings,
          data_source: vc.data_source,
          checklist_id: vc.checklist_id,
          security_rule_id: vc.security_rule_id,
          account_field_name: vc.account_field_name,
          role: vc.role,
        }))
      );

      for (const sa of stepAssertions) {
        await workflowsService.updateStepAssertions(sa.step_id, sa.assertions, sa.assertions_mode);
      }

      setIsConfigModalOpen(false);
      setConfigWorkflow(null);
      setVariableConfigs([]);
      setStepAssertions([]);
      setCustomPathInput({});
    } catch (error: any) {
      console.error('Failed to save config:', error);
      alert(`Failed to save configuration: ${error.message || 'Unknown error'}`);
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
    setFormData({ name: '', description: '', is_active: true });
    setSelectedTemplateIds([]);
  };

  const handleAddTemplate = (templateId: string) => {
    setSelectedTemplateIds([...selectedTemplateIds, templateId]);
  };

  const handleRemoveStep = (index: number) => {
    setSelectedTemplateIds(selectedTemplateIds.filter((_, i) => i !== index));
  };

  const handleMoveStep = (index: number, direction: 'up' | 'down') => {
    const newIds = [...selectedTemplateIds];
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= newIds.length) return;
    [newIds[index], newIds[newIndex]] = [newIds[newIndex], newIds[index]];
    setSelectedTemplateIds(newIds);
  };

  const handleAddVariableConfig = () => {
    setVariableConfigs([
      ...variableConfigs,
      {
        id: `temp_${Date.now()}`,
        name: '',
        step_variable_mappings: [],
        data_source: 'checklist',
      },
    ]);
  };

  const handleRemoveVariableConfig = (index: number) => {
    setVariableConfigs(variableConfigs.filter((_, i) => i !== index));
  };

  const handleUpdateVariableConfig = (index: number, updates: Partial<LocalVariableConfig>) => {
    setVariableConfigs(variableConfigs.map((vc, i) => i === index ? { ...vc, ...updates } : vc));
  };

  const handleAddStepMapping = (configIndex: number, stepOrder: number, jsonPath: string, originalValue: string) => {
    const config = variableConfigs[configIndex];
    const newMappings = [...config.step_variable_mappings, { step_order: stepOrder, json_path: jsonPath, original_value: originalValue }];
    handleUpdateVariableConfig(configIndex, { step_variable_mappings: newMappings });
  };

  const handleAddCustomPathMapping = (configIndex: number) => {
    const path = customPathInput[configIndex]?.trim();
    if (!path) return;
    const stepOrder = parseInt(path.split(':')[0]) || 1;
    const jsonPath = path.includes(':') ? path.split(':').slice(1).join(':').trim() : path;
    if (!jsonPath.startsWith('body.') && !jsonPath.startsWith('headers.') && !jsonPath.startsWith('query.') && !jsonPath.startsWith('path.')) {
      alert('Path must start with body., headers., query., or path.');
      return;
    }
    handleAddStepMapping(configIndex, stepOrder, jsonPath, '');
    setCustomPathInput({ ...customPathInput, [configIndex]: '' });
  };

  const handleRemoveStepMapping = (configIndex: number, mappingIndex: number) => {
    const config = variableConfigs[configIndex];
    const newMappings = config.step_variable_mappings.filter((_, i) => i !== mappingIndex);
    handleUpdateVariableConfig(configIndex, { step_variable_mappings: newMappings });
  };

  const handleImportFromTemplates = () => {
    if (!configWorkflow) return;

    const steps = configWorkflow.steps || [];
    if (steps.length === 0) {
      alert('No steps in workflow');
      return;
    }

    const variableGroups: Record<string, { stepOrder: number; jsonPath: string; originalValue: string }[]> = {};

    steps.forEach((step, stepIndex) => {
      const template = step.api_template;
      if (!template) return;

      const vars = template.variables || [];
      vars.forEach(v => {
        const pathParts = v.json_path.split('.');
        const fieldName = pathParts[pathParts.length - 1] || v.json_path;

        if (!variableGroups[fieldName]) {
          variableGroups[fieldName] = [];
        }
        variableGroups[fieldName].push({
          stepOrder: stepIndex + 1,
          jsonPath: v.json_path,
          originalValue: v.original_value || '',
        });
      });
    });

    const existingNames = new Set(variableConfigs.map(vc => vc.name.toLowerCase()));
    const newConfigs: LocalVariableConfig[] = [];

    Object.entries(variableGroups).forEach(([fieldName, mappings]) => {
      if (existingNames.has(fieldName.toLowerCase())) return;

      newConfigs.push({
        id: `temp_${Date.now()}_${fieldName}`,
        name: fieldName,
        step_variable_mappings: mappings.map(m => ({
          step_order: m.stepOrder,
          json_path: m.jsonPath,
          original_value: m.originalValue,
        })),
        data_source: 'checklist',
      });
    });

    if (newConfigs.length === 0) {
      alert('No new variables to import. All template variables already exist in configuration.');
      return;
    }

    setVariableConfigs([...variableConfigs, ...newConfigs]);
    alert(`Imported ${newConfigs.length} variable configuration(s) from templates.`);
  };

  const handleAddExtractor = () => {
    setExtractors([
      ...extractors,
      {
        id: `temp_${Date.now()}`,
        step_order: 1,
        name: '',
        source: 'response_body_jsonpath',
        expression: '',
        required: false,
      },
    ]);
  };

  const handleRemoveExtractor = (index: number) => {
    setExtractors(extractors.filter((_, i) => i !== index));
  };

  const handleUpdateExtractor = (index: number, updates: Partial<LocalExtractor>) => {
    setExtractors(extractors.map((e, i) => i === index ? { ...e, ...updates } : e));
  };

  const handleAddBodyPath = () => {
    if (newBodyPath.trim()) {
      setSessionJarConfig({
        ...sessionJarConfig,
        body_json_paths: [...(sessionJarConfig.body_json_paths || []), newBodyPath.trim()],
      });
      setNewBodyPath('');
    }
  };

  const handleRemoveBodyPath = (index: number) => {
    setSessionJarConfig({
      ...sessionJarConfig,
      body_json_paths: (sessionJarConfig.body_json_paths || []).filter((_, i) => i !== index),
    });
  };

  const handleAddHeaderKey = () => {
    if (newHeaderKey.trim()) {
      setSessionJarConfig({
        ...sessionJarConfig,
        header_keys: [...(sessionJarConfig.header_keys || []), newHeaderKey.trim()],
      });
      setNewHeaderKey('');
    }
  };

  const handleRemoveHeaderKey = (index: number) => {
    setSessionJarConfig({
      ...sessionJarConfig,
      header_keys: (sessionJarConfig.header_keys || []).filter((_, i) => i !== index),
    });
  };

  const getTemplateName = (templateId: string) => {
    const template = templates.find(t => t.id === templateId);
    return template?.name || 'Unknown';
  };

  const getTemplateMethod = (templateId: string) => {
    const template = templates.find(t => t.id === templateId);
    return template?.parsed_structure?.method || 'GET';
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

  const columns = [
    { key: 'name' as const, label: 'Name' },
    {
      key: 'workflow_type' as const,
      label: 'Type',
      render: (_: string, row: any) => {
        const type = row.workflow_type || 'baseline';
        const status = row.learning_status || 'unlearned';
        const version = row.learning_version || 0;
        return (
          <div className="flex flex-col gap-1">
            <span className={`px-2 py-0.5 text-xs font-medium rounded inline-flex items-center w-fit ${
              type === 'mutation' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'
            }`}>
              {type === 'mutation' ? <><GitBranch size={12} className="mr-1" />Mutation</> : <><Beaker size={12} className="mr-1" />Baseline</>}
            </span>
            {type === 'baseline' && (
              <span className={`text-xs ${status === 'learned' ? 'text-green-600' : 'text-gray-400'}`}>
                {status === 'learned' ? `Learned v${version}` : 'Not learned'}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'is_active' as const,
      label: 'Status',
      render: (value: boolean) => (
        <span className={`px-2 py-1 text-xs font-medium rounded ${value ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
          {value ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      key: 'enable_extractor' as const,
      label: 'Features',
      render: (_: boolean, row: Workflow) => (
        <div className="flex gap-1 flex-wrap">
          {row.enable_extractor && (
            <span className="px-2 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">Extractor</span>
          )}
          {row.enable_session_jar && (
            <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">Session</span>
          )}
          {row.enable_baseline && (
            <span className="px-2 py-0.5 text-xs bg-teal-100 text-teal-700 rounded">Compare</span>
          )}
          {!row.enable_extractor && !row.enable_session_jar && !row.enable_baseline && (
            <span className="text-gray-400 text-xs">-</span>
          )}
        </div>
      ),
    },
    {
      key: 'created_at' as const,
      label: 'Created',
      render: (value: string) => new Date(value).toLocaleDateString(),
    },
    {
      key: 'id' as const,
      label: 'Actions',
      render: (_: string, row: Workflow) => {
        const wfType = (row as any).workflow_type || 'baseline';
        const isBaseline = wfType === 'baseline';
        const isMutation = wfType === 'mutation';
        return (
          <div className="flex gap-1 flex-wrap">
            {isBaseline && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); handleRunLearning(row); }}
                  className="p-1 hover:bg-cyan-100 rounded text-cyan-600"
                  title="Run Learning Mode"
                  disabled={isLearning}
                >
                  <Brain size={16} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleOpenVariablePool(row); }}
                  className="p-1 hover:bg-teal-100 rounded text-teal-600"
                  title="Variable Pool"
                >
                  <Database size={16} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleCreateMutation(row); }}
                  className="p-1 hover:bg-orange-100 rounded text-orange-600"
                  title="Create Mutation"
                >
                  <GitBranch size={16} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleOpenContextSettings(row); }}
                  className="p-1 hover:bg-amber-100 rounded text-amber-600"
                  title="Context Settings"
                >
                  <Zap size={16} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleOpenConfig(row); }}
                  className="p-1 hover:bg-emerald-100 rounded text-emerald-600"
                  title="Configure Variables"
                >
                  <Settings size={16} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleEdit(row); }}
                  className="p-1 hover:bg-blue-100 rounded text-blue-600"
                  title="Edit Workflow"
                >
                  <Edit2 size={16} />
                </button>
              </>
            )}
            {isMutation && (
              <button
                onClick={(e) => { e.stopPropagation(); handleEditMutation(row); }}
                className="p-1 hover:bg-purple-100 rounded text-purple-600"
                title="Edit Mutation Profile"
              >
                <Beaker size={16} />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(row.id); }}
              className="p-1 hover:bg-red-100 rounded text-red-600"
              title="Delete"
            >
              <Trash2 size={16} />
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Workflows</h1>
          <p className="text-gray-600 mt-1">Define API call sequences for testing</p>
        </div>
        <Button onClick={() => setIsModalOpen(true)} size="lg">
          <Plus size={20} className="mr-2" />
          New Workflow
        </Button>
      </div>

      <Table columns={columns} data={workflows} loading={loading} onRowClick={handleEdit} />

      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={editingId ? 'Edit Workflow' : 'Create Workflow'}
        size="xl"
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseModal}>Cancel</Button>
            <Button onClick={editingId ? handleUpdate : handleCreate}>
              {editingId ? 'Update' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          <Input
            label="Workflow Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="e.g., Login Flow, Registration Flow"
          />

          <TextArea
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder="Describe what this workflow does..."
          />

          <Checkbox
            label="Active"
            checked={formData.is_active}
            onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Workflow Steps (in order)
            </label>
            <div className="border border-gray-300 rounded-lg divide-y">
              {selectedTemplateIds.length === 0 ? (
                <p className="p-4 text-gray-500 text-sm text-center">No steps added yet</p>
              ) : (
                selectedTemplateIds.map((templateId, index) => (
                  <div key={`${templateId}-${index}`} className="p-3 flex items-center justify-between bg-white">
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-sm font-medium">
                        {index + 1}
                      </span>
                      <span className="text-xs px-2 py-0.5 bg-gray-100 rounded font-mono">
                        {getTemplateMethod(templateId)}
                      </span>
                      <span className="font-medium">{getTemplateName(templateId)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleMoveStep(index, 'up')}
                        disabled={index === 0}
                        className="p-1 hover:bg-gray-100 rounded disabled:opacity-30"
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        onClick={() => handleMoveStep(index, 'down')}
                        disabled={index === selectedTemplateIds.length - 1}
                        className="p-1 hover:bg-gray-100 rounded disabled:opacity-30"
                      >
                        <ChevronDown size={16} />
                      </button>
                      <button
                        onClick={() => handleRemoveStep(index)}
                        className="p-1 hover:bg-red-100 rounded text-red-600"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Add API Template to Workflow
            </label>
            <div className="border border-gray-300 rounded-lg p-3 max-h-48 overflow-y-auto">
              {templates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => handleAddTemplate(template.id)}
                  className="w-full text-left p-2 hover:bg-gray-50 rounded flex items-center gap-2"
                >
                  <Plus size={14} className="text-gray-400" />
                  <span className="text-xs px-2 py-0.5 bg-gray-100 rounded font-mono">
                    {template.parsed_structure?.method || 'GET'}
                  </span>
                  <span className="text-sm">{template.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isConfigModalOpen}
        onClose={() => { setIsConfigModalOpen(false); setConfigWorkflow(null); }}
        title={`Configure Variables: ${configWorkflow?.name || ''}`}
        size="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => { setIsConfigModalOpen(false); setConfigWorkflow(null); }}>
              Cancel
            </Button>
            <Button onClick={handleSaveConfig}>Save Configuration</Button>
          </>
        }
      >
        {configWorkflow && (
          <div className="space-y-6">
            <div className="p-4 bg-blue-50 rounded-lg">
              <h4 className="font-medium text-blue-800 mb-2 flex items-center gap-2">
                <Layers size={18} />
                Workflow Steps
              </h4>
              <div className="space-y-1">
                {(configWorkflow.steps || []).map((step, index) => (
                  <div key={step.id} className="flex items-center gap-2 text-sm text-blue-700">
                    <span className="w-5 h-5 bg-blue-200 rounded-full flex items-center justify-center text-xs font-medium">
                      {index + 1}
                    </span>
                    <span>{step.api_template?.name || 'Unknown'}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-4 bg-emerald-50 rounded-lg border border-emerald-200">
              <h4 className="font-medium text-emerald-800 mb-3 flex items-center gap-2">
                <CheckCircle size={18} />
                Step Assertions (Cross-Step Validation)
              </h4>
              <p className="text-sm text-emerald-700 mb-3">
                Define assertions to validate response values against workflow variables.
                Example: response.body.phone == sms_phone AND != login_phone
              </p>
              {(configWorkflow.steps || []).map((step) => {
                const sa = stepAssertions.find(s => s.step_id === step.id);
                return (
                  <StepAssertionsEditor
                    key={step.id}
                    stepOrder={step.step_order}
                    stepName={step.api_template?.name || 'Unknown'}
                    assertions={sa?.assertions || []}
                    assertionsMode={sa?.assertions_mode || 'all'}
                    variableConfigs={variableConfigs as any}
                    contextVariables={extractors.map(e => e.name)}
                    onChange={(newAssertions, newMode) => {
                      setStepAssertions(prev => {
                        const existing = prev.find(s => s.step_id === step.id);
                        if (existing) {
                          return prev.map(s => s.step_id === step.id
                            ? { ...s, assertions: newAssertions, assertions_mode: newMode }
                            : s
                          );
                        }
                        return [...prev, {
                          step_id: step.id,
                          step_order: step.step_order,
                          assertions: newAssertions,
                          assertions_mode: newMode,
                        }];
                      });
                    }}
                  />
                );
              })}
            </div>

            <div>
              <div className="flex justify-between items-center mb-3">
                <label className="block text-sm font-medium text-gray-700">
                  Variable Configurations
                </label>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={handleImportFromTemplates}>
                    <Download size={14} className="mr-1" />
                    Import from Templates
                  </Button>
                  <Button size="sm" onClick={handleAddVariableConfig}>
                    <Plus size={14} className="mr-1" />
                    Add Variable
                  </Button>
                </div>
              </div>

              {variableConfigs.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-4 border border-dashed rounded-lg">
                  No variables configured. Add a variable to map values across workflow steps.
                </p>
              ) : (
                <div className="space-y-4">
                  {variableConfigs.map((config, configIndex) => (
                    <div key={config.id} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex justify-between items-start mb-4">
                        <Input
                          label="Variable Name"
                          value={config.name}
                          onChange={(e) => handleUpdateVariableConfig(configIndex, { name: e.target.value })}
                          placeholder="e.g., user_id, payload"
                          className="flex-1 mr-4"
                        />
                        <button
                          onClick={() => handleRemoveVariableConfig(configIndex)}
                          className="p-1 hover:bg-red-100 rounded text-red-600 mt-6"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>

                      <Select
                        label="Data Source"
                        value={config.data_source}
                        onChange={(e) => handleUpdateVariableConfig(configIndex, {
                          data_source: e.target.value as LocalVariableConfig['data_source'],
                          checklist_id: undefined,
                          security_rule_id: undefined,
                          account_field_name: undefined,
                        })}
                        options={[
                          { value: 'checklist', label: 'Checklist (Replace Values)' },
                          { value: 'account_field', label: 'Account Field' },
                          { value: 'security_rule', label: 'Security Rule (Append Payloads)' },
                          { value: 'workflow_context', label: 'Workflow Context (From Extractor)' },
                        ]}
                      />

                      {config.data_source === 'checklist' && (
                        <Select
                          label="Select Checklist"
                          value={config.checklist_id || ''}
                          onChange={(e) => handleUpdateVariableConfig(configIndex, { checklist_id: e.target.value })}
                          options={[
                            { value: '', label: 'Select...' },
                            ...checklists.map(c => ({ value: c.id, label: `${c.name} (${c.config.values.length} values)` })),
                          ]}
                        />
                      )}

                      {config.data_source === 'security_rule' && (
                        <Select
                          label="Select Security Rule"
                          value={config.security_rule_id || ''}
                          onChange={(e) => handleUpdateVariableConfig(configIndex, { security_rule_id: e.target.value })}
                          options={[
                            { value: '', label: 'Select...' },
                            ...securityRules.map(r => ({ value: r.id, label: `${r.name} (${r.payloads.length} payloads)` })),
                          ]}
                        />
                      )}

                      {config.data_source === 'account_field' && (
                        <div className="space-y-3">
                          <Select
                            label="Select Account Field"
                            value={config.account_field_name || ''}
                            onChange={(e) => handleUpdateVariableConfig(configIndex, { account_field_name: e.target.value })}
                            options={[
                              { value: '', label: 'Select...' },
                              ...getAccountFields().map(f => ({ value: f, label: f })),
                            ]}
                          />
                          {bindingStrategy === 'anchor_attacker' && (
                            <Select
                              label="Variable Role"
                              value={config.role || 'neutral'}
                              onChange={(e) => handleUpdateVariableConfig(configIndex, { role: e.target.value as VariableRole })}
                              options={[
                                { value: 'attacker', label: 'Attacker (fixed from attacker account)' },
                                { value: 'target', label: 'Target (rotated through victim accounts)' },
                                { value: 'neutral', label: 'Neutral (not account-bound)' },
                              ]}
                            />
                          )}
                        </div>
                      )}

                      {config.data_source === 'workflow_context' && (
                        <p className="text-sm text-amber-600 bg-amber-50 p-2 rounded mt-2">
                          This variable will use values extracted by the Extractor. Enable Extractor in Context Settings and create an extractor rule with the same name.
                        </p>
                      )}

                      <div className="mt-4">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Step Mappings
                        </label>
                        <div className="space-y-2">
                          {config.step_variable_mappings.map((mapping, mappingIndex) => (
                            <div key={mappingIndex} className="flex items-center gap-2 bg-gray-50 p-2 rounded">
                              <span className="text-sm">Step {mapping.step_order}:</span>
                              <code className="text-xs bg-white px-2 py-1 rounded border flex-1">
                                {mapping.json_path}
                              </code>
                              <button
                                onClick={() => handleRemoveStepMapping(configIndex, mappingIndex)}
                                className="p-1 hover:bg-red-100 rounded text-red-600"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ))}
                        </div>

                        <div className="mt-2 space-y-2">
                          <Select
                            value=""
                            onChange={(e) => {
                              const [stepOrderStr, jsonPath, originalValue] = e.target.value.split('|||');
                              if (stepOrderStr && jsonPath) {
                                handleAddStepMapping(configIndex, parseInt(stepOrderStr), jsonPath, originalValue || '');
                              }
                            }}
                            options={[
                              { value: '', label: 'Add from template variables...' },
                              ...(configWorkflow.steps || []).flatMap(step => {
                                const template = step.api_template;
                                if (!template) return [];
                                const vars = template.variables || [];
                                return vars.map(v => ({
                                  value: `${step.step_order}|||${v.json_path}|||${v.original_value}`,
                                  label: `Step ${step.step_order}: ${v.json_path}`,
                                }));
                              }),
                            ]}
                            className="flex-1"
                          />
                          <div className="flex gap-2">
                            <Input
                              value={customPathInput[configIndex] || ''}
                              onChange={(e) => setCustomPathInput({ ...customPathInput, [configIndex]: e.target.value })}
                              placeholder="e.g., 2:body.phone or 1:headers.Authorization"
                              className="flex-1 text-sm"
                            />
                            <Button size="sm" variant="secondary" onClick={() => handleAddCustomPathMapping(configIndex)}>
                              Add Custom
                            </Button>
                          </div>
                          <p className="text-xs text-gray-500">
                            Custom format: step_number:json_path (e.g., "2:body.targetPhone" for logic vuln testing)
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isContextModalOpen}
        onClose={() => { setIsContextModalOpen(false); setContextWorkflow(null); }}
        title={`Execution Context: ${contextWorkflow?.name || ''}`}
        size="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => { setIsContextModalOpen(false); setContextWorkflow(null); }}>
              Cancel
            </Button>
            <Button onClick={handleSaveContextSettings}>Save Settings</Button>
          </>
        }
      >
        {contextWorkflow && (
          <div className="space-y-6">
            <div className="border border-emerald-200 rounded-lg p-4 bg-emerald-50/50">
              <h4 className="font-medium text-emerald-800 flex items-center gap-2 mb-4">
                <Shield size={18} />
                Execution Strategy
              </h4>
              <div className="grid grid-cols-3 gap-3 mb-4">
                {(['independent', 'per_account', 'anchor_attacker'] as AccountBindingStrategy[]).map(strategy => (
                  <div
                    key={strategy}
                    onClick={() => setBindingStrategy(strategy)}
                    className={`p-3 rounded-lg border-2 cursor-pointer transition-colors ${bindingStrategy === strategy ? 'border-emerald-500 bg-emerald-100' : 'border-gray-200 bg-white hover:border-emerald-300'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {strategy === 'independent' && <Shuffle size={18} className={bindingStrategy === strategy ? 'text-emerald-600' : 'text-gray-400'} />}
                      {strategy === 'per_account' && <Users size={18} className={bindingStrategy === strategy ? 'text-emerald-600' : 'text-gray-400'} />}
                      {strategy === 'anchor_attacker' && <Target size={18} className={bindingStrategy === strategy ? 'text-emerald-600' : 'text-gray-400'} />}
                      <span className="font-medium text-sm">
                        {strategy === 'independent' ? 'Independent' : strategy === 'per_account' ? 'Per Account' : 'Anchor Attacker'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">
                      {strategy === 'independent' && 'All combinations of account fields'}
                      {strategy === 'per_account' && 'All fields from same account'}
                      {strategy === 'anchor_attacker' && 'Fixed attacker, rotate victims'}
                    </p>
                  </div>
                ))}
              </div>

              {bindingStrategy === 'anchor_attacker' && (
                <div className="space-y-3 p-3 bg-white rounded-lg border border-emerald-200">
                  <Select
                    label="Attacker Account"
                    value={attackerAccountId}
                    onChange={(e) => setAttackerAccountId(e.target.value)}
                    options={[
                      { value: '', label: 'Select attacker account...' },
                      ...accounts.map(a => ({ value: a.id, label: a.name })),
                    ]}
                  />
                  <div className="flex items-start gap-2 p-2 bg-amber-50 rounded border border-amber-200">
                    <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      The attacker account's identity fields (token, session) will be used for all requests.
                      Target fields will be rotated through other accounts to test for IDOR/privilege escalation.
                    </p>
                  </div>
                </div>
              )}

              {bindingStrategy === 'independent' && (
                <p className="text-sm text-gray-600 p-2 bg-white rounded border">
                  Each variable can come from any account independently. Creates the Cartesian product of all variable values.
                  This maximizes coverage but can generate many combinations.
                </p>
              )}

              {bindingStrategy === 'per_account' && (
                <p className="text-sm text-gray-600 p-2 bg-white rounded border">
                  Each test combination uses all fields from a single account. Ideal for login flows and session-based tests.
                </p>
              )}
            </div>

            {bindingStrategy === 'anchor_attacker' && (
              <div className="border border-cyan-200 rounded-lg p-4 bg-cyan-50/50">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-cyan-800 flex items-center gap-2">
                    <Shield size={18} />
                    Baseline Comparison
                  </h4>
                  <Checkbox
                    label="Enable Baseline"
                    checked={enableBaseline}
                    onChange={(e) => setEnableBaseline(e.target.checked)}
                  />
                </div>
                <p className="text-xs text-cyan-700 mb-3">
                  When enabled, the workflow first runs with attacker accessing their own resources (baseline),
                  then compares with attacker accessing victim resources. Findings are created only when responses differ significantly.
                </p>

                {enableBaseline && (
                  <div className="space-y-3 p-3 bg-white rounded-lg border border-cyan-200">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Ignore Fields (one per line)
                      </label>
                      <textarea
                        value={baselineIgnoreFields}
                        onChange={(e) => setBaselineIgnoreFields(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                        rows={3}
                        placeholder={"timestamp\nrequest_id\nbody.created_at"}
                      />
                      <p className="text-xs text-gray-500 mt-1">Fields to ignore when comparing responses (e.g., timestamps, random IDs)</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Critical Fields (one per line)
                      </label>
                      <textarea
                        value={baselineCriticalFields}
                        onChange={(e) => setBaselineCriticalFields(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                        rows={3}
                        placeholder={"user_id\nowner_id\nbody.data.email"}
                      />
                      <p className="text-xs text-gray-500 mt-1">Fields that must match - changes here always trigger findings</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {bindingStrategy !== 'anchor_attacker' && (
              <div className="flex items-start gap-2 p-3 bg-gray-100 rounded-lg border border-gray-200">
                <AlertTriangle size={16} className="text-gray-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-gray-600">
                  Baseline comparison is only available with the "Anchor Attacker" strategy. It compares
                  attacker accessing their own resources vs victim resources to detect IDOR vulnerabilities.
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className={`p-4 rounded-lg border-2 cursor-pointer transition-colors ${enableExtractor ? 'border-amber-500 bg-amber-50' : 'border-gray-200 bg-white'}`} onClick={() => setEnableExtractor(!enableExtractor)}>
                <div className="flex items-center gap-3">
                  <Zap size={24} className={enableExtractor ? 'text-amber-600' : 'text-gray-400'} />
                  <div>
                    <h4 className="font-medium">Enable Extractor</h4>
                    <p className="text-sm text-gray-500">Extract values from responses</p>
                  </div>
                  <Checkbox checked={enableExtractor} onChange={() => {}} className="ml-auto" />
                </div>
              </div>

              <div className={`p-4 rounded-lg border-2 cursor-pointer transition-colors ${enableSessionJar ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}`} onClick={() => setEnableSessionJar(!enableSessionJar)}>
                <div className="flex items-center gap-3">
                  <Cookie size={24} className={enableSessionJar ? 'text-blue-600' : 'text-gray-400'} />
                  <div>
                    <h4 className="font-medium">Enable Session Jar</h4>
                    <p className="text-sm text-gray-500">Carry cookies/session across steps</p>
                  </div>
                  <Checkbox checked={enableSessionJar} onChange={() => {}} className="ml-auto" />
                </div>
              </div>
            </div>

            {enableExtractor && (
              <div className="border border-amber-200 rounded-lg p-4 bg-amber-50/50">
                <div className="flex justify-between items-center mb-4">
                  <h4 className="font-medium text-amber-800 flex items-center gap-2">
                    <Zap size={18} />
                    Extractor Rules
                  </h4>
                  <Button size="sm" onClick={handleAddExtractor}>
                    <Plus size={14} className="mr-1" />
                    Add Rule
                  </Button>
                </div>

                {extractors.length === 0 ? (
                  <p className="text-amber-700 text-sm text-center py-4 border border-dashed border-amber-300 rounded-lg">
                    No extractors configured. Add rules to extract values from step responses.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {extractors.map((extractor, index) => (
                      <div key={extractor.id} className="bg-white border border-amber-200 rounded-lg p-4">
                        <div className="flex justify-between items-start mb-3">
                          <div className="flex-1 grid grid-cols-2 gap-3">
                            <Select
                              label="Step"
                              value={extractor.step_order.toString()}
                              onChange={(e) => handleUpdateExtractor(index, { step_order: parseInt(e.target.value) })}
                              options={(contextWorkflow.steps || []).map((s, i) => ({
                                value: (i + 1).toString(),
                                label: `Step ${i + 1}: ${s.api_template?.name || 'Unknown'}`,
                              }))}
                            />
                            <Input
                              label="Variable Name"
                              value={extractor.name}
                              onChange={(e) => handleUpdateExtractor(index, { name: e.target.value })}
                              placeholder="e.g., sessionId"
                            />
                          </div>
                          <button
                            onClick={() => handleRemoveExtractor(index)}
                            className="p-1 hover:bg-red-100 rounded text-red-600 ml-2 mt-6"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <Select
                            label="Source"
                            value={extractor.source}
                            onChange={(e) => handleUpdateExtractor(index, { source: e.target.value as ExtractorSource })}
                            options={[
                              { value: 'response_body_jsonpath', label: 'Response Body (JSONPath)' },
                              { value: 'response_body_regex', label: 'Response Body (Regex)' },
                              { value: 'response_header', label: 'Response Header' },
                              { value: 'response_status', label: 'Response Status' },
                            ]}
                          />
                          <Input
                            label={extractor.source === 'response_body_jsonpath' ? 'JSONPath' : extractor.source === 'response_body_regex' ? 'Regex Pattern' : extractor.source === 'response_header' ? 'Header Key' : 'Expression'}
                            value={extractor.expression}
                            onChange={(e) => handleUpdateExtractor(index, { expression: e.target.value })}
                            placeholder={extractor.source === 'response_body_jsonpath' ? '$.content.sessionId' : extractor.source === 'response_body_regex' ? '"sessionId":"(.*?)"' : 'X-Session-Id'}
                          />
                        </div>

                        <div className="grid grid-cols-3 gap-3 mt-3">
                          <Select
                            label="Transform"
                            value={extractor.transform_type || ''}
                            onChange={(e) => handleUpdateExtractor(index, { transform_type: e.target.value as LocalExtractor['transform_type'] || undefined })}
                            options={[
                              { value: '', label: 'None' },
                              { value: 'trim', label: 'Trim' },
                              { value: 'lower', label: 'Lowercase' },
                              { value: 'upper', label: 'Uppercase' },
                              { value: 'prefix', label: 'Add Prefix' },
                              { value: 'suffix', label: 'Add Suffix' },
                            ]}
                          />
                          {(extractor.transform_type === 'prefix' || extractor.transform_type === 'suffix') && (
                            <Input
                              label="Transform Value"
                              value={extractor.transform_value || ''}
                              onChange={(e) => handleUpdateExtractor(index, { transform_value: e.target.value })}
                              placeholder="Value to add"
                            />
                          )}
                          <div className="flex items-end">
                            <Checkbox
                              label="Required (fail if not found)"
                              checked={extractor.required}
                              onChange={(e) => handleUpdateExtractor(index, { required: e.target.checked })}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {enableSessionJar && (
              <div className="border border-blue-200 rounded-lg p-4 bg-blue-50/50">
                <h4 className="font-medium text-blue-800 flex items-center gap-2 mb-4">
                  <Cookie size={18} />
                  Session Jar Configuration
                </h4>

                <Checkbox
                  label="Enable Cookie Mode (auto-carry Set-Cookie headers)"
                  checked={sessionJarConfig.cookie_mode !== false}
                  onChange={(e) => setSessionJarConfig({ ...sessionJarConfig, cookie_mode: e.target.checked })}
                />

                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Body JSON Paths to Carry
                  </label>
                  <p className="text-xs text-gray-500 mb-2">
                    Values at these paths will be extracted and injected into subsequent requests
                  </p>
                  <div className="flex gap-2 mb-2">
                    <Input
                      value={newBodyPath}
                      onChange={(e) => setNewBodyPath(e.target.value)}
                      placeholder="$.content.sessionId"
                      className="flex-1"
                    />
                    <Button onClick={handleAddBodyPath} size="sm">Add</Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(sessionJarConfig.body_json_paths || []).map((path, index) => (
                      <span key={index} className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-blue-200 rounded text-sm">
                        <code>{path}</code>
                        <button onClick={() => handleRemoveBodyPath(index)} className="text-red-500 hover:text-red-700">
                          <X size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Header Keys to Carry
                  </label>
                  <div className="flex gap-2 mb-2">
                    <Input
                      value={newHeaderKey}
                      onChange={(e) => setNewHeaderKey(e.target.value)}
                      placeholder="X-Session-Token"
                      className="flex-1"
                    />
                    <Button onClick={handleAddHeaderKey} size="sm">Add</Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(sessionJarConfig.header_keys || []).map((key, index) => (
                      <span key={index} className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-blue-200 rounded text-sm">
                        {key}
                        <button onClick={() => handleRemoveHeaderKey(index)} className="text-red-500 hover:text-red-700">
                          <X size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {learningError && (
        <div className="fixed bottom-4 right-4 bg-red-100 border border-red-300 text-red-800 px-4 py-3 rounded-lg shadow-lg max-w-md z-50">
          <div className="flex items-start gap-2">
            <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Learning Failed</p>
              <p className="text-sm">{learningError}</p>
            </div>
            <button onClick={() => setLearningError(null)} className="ml-2 text-red-600 hover:text-red-800">
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {isLearning && (
        <div className="fixed bottom-4 right-4 bg-cyan-100 border border-cyan-300 text-cyan-800 px-4 py-3 rounded-lg shadow-lg z-50">
          <div className="flex items-center gap-2">
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-cyan-600 border-t-transparent"></div>
            <span>Running learning mode...</span>
          </div>
        </div>
      )}

      <Modal
        isOpen={isLearningSelectOpen}
        onClose={() => setIsLearningSelectOpen(false)}
        title="Select Account & Environment for Learning"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Account</label>
            <Select
              value={learningAccountId}
              onChange={(e) => setLearningAccountId(e.target.value)}
              options={[
                { value: '', label: 'Select an account...' },
                ...accounts.map(a => ({ value: a.id, label: a.name }))
              ]}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Environment</label>
            <Select
              value={learningEnvironmentId}
              onChange={(e) => setLearningEnvironmentId(e.target.value)}
              options={[
                { value: '', label: 'Select an environment...' },
                ...environments.map((e: any) => ({ value: e.id, label: e.name }))
              ]}
            />
          </div>

          <div className="flex gap-2 justify-end">
            <Button
              variant="secondary"
              onClick={() => setIsLearningSelectOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirmLearning}
              disabled={!learningAccountId || !learningEnvironmentId}
            >
              Run Learning Mode
            </Button>
          </div>
        </div>
      </Modal>

      <LearningResultsModal
        isOpen={isLearningModalOpen}
        onClose={() => {
          setIsLearningModalOpen(false);
          setLearningResult(null);
        }}
        result={learningResult}
        workflowSteps={learningResult?.stepSnapshots?.map(s => ({ stepOrder: s.stepOrder, name: s.templateName })) || []}
        onApply={handleApplyMappings}
      />

      {variablePoolWorkflow && (
        <VariablePoolManager
          isOpen={isVariablePoolOpen}
          onClose={() => {
            setIsVariablePoolOpen(false);
            setVariablePoolWorkflow(null);
            setVariablePoolSteps([]);
          }}
          workflowId={variablePoolWorkflow.id}
          workflowName={variablePoolWorkflow.name}
          workflowSteps={variablePoolSteps}
        />
      )}

      <Modal
        isOpen={isMutationModalOpen}
        onClose={() => {
          setIsMutationModalOpen(false);
          setMutationName('');
          setEditingMutationWorkflowId(null);
          setEditingMutationId(null);
          setMutationProfile({
            skip_steps: [],
            swap_account_at_steps: {},
            lock_variables: [],
            reuse_tickets: false,
            repeat_steps: {},
            concurrent_replay: undefined,
            parallel_groups: undefined,
          });
          setMutationStepOptions([]);
          setConcurrencyMode('none');
        }}
        title="Create Mutation Profile"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Mutation Name
            </label>
            <Input
              type="text"
              value={mutationName}
              onChange={(e) => setMutationName(e.target.value)}
              placeholder="Enter mutation name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Skip Steps
            </label>
            <div className="space-y-2">
              {mutationStepOptions.map(step => (
                <Checkbox
                  key={step}
                  label={`Step ${step}`}
                  checked={mutationProfile.skip_steps.includes(step)}
                  onChange={(checked) => {
                    if (checked) {
                      setMutationProfile({
                        ...mutationProfile,
                        skip_steps: [...mutationProfile.skip_steps, step],
                      });
                    } else {
                      setMutationProfile({
                        ...mutationProfile,
                        skip_steps: mutationProfile.skip_steps.filter(s => s !== step),
                      });
                    }
                  }}
                />
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Swap Account at Steps
            </label>
            <div className="space-y-3">
              {mutationStepOptions.map(step => (
                <div key={step} className="flex items-center gap-2">
                  <span className="text-sm text-gray-600 w-20">Step {step}:</span>
                  <Select
                    value={mutationProfile.swap_account_at_steps[step] || ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      const updated = { ...mutationProfile.swap_account_at_steps };
                      if (value) {
                        updated[step] = value;
                      } else {
                        delete updated[step];
                      }
                      setMutationProfile({
                        ...mutationProfile,
                        swap_account_at_steps: updated,
                      });
                    }}
                    options={[
                      { label: 'None', value: '' },
                      { label: 'Attacker (dynamic)', value: 'attacker' },
                      { label: 'Victim (dynamic)', value: 'victim' },
                      ...accounts.map(acc => ({ label: acc.name, value: acc.id })),
                    ]}
                  />
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Lock Variables
            </label>
            <Input
              type="text"
              value={mutationProfile.lock_variables.join(', ')}
              onChange={(e) => {
                const vars = e.target.value
                  .split(',')
                  .map(v => v.trim())
                  .filter(v => v);
                setMutationProfile({
                  ...mutationProfile,
                  lock_variables: vars,
                });
              }}
              placeholder="Enter variable names separated by commas"
            />
          </div>

          <div>
            <Checkbox
              label="Reuse Tickets (FLOW_TICKET from baseline)"
              checked={mutationProfile.reuse_tickets}
              onChange={(e) => {
                setMutationProfile({
                  ...mutationProfile,
                  reuse_tickets: e.target.checked,
                });
              }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Repeat Steps
            </label>
            <div className="space-y-2">
              {mutationStepOptions.map(step => (
                <div key={step} className="flex items-center gap-2">
                  <span className="text-sm text-gray-600 w-20">Step {step}:</span>
                  <Input
                    type="number"
                    min="0"
                    max="10"
                    value={mutationProfile.repeat_steps[step] || 0}
                    onChange={(e) => {
                      const count = parseInt(e.target.value, 10) || 0;
                      const updated = { ...mutationProfile.repeat_steps };
                      if (count > 0) {
                        updated[step] = count;
                      } else {
                        delete updated[step];
                      }
                      setMutationProfile({
                        ...mutationProfile,
                        repeat_steps: updated,
                      });
                    }}
                    placeholder="0"
                  />
                  <span className="text-xs text-gray-500">times</span>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t pt-4">
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Concurrency Testing Mode
              </label>
              <div className="flex gap-4">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="concurrency_mode"
                    checked={concurrencyMode === 'none'}
                    onChange={() => {
                      setConcurrencyMode('none');
                      setMutationProfile({
                        ...mutationProfile,
                        concurrent_replay: undefined,
                        parallel_groups: undefined,
                      });
                    }}
                    className="mr-2"
                  />
                  <span className="text-sm">None</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="concurrency_mode"
                    checked={concurrencyMode === 'same_request'}
                    onChange={() => {
                      setConcurrencyMode('same_request');
                      setMutationProfile({
                        ...mutationProfile,
                        concurrent_replay: {
                          step_order: mutationStepOptions[0] || 1,
                          concurrency: 5,
                          barrier: true,
                          timeout_ms: 5000,
                          pick_primary: 'first_success',
                        },
                        parallel_groups: undefined,
                      });
                    }}
                    className="mr-2"
                  />
                  <span className="text-sm">Same Request (Concurrent Replay)</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="concurrency_mode"
                    checked={concurrencyMode === 'multi_request'}
                    onChange={() => {
                      setConcurrencyMode('multi_request');
                      setMutationProfile({
                        ...mutationProfile,
                        concurrent_replay: undefined,
                        parallel_groups: [{
                          anchor_step_order: mutationStepOptions[0] || 1,
                          barrier: true,
                          timeout_ms: 5000,
                          extras: [],
                          writeback_policy: 'primary_only',
                        }],
                      });
                    }}
                    className="mr-2"
                  />
                  <span className="text-sm">Multi-Request (Parallel Group)</span>
                </label>
              </div>
            </div>

            {mutationProfile.concurrent_replay && (
              <div className="pl-6 space-y-3 border-l-2 border-blue-200">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Step to Replay Concurrently
                  </label>
                  <Select
                    value={mutationProfile.concurrent_replay.step_order.toString()}
                    onChange={(e) => {
                      const value = e.target.value;
                      setMutationProfile({
                        ...mutationProfile,
                        concurrent_replay: {
                          ...mutationProfile.concurrent_replay!,
                          step_order: parseInt(value, 10),
                        },
                      });
                    }}
                    options={mutationStepOptions.map((step) => ({
                      label: `Step ${step}`,
                      value: step.toString(),
                    }))}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Concurrency (Number of Parallel Requests)
                  </label>
                  <Input
                    type="number"
                    min="2"
                    max="50"
                    value={mutationProfile.concurrent_replay.concurrency}
                    onChange={(e) => {
                      const concurrency = Math.max(2, Math.min(50, parseInt(e.target.value, 10) || 5));
                      setMutationProfile({
                        ...mutationProfile,
                        concurrent_replay: {
                          ...mutationProfile.concurrent_replay!,
                          concurrency,
                        },
                      });
                    }}
                    placeholder="5"
                  />
                  <p className="text-xs text-gray-500 mt-1">Between 2 and 50 concurrent requests</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Timeout (milliseconds)
                  </label>
                  <Input
                    type="number"
                    min="100"
                    max="60000"
                    value={mutationProfile.concurrent_replay.timeout_ms || 5000}
                    onChange={(e) => {
                      const timeout = Math.max(100, parseInt(e.target.value, 10) || 5000);
                      setMutationProfile({
                        ...mutationProfile,
                        concurrent_replay: {
                          ...mutationProfile.concurrent_replay!,
                          timeout_ms: timeout,
                        },
                      });
                    }}
                    placeholder="5000"
                  />
                </div>

                <div>
                  <Checkbox
                    label="Use Barrier (All requests start simultaneously)"
                    checked={mutationProfile.concurrent_replay.barrier !== false}
                    onChange={(e) => {
                      setMutationProfile({
                        ...mutationProfile,
                        concurrent_replay: {
                          ...mutationProfile.concurrent_replay!,
                          barrier: e.target.checked,
                        },
                      });
                    }}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Primary Response Selection
                  </label>
                  <Select
                    value={mutationProfile.concurrent_replay.pick_primary || 'first_success'}
                    onChange={(e) => {
                      setMutationProfile({
                        ...mutationProfile,
                        concurrent_replay: {
                          ...mutationProfile.concurrent_replay!,
                          pick_primary: e.target.value as 'first_success' | 'first' | 'majority_success',
                        },
                      });
                    }}
                    options={[
                      { label: 'First Successful (2xx)', value: 'first_success' },
                      { label: 'First Response', value: 'first' },
                      { label: 'Majority Success', value: 'majority_success' },
                    ]}
                  />
                </div>
              </div>
            )}

            {mutationProfile.parallel_groups && mutationProfile.parallel_groups.length > 0 && (
              <div className="pl-6 space-y-4 border-l-2 border-green-200">
                {mutationProfile.parallel_groups.map((group, groupIdx) => (
                  <div key={groupIdx} className="space-y-3 p-4 bg-gray-50 rounded">
                    <div className="flex justify-between items-center">
                      <h4 className="text-sm font-semibold text-gray-700">Parallel Group #{groupIdx + 1}</h4>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...mutationProfile.parallel_groups!];
                          updated.splice(groupIdx, 1);
                          setMutationProfile({
                            ...mutationProfile,
                            parallel_groups: updated.length > 0 ? updated : undefined,
                          });
                          if (updated.length === 0) {
                            setConcurrencyMode('none');
                          }
                        }}
                        className="text-red-600 hover:text-red-800"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Anchor Step (Main Request)
                      </label>
                      <Select
                        value={group.anchor_step_order.toString()}
                        onChange={(e) => {
                          const updated = [...mutationProfile.parallel_groups!];
                          updated[groupIdx] = {
                            ...updated[groupIdx],
                            anchor_step_order: parseInt(e.target.value, 10),
                          };
                          setMutationProfile({
                            ...mutationProfile,
                            parallel_groups: updated,
                          });
                        }}
                        options={mutationStepOptions.map((step) => ({
                          label: `Step ${step}`,
                          value: step.toString(),
                        }))}
                      />
                    </div>

                    <div className="flex gap-4">
                      <div className="flex-1">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Timeout (ms)
                        </label>
                        <Input
                          type="number"
                          min="100"
                          value={group.timeout_ms || 5000}
                          onChange={(e) => {
                            const updated = [...mutationProfile.parallel_groups!];
                            updated[groupIdx] = {
                              ...updated[groupIdx],
                              timeout_ms: Math.max(100, parseInt(e.target.value, 10) || 5000),
                            };
                            setMutationProfile({
                              ...mutationProfile,
                              parallel_groups: updated,
                            });
                          }}
                          placeholder="5000"
                        />
                      </div>
                      <div className="flex items-end">
                        <Checkbox
                          label="Use Barrier"
                          checked={group.barrier !== false}
                          onChange={(checked) => {
                            const updated = [...mutationProfile.parallel_groups!];
                            updated[groupIdx] = {
                              ...updated[groupIdx],
                              barrier: checked,
                            };
                            setMutationProfile({
                              ...mutationProfile,
                              parallel_groups: updated,
                            });
                          }}
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Extra Requests (Parallel Execution)
                      </label>
                      <div className="space-y-2">
                        {group.extras.map((extra, extraIdx) => (
                          <div key={extraIdx} className="flex items-center gap-2 p-2 bg-white rounded border">
                            <span className="flex-1 text-sm">{extra.name}</span>
                            <span className="text-xs text-gray-500">{extra.snapshot_template_name}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const updated = [...mutationProfile.parallel_groups!];
                                updated[groupIdx].extras.splice(extraIdx, 1);
                                setMutationProfile({
                                  ...mutationProfile,
                                  parallel_groups: updated,
                                });
                              }}
                              className="text-red-600 hover:text-red-800"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                        <Button
                          variant="secondary"
                          onClick={() => {
                            const templateId = prompt('Select Template ID (from templates list):');
                            if (!templateId) return;

                            const template = templates.find(t => t.id === templateId);
                            if (!template) {
                              alert('Template not found');
                              return;
                            }

                            const extraName = prompt('Extra Request Name:', template.name);
                            if (!extraName) return;

                            const updated = [...mutationProfile.parallel_groups!];
                            updated[groupIdx].extras.push({
                              kind: 'extra',
                              name: extraName,
                              snapshot_template_id: template.id,
                              snapshot_template_name: template.name,
                              request_snapshot_raw: template.raw_request,
                            });
                            setMutationProfile({
                              ...mutationProfile,
                              parallel_groups: updated,
                            });
                          }}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add Extra Request
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2 justify-end pt-4 border-t">
            <Button
              variant="secondary"
              onClick={() => {
                setIsMutationModalOpen(false);
                setMutationName('');
                setEditingMutationWorkflowId(null);
                setEditingMutationId(null);
                setMutationProfile({
                  skip_steps: [],
                  swap_account_at_steps: {},
                  lock_variables: [],
                  reuse_tickets: false,
                  repeat_steps: {},
                  concurrent_replay: undefined,
                  parallel_groups: undefined,
                });
                setMutationStepOptions([]);
                setConcurrencyMode('none');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveMutation}
              disabled={
                !mutationName.trim() ||
                (concurrencyMode === 'multi_request' &&
                  (!mutationProfile.parallel_groups ||
                    mutationProfile.parallel_groups.length === 0 ||
                    mutationProfile.parallel_groups[0].extras.length === 0))
              }
            >
              Create Mutation
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
