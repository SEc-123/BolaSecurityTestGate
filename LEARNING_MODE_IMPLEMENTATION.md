# Workflow Learning Mode Implementation Guide

This document provides a complete implementation plan for the Baseline Learning Mode + Workflow Variable Pool + Mutation Execution system.

## System Overview

The learning mode system transforms workflows from simple sequential API calls into intelligent, self-learning test frameworks that can:
1. **Learn** variable dependencies automatically from baseline executions
2. **Store** and manage variables in a workflow-scoped variable pool
3. **Execute** mutations (modified versions) with account swapping, step skipping, and baseline comparison

## Architecture Decisions

### 1. Data Storage Strategy
- **Local Backend**: Primary implementation in SQLite/PostgreSQL via local server
- **Supabase**: Optional sync (current Supabase schema is outdated)
- **Snapshots**: Workflows use template snapshots (not references) to prevent pollution

### 2. Variable Priority Order
```
1. IDENTITY (from account binding strategy) - HIGHEST PRIORITY
2. WORKFLOW VARIABLE POOL (learned or manual)
3. TEMPLATE DEFAULT VALUES - LOWEST PRIORITY
```

### 3. Learning Mode Constraints
- Only `workflow_type='baseline'` can enter learning mode
- Mutation workflows READ variable schema from their baseline
- Learning runs use fixed account (no combinations)
- Confidence scores guide but don't auto-apply mappings

---

## Phase 1: Database Schema Extensions

### Migration 1: Workflow Enhancements

```sql
-- Add to server/src/db/schema.ts types
export interface Workflow {
  id: string;
  name: string;
  description?: string;
  is_active: boolean;

  // NEW FIELDS
  workflow_type: 'baseline' | 'mutation';
  base_workflow_id?: string;  // For mutations, points to baseline
  learning_status: 'unlearned' | 'learned';
  learning_version: number;  // Increments on each learn
  template_mode: 'reference' | 'snapshot';
  mutation_profile?: {
    skip_steps?: number[];
    swap_account_at_steps?: Record<number, 'attacker' | 'victim'>;
    lock_variables?: string[];
    reuse_tickets?: boolean;
    repeat_steps?: Record<number, number>;
  };

  // Existing fields
  assertion_strategy?: string;
  critical_step_orders?: number[];
  account_binding_strategy?: string;
  attacker_account_id?: string;
  enable_baseline?: boolean;
  baseline_config?: any;
  enable_extractor?: boolean;
  enable_session_jar?: boolean;
  session_jar_config?: any;
  created_at: string;
  updated_at: string;
}

export interface WorkflowStep {
  id: string;
  workflow_id: string;
  api_template_id: string;
  step_order: number;
  step_assertions?: any[];
  assertions_mode?: string;
  failure_patterns_override?: any[];

  // NEW SNAPSHOT FIELDS
  request_snapshot_raw?: string;
  parsed_snapshot?: any;
  failure_patterns_snapshot?: any[];
  snapshot_template_name?: string;
  snapshot_template_id?: string;
  snapshot_created_at?: string;

  created_at: string;
}
```

### Migration 2: Workflow Variable Pool

```sql
-- New table: workflow_variables
CREATE TABLE workflow_variables (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,  -- e.g., 'auth.token', 'flow.challengeId', 'obj.orderId'
  type TEXT NOT NULL CHECK (type IN ('IDENTITY', 'FLOW_TICKET', 'OBJECT_ID', 'GENERIC')),
  source TEXT NOT NULL CHECK (source IN ('account_injected', 'extracted', 'manual')),
  write_policy TEXT NOT NULL DEFAULT 'first' CHECK (write_policy IN ('first', 'overwrite', 'on_success_only')),
  is_locked BOOLEAN DEFAULT false,
  description TEXT,
  current_value TEXT,  -- Serialized value for debugging
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(workflow_id, name)
);

CREATE INDEX idx_workflow_variables_workflow ON workflow_variables(workflow_id);
CREATE INDEX idx_workflow_variables_type ON workflow_variables(type);
```

### Migration 3: Workflow Mappings

