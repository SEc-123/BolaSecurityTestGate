/** Isolated, view-only desktops for the SAME headed browsers used by the agent.
 * No host DISPLAY, shared desktop, public VNC port, screenshot polling or viewer input.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net, { type Socket } from 'node:net';

export interface DesktopView {
  id: string; run_id: string; task_id: string | null;
  state: 'ready' | 'working'; created_at: string; last_action_at: string;
  width: number; height: number; read_only: true; transport: 'novnc';
}
export interface DesktopSession {
  view: DesktopView; display: string; authority: string; socketPath: string;
  sockets: Set<Socket>; closed: boolean;
  activity(taskId?: string, working?: boolean): void;
  onClose(callback: () => Promise<unknown>): void;
  close(): Promise<void>;
}
const bounded = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v); return v && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};
const sessions = new Map<string, DesktopSession>();
let starting = 0;
let shuttingDown = false;
export function desktopSessions(runId: string): DesktopView[] {
  return [...sessions.values()].filter(s => !s.closed && s.view.run_id === runId).map(s => ({...s.view}));
}
export function getDesktop(id: string): DesktopSession | undefined {
  const s = sessions.get(id); return s && !s.closed ? s : undefined;
}
// Xauthority binary records. The server reads the cookie; the client matches the allocated display.
function authorityRecord(number: string, cookie: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xff])]; // FamilyWild, confined by private filesystem mode
  for (const field of [Buffer.alloc(0), Buffer.from(number), Buffer.from('MIT-MAGIC-COOKIE-1'), cookie]) {
    const length = Buffer.alloc(2); length.writeUInt16BE(field.length); parts.push(length, field);
  }
  return Buffer.concat(parts);
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>(r => child.once('exit', () => r()));
  // Each child is spawned into its own process group; this also reaps websockify workers.
  try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
  await Promise.race([done, delay(1500)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    await Promise.race([done, delay(1000)]);
  }
}
async function readySocket(socketPath: string, alive: () => boolean): Promise<void> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && alive()) {
    if (await new Promise<boolean>(resolve => {
      const s = net.connect({path: socketPath}); let settled = false;
      const finish = (ok: boolean) => { if (!settled) { settled = true; s.destroy(); resolve(ok); } };
      s.once('connect', () => finish(true)); s.once('error', () => finish(false)); s.setTimeout(300, () => finish(false));
    })) return;
    await delay(60);
  }
  throw new Error('LIVE_BROWSER_DESKTOP_NOT_READY');
}

export async function openDesktop(input: {runId: string; taskId?: string}): Promise<DesktopSession> {
  if (process.platform !== 'linux') throw new Error('LIVE_BROWSER_REQUIRES_LINUX');
  if (shuttingDown) throw new Error('LIVE_BROWSER_SHUTTING_DOWN');
  if (!input.runId || input.runId.length > 200) throw new Error('LIVE_BROWSER_INVALID_RUN');
  const limit = bounded(process.env.BSTG_LIVE_MAX_SESSIONS, 8, 1, 32);
  if (sessions.size + starting >= limit) throw new Error('LIVE_BROWSER_CAPACITY');
  starting++;
  const children: ChildProcess[] = [];
  let directory = ''; let failed = false; let closing: Promise<void> | null = null;
  const callbacks: Array<() => Promise<unknown>> = [];
  const sockets = new Set<Socket>();
  let session: DesktopSession | undefined;
  let expiry: ReturnType<typeof setInterval> | undefined;
  const cleanup = (): Promise<void> => {
    if (closing) return closing;
    if (session) { session.closed = true; sessions.delete(session.view.id); }
    if (expiry) clearInterval(expiry);
    closing = (async () => {
      for (const socket of sockets) socket.destroy(); sockets.clear();
      // Browser/context close callbacks precede destroying their X server.
      await Promise.race([Promise.allSettled(callbacks.map(cb => Promise.resolve().then(cb))), delay(3000)]);
      for (const child of [...children].reverse()) await stopChild(child);
      if (directory) await rm(directory, {recursive: true, force: true});
    })();
    return closing;
  };
  function launch(command: string, args: string[], extraPipe = false): ChildProcess {
    const child = spawn(command, args, {shell: false, detached: true,
      stdio: extraPipe ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      env: {...process.env, LC_ALL: 'C'}});
    children.push(child);
    // Drain output but never emit private socket paths, VNC tickets or desktop content to UI.
    child.stdout?.resume(); child.stderr?.resume();
    const died = () => { failed = true; if (session && !session.closed) void cleanup(); };
    child.once('error', died); child.once('exit', died);
    return child;
  }
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'bstg-live-'));
    await chmod(directory, 0o700);
    const authority = path.join(directory, 'Xauthority'); const cookie = randomBytes(16);
    await writeFile(authority, authorityRecord('', cookie), {mode: 0o600});
    const width = bounded(process.env.BSTG_LIVE_WIDTH, 1366, 800, 2560);
    const height = bounded(process.env.BSTG_LIVE_HEIGHT, 900, 600, 1440);
    const xvfb = launch(process.env.BSTG_XVFB_BIN || 'Xvfb', ['-displayfd', '3', '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-auth', authority], true);
    const number = await new Promise<string>((resolve, reject) => {
      let buffer = ''; const timer = setTimeout(() => finish(new Error('LIVE_BROWSER_XVFB_TIMEOUT')), 12000);
      const finish = (error?: Error, value?: string) => {clearTimeout(timer); xvfb.removeListener('error', onError); xvfb.removeListener('exit', onExit); if(error) reject(error); else resolve(value!);};
      const onError = () => finish(new Error('LIVE_BROWSER_XVFB_MISSING'));
      const onExit = () => finish(new Error('LIVE_BROWSER_XVFB_FAILED'));
      xvfb.once('error', onError); xvfb.once('exit', onExit);
      (xvfb.stdio[3] as NodeJS.ReadableStream).on('data', (data: Buffer) => {
        buffer += data.toString(); if (buffer.includes('\n')) {
          const n = buffer.trim(); finish(/^\d{1,5}$/.test(n) ? undefined : new Error('LIVE_BROWSER_INVALID_DISPLAY'), n);
        }
      });
    });
    const display = `:${number}`;
    await writeFile(authority, authorityRecord(number, cookie), {mode: 0o600});
    const vncPath = path.join(directory, 'rfb.sock'); const socketPath = path.join(directory, 'websocket.sock');
    launch(process.env.BSTG_X11VNC_BIN || 'x11vnc', ['-display', display, '-auth', authority,
      '-unixsock', vncPath, '-rfbport', '0', '-no6', '-viewonly', '-shared', '-forever', '-nopw',
      '-nosel', '-nosetprimary', '-nosetclipboard', '-noxdamage', '-quiet']);
    await readySocket(vncPath, () => !failed);
    launch(process.env.BSTG_WEBSOCKIFY_BIN || 'websockify', [`--unix-listen=${socketPath}`, '--unix-listen-mode=0600', `--unix-target=${vncPath}`, '--heartbeat=15']);
    await readySocket(socketPath, () => !failed);
    if (failed || shuttingDown) throw new Error('LIVE_BROWSER_START_INTERRUPTED');
    const now = new Date().toISOString();
    session = {
      view: {id: randomUUID(), run_id: input.runId, task_id: input.taskId || null, state:'ready',
        created_at: now, last_action_at: now, width, height, read_only:true, transport:'novnc'},
      display, authority, socketPath, sockets, closed:false,
      activity(taskId, working = true) {
        if (session!.closed) return;
        session!.view.task_id = taskId || session!.view.task_id;
        session!.view.state = working ? 'working' : 'ready';
        session!.view.last_action_at = new Date().toISOString();
      },
      onClose(callback) { callbacks.push(callback); }, close: cleanup,
    };
    sessions.set(session.view.id, session);
    const born = Date.now();
    const idleMs = bounded(process.env.BSTG_LIVE_IDLE_SECONDS, 900, 60, 86400) * 1000;
    const maxMs = bounded(process.env.BSTG_LIVE_MAX_SECONDS, 7200, 120, 86400) * 1000;
    expiry = setInterval(() => {
      if (Date.now() - born > maxMs || (session!.view.state !== 'working' && Date.now() - Date.parse(session!.view.last_action_at) > idleMs)) void cleanup();
    }, 15000); expiry.unref();
    return session;
  } catch (error) { await cleanup(); throw error; }
  finally { starting--; }
}
export async function closeAllDesktops(): Promise<void> {
  shuttingDown = true;
  await Promise.allSettled([...sessions.values()].map(s => s.close()));
}
