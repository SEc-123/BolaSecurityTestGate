import { spawn, type ChildProcess } from 'child_process';
const ownedChildren = new Map<number, ChildProcess>();
const completedChildren = new Set<number>();

export function isBackgroundCommandRunning(pid: number): boolean {
  const child = ownedChildren.get(pid);
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

export async function stopBackgroundCommand(pid: number): Promise<Record<string, any>> {
  if (completedChildren.has(pid)) return { stopped: true, already_exited: true };
  const child = ownedChildren.get(pid);
  if (!child) return { stopped: false, error: 'Process ownership is unavailable (possibly after restart); refusing to signal an unverified PID. Manual cleanup is required.' };
  if (child.exitCode !== null || child.signalCode !== null) return { stopped: true, already_exited: true };
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && isBackgroundCommandRunning(pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (isBackgroundCommandRunning(pid)) child.kill('SIGKILL');
  for (let i = 0; i < 10 && isBackgroundCommandRunning(pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  return { stopped: !isBackgroundCommandRunning(pid), pid };
}

export interface CommandResult {
  ok: boolean;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
}

export interface BackgroundCommandResult {
  ok: boolean;
  command: string;
  args: string[];
  pid?: number;
  error?: string;
}

export function splitCommandLine(commandLine: string): { command: string; args: string[] } {
  const text = String(commandLine || '').trim();
  if (!text) throw new Error('command is empty');
  const parts = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const unquote = (value: string) => value.replace(/^['"]|['"]$/g, '');
  const command = parts[0] ? unquote(parts[0]) : '';
  if (!command) throw new Error('command is empty');
  return { command, args: parts.slice(1).map(unquote) };
}

export async function runCommand(command: string, args: string[] = [], options: { timeoutMs?: number; input?: string | Buffer; cwd?: string } = {}): Promise<CommandResult> {
  const started = Date.now();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 30000));
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, command, args, stdout: Buffer.concat(stdout).toString('utf8'), stderr: String(err.message || err), exit_code: null, duration_ms: Date.now() - started });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, command, args, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exit_code: code, duration_ms: Date.now() - started });
    });
    if (options.input) child.stdin.end(options.input); else child.stdin.end();
  });
}

export async function startBackgroundCommand(command: string, args: string[] = [], options: { cwd?: string; env?: NodeJS.ProcessEnv; startupGraceMs?: number } = {}): Promise<BackgroundCommandResult> {
  return await new Promise(resolve => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      detached: true,
      stdio: 'ignore',
    });
    const finish = (result: BackgroundCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', error => finish({ ok: false, command, args, error: String(error?.message || error) }));
    child.once('spawn', () => {
      if (child.pid) { ownedChildren.set(child.pid, child); completedChildren.delete(child.pid); }
      child.once('exit', () => { if (child.pid) { ownedChildren.delete(child.pid); completedChildren.add(child.pid); } });
      child.unref();
      const grace = Math.max(100, Number(options.startupGraceMs || 650));
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) finish({ ok: false, command, args, pid: child.pid, error: `Process exited during startup with code ${child.exitCode}.` });
        else finish({ ok: true, command, args, pid: child.pid });
      }, grace);
    });
  });
}

export async function runCommandBinary(command: string, args: string[] = [], options: { timeoutMs?: number; cwd?: string } = {}): Promise<{ ok: boolean; buffer: Buffer; stderr: string; exit_code: number | null; duration_ms: number }> {
  const started = Date.now();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 30000));
  return await new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, buffer: Buffer.concat(stdout), stderr: String(err.message || err), exit_code: null, duration_ms: Date.now() - started });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, buffer: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'), exit_code: code, duration_ms: Date.now() - started });
    });
  });
}
