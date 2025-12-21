import { FieldDictionary, DictionaryRule } from './field-dictionary.js';

export interface CandidateField {
  stepOrder: number;
  location: 'response.body' | 'response.header' | 'response.cookie';
  path: string;
  value: any;
  valuePreview: string;
  predictedType: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC' | 'NOISE';
  score: number;
  matchedRule?: string;
}

export interface RequestField {
  stepOrder: number;
  location: 'request.body' | 'request.header' | 'request.cookie' | 'request.query' | 'request.path';
  path: string;
  currentValue?: any;
}

export interface MappingCandidate {
  fromStepOrder: number;
  fromLocation: 'response.body' | 'response.header' | 'response.cookie';
  fromPath: string;
  toStepOrder: number;
  toLocation: 'request.body' | 'request.header' | 'request.cookie' | 'request.query' | 'request.path';
  toPath: string;
  confidence: number;
  reason: 'same_name' | 'same_value' | 'heuristic' | 'manual';
  predictedType: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC';
  variableName: string;
  fromValuePreview: string;
}

export interface StepSnapshot {
  stepOrder: number;
  templateId: string;
  templateName: string;
  request: {
    method: string;
    url: string;
    path?: string;
    headers: Record<string, string>;
    cookies: Record<string, string>;
    query: Record<string, string>;
    body: any;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    cookies: Record<string, string>;
    body: any;
  };
}

export interface LearningResult {
  workflowId: string;
  learningVersion: number;
  stepSnapshots: StepSnapshot[];
  candidateFields: Record<number, CandidateField[]>;
  requestFields: Record<number, RequestField[]>;
  mappingCandidates: MappingCandidate[];
}

const NOISE_PATTERNS = [
  /^(message|msg|success|status|code|error|description|desc)$/i,
  /^(timestamp|time|date|created_at|updated_at|modified_at)$/i,
  /^(request_id|trace_id|span_id|correlation_id|x-request-id)$/i,
  /^(version|v|api_version)$/i,
  /^(count|total|page|limit|offset|size)$/i,
];

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_PATTERN = /^[0-9a-f]{16,}$/i;
const NUMERIC_ID_PATTERN = /^\d{4,}$/;

export class LearningEngine {
  private dictionary: FieldDictionary;

  constructor(private db: any) {
    this.dictionary = new FieldDictionary(db);
  }

  async initialize(): Promise<void> {
    await this.dictionary.load();
  }

  async learn(workflowId: string, stepSnapshots: StepSnapshot[]): Promise<LearningResult> {
    await this.initialize();

    const candidateFields: Record<number, CandidateField[]> = {};
    const requestFields: Record<number, RequestField[]> = {};

    for (const snapshot of stepSnapshots) {
      candidateFields[snapshot.stepOrder] = this.extractCandidateFields(snapshot);
      requestFields[snapshot.stepOrder] = this.extractRequestFields(snapshot);
    }

    const mappingCandidates = this.generateMappingCandidates(
      stepSnapshots,
      candidateFields,
      requestFields
    );

    const workflow = await this.getWorkflow(workflowId);
    const learningVersion = (workflow?.learning_version || 0) + 1;

    return {
      workflowId,
      learningVersion,
      stepSnapshots,
      candidateFields,
      requestFields,
      mappingCandidates,
    };
  }

  private async getWorkflow(workflowId: string): Promise<any> {
    try {
      const query = `SELECT * FROM workflows WHERE id = ?`;
      const results = await this.db.runRawQuery(query, [workflowId]);
      return results?.[0] || null;
    } catch (error) {
      console.error('Error getting workflow:', error);
      return null;
    }
  }

  private extractCandidateFields(snapshot: StepSnapshot): CandidateField[] {
    const candidates: CandidateField[] = [];
    const { stepOrder, response } = snapshot;

    let bodyObj: any = null;
    if (typeof response.body === 'string') {
      try {
        bodyObj = JSON.parse(response.body);
      } catch {}
    } else if (response.body && typeof response.body === 'object') {
      bodyObj = response.body;
    }

    if (bodyObj && typeof bodyObj === 'object') {
      const flattened = this.flattenObject(bodyObj);
      for (const [path, value] of Object.entries(flattened)) {
        if (this.isScalarValue(value)) {
          const candidate = this.evaluateField(stepOrder, 'response.body', path, value);
          if (candidate.predictedType !== 'NOISE' || candidate.score > 30) {
            candidates.push(candidate);
          }
        }
      }
    }

    for (const [key, value] of Object.entries(response.headers || {})) {
      const candidate = this.evaluateField(stepOrder, 'response.header', key, value);
      if (candidate.predictedType !== 'NOISE') {
        candidates.push(candidate);
      }
    }

    for (const [key, value] of Object.entries(response.cookies || {})) {
      const candidate = this.evaluateField(stepOrder, 'response.cookie', key, value);
      candidates.push(candidate);
    }

    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }

