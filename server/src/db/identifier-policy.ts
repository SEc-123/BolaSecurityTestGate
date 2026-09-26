import { POSTGRES_SCHEMA, SQLITE_SCHEMA } from './schema.js';

export class SqlIdentifierError extends Error {
  status = 400;
}

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const CREATE_TABLE_RE = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+("?[\w]+"?)\s*\(([\s\S]*?)\n\);/gi;
const COLUMN_START_RE = /^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+/;
const SKIP_COLUMN_RE = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE)\b/i;

function normalizeIdentifier(value: string): string {
  return value.replace(/^"|"$/g, '');
}

function parseColumns(schema: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  let match: RegExpExecArray | null;
  while ((match = CREATE_TABLE_RE.exec(schema)) !== null) {
    const table = normalizeIdentifier(match[1]);
    const columns = tables.get(table) || new Set<string>();
    for (const rawLine of match[2].split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || SKIP_COLUMN_RE.test(line)) continue;
      const columnMatch = line.match(COLUMN_START_RE);
      if (columnMatch) columns.add(normalizeIdentifier(columnMatch[1]));
    }
    tables.set(table, columns);
  }
  return tables;
}

function mergeColumnMaps(...maps: Array<Map<string, Set<string>>>): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>();
  for (const map of maps) {
    for (const [table, columns] of map.entries()) {
      const existing = merged.get(table) || new Set<string>();
      for (const column of columns) existing.add(column);
      merged.set(table, existing);
    }
  }
  return merged;
}

const TABLE_COLUMNS = mergeColumnMaps(parseColumns(SQLITE_SCHEMA), parseColumns(POSTGRES_SCHEMA));

export function assertSafeIdentifier(identifier: string, label = 'SQL identifier'): string {
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new SqlIdentifierError(`${label} is not allowed: ${identifier}`);
  }
  return identifier;
}

export function quoteSqliteIdentifier(identifier: string): string {
  return `"${assertSafeIdentifier(identifier).replace(/"/g, '""')}"`;
}

export function quotePostgresIdentifier(identifier: string): string {
  return `"${assertSafeIdentifier(identifier).replace(/"/g, '""')}"`;
}

export function knownColumnsForTable(tableName: string): Set<string> {
  assertSafeIdentifier(tableName, 'SQL table');
  const columns = TABLE_COLUMNS.get(tableName);
  if (!columns) {
    throw new SqlIdentifierError(`Unknown SQL table: ${tableName}`);
  }
  return columns;
}

export function assertKnownColumn(tableName: string, column: string): string {
  assertSafeIdentifier(column, 'SQL column');
  const columns = knownColumnsForTable(tableName);
  if (!columns.has(column)) {
    throw new SqlIdentifierError(`Unknown column "${column}" for table "${tableName}"`);
  }
  return column;
}

export function filterKnownTableData(
  tableName: string,
  data: Record<string, any>,
  options: { dropUnknown?: boolean; dropUndefined?: boolean } = {}
): Record<string, any> {
  const out: Record<string, any> = {};
  const columns = knownColumnsForTable(tableName);
  for (const [key, value] of Object.entries(data || {})) {
    assertSafeIdentifier(key, 'SQL column');
    if (!columns.has(key)) {
      if (options.dropUnknown) continue;
      throw new SqlIdentifierError(`Unknown column "${key}" for table "${tableName}"`);
    }
    if (options.dropUndefined !== false && value === undefined) continue;
    out[key] = value;
  }
  return out;
}
