#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import process from 'process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pidFile = path.join(repoRoot, '.bstg-server.pid');
const logDir = path.join(repoRoot, 'logs');
const outLog = path.join(logDir, 'server.out.log');
const errLog = path.join(logDir, 'server.err.log');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const nodeCmd = process.execPath;
const serverEntry = path.join(repoRoot, 'server', 'dist', 'index.js');
const isWindows = process.platform === 'win32';

function parseArgs(argv) {
  const options = {
    background: false,
    baseUrl: process.env.BSTG_BASE_URL || 'http://127.0.0.1:3001',
    clean: true,
    retries: 30,
    delayMs: 2000,
  };
  let action = 'up';
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === '--background') options.background = true;
    else if (part === '--foreground') options.background = false;
    else if (part === '--base-url') options.baseUrl = argv[++i];
    else if (part === '--no-clean') options.clean = false;
    else if (part === '--retries') options.retries = Number(argv[++i] || options.retries);
    else if (part === '--delay-ms') options.delayMs = Number(argv[++i] || options.delayMs);
    else if (!part.startsWith('--')) action = part;
  }
  return { action, options };
}

function formatSpawnError(command, args, error, cwd) {
  return new Error(`${error.message || error} | command=${command} args=${JSON.stringify(args)} cwd=${cwd}`);
}

function runCommand(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd || repoRoot,
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, ...(opts.env || {}) },
      windowsHide: false,
    });
    child.on('error', (error) => reject(formatSpawnError(command, args, error, opts.cwd || repoRoot)));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function runCapture(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, args, {
      cwd: opts.cwd || repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, ...(opts.env || {}) },
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', (error) => reject(formatSpawnError(command, args, error, opts.cwd || repoRoot)));
    child.on('exit', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}\n${stderr || stdout}`));
    });
  });
}

function npmInstallArgs(cwd, ignoreScripts = false) {
  const hasLock = fs.existsSync(path.join(cwd, 'package-lock.json'));
  const base = hasLock ? ['ci'] : ['install'];
  if (ignoreScripts) base.push('--ignore-scripts');
  base.push('--no-audit', '--fund=false');
  return base;
}

function removeIfExists(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  }
}

async function cleanWorkspace() {
  console.log('Cleaning bundled dependencies and build output...');
  removeIfExists(path.join(repoRoot, 'node_modules'));
  removeIfExists(path.join(repoRoot, 'server', 'node_modules'));
  removeIfExists(path.join(repoRoot, 'dist'));
  removeIfExists(path.join(repoRoot, 'server', 'dist'));
}

async function install(options = {}) {
  if (options.clean) await cleanWorkspace();
  await runCommand(npmCmd, npmInstallArgs(repoRoot, true), { env: { ...process.env, BSTG_SKIP_SERVER_POSTINSTALL: '1' } });
  await runCommand(npmCmd, npmInstallArgs(path.join(repoRoot, 'server')), { cwd: path.join(repoRoot, 'server') });
  await runCommand(nodeCmd, ['scripts/verify-runtime.mjs'], { cwd: repoRoot });
}

async function build() { await runCommand(npmCmd, ['run', 'build'], { cwd: repoRoot }); }

function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function readPid() {
  if (!fs.existsSync(pidFile)) return null;
  const raw = fs.readFileSync(pidFile, 'utf8').trim();
  const pid = Number(raw);
  return Number.isFinite(pid) ? pid : null;
}
function writePid(pid) { fs.writeFileSync(pidFile, String(pid)); }
function removePid() { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); }

async function startForeground() { await runCommand(nodeCmd, ['scripts/start-server.mjs'], { cwd: repoRoot }); }

async function startBackgroundWindows() {
  fs.mkdirSync(logDir, { recursive: true });
  const psScript = `
$ErrorActionPreference = 'Stop'
$repo = ${JSON.stringify(repoRoot)}
$node = ${JSON.stringify(nodeCmd)}
$entry = ${JSON.stringify(path.join(repoRoot, 'scripts', 'start-server.mjs'))}
$out = ${JSON.stringify(outLog)}
$err = ${JSON.stringify(errLog)}
$p = Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $repo -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
Write-Output $p.Id
`;
  const { stdout } = await runCapture('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { cwd: repoRoot });
  const pid = Number(String(stdout).trim().split(/\r?\n/).pop());
  if (!Number.isFinite(pid)) throw new Error(`Failed to capture Windows background PID. Output: ${stdout}`);
  writePid(pid);
  console.log(`BSTG server started in background. pid=${pid}`);
  console.log(`Logs: ${outLog} / ${errLog}`);
}

async function startBackgroundPosix() {
  fs.mkdirSync(logDir, { recursive: true });
  const stdout = fs.openSync(outLog, 'a');
  const stderr = fs.openSync(errLog, 'a');
  const child = spawn(nodeCmd, ['scripts/start-server.mjs'], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', stdout, stderr],
    env: process.env,
    shell: false,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
  writePid(child.pid);
  console.log(`BSTG server started in background. pid=${child.pid}`);
  console.log(`Logs: ${outLog} / ${errLog}`);
}

async function startBackground() {
  if (!fs.existsSync(serverEntry)) throw new Error(`Server entry not found: ${serverEntry}. Did the build succeed?`);
  if (isWindows) return startBackgroundWindows();
  return startBackgroundPosix();
}

async function stopServer() {
  const pid = readPid();
  if (!pid) { console.log('No PID file found. Nothing to stop.'); return; }
  if (!isProcessRunning(pid)) { console.log(`Process ${pid} is not running. Cleaning stale PID file.`); removePid(); return; }
  if (isWindows) {
    await runCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    process.kill(pid);
  }
  removePid();
  console.log(`Stopped BSTG server pid=${pid}`);
}

async function healthCheck(baseUrl, retries, delayMs) {
  await runCommand(nodeCmd, ['scripts/post-deploy-check.mjs', '--base-url', baseUrl, '--retries', String(retries), '--delay-ms', String(delayMs)], { cwd: repoRoot });
}
async function routeAudit() { await runCommand(nodeCmd, ['scripts/route-audit.mjs'], { cwd: repoRoot }); }

function printLogTail(filePath, maxLines = 60) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).slice(-maxLines);
  console.error(`\n--- tail ${filePath} ---`);
  console.error(lines.join('\n'));
}

async function main() {
  const { action, options } = parseArgs(process.argv);
  if (action === 'install') return install(options);
  if (action === 'build') return build();
  if (action === 'start') return options.background ? startBackground() : startForeground();
  if (action === 'stop') return stopServer();
  if (action === 'check') return healthCheck(options.baseUrl, options.retries, options.delayMs);
  if (action === 'audit') return routeAudit();
  if (action === 'up') {
    await stopServer();
    await install(options);
    await build();
    await routeAudit();
    if (options.background) {
      await startBackground();
      try {
        await healthCheck(options.baseUrl, options.retries, options.delayMs);
      } catch (error) {
        printLogTail(errLog);
        printLogTail(outLog);
        await stopServer().catch(() => {});
        throw error;
      }
      return;
    }
    return startForeground();
  }
  throw new Error(`Unknown action: ${action}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
