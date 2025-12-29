export interface DictionaryRule {
  id: string;
  scope: 'global' | 'project';
  scope_id?: string | null;
  pattern: string;
  category: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'NOISE';
  priority: number;
  is_enabled: number | boolean;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export class FieldDictionary {
  private rules: DictionaryRule[] = [];
  private compiledPatterns: Map<string, RegExp> = new Map();

  constructor(private db: any) {}

  async load(scope: 'global' | 'project' = 'global', scopeId?: string): Promise<void> {
    const query = scope === 'global'
      ? `SELECT * FROM field_dictionary WHERE scope = 'global' AND is_enabled = 1 ORDER BY priority DESC`
      : `SELECT * FROM field_dictionary WHERE (scope = 'global' OR (scope = 'project' AND scope_id = ?)) AND is_enabled = 1 ORDER BY priority DESC`;

    try {
      const results = await this.db.runRawQuery(query, scope === 'project' ? [scopeId] : []);
      this.rules = results || [];

      this.compiledPatterns.clear();
      for (const rule of this.rules) {
        try {
          this.compiledPatterns.set(rule.id, new RegExp(rule.pattern));
        } catch (e) {
          console.warn(`Invalid regex pattern in dictionary rule ${rule.id}: ${rule.pattern}`, e);
        }
      }
    } catch (error) {
      console.error('Error loading field dictionary:', error);
      this.rules = [];
      this.compiledPatterns.clear();
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

  async addRule(rule: Omit<DictionaryRule, 'id' | 'created_at' | 'updated_at'>): Promise<DictionaryRule> {
    const id = `dict_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();
    const newRule: DictionaryRule = {
      ...rule,
      id,
      is_enabled: rule.is_enabled ? 1 : 0,
      created_at: now,
      updated_at: now
    };

    const query = `INSERT INTO field_dictionary (id, scope, scope_id, pattern, category, priority, is_enabled, notes, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    try {
      await this.db.runRawQuery(query, [
        newRule.id,
        newRule.scope,
        newRule.scope_id || null,
        newRule.pattern,
        newRule.category,
        newRule.priority,
        newRule.is_enabled ? 1 : 0,
        newRule.notes || null,
        newRule.created_at,
        newRule.updated_at
      ]);

      await this.load(rule.scope, rule.scope_id || undefined);
      return newRule;
    } catch (error) {
      console.error('Error adding dictionary rule:', error);
      throw error;
    }
  }

  async updateRule(id: string, updates: Partial<Omit<DictionaryRule, 'id' | 'created_at'>>): Promise<void> {
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (key !== 'id' && key !== 'created_at') {
        setClauses.push(`${key} = ?`);
        if (key === 'is_enabled') {
          values.push(value ? 1 : 0);
        } else {
          values.push(value === undefined || value === null ? null : value);
        }
      }
    }

    setClauses.push(`updated_at = ?`);
    values.push(new Date().toISOString());
    values.push(id);

    const query = `UPDATE field_dictionary SET ${setClauses.join(', ')} WHERE id = ?`;

    try {
      await this.db.runRawQuery(query, values);
      await this.load();
    } catch (error) {
      console.error('Error updating dictionary rule:', error);
      throw error;
    }
  }

  async deleteRule(id: string): Promise<void> {
    const query = `DELETE FROM field_dictionary WHERE id = ?`;

    try {
      await this.db.runRawQuery(query, [id]);
      await this.load();
    } catch (error) {
      console.error('Error deleting dictionary rule:', error);
      throw error;
    }
  }

  getRules(): DictionaryRule[] {
    return this.rules;
  }
}