  private extractRequestFields(snapshot: StepSnapshot): RequestField[] {
    const fields: RequestField[] = [];
    const { stepOrder, request } = snapshot;

    let bodyObj: any = null;
    if (typeof request.body === 'string') {
      try {
        bodyObj = JSON.parse(request.body);
      } catch {}
    } else if (request.body && typeof request.body === 'object') {
      bodyObj = request.body;
    }

    if (bodyObj && typeof bodyObj === 'object') {
      const flattened = this.flattenObject(bodyObj);
      for (const [path, value] of Object.entries(flattened)) {
        fields.push({
          stepOrder,
          location: 'request.body',
          path,
          currentValue: value,
        });
      }
    }

    for (const [key, value] of Object.entries(request.headers || {})) {
      fields.push({
        stepOrder,
        location: 'request.header',
        path: key,
        currentValue: value,
      });
    }

    for (const [key, value] of Object.entries(request.cookies || {})) {
      fields.push({
        stepOrder,
        location: 'request.cookie',
        path: key,
        currentValue: value,
      });
    }

    for (const [key, value] of Object.entries(request.query || {})) {
      fields.push({
        stepOrder,
        location: 'request.query',
        path: key,
        currentValue: value,
      });
    }

    if (request.path) {
      const pathParts = request.path.split('/').filter(p => p);
      for (let i = 0; i < pathParts.length; i++) {
        const part = pathParts[i];
        if (part) {
          fields.push({
            stepOrder,
            location: 'request.path',
            path: `[${i}]`,
            currentValue: part,
          });
        }
      }
    }

    return fields;
  }

  private evaluateField(
    stepOrder: number,
    location: 'response.body' | 'response.header' | 'response.cookie',
    path: string,
    value: any
  ): CandidateField {
    const fieldName = this.extractFieldName(path);
    let score = 0;
    let predictedType: CandidateField['predictedType'] = 'GENERIC';
    let matchedRule: string | undefined;

    const dictMatch = this.dictionary.match(fieldName);
    if (dictMatch) {
      predictedType = dictMatch.category;
      matchedRule = dictMatch.pattern;
      score += dictMatch.priority;

      if (dictMatch.category === 'NOISE') {
        return {
          stepOrder,
          location,
          path,
          value,
          valuePreview: this.maskValue(value),
          predictedType: 'NOISE',
          score: 0,
          matchedRule,
        };
      }
    }

    if (this.isNoiseField(fieldName)) {
      return {
        stepOrder,
        location,
        path,
        value,
        valuePreview: this.maskValue(value),
        predictedType: 'NOISE',
        score: 0,
      };
    }

    const valueStr = String(value);

    if (JWT_PATTERN.test(valueStr)) {
      score += 80;
      if (!dictMatch) predictedType = 'IDENTITY';
    } else if (UUID_PATTERN.test(valueStr)) {
      score += 60;
      if (!dictMatch) predictedType = 'OBJECT_ID';
    } else if (HEX_PATTERN.test(valueStr) && valueStr.length >= 32) {
      score += 50;
      if (!dictMatch) predictedType = 'FLOW_TICKET';
    } else if (NUMERIC_ID_PATTERN.test(valueStr)) {
      score += 40;
      if (!dictMatch) predictedType = 'OBJECT_ID';
    }

    if (this.isIdentityFieldName(fieldName)) {
      score += 70;
      if (!dictMatch) predictedType = 'IDENTITY';
    } else if (this.isTicketFieldName(fieldName)) {
      score += 50;
      if (!dictMatch) predictedType = 'FLOW_TICKET';
    } else if (this.isObjectIdFieldName(fieldName)) {
      score += 40;
      if (!dictMatch) predictedType = 'OBJECT_ID';
    }

    const depth = path.split('.').length;
    score += Math.max(0, 20 - depth * 3);

    if (location === 'response.cookie') {
      score += 30;
      if (!dictMatch && predictedType === 'GENERIC') {
        predictedType = 'IDENTITY';
      }
    } else if (location === 'response.header') {
      score += 20;
    }

    return {
      stepOrder,
      location,
      path,
      value,
      valuePreview: this.maskValue(value),
      predictedType,
      score,
      matchedRule,
    };
  }