```sql
-- New table: workflow_mappings
CREATE TABLE workflow_mappings (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,

  -- Source (response)
  from_step_order INTEGER NOT NULL,
  from_location TEXT NOT NULL CHECK (from_location IN ('response.body', 'response.header', 'response.cookie')),
  from_path TEXT NOT NULL,  -- JSONPath or key

  -- Target (request)
  to_step_order INTEGER NOT NULL,
  to_location TEXT NOT NULL CHECK (to_location IN ('request.body', 'request.header', 'request.cookie', 'request.query', 'request.path')),
  to_path TEXT NOT NULL,

  -- Variable connection
  variable_name TEXT NOT NULL,  -- References workflow_variables.name

  -- Metadata
  confidence REAL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  reason TEXT CHECK (reason IN ('same_name', 'same_value', 'heuristic', 'manual')),
  is_enabled BOOLEAN DEFAULT true,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (workflow_id, variable_name) REFERENCES workflow_variables(workflow_id, name) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_mappings_workflow ON workflow_mappings(workflow_id);
CREATE INDEX idx_workflow_mappings_from_step ON workflow_mappings(workflow_id, from_step_order);
CREATE INDEX idx_workflow_mappings_to_step ON workflow_mappings(workflow_id, to_step_order);
CREATE INDEX idx_workflow_mappings_variable ON workflow_mappings(workflow_id, variable_name);
```

### Migration 4: Field Dictionary

```sql
-- New table: field_dictionary
CREATE TABLE field_dictionary (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  scope_id TEXT,  -- NULL for global, project_id for project

  pattern TEXT NOT NULL,  -- Field name or regex, e.g., '(?i)authorization|access[_-]?token'
  category TEXT NOT NULL CHECK (category IN ('IDENTITY', 'FLOW_TICKET', 'OBJECT_ID', 'NOISE')),
  priority INTEGER DEFAULT 0,  -- Higher = checked first
  is_enabled BOOLEAN DEFAULT true,
  notes TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_field_dictionary_enabled ON field_dictionary(is_enabled, priority DESC) WHERE is_enabled = true;
CREATE INDEX idx_field_dictionary_scope ON field_dictionary(scope, scope_id);

-- Insert default rules
INSERT INTO field_dictionary (id, scope, pattern, category, priority, notes) VALUES
  ('dict_001', 'global', '(?i)^(authorization|access_token|auth_token|bearer|x-auth-token)$', 'IDENTITY', 100, 'Common auth headers'),
  ('dict_002', 'global', '(?i)^(token|jwt|session_id|session)$', 'IDENTITY', 90, 'Session tokens'),
  ('dict_003', 'global', '(?i)^(user_id|userid|uid|account_id)$', 'OBJECT_ID', 80, 'User identifiers'),
  ('dict_004', 'global', '(?i)^(order_id|orderid|transaction_id|txn_id)$', 'OBJECT_ID', 70, 'Business object IDs'),
  ('dict_005', 'global', '(?i)^(challenge_id|nonce|csrf_token|state)$', 'FLOW_TICKET', 60, 'Flow control tokens'),
  ('dict_006', 'global', '(?i)^(timestamp|time|date|created_at|updated_at)$', 'NOISE', 50, 'Temporal noise'),
  ('dict_007', 'global', '(?i)^(request_id|trace_id|span_id|correlation_id)$', 'NOISE', 50, 'Tracing noise'),
  ('dict_008', 'global', '(?i)^(message|msg|success|status|code|error)$', 'NOISE', 40, 'Status fields');
```

---

## Phase 2: Backend Services

### Service 1: Learning Algorithm

**File**: `server/src/services/learning-engine.ts`

