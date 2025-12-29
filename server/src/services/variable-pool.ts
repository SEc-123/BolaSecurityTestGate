export interface WorkflowVariable {
  id: string;
  workflow_id: string;
  name: string;
  type: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC';
  source: 'account_injected' | 'extracted' | 'manual';
  write_policy: 'first' | 'overwrite' | 'on_success_only';
  is_locked: boolean | number;
  description?: string | null;
  current_value?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowMapping {
  id: string;
  workflow_id: string;
  from_step_order: number;
  from_location: 'response.body' | 'response.header' | 'response.cookie';
  from_path: string;
  to_step_order: number;
  to_location: 'request.body' | 'request.header' | 'request.cookie' | 'request.query' | 'request.path';
  to_path: string;
  variable_name: string;
  confidence: number;
  reason: 'same_name' | 'same_value' | 'heuristic' | 'manual';
  is_enabled: boolean | number;
  created_at: string;
}

export interface VariablePoolState {
  variables: Map<string, any>;
  metadata: Map<string, { source: string; stepOrder: number; timestamp: number }>;
}

export class VariablePoolManager {
  private variables: WorkflowVariable[] = [];
  private mappings: WorkflowMapping[] = [];
  private state: VariablePoolState = {
    variables: new Map(),
    metadata: new Map(),
  };

  constructor(private db: any) {}

  async loadForWorkflow(workflowId: string): Promise<void> {
    await this.loadVariables(workflowId);
    await this.loadMappings(workflowId);
    this.initializeState();
  }

  private async loadVariables(workflowId: string): Promise<void> {
    try {
      const query = `SELECT * FROM workflow_variables WHERE workflow_id = ? ORDER BY name`;
      this.variables = await this.db.runRawQuery(query, [workflowId]) || [];
    } catch (error) {
      console.error('Error loading workflow variables:', error);
      this.variables = [];
    }
  }

  private async loadMappings(workflowId: string): Promise<void> {
    try {
      const query = `SELECT * FROM workflow_mappings WHERE workflow_id = ? AND is_enabled = 1 ORDER BY to_step_order, from_step_order`;
      this.mappings = await this.db.runRawQuery(query, [workflowId]) || [];
    } catch (error) {
      console.error('Error loading workflow mappings:', error);
      this.mappings = [];
    }
  }

  private initializeState(): void {
    this.state.variables.clear();
    this.state.metadata.clear();

    for (const variable of this.variables) {
      if (variable.current_value !== null && variable.current_value !== undefined) {
        this.state.variables.set(variable.name, variable.current_value);
        this.state.metadata.set(variable.name, {
          source: 'initial',
          stepOrder: 0,
          timestamp: Date.now(),
        });
      }
    }
  }

  injectAccountIdentity(accountContext: Record<string, any>): void {
    const normalizedAccountContext = this.buildNormalizedMap(accountContext);

    for (const variable of this.variables) {
      if (variable.type === 'IDENTITY' && variable.source === 'account_injected') {
        const fieldName = variable.name.replace(/^auth\./, '');
        const normalizedFieldName = this.normalizeKey(fieldName);

        let value = accountContext[fieldName];
        if (value === undefined) {
          value = normalizedAccountContext[normalizedFieldName];
        }

        if (value !== undefined) {
          this.state.variables.set(variable.name, value);
          this.state.metadata.set(variable.name, {
            source: 'account',
            stepOrder: 0,
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  getMappingsForStep(stepOrder: number, direction: 'inject' | 'extract'): WorkflowMapping[] {
    if (direction === 'inject') {
      return this.mappings.filter(m => m.to_step_order === stepOrder);
    } else {
      return this.mappings.filter(m => m.from_step_order === stepOrder);
    }
  }

  injectIntoRequest(
    stepOrder: number,
    request: {
      headers: Record<string, string>;
      cookies: Record<string, string>;
      query: Record<string, string>;
      body: any;
      url: string;
    },
    accountIdentity?: Record<string, string>
  ): void {
    const injectMappings = this.getMappingsForStep(stepOrder, 'inject');

    for (const mapping of injectMappings) {
      const variable = this.variables.find(v => v.name === mapping.variable_name);
      if (!variable) continue;

      let value: any;

      if (variable.type === 'IDENTITY' && accountIdentity) {
        const fieldName = variable.name.replace(/^auth\./, '');
        const normalizedFieldName = this.normalizeKey(fieldName);
        const normalizedAccountIdentity = this.buildNormalizedMap(accountIdentity);

        value = accountIdentity[fieldName];
        if (value === undefined) {
          value = normalizedAccountIdentity[normalizedFieldName];
        }
      }

      if (value === undefined) {
        value = this.state.variables.get(mapping.variable_name);
      }

      if (value === undefined || value === null) continue;

      this.setValueAtLocation(request, mapping.to_location, mapping.to_path, value);
    }
  }

  extractFromResponse(
    stepOrder: number,
    response: {
      status: number;
      headers: Record<string, string>;
      cookies: Record<string, string>;
      body: any;
    },
    wasSuccessful: boolean
  ): void {
    const extractMappings = this.getMappingsForStep(stepOrder, 'extract');

    for (const mapping of extractMappings) {
      const variable = this.variables.find(v => v.name === mapping.variable_name);
      if (!variable) continue;

      if (variable.is_locked) continue;

      if (variable.write_policy === 'on_success_only' && !wasSuccessful) continue;

      if (variable.write_policy === 'first' && this.state.variables.has(mapping.variable_name)) {
        continue;
      }

      const value = this.getValueFromLocation(response, mapping.from_location, mapping.from_path);

      if (value !== undefined && value !== null) {
        this.state.variables.set(mapping.variable_name, value);
        this.state.metadata.set(mapping.variable_name, {
          source: `step_${stepOrder}`,
          stepOrder,
          timestamp: Date.now(),
        });
      }
    }
  }

  private normalizeLocation(location: string): string {
    return location
      .replace(/\.headers$/, '.header')
      .replace(/\.cookies$/, '.cookie');
  }

  private normalizeKey(name: string): string {
    return name
      .toLowerCase()
      .replace(/[-_\s]+/g, '')
      .replace(/id$/i, 'id')
      .replace(/token$/i, 'token');
  }

  private buildNormalizedMap(obj: Record<string, any>): Record<string, any> {
    const normalized: Record<string, any> = {};
    for (const key in obj) {
      normalized[this.normalizeKey(key)] = obj[key];
    }
    return normalized;
  }

  private setValueAtLocation(
    request: any,
    location: string,
    path: string,
    value: any
  ): void {
    location = this.normalizeLocation(location);
    switch (location) {
      case 'request.header':
        request.headers = request.headers || {};
        request.headers[path] = String(value);
        break;

      case 'request.cookie':
        request.cookies = request.cookies || {};
        request.cookies[path] = String(value);
        break;

      case 'request.query':
        request.query = request.query || {};
        request.query[path] = String(value);
        break;

      case 'request.path':
        if (request.url) {
          const indexMatch = path.match(/^\[(\d+)\]$/);
          if (indexMatch) {
            const segmentIndex = parseInt(indexMatch[1], 10);
            request.url = this.replaceUrlPathSegment(request.url, segmentIndex, String(value));
          } else {
            request.url = request.url.replace(new RegExp(`{${path}}|:${path}`, 'g'), String(value));
          }
        }
        break;

      case 'request.body':
        if (request.body && typeof request.body === 'object') {
          this.setNestedValue(request.body, path, value);
        }
        break;
    }
  }

  private getValueFromLocation(
    response: any,
    location: string,
    path: string
  ): any {
    location = this.normalizeLocation(location);
    switch (location) {
      case 'response.header':
        return response.headers?.[path] || response.headers?.[path.toLowerCase()];

      case 'response.cookie':
        return response.cookies?.[path];

      case 'response.body':
        if (response.body && typeof response.body === 'object') {
          return this.getNestedValue(response.body, path);
        }
        return undefined;

      default:
        return undefined;
    }
  }

  private setNestedValue(obj: any, path: string, value: any): void {
    const parts = this.parsePath(path);
    let current = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] === undefined) {
        current[part] = typeof parts[i + 1] === 'number' ? [] : {};
      }
      current = current[part];
    }

    const lastPart = parts[parts.length - 1];
    current[lastPart] = value;
  }

  private getNestedValue(obj: any, path: string): any {
    const parts = this.parsePath(path);
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }

    return current;
  }

  private parsePath(path: string): (string | number)[] {
    const parts: (string | number)[] = [];
    const regex = /([^.\[\]]+)|\[(\d+)\]/g;
    let match;

    while ((match = regex.exec(path)) !== null) {
      if (match[1] !== undefined) {
        parts.push(match[1]);
      } else if (match[2] !== undefined) {
        parts.push(parseInt(match[2], 10));
      }
    }

    return parts;
  }

  private replaceUrlPathSegment(url: string, segmentIndex: number, value: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const segments = pathname.split('/').filter(s => s.length > 0);

      if (segmentIndex >= 0 && segmentIndex < segments.length) {
        segments[segmentIndex] = value;
        urlObj.pathname = '/' + segments.join('/');
        return urlObj.toString();
      }

      return url;
    } catch {
      return url;
    }
  }

  getValue(variableName: string): any {
    return this.state.variables.get(variableName);
  }

  setValue(variableName: string, value: any, stepOrder: number = 0): void {
    const variable = this.variables.find(v => v.name === variableName);

    if (variable?.is_locked) return;

    if (variable?.write_policy === 'first' && this.state.variables.has(variableName)) {
      return;
    }

    this.state.variables.set(variableName, value);
    this.state.metadata.set(variableName, {
      source: stepOrder > 0 ? `step_${stepOrder}` : 'manual',
      stepOrder,
      timestamp: Date.now(),
    });
  }

  getAllValues(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of this.state.variables) {
      result[key] = value;
    }
    return result;
  }

  getState(): VariablePoolState {
    return this.state;
  }

  reset(): void {
    this.initializeState();
  }

  copyVariablesFrom(sourcePool: VariablePoolManager, allowedTypes?: string[]): void {
    for (const [name, value] of sourcePool.state.variables.entries()) {
      const variable = this.variables.find(v => v.name === name);
      if (!variable) continue;
      if (variable.is_locked) continue;

      if (allowedTypes && allowedTypes.length > 0) {
        if (!allowedTypes.includes(variable.type)) continue;
      }

      this.state.variables.set(name, value);
      const metadata = sourcePool.state.metadata.get(name);
      if (metadata) {
        this.state.metadata.set(name, metadata);
      }
    }
  }

  lockVariable(variableName: string): void {
    const variable = this.variables.find(v => v.name === variableName);
    if (variable) {
      variable.is_locked = true;
    }
  }

  unlockVariable(variableName: string): void {
    const variable = this.variables.find(v => v.name === variableName);
    if (variable) {
      variable.is_locked = false;
    }
  }
}

export async function createVariable(
  db: any,
  workflowId: string,
  variable: Omit<WorkflowVariable, 'id' | 'workflow_id' | 'created_at' | 'updated_at'>
): Promise<WorkflowVariable> {
  const now = new Date().toISOString();

  const existingQuery = `SELECT id, created_at FROM workflow_variables WHERE workflow_id = ? AND name = ?`;
  const existingResult = await db.runRawQuery(existingQuery, [workflowId, variable.name]);
  const existing = existingResult && existingResult.length > 0 ? existingResult[0] : null;

  if (existing) {
    const updateQuery = `UPDATE workflow_variables SET
      type = ?, source = ?, write_policy = ?, is_locked = ?, description = ?, current_value = ?, updated_at = ?
      WHERE workflow_id = ? AND name = ?`;

    await db.runRawQuery(updateQuery, [
      variable.type,
      variable.source,
      variable.write_policy,
      variable.is_locked ? 1 : 0,
      variable.description || null,
      variable.current_value || null,
      now,
      workflowId,
      variable.name
    ]);

    return {
      id: existing.id,
      workflow_id: workflowId,
      ...variable,
      is_locked: variable.is_locked ? 1 : 0,
      created_at: existing.created_at,
      updated_at: now
    };
  } else {
    const id = `wv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const insertQuery = `INSERT INTO workflow_variables
      (id, workflow_id, name, type, source, write_policy, is_locked, description, current_value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    await db.runRawQuery(insertQuery, [
      id,
      workflowId,
      variable.name,
      variable.type,
      variable.source,
      variable.write_policy,
      variable.is_locked ? 1 : 0,
      variable.description || null,
      variable.current_value || null,
      now,
      now
    ]);

    return {
      id,
      workflow_id: workflowId,
      ...variable,
      is_locked: variable.is_locked ? 1 : 0,
      created_at: now,
      updated_at: now
    };
  }
}

function normalizeLocationValue(location: string): string {
  return location
    .replace(/\.headers$/, '.header')
    .replace(/\.cookies$/, '.cookie');
}

export async function createMapping(
  db: any,
  workflowId: string,
  mapping: Omit<WorkflowMapping, 'id' | 'workflow_id' | 'created_at'>
): Promise<WorkflowMapping> {
  const now = new Date().toISOString();

  const normalizedFromLocation = normalizeLocationValue(mapping.from_location);
  const normalizedToLocation = normalizeLocationValue(mapping.to_location);

  const existingQuery = `SELECT id, created_at FROM workflow_mappings
    WHERE workflow_id = ? AND from_step_order = ? AND from_location = ? AND from_path = ?
    AND to_step_order = ? AND to_location = ? AND to_path = ? AND variable_name = ?`;
  const existingResult = await db.runRawQuery(existingQuery, [
    workflowId,
    mapping.from_step_order,
    normalizedFromLocation,
    mapping.from_path,
    mapping.to_step_order,
    normalizedToLocation,
    mapping.to_path,
    mapping.variable_name
  ]);
  const existing = existingResult && existingResult.length > 0 ? existingResult[0] : null;

  if (existing) {
    const updateQuery = `UPDATE workflow_mappings SET
      confidence = ?, reason = ?, is_enabled = ?
      WHERE id = ?`;

    await db.runRawQuery(updateQuery, [
      mapping.confidence,
      mapping.reason,
      mapping.is_enabled ? 1 : 0,
      existing.id
    ]);

    return {
      id: existing.id,
      workflow_id: workflowId,
      ...mapping,
      from_location: normalizedFromLocation as any,
      to_location: normalizedToLocation as any,
      is_enabled: mapping.is_enabled ? 1 : 0,
      created_at: existing.created_at
    };
  } else {
    const id = `wm_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const insertQuery = `INSERT INTO workflow_mappings
      (id, workflow_id, from_step_order, from_location, from_path, to_step_order, to_location, to_path, variable_name, confidence, reason, is_enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    await db.runRawQuery(insertQuery, [
      id,
      workflowId,
      mapping.from_step_order,
      normalizedFromLocation,
      mapping.from_path,
      mapping.to_step_order,
      normalizedToLocation,
      mapping.to_path,
      mapping.variable_name,
      mapping.confidence,
      mapping.reason,
      mapping.is_enabled ? 1 : 0,
      now
    ]);

    return {
      id,
      workflow_id: workflowId,
      ...mapping,
      from_location: normalizedFromLocation as any,
      to_location: normalizedToLocation as any,
      is_enabled: mapping.is_enabled ? 1 : 0,
      created_at: now
    };
  }
}
