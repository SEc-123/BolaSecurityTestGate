// Execute production schema/repository SQL using Node's real SQLite engine.
// This verifies application SQL, NOT the better-sqlite3 native addon/packaging.
import { DatabaseSync } from 'node:sqlite';
export default class Database {
  constructor(file) { this.native = new DatabaseSync(file); }
  pragma(sql) { return this.native.exec(`PRAGMA ${sql}`); }
  exec(sql) { return this.native.exec(sql); }
  close() { this.native.close(); }
  prepare(sql) {
    const statement = this.native.prepare(sql);
    const params = values => values.map(value => value === undefined ? null : value);
    return {
      run: (...values) => statement.run(...params(values)),
      get: (...values) => statement.get(...params(values)),
      all: (...values) => statement.all(...params(values)),
    };
  }
  transaction(fn) { return (...args) => { this.native.exec('BEGIN'); try { const result = fn(...args); this.native.exec('COMMIT'); return result; } catch (error) { this.native.exec('ROLLBACK'); throw error; } }; }
}