```typescript
export interface CandidateField {
  path: string;
  value: any;
  valuePreview: string;  // Masked/truncated
  predictedType: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC';
  score: number;  // 0-100
  reason: string;
}

export interface MappingCandidate {
  fromStep: number;
  fromLocation: string;
  fromPath: string;
  toStep: number;
  toLocation: string;
  toPath: string;
  predictedType: string;
  confidence: number;  // 0-1
  reason: 'same_name' | 'same_value' | 'heuristic';
  sampleValue?: string;
}

export interface LearningResult {
  workflowId: string;
  responseFields: Record<number, CandidateField[]>;  // stepOrder -> fields
  requestFields: Record<number, {path: string; location: string}[]>;
  mappingCandidates: MappingCandidate[];
  metadata: {
    totalCandidates: number;
    autoMappable: number;
    requiresReview: number;
    durationMs: number;
  };
}

export class LearningEngine {
  constructor(private db: DatabaseProvider, private dictionary: FieldDictionary) {}

  /**
   * Run learning mode on a baseline workflow
   * Executes workflow once with fixed account, analyzes responses
   */
  async runLearningMode(workflowId: string, accountId: string): Promise<LearningResult> {
    const workflow = await this.db.repos.workflows.findById(workflowId);
    if (!workflow || workflow.workflow_type !== 'baseline') {
      throw new Error('Only baseline workflows can run learning mode');
    }

    // Execute workflow and capture request/response pairs
    const execution = await this.executeForLearning(workflow, accountId);

    // Extract candidate fields from responses
    const responseFields = this.extractResponseCandidates(execution.steps);

    // Extract request fields
    const requestFields = this.extractRequestFields(execution.steps);

    // Generate mapping candidates
    const mappingCandidates = this.generateMappings(execution.steps, responseFields, requestFields);

    return {
      workflowId,
      responseFields,
      requestFields,
      mappingCandidates,
      metadata: {
        totalCandidates: mappingCandidates.length,
        autoMappable: mappingCandidates.filter(c => c.confidence > 0.8).length,
        requiresReview: mappingCandidates.filter(c => c.confidence <= 0.8).length,
        durationMs: Date.now() - execution.startTime,
      },
    };
  }

  /**
   * Extract candidate fields from response with scoring
   */
  private extractResponseCandidates(steps: StepExecution[]): Record<number, CandidateField[]> {
    const result: Record<number, CandidateField[]> = {};

    for (const step of steps) {
      const candidates: CandidateField[] = [];

      // Parse response body
      let body: any;
      try {
        body = JSON.parse(step.response.body);
      } catch {
        continue;  // Skip non-JSON responses
      }

      // Flatten JSON to path-value pairs
      const flattened = this.flattenJson(body);

      for (const [path, value] of Object.entries(flattened)) {
        // Filter noise
        if (this.isNoiseField(path, value)) continue;

        // Score and categorize
        const { type, score, reason } = this.scoreField(path, value);

        candidates.push({
          path,
          value,
          valuePreview: this.maskValue(value, type),
          predictedType: type,
          score,
          reason,
        });
      }

      // Sort by score and take top N
      result[step.step_order] = candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);
    }

    return result;
  }

  /**
   * Generate mapping candidates between adjacent steps
   */
  private generateMappings(
    steps: StepExecution[],
    responseFields: Record<number, CandidateField[]>,
    requestFields: Record<number, {path: string; location: string}[]>
  ): MappingCandidate[] {
    const candidates: MappingCandidate[] = [];

    for (let i = 0; i < steps.length - 1; i++) {
      const currentStep = steps[i];
      const nextStep = steps[i + 1];

      const responseCandidates = responseFields[currentStep.step_order] || [];
      const nextRequests = requestFields[nextStep.step_order] || [];

      // Same-name matching
      for (const respField of responseCandidates) {
        for (const reqField of nextRequests) {
          const normalizedRespKey = this.normalizeKey(this.getLastSegment(respField.path));
          const normalizedReqKey = this.normalizeKey(this.getLastSegment(reqField.path));

          if (normalizedRespKey === normalizedReqKey) {
            candidates.push({
              fromStep: currentStep.step_order,
              fromLocation: 'response.body',
              fromPath: respField.path,
              toStep: nextStep.step_order,
              toLocation: reqField.location,
              toPath: reqField.path,
              predictedType: respField.predictedType,
              confidence: 0.9,
              reason: 'same_name',
              sampleValue: respField.valuePreview,
            });
          }
        }
      }

      // Same-value matching (for renamed fields)
      const requestValues = this.extractRequestValues(nextStep.request_resolved);
      for (const respField of responseCandidates) {
        for (const [reqPath, reqLocation, reqValue] of requestValues) {
          if (this.valuesMatch(respField.value, reqValue)) {
            // Check if already have same-name match
            const hasSameName = candidates.some(
              c => c.fromPath === respField.path && c.toPath === reqPath
            );
            if (!hasSameName) {
              candidates.push({
                fromStep: currentStep.step_order,
                fromLocation: 'response.body',
                fromPath: respField.path,
                toStep: nextStep.step_order,
                toLocation: reqLocation,
                toPath: reqPath,
                predictedType: respField.predictedType,
                confidence: 0.7,
                reason: 'same_value',
                sampleValue: respField.valuePreview,
              });
            }
          }
        }
      }
    }

    return candidates.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Score a field based on dictionary and heuristics
   */
  private scoreField(path: string, value: any): {type: string; score: number; reason: string} {
    let score = 0;
    let type: string = 'GENERIC';
    let reason = 'heuristic';

    const key = this.getLastSegment(path);

    // Check dictionary
    const dictMatch = this.dictionary.match(key);
    if (dictMatch) {
      if (dictMatch.category !== 'NOISE') {
        type = dictMatch.category;
        score += dictMatch.priority;
        reason = `matched_dict:${dictMatch.pattern}`;
      } else {
        return { type: 'NOISE', score: -100, reason: 'dictionary_noise' };
      }
    }

    // Value heuristics
    const valueStr = String(value);
    if (this.isJWT(valueStr)) {
      score += 50;
      if (type === 'GENERIC') type = 'IDENTITY';
    } else if (this.isUUID(valueStr)) {
      score += 40;
      if (type === 'GENERIC') type = 'OBJECT_ID';
    } else if (this.isHex(valueStr) && valueStr.length >= 16) {
      score += 30;
    }

    // Path depth bonus (shallower = more important)
    const depth = path.split('.').length;
    score += Math.max(0, 20 - depth * 5);

    return { type, score, reason };
  }

  private isNoiseField(path: string, value: any): boolean {
    const key = this.getLastSegment(path);
    const dictMatch = this.dictionary.match(key);
    if (dictMatch?.category === 'NOISE') return true;

    // Value-based noise detection
    const valueStr = String(value);
    if (valueStr.length < 3 || valueStr.length > 2000) return true;

    return false;
  }

  private flattenJson(obj: any, prefix = ''): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(result, this.flattenJson(value, path));
      } else if (typeof value !== 'object') {  // Only scalars
        result[path] = value;
      }
    }
    return result;
  }

  private normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[_-]/g, '');
  }

  private getLastSegment(path: string): string {
    return path.split('.').pop() || path;
  }

  private maskValue(value: any, type: string): string {
    const str = String(value);
    if (type === 'IDENTITY' && str.length > 20) {
      return str.substring(0, 10) + '...' + str.substring(str.length - 6);
    }
    if (str.length > 50) {
      return str.substring(0, 50) + '...';
    }
    return str;
  }

  private isJWT(value: string): boolean {
    return /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(value);
  }

  private isUUID(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  private isHex(value: string): boolean {
    return /^[0-9a-f]+$/i.test(value);
  }

  private valuesMatch(v1: any, v2: any): boolean {
    // Strict equality for now; could add fuzzy matching
    return v1 === v2;
  }
}
```

