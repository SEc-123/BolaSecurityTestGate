#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import process from 'process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const serverDir = path.join(repoRoot, 'server');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (process.env.BSTG_SKIP_SERVER_POSTINSTALL === '1') {
  process.exit(0);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

const lockFile = fs.existsSync(path.join(serverDir, 'package-lock.json'));
const args = lockFile ? ['ci', '--no-audit', '--fund=false'] : ['install', '--no-audit', '--fund=false'];
run(npmCmd, args, serverDir).catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
