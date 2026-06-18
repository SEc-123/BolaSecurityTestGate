#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const serverPackageJson = path.join(repoRoot, 'server', 'package.json');
const serverEntry = path.join(repoRoot, 'server', 'dist', 'index.js');
const requireFromServer = createRequire(serverPackageJson);

const result = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  checks: [],
};

function record(name, ok, detail) {
  result.checks.push({ name, ok, detail });
  if (!ok) result.failed = true;
}

record('server package.json', fs.existsSync(serverPackageJson), serverPackageJson);
record('server entry', fs.existsSync(serverEntry), serverEntry);

try {
  const Database = requireFromServer('better-sqlite3');
  const db = new Database(':memory:');
  const row = db.prepare('select 1 as ok').get();
  db.close();
  record('better-sqlite3 runtime', !!row?.ok, 'native module loaded and :memory: query succeeded');
} catch (error) {
  record('better-sqlite3 runtime', false, error?.message || String(error));
}

console.log(JSON.stringify(result, null, 2));
if (result.failed) process.exit(1);