### Service 2: Field Dictionary

**File**: `server/src/services/field-dictionary.ts`

```typescript
export interface DictionaryRule {
  id: string;
  scope: 'global' | 'project';
  scope_id?: string;
  pattern: string;
  category: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'NOISE';
  priority: number;
  is_enabled: boolean;
  notes?: string;
}

export class FieldDictionary {
  private rules: DictionaryRule[] = [];
  private compiledPatterns: Map<string, RegExp> = new Map();

  constructor(private db: DatabaseProvider) {}

  async load(scope: 'global' | 'project' = 'global', scopeId?: string): Promise<void> {
    const query = scope === 'global'
      ? `SELECT * FROM field_dictionary WHERE scope = 'global' AND is_enabled = 1 ORDER BY priority DESC`
      : `SELECT * FROM field_dictionary WHERE (scope = 'global' OR (scope = 'project' AND scope_id = ?)) AND is_enabled = 1 ORDER BY priority DESC`;

    this.rules = scope === 'global'
      ? await this.db.execute(query)
      : await this.db.execute(query, [scopeId]);

    // Precompile regex patterns
    for (const rule of this.rules) {
      try {
        this.compiledPatterns.set(rule.id, new RegExp(rule.pattern));
      } catch (e) {
        console.warn(`Invalid regex pattern in dictionary rule ${rule.id}: ${rule.pattern}`);
      }
    }
  }

  match(fieldName: string): DictionaryRule | null {
    for (const rule of this.rules) {
      const regex = this.compiledPatterns.get(rule.id);
      if (regex && regex.test(fieldName)) {
        return rule;
      }
    }
    return null;
  }

  async addRule(rule: Omit<DictionaryRule, 'id'>): Promise<DictionaryRule> {
    const id = `dict_${Date.now()}`;
    const newRule = { ...rule, id };
    await this.db.execute(
      `INSERT INTO field_dictionary (id, scope, scope_id, pattern, category, priority, is_enabled, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newRule.id, newRule.scope, newRule.scope_id, newRule.pattern, newRule.category, newRule.priority, newRule.is_enabled ? 1 : 0, newRule.notes]
    );
    await this.load(rule.scope, rule.scope_id);
    return newRule;
  }

  async updateRule(id: string, updates: Partial<DictionaryRule>): Promise<void> {
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (key !== 'id') {
        setClauses.push(`${key} = ?`);
        values.push(key === 'is_enabled' ? (value ? 1 : 0) : value);
      }
    }

    values.push(id);
    await this.db.execute(
      `UPDATE field_dictionary SET ${setClauses.join(', ')} WHERE id = ?`,
      values
    );
    await this.load();
  }

  async deleteRule(id: string): Promise<void> {
    await this.db.execute(`DELETE FROM field_dictionary WHERE id = ?`, [id]);
    await this.load();
  }
}
```

### Service 3: Variable Pool Manager

**File**: `server/src/services/variable-pool.ts`

```typescript
export interface WorkflowVariable {
  id: string;
  workflow_id: string;
  name: string;
  type: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC';
  source: 'account_injected' | 'extracted' | 'manual';
  write_policy: 'first' | 'overwrite' | 'on_success_only';
  is_locked: boolean;
  description?: string;
  current_value?: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowMapping {
  id: string;
  workflow_id: string;
  from_step_order: number;
  from_location: string;
  from_path: string;
  to_step_order: number;
  to_location: string;
  to_path: string;
  variable_name: string;
  confidence: number;
  reason: string;
  is_enabled: boolean;
  created_at: string;
}

export class VariablePoolManager {
  private variables: Map<string, any> = new Map();  // Runtime values

