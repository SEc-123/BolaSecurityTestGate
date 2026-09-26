/** HTTP/WS gateway shared by Express deployment and real integration tests.
 * The only upstream is a server-owned Unix socket; client input never selects a host/port.
 */
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import net, { type Socket } from 'node:net';
import { authorizeViewer, ViewerDenied, ViewerTickets } from './access-policy.js';
import { desktopSessions, getDesktop } from './desktop-runtime.js';
const ROUTE = /^\/api\/ai-scans\/([\w-]{1,200})\/live-browser(?:\/([\w-]{1,200})\/(ticket|socket))?$/;
const json = (res: ServerResponse, code: number, data: unknown, error: string | null = null) => {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  res.end(JSON.stringify({data,error}));
};
export class LiveBrowserGateway {
  readonly tickets = new ViewerTickets();
  constructor(private env = process.env) {}
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || '/', 'http://local.invalid'); const match = url.pathname.match(ROUTE);
    if (!match) return false;
    const [,runId,sessionId,action] = match;
    try {
      const identity = authorizeViewer(req, runId, action === 'ticket', this.env);
      if (!action && req.method === 'GET') {
        json(res,200,{sessions:desktopSessions(runId),read_only:true,transport:'novnc'}); return true;
      }
      if (action === 'ticket' && req.method === 'POST') {
        if (Number(req.headers['content-length'] || 0) > 512) throw new ViewerDenied(413);
        req.resume();
        const session = getDesktop(sessionId);
        if (!session || session.view.run_id !== runId) throw new ViewerDenied(410);
        if (session.sockets.size >= 8) throw new ViewerDenied(429); // 2 sockets per viewer
        const ticket = this.tickets.issue(identity,runId,sessionId);
        const endpoint = `/api/ai-scans/${runId}/live-browser/${sessionId}/socket?ticket=${encodeURIComponent(ticket.ticket)}`;
        json(res,201,{socket_path:endpoint,expires_at:ticket.expires_at,read_only:true}); return true;
      }
      json(res,405,null,'此观看操作不受支持。');
    } catch (error) {
      const code = error instanceof ViewerDenied ? error.status : 500;
      json(res,code,null, code === 410 ? '浏览器会话已结束。' : code === 429 ? '观看连接已达上限，请稍后重试。' : '无法授权当前浏览器观看连接。');
    }
    return true;
  }
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as Socket, head));
  }
  upgrade(req: IncomingMessage, client: Socket, head: Buffer): void {
    const reject = (status = 403) => {
      client.end(`HTTP/1.1 ${status} Denied\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
    };
    try {
      const url = new URL(req.url || '/', 'http://local.invalid'); const match = url.pathname.match(ROUTE);
      if (!match || match[3] !== 'socket' || req.method !== 'GET') return reject(404);
      const [,runId,sessionId] = match;
      const identity = authorizeViewer(req,runId,true,this.env);
      const key = String(req.headers['sec-websocket-key'] || '');
      if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || req.headers['sec-websocket-version'] !== '13' || String(req.headers.upgrade).toLowerCase() !== 'websocket') return reject(400);
      if (head.length > 65536) return reject(413);
      this.tickets.consume(url.searchParams.get('ticket') || '',identity,runId,sessionId);
      const session = getDesktop(sessionId);
      if (!session || session.view.run_id !== runId) return reject(410);
      if (session.sockets.size >= 8) return reject(429);
      const upstream = net.connect({path:session.socketPath});
      session.sockets.add(client); session.sockets.add(upstream);
      client.setNoDelay(true); upstream.setNoDelay(true);
      let connected = false;
      const timeout = setTimeout(() => {if(!connected) reject(502); upstream.destroy();},5000);
      // Reauthentication is bounded even if the auth-proxy session is revoked mid-stream.
      const authExpiry = setTimeout(() => {client.destroy();upstream.destroy();},300000); authExpiry.unref();
      const cleanup = () => {clearTimeout(timeout);clearTimeout(authExpiry);session.sockets.delete(client);session.sockets.delete(upstream);client.destroy();upstream.destroy();};
      client.once('error',cleanup); upstream.once('error',cleanup);client.once('close',cleanup);upstream.once('close',cleanup);
      upstream.once('connect', () => {
        clearTimeout(timeout); connected = true;
        if (session.closed) return cleanup();
        // Do not forward auth cookies, proxy secrets, URI tickets or arbitrary headers to VNC.
        const protocol = String(req.headers['sec-websocket-protocol'] || '').split(',').map(x=>x.trim());
        const protocolHeader = protocol.includes('binary') ? 'Sec-WebSocket-Protocol: binary\r\n' : '';
        upstream.write(`GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n${protocolHeader}\r\n`);
        if(head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client); // Node stream backpressure, no unbounded frame queue
      });
    } catch (error) { reject(error instanceof ViewerDenied ? error.status : 500); }
  }
}
export const liveBrowserGateway = new LiveBrowserGateway();
