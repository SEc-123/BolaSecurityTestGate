export class AgentToolContractError extends Error {
  readonly code = 'AGENT_TOOL_CONTRACT_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'AgentToolContractError';
  }
}

function typeMatches(value: unknown, type: string): boolean {
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

function validateNode(value: unknown, schema: any, path: string, errors: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => Object.is(item, value))) {
    errors.push(`${path} must be one of ${schema.enum.map(String).join(', ')}`);
    return;
  }
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}`);
    return;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < Number(schema.minLength)) errors.push(`${path} is shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > Number(schema.maxLength)) errors.push(`${path} is longer than maxLength ${schema.maxLength}`);
    if (schema.pattern) {
      try { if (!new RegExp(String(schema.pattern)).test(value)) errors.push(`${path} does not match required pattern`); } catch { /* ignore invalid producer schema */ }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < Number(schema.minimum)) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > Number(schema.maximum)) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < Number(schema.minItems)) errors.push(`${path} must contain at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > Number(schema.maxItems)) errors.push(`${path} must contain at most ${schema.maxItems} item(s)`);
    if (schema.items) value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!(required in objectValue) || objectValue[required] === undefined || objectValue[required] === null || objectValue[required] === '') {
        errors.push(`${path}.${required} is required`);
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in objectValue && objectValue[key] !== undefined) validateNode(objectValue[key], childSchema, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
    }
  }
}

export function validateAgentToolInput(input: unknown, schema: Record<string, any>): void {
  const errors: string[] = [];
  validateNode(input, schema, '$', errors);
  if (errors.length) throw new AgentToolContractError(`Invalid tool input: ${errors.slice(0, 8).join('; ')}`);
}

export function readInputPath(input: Record<string, any>, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<any>((current, key) => current == null ? undefined : current[key], input);
}