  constructor(
    private db: DatabaseProvider,
    private workflowId: string
  ) {}

  /**
   * Load variable definitions from database
   */
  async load(): Promise<void> {
    const vars = await this.db.execute<WorkflowVariable>(
      `SELECT * FROM workflow_variables WHERE workflow_id = ?`,
      [this.workflowId]
    );

    for (const v of vars) {
      if (v.current_value) {
        try {
          this.variables.set(v.name, JSON.parse(v.current_value));
        } catch {
          this.variables.set(v.name, v.current_value);
        }
      }
    }
  }

  /**
   * Write a variable value (respects write_policy)
   */
  async writeVariable(name: string, value: any, wasSuccessful: boolean = true): Promise<void> {
    const varDef = await this.getVariableDefinition(name);
    if (!varDef) {
      throw new Error(`Variable ${name} not defined in workflow ${this.workflowId}`);
    }

    if (varDef.is_locked) {
      return;  // Locked variables cannot be written
    }

    const currentValue = this.variables.get(name);

    switch (varDef.write_policy) {
      case 'first':
        if (currentValue === undefined) {
          this.variables.set(name, value);
        }
        break;
      case 'overwrite':
        this.variables.set(name, value);
        break;
      case 'on_success_only':
        if (wasSuccessful) {
          this.variables.set(name, value);
        }
        break;
    }
  }

  /**
   * Read a variable value
   */
  readVariable(name: string): any {
    return this.variables.get(name);
  }

  /**
   * Inject variables into a request before sending
   */
  async injectIntoRequest(stepOrder: number, request: any): Promise<any> {
    const mappings = await this.db.execute<WorkflowMapping>(
      `SELECT * FROM workflow_mappings
       WHERE workflow_id = ? AND to_step_order = ? AND is_enabled = 1`,
      [this.workflowId, stepOrder]
    );

    for (const mapping of mappings) {
      const value = this.readVariable(mapping.variable_name);
      if (value === undefined) continue;

      // Apply to request based on location
      request = this.applyValueToRequest(request, mapping.to_location, mapping.to_path, value);
    }

    return request;
  }

  /**
   * Extract variables from a response after receiving
   */
  async extractFromResponse(stepOrder: number, response: any, wasSuccessful: boolean): Promise<void> {
    const mappings = await this.db.execute<WorkflowMapping>(
      `SELECT * FROM workflow_mappings
       WHERE workflow_id = ? AND from_step_order = ? AND is_enabled = 1`,
      [this.workflowId, stepOrder]
    );

    for (const mapping of mappings) {
      const value = this.extractValueFromResponse(response, mapping.from_location, mapping.from_path);
      if (value !== undefined) {
        await this.writeVariable(mapping.variable_name, value, wasSuccessful);
      }
    }
  }

