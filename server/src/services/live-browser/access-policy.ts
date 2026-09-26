import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export class ViewerDenied extends Error { constructor(public status = 403) { super('LIVE_BROWSER_ACCESS_DENIED'); } }
export interface ViewerIdentity { principal: string; origin: string; }
const loopback = (value: string) => ['127.0.0.1','::1','::ffff:127.0.0.1','localhost','[::1]'].includes(value.toLowerCase());
function scalar(value: string | string[] | undefined): string {
  if (Array.isArray(value)) throw new ViewerDenied(); return value || '';
}
function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length >= 32 && left.length === right.length && timingSafeEqual(left, right);
}
/** Default: a local single-operator app, NOT a multi-tenant authorization system.
 * Remote deployment: TLS authentication proxy must supply stripped/replaced, authenticated-boundary headers.
 * Never trust forwarded client IP, arbitrary hosts, wildcard origins, or a browser-supplied user ID.
 */
export function authorizeViewer(req: IncomingMessage, runId: string, requireOrigin: boolean, env = process.env): ViewerIdentity {
  if (!/^[\w-]{1,200}$/.test(runId)) throw new ViewerDenied();
  const mode = env.BSTG_LIVE_ACCESS_MODE || 'local';
  let origin: string; let principal: string;
  if (mode === 'proxy') {
    if ((req.socket.remoteAddress || '') !== (env.BSTG_LIVE_PROXY_IP || '127.0.0.1')) throw new ViewerDenied();
    if (!equalSecret(scalar(req.headers['x-bstg-proxy-secret']), env.BSTG_LIVE_PROXY_SECRET || '')) throw new ViewerDenied();
    principal = scalar(req.headers['x-bstg-user']);
    const grants = scalar(req.headers['x-bstg-run-ids']).split(',').map(s => s.trim());
    if (!/^[\w@.+:-]{1,160}$/.test(principal) || !grants.includes(runId)) throw new ViewerDenied();
    try {
      const configured = new URL(env.BSTG_PUBLIC_ORIGIN || '');
      if (configured.protocol !== 'https:' || configured.origin !== env.BSTG_PUBLIC_ORIGIN) throw new Error();
      origin = configured.origin;
    } catch { throw new ViewerDenied(503); }
  } else if (mode === 'local') {
    if (!loopback(req.socket.remoteAddress || '')) throw new ViewerDenied();
    if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-bstg-user']) throw new ViewerDenied();
    try {
      const host = scalar(req.headers.host);
      const url = new URL(`http://${host}`);
      if (!loopback(url.hostname) || url.host !== host) throw new Error();
      const tls = Boolean((req.socket as any).encrypted);
      origin = `${tls ? 'https' : 'http'}://${host}`;
    } catch { throw new ViewerDenied(); }
    principal = 'local-operator';
  } else { throw new ViewerDenied(503); }
  const supplied = scalar(req.headers.origin);
  if ((requireOrigin && !supplied) || (supplied && supplied !== origin)) throw new ViewerDenied();
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new ViewerDenied();
  return {origin, principal};
}
interface Ticket extends ViewerIdentity {runId: string; sessionId: string; expires: number;}
export class ViewerTickets {
  private tickets = new Map<string, Ticket>();
  constructor(private clock = Date.now, private ttlMs = 30000) {}
  private prune(): void { for (const [id,t] of this.tickets) if(t.expires <= this.clock()) this.tickets.delete(id); }
  issue(identity: ViewerIdentity, runId: string, sessionId: string): {ticket: string; expires_at: string} {
    this.prune();
    if (this.tickets.size >= 2048 || [...this.tickets.values()].filter(t => t.principal === identity.principal).length >= 64) throw new ViewerDenied(429);
    const ticket = randomBytes(32).toString('base64url'); const expires = this.clock() + this.ttlMs;
    this.tickets.set(ticket, {...identity,runId,sessionId,expires});
    return {ticket, expires_at: new Date(expires).toISOString()};
  }
  consume(value: string, identity: ViewerIdentity, runId: string, sessionId: string): void {
    this.prune(); const ticket = this.tickets.get(value); this.tickets.delete(value);
    if (!ticket || ticket.runId !== runId || ticket.sessionId !== sessionId || ticket.origin !== identity.origin || ticket.principal !== identity.principal) throw new ViewerDenied();
  }
}