  private generateMappingCandidates(
    snapshots: StepSnapshot[],
    candidateFields: Record<number, CandidateField[]>,
    requestFields: Record<number, RequestField[]>
  ): MappingCandidate[] {
    const candidates: MappingCandidate[] = [];
    const usedVariableNames = new Set<string>();

    for (let i = 0; i < snapshots.length - 1; i++) {
      const currentStep = snapshots[i].stepOrder;
      const responseCandidates = candidateFields[currentStep] || [];

      for (let j = i + 1; j < snapshots.length; j++) {
        const nextStep = snapshots[j].stepOrder;
        const reqFields = requestFields[nextStep] || [];

        for (const respField of responseCandidates) {
          if (respField.predictedType === 'NOISE') continue;

          for (const reqField of reqFields) {
            const sameNameMatch = this.normalizeFieldName(this.extractFieldName(respField.path)) ===
                                  this.normalizeFieldName(this.extractFieldName(reqField.path));

            const sameValueMatch = respField.value !== null &&
                                   respField.value !== undefined &&
                                   respField.value !== '' &&
                                   String(respField.value) === String(reqField.currentValue);

            if (sameNameMatch || sameValueMatch) {
              let confidence = 0;
              let reason: MappingCandidate['reason'] = 'heuristic';

              if (sameNameMatch && sameValueMatch) {
                confidence = 0.95;
                reason = 'same_name';
              } else if (sameNameMatch) {
                confidence = 0.8;
                reason = 'same_name';
              } else if (sameValueMatch) {
                confidence = 0.7;
                reason = 'same_value';
              }

              confidence *= (respField.score / 100);

              let variableName = this.generateVariableName(respField, usedVariableNames);
              usedVariableNames.add(variableName);

              candidates.push({
                fromStepOrder: currentStep,
                fromLocation: respField.location,
                fromPath: respField.path,
                toStepOrder: nextStep,
                toLocation: reqField.location,
                toPath: reqField.path,
                confidence: Math.min(1, Math.max(0, confidence)),
                reason,
                predictedType: respField.predictedType as MappingCandidate['predictedType'],
                variableName,
                fromValuePreview: respField.valuePreview,
              });
            }
          }
        }
      }
    }

    return candidates
      .sort((a, b) => b.confidence - a.confidence)
      .filter((c, i, arr) => {
        const isDuplicate = arr.findIndex(
          x => x.fromStepOrder === c.fromStepOrder &&
               x.fromPath === c.fromPath &&
               x.toStepOrder === c.toStepOrder &&
               x.toPath === c.toPath
        ) !== i;
        return !isDuplicate;
      });
  }

  private generateVariableName(field: CandidateField, used: Set<string>): string {
    const fieldName = this.extractFieldName(field.path);
    const normalized = this.normalizeFieldName(fieldName);

    let prefix = 'var';
    switch (field.predictedType) {
      case 'IDENTITY': prefix = 'auth'; break;
      case 'FLOW_TICKET': prefix = 'flow'; break;
      case 'OBJECT_ID': prefix = 'obj'; break;
    }

    let baseName = `${prefix}.${normalized}`;
    let name = baseName;
    let counter = 1;

    while (used.has(name)) {
      name = `${baseName}_${counter}`;
      counter++;
    }

    return name;
  }

  private flattenObject(obj: any, prefix = ''): Record<string, any> {
    const result: Record<string, any> = {};

    if (obj === null || obj === undefined) return result;

    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        const newPrefix = prefix ? `${prefix}[${index}]` : `[${index}]`;
        if (typeof item === 'object' && item !== null) {
          Object.assign(result, this.flattenObject(item, newPrefix));
        } else {
          result[newPrefix] = item;
        }
      });
    } else if (typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        const newPrefix = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'object' && value !== null) {
          Object.assign(result, this.flattenObject(value, newPrefix));
        } else {
          result[newPrefix] = value;
        }
      }
    }

    return result;
  }

  private isScalarValue(value: any): boolean {
    return value !== null &&
           value !== undefined &&
           (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
  }

  private extractFieldName(path: string): string {
    const parts = path.split(/[.\[\]]+/).filter(Boolean);
    return parts[parts.length - 1] || path;
  }

  private normalizeFieldName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[-_\s]+/g, '')
      .replace(/id$/i, 'id')
      .replace(/token$/i, 'token');
  }

  private isNoiseField(name: string): boolean {
    return NOISE_PATTERNS.some(pattern => pattern.test(name));
  }

  private isIdentityFieldName(name: string): boolean {
    const patterns = [
      /token/i, /auth/i, /bearer/i, /jwt/i, /session/i,
      /access.?key/i, /api.?key/i, /secret/i,
    ];
    return patterns.some(p => p.test(name));
  }

  private isTicketFieldName(name: string): boolean {
    const patterns = [
      /challenge/i, /nonce/i, /csrf/i, /state/i,
      /verification/i, /code/i, /otp/i,
    ];
    return patterns.some(p => p.test(name));
  }

  private isObjectIdFieldName(name: string): boolean {
    const patterns = [
      /.*id$/i, /.*_id$/i, /.*Id$/,
      /uuid/i, /guid/i, /key$/i,
    ];
    return patterns.some(p => p.test(name));
  }

  private maskValue(value: any): string {
    const str = String(value);
    if (str.length <= 8) return str;

    if (JWT_PATTERN.test(str)) {
      return `${str.substring(0, 20)}...${str.substring(str.length - 10)}`;
    }

    if (str.length > 20) {
      return `${str.substring(0, 10)}...${str.substring(str.length - 6)}`;
    }

    return str;
  }
}