  private applyValueToRequest(request: any, location: string, path: string, value: any): any {
    // Implementation depends on request structure
    if (location === 'request.header') {
      request.headers[path] = value;
    } else if (location === 'request.body') {
      this.setNestedValue(request.body, path, value);
    } else if (location === 'request.query') {
      request.query[path] = value;
    }
    // ... etc
    return request;
  }

  private extractValueFromResponse(response: any, location: string, path: string): any {
    if (location === 'response.body') {
      return this.getNestedValue(response.body, path);
    } else if (location === 'response.header') {
      return response.headers[path];
    }
    // ... etc
    return undefined;
  }

  private setNestedValue(obj: any, path: string, value: any): void {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  private getNestedValue(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current == null) return undefined;
      current = current[part];
    }
    return current;
  }

  private async getVariableDefinition(name: string): Promise<WorkflowVariable | null> {
    const results = await this.db.execute<WorkflowVariable>(
      `SELECT * FROM workflow_variables WHERE workflow_id = ? AND name = ?`,
      [this.workflowId, name]
    );
    return results[0] || null;
  }
}
```

---

## Phase 3: Backend API Routes

**File**: `server/src/routes/learning.ts` (NEW)

```typescript
import { Router } from 'express';
import { dbManager } from '../db/db-manager.js';
import { LearningEngine } from '../services/learning-engine.js';
import { FieldDictionary } from '../services/field-dictionary.js';

const router = Router();

