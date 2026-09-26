/** Test-only stateful HTTPS service; no HTTP listener and no insecure TLS switch. */
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export function createLabBackend({ key, cert, password }) {
  if (!password) throw new Error('Explicit test password required.');
  const sessions = new Set();
  return https.createServer({ key, cert, minVersion: 'TLSv1.2' }, async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 65536) return json(413, { error: 'too_large' }); }
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (req.method === 'POST' && req.url === '/login') {
        let body; try { body = JSON.parse(text); } catch { return json(400, { error: 'invalid_json' }); }
        if (body.username !== 'alice' || body.password !== password) return json(401, { error: 'invalid_credentials' });
        const token = randomUUID(); sessions.add(token); return json(200, { token, user: { id: 'alice' } });
      }
      if (req.method === 'GET' && req.url === '/profile') {
        if (!token || !sessions.has(token)) return json(401, { error: 'unauthorized' });
        return json(200, { user: { id: 'alice' }, authenticated: true });
      }
      if (req.method === 'POST' && req.url === '/logout') {
        if (!token || !sessions.delete(token)) return json(401, { error: 'unauthorized' });
        return json(200, { logged_out: true });
      }
      return json(404, { error: 'not_found' });
    } catch { if (!res.headersSent) json(400, { error: 'request_failed' }); else res.destroy(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const read = name => { if (!process.env[name]) throw new Error(`Missing ${name}`); return fs.readFile(process.env[name]); };
  const server = createLabBackend({ key: await read('BSTG_LAB_TLS_KEY'), cert: await read('BSTG_LAB_TLS_CERT'), password: process.env.BSTG_LAB_PASSWORD });
  server.listen(Number(process.env.BSTG_LAB_PORT || 9443), process.env.BSTG_LAB_BIND || '127.0.0.1', () => console.log('Authorized HTTPS lab listening; only exposed interfaces you explicitly configured.'));
}
