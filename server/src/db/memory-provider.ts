import { v4 as uuidv4 } from 'uuid';
import type { DbProvider, DbRepositories, Repository, DbConfig, DbKind } from '../types/index.js';

// Simple in-memory repository implementation
class MemoryRepository<T> implements Repository<T> {
  private data: Map<string, T> = new Map();

  async findAll(options?: { where?: Partial<T>; limit?: number; offset?: number }): Promise<T[]> {
    let result = Array.from(this.data.values());
    
    if (options?.where) {
      result = result.filter(item => {
        return Object.entries(options.where!).every(([key, value]) => {
          return (item as any)[key] === value;
        });
      });
    }
    
    if (options?.offset) {
      result = result.slice(options.offset);
    }
    
    if (options?.limit) {
      result = result.slice(0, options.limit);
    }
    
    return result;
  }

  async findById(id: string): Promise<T | null> {
    return this.data.get(id) || null;
  }

  async create(data: Omit<T, 'id' | 'created_at' | 'updated_at'>): Promise<T> {
    const item = {
      ...data,
      id: uuidv4(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as unknown as T;
    
    this.data.set((item as any).id, item);
    return item;
  }

  async update(id: string, data: Partial<T>): Promise<T | null> {
    const existing = this.data.get(id);
    if (!existing) return null;
    
    const updated = {
      ...existing,
      ...data,
      updated_at: new Date().toISOString(),
    };
    
    this.data.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.data.delete(id);
  }

  async count(where?: Partial<T>): Promise<number> {
    if (!where) return this.data.size;
    
    return Array.from(this.data.values()).filter(item => {
      return Object.entries(where).every(([key, value]) => {
        return (item as any)[key] === value;
      });
    }).length;
  }
}

export class MemoryProvider implements DbProvider {
  private _repos: DbRepositories;
  private connected = false;
  public kind: DbKind = 'memory';
  public profileId: string;

  constructor(name: string, config: DbConfig) {
    this.profileId = name;
    this._repos = {
      environments: new MemoryRepository(),
      accounts: new MemoryRepository(),
      apiTemplates: new MemoryRepository(),
      workflows: new MemoryRepository(),
      workflowSteps: new MemoryRepository(),
      workflowVariableConfigs: new MemoryRepository(),
      workflowExtractors: new MemoryRepository(),
      checklists: new MemoryRepository(),
      securityRules: new MemoryRepository(),
      recordingSessions: new MemoryRepository(),
      recordingEvents: new MemoryRepository(),
      recordingFieldTargets: new MemoryRepository(),
      recordingFieldHits: new MemoryRepository(),
      recordingRuntimeContext: new MemoryRepository(),
      recordingAccountApplyLogs: new MemoryRepository(),
      recordingAuditLogs: new MemoryRepository(),
      recordingDeadLetters: new MemoryRepository(),
      workflowDrafts: new MemoryRepository(),
      workflowDraftSteps: new MemoryRepository(),
      recordingExtractorCandidates: new MemoryRepository(),
      recordingVariableCandidates: new MemoryRepository(),
      testRunDrafts: new MemoryRepository(),
      testRunPresets: new MemoryRepository(),
      draftPublishLogs: new MemoryRepository(),
      testRuns: new MemoryRepository(),
      findings: new MemoryRepository(),
      cicdGatePolicies: new MemoryRepository(),
      securitySuites: new MemoryRepository(),
      securityRuns: new MemoryRepository(),
      findingSuppressionRules: new MemoryRepository(),
      findingDropRules: new MemoryRepository(),
      dbProfiles: new MemoryRepository(),
    };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async migrate(): Promise<void> {
    // No migration needed for in-memory database
  }

  get repos(): DbRepositories {
    if (!this.connected) {
      throw new Error('Database not connected');
    }
    return this._repos;
  }

  async ping(): Promise<boolean> {
    return this.connected;
  }

  async getSchemaVersion(): Promise<string> {
    return '1.0.0';
  }

  async runRawQuery(query: string, params?: any[]): Promise<any[]> {
    return [];
  }

  async getStatus(): Promise<{ connected: boolean; schemaVersion: string; activeProfileName: string; runningRunsCount: number }> {
    return {
      connected: this.connected,
      schemaVersion: '1.0.0',
      activeProfileName: 'memory',
      runningRunsCount: 0,
    };
  }
}