// Run learning mode on a baseline workflow
router.post('/workflows/:id/learn', async (req, res) => {
  try {
    const { id } = req.params;
    const { account_id } = req.body;

    if (!account_id) {
      res.status(400).json({ data: null, error: 'account_id is required' });
      return;
    }

    const db = dbManager.getActive();
    const dictionary = new FieldDictionary(db);
    await dictionary.load();

    const engine = new LearningEngine(db, dictionary);
    const result = await engine.runLearningMode(id, account_id);

    res.json({ data: result, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

// Apply learning results (save mappings and variables)
router.post('/workflows/:id/mappings/apply', async (req, res) => {
  try {
    const { id } = req.params;
    const { mappings, variables } = req.body;

    const db = dbManager.getActive();

    // Start transaction
    // 1. Create/update workflow variables
    for (const variable of variables) {
      // Insert or update
      await db.execute(
        `INSERT INTO workflow_variables (id, workflow_id, name, type, source, write_policy, is_locked, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workflow_id, name) DO UPDATE SET
         type = excluded.type, description = excluded.description, updated_at = CURRENT_TIMESTAMP`,
        [
          variable.id || `var_${Date.now()}_${Math.random()}`,
          id,
          variable.name,
          variable.type,
          variable.source || 'extracted',
          variable.write_policy || 'first',
          variable.is_locked ? 1 : 0,
          variable.description
        ]
      );
    }

    // 2. Create mappings
    for (const mapping of mappings) {
      await db.execute(
        `INSERT INTO workflow_mappings (
          id, workflow_id, from_step_order, from_location, from_path,
          to_step_order, to_location, to_path, variable_name,
          confidence, reason, is_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `map_${Date.now()}_${Math.random()}`,
          id,
          mapping.fromStep,
          mapping.fromLocation,
          mapping.fromPath,
          mapping.toStep,
          mapping.toLocation,
          mapping.toPath,
          mapping.variableName,
          mapping.confidence,
          mapping.reason,
          1
        ]
      );
    }

    // 3. Update workflow learning status
    await db.execute(
      `UPDATE workflows
       SET learning_status = 'learned',
           learning_version = learning_version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [id]
    );

    res.json({ data: { success: true, variablesCreated: variables.length, mappingsCreated: mappings.length }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

// Get workflow variables
router.get('/workflows/:id/variables', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const variables = await db.execute(
      `SELECT * FROM workflow_variables WHERE workflow_id = ? ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ data: variables, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

// CRUD for variables
router.post('/workflows/:id/variables', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const id = `var_${Date.now()}`;
    await db.execute(
      `INSERT INTO workflow_variables (id, workflow_id, name, type, source, write_policy, is_locked, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, req.body.name, req.body.type, req.body.source, req.body.write_policy, req.body.is_locked ? 1 : 0, req.body.description]
    );
    res.status(201).json({ data: { id, ...req.body }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.put('/workflows/:workflowId/variables/:varId', async (req, res) => {
  try {
    const db = dbManager.getActive();
    await db.execute(
      `UPDATE workflow_variables SET name = ?, type = ?, write_policy = ?, is_locked = ?, description = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND workflow_id = ?`,
      [req.body.name, req.body.type, req.body.write_policy, req.body.is_locked ? 1 : 0, req.body.description, req.params.varId, req.params.workflowId]
    );
    res.json({ data: { id: req.params.varId, ...req.body }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.delete('/workflows/:workflowId/variables/:varId', async (req, res) => {
  try {
    const db = dbManager.getActive();
    await db.execute(`DELETE FROM workflow_variables WHERE id = ? AND workflow_id = ?`, [req.params.varId, req.params.workflowId]);
    res.json({ data: { success: true }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

// Get workflow mappings
router.get('/workflows/:id/mappings', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const mappings = await db.execute(
      `SELECT * FROM workflow_mappings WHERE workflow_id = ? ORDER BY from_step_order, to_step_order`,
      [req.params.id]
    );
    res.json({ data: mappings, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

// CRUD for mappings
router.post('/workflows/:id/mappings', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const id = `map_${Date.now()}`;
    const m = req.body;
    await db.execute(
      `INSERT INTO workflow_mappings (
        id, workflow_id, from_step_order, from_location, from_path,
        to_step_order, to_location, to_path, variable_name, confidence, reason, is_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, m.from_step_order, m.from_location, m.from_path, m.to_step_order, m.to_location, m.to_path, m.variable_name, m.confidence || 1.0, m.reason || 'manual', m.is_enabled !== false ? 1 : 0]
    );
    res.status(201).json({ data: { id, ...m }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.put('/workflows/:workflowId/mappings/:mappingId', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const m = req.body;
    await db.execute(
      `UPDATE workflow_mappings SET
        from_step_order = ?, from_location = ?, from_path = ?,
        to_step_order = ?, to_location = ?, to_path = ?,
        variable_name = ?, confidence = ?, reason = ?, is_enabled = ?
       WHERE id = ? AND workflow_id = ?`,
      [m.from_step_order, m.from_location, m.from_path, m.to_step_order, m.to_location, m.to_path, m.variable_name, m.confidence, m.reason, m.is_enabled ? 1 : 0, req.params.mappingId, req.params.workflowId]
    );
    res.json({ data: { id: req.params.mappingId, ...m }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.delete('/workflows/:workflowId/mappings/:mappingId', async (req, res) => {
  try {
    const db = dbManager.getActive();
    await db.execute(`DELETE FROM workflow_mappings WHERE id = ? AND workflow_id = ?`, [req.params.mappingId, req.params.workflowId]);
    res.json({ data: { success: true }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

// Field Dictionary CRUD
router.get('/dictionary', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const { scope = 'global', scope_id } = req.query;
    const query = scope === 'global'
      ? `SELECT * FROM field_dictionary WHERE scope = 'global' ORDER BY priority DESC, created_at DESC`
      : `SELECT * FROM field_dictionary WHERE (scope = 'global' OR (scope = 'project' AND scope_id = ?)) ORDER BY priority DESC, created_at DESC`;
    const rules = scope === 'global'
      ? await db.execute(query)
      : await db.execute(query, [scope_id]);
    res.json({ data: rules, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/dictionary', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const id = `dict_${Date.now()}`;
    const r = req.body;
    await db.execute(
      `INSERT INTO field_dictionary (id, scope, scope_id, pattern, category, priority, is_enabled, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, r.scope, r.scope_id, r.pattern, r.category, r.priority || 0, r.is_enabled !== false ? 1 : 0, r.notes]
    );
    res.status(201).json({ data: { id, ...r }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.put('/dictionary/:id', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const r = req.body;
    await db.execute(
      `UPDATE field_dictionary SET pattern = ?, category = ?, priority = ?, is_enabled = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [r.pattern, r.category, r.priority, r.is_enabled ? 1 : 0, r.notes, req.params.id]
    );
    res.json({ data: { id: req.params.id, ...r }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.delete('/dictionary/:id', async (req, res) => {
  try {
    const db = dbManager.getActive();
    await db.execute(`DELETE FROM field_dictionary WHERE id = ?`, [req.params.id]);
    res.json({ data: { success: true }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

export default router;
```

Mount in `server/src/index.ts`:
```typescript
import learningRoutes from './routes/learning.js';
app.use('/api', learningRoutes);
```

---

## Phase 4: Frontend Implementation

Due to token/scope limits, I'll provide the key components structure:

### 1. Dictionary Manager Page

**File**: `src/pages/DictionaryManager.tsx`

**Features**:
- Table view of all dictionary rules
- Add/Edit/Delete rules
- Enable/Disable toggle
- Priority ordering
- Pattern regex validation
- Category selection (IDENTITY/FLOW_TICKET/OBJECT_ID/NOISE)

### 2. Enhanced Workflows Page

**File**: `src/pages/Workflows.tsx` (MODIFY)

**Add to each workflow row**:
- Type badge (Baseline/Mutation)
- Learning status indicator
- "Run Learning Mode" button (baseline only)
- "View Variables" button
- "View Mappings" button

### 3. Learning Results Modal

**File**: `src/components/LearningResultsModal.tsx` (NEW)

**Layout**:
```
┌─────────────────────────────────────────────────┐
│ Learning Results for: [Workflow Name]          │
├─────────────────────────────────────────────────┤
│ Response Candidates (Step 1)          [▼]     │
│ ┌─────────────────────────────────────────┐   │
│ │ ☐ auth.token (IDENTITY, score: 95)     │   │
│ │ ☐ challengeId (FLOW_TICKET, score: 85) │   │
│ │ ☐ userId (OBJECT_ID, score: 80)        │   │
│ └─────────────────────────────────────────┘   │
│                                                 │
│ Suggested Mappings               [Accept All]  │
│ ┌───────────────────────────────────────────┐ │
│ │ Step1.response.auth.token →               │ │
│ │   Step2.request.header.Authorization     │ │
│ │   [Confidence: 90%] [same_name]   [✓][✗] │ │
│ │───────────────────────────────────────────│ │
│ │ Step1.response.challengeId →              │ │
│ │   Step2.request.body.challenge_id         │ │
│ │   [Confidence: 85%] [same_value]  [✓][✗] │ │
│ └───────────────────────────────────────────┘ │
│                                                 │
│ [Cancel]  [Save Selected Mappings]            │
└─────────────────────────────────────────────────┘
```

### 4. Variable Pool Manager

**File**: `src/components/VariablePoolModal.tsx` (NEW)

**Layout**:
```
┌─────────────────────────────────────────────────┐
│ Workflow Variable Pool                         │
├─────────────────────────────────────────────────┤
│ Variable Name    Type          Locked  Actions │
│ auth.token       IDENTITY      [ ]     [✏][🗑] │
│ flow.challengeId FLOW_TICKET   [ ]     [✏][🗑] │
│ obj.orderId      OBJECT_ID     [✓]     [✏][🗑] │
│                                                 │
│ [+ Add Variable]                                │
│                                                 │
│ [Close]                                         │
└─────────────────────────────────────────────────┘
```

---

## Summary & Next Steps

This implementation provides:

1. **Complete database schema** for learning mode, variable pools, and field dictionary
2. **Backend services** for learning algorithm, dictionary matching, and variable injection
3. **REST APIs** for all CRUD operations
4. **Frontend structure** for UI components

### Validation Checklist

Before considering this feature complete:

- [ ] Baseline workflow can run learning mode with fixed account
- [ ] Learning results show response candidates with scores
- [ ] Mapping candidates generated with confidence levels
- [ ] User can accept/reject mappings via UI
- [ ] Variable pool stores variables correctly
- [ ] Mappings are applied during workflow execution
- [ ] Mutation workflow can reference baseline's variable schema
- [ ] Dictionary rules are editable and affect learning
- [ ] Identity variables from account binding take priority over learned variables
- [ ] Locked variables cannot be overwritten

### Known Limitations

1. **No parallel step execution** (as per requirements)
2. **No automatic re-learning** on baseline changes (manual trigger only)
3. **Simple value matching** (no fuzzy/ML-based matching yet)
4. **Header/Cookie extraction** basic implementation (may need refinement)

This blueprint provides the full engineering foundation. Implementation can proceed module-by-module with testing at each phase.
