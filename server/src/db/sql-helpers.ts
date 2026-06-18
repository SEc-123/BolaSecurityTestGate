import type { DbProvider } from '../types/index.js';

export async function dbAll<T>(db: DbProvider, sql: string, params: any[] = []): Promise<T[]> {
  return db.runRawQuery<T>(sql, params);
}

export async function dbGet<T>(db: DbProvider, sql: string, params: any[] = []): Promise<T | null> {
  const rows = await db.runRawQuery<T>(sql, params);
  return rows[0] ?? null;
}

export async function dbRun(db: DbProvider, sql: string, params: any[] = []): Promise<void> {
  await db.runRawQuery(sql, params);
}
