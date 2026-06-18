#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

const repoRoot = process.cwd();
const serverEntry = path.join(repoRoot, 'server', 'dist', 'index.js');
const serverNodeModules = path.join(repoRoot, 'server', 'node_modules');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(serverEntry)) {
  fail('Missing server/dist/index.js. Run "npm run build" or the deploy script first.');
}

if (!fs.existsSync(serverNodeModules)) {
  fail('Missing server/node_modules. Run "npm install" or the deploy script first.');
}

try {
  const requireFromServer = createRequire(path.join(repoRoot, 'server', 'package.json'));
  const Database = requireFromServer('better-sqlite3');
  const db = new Database(':memory:');
  db.prepare('select 1 as ok').get();
  db.close();
} catch (error) {
  fail([
    'Failed to initialize server runtime dependency "better-sqlite3".',
    'This usually means the bundled node_modules were built on a different platform, or dependencies were not installed correctly.',
    'Run the deploy script or reinstall dependencies on this machine:',
    '  Windows: .\\deploy.ps1',
    '  Linux/macOS: ./deploy.sh',
    `Original error: ${error?.message || error}`,
  ].join('\n'));
}

process.env.SERVE_FRONTEND ??= 'true';
await import(pathToFileURL(serverEntry).href);
