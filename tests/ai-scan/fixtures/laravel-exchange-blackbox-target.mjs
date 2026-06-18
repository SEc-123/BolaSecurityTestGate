import http from 'http';
import fs from 'fs';
import path from 'path';

const port = Number(process.env.PORT || 3330);
const sourceDir = process.env.TARGET_SOURCE_DIR || '/mnt/data/work/target';
const uploads = new Map();
const issuedCodes = new Map();
const tokens = new Map([
  ['token-attacker', { id: 'attacker-alice', role: 'user', order_id: '1001' }],
  ['token-victim', { id: 'victim-bob', role: 'user', order_id: '2002' }],
  ['token-admin', { id: 'admin-root', role: 'admin', order_id: '9001' }],
]);

function readRouteFiles() {
  const routesDir = path.join(sourceDir, 'routes');
  const out = [];
  if (!fs.existsSync(routesDir)) return out;
  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith('.php')) continue;
    const text = fs.readFileSync(path.join(routesDir, file), 'utf8');
    const prefix = file.includes('appapi') ? '/api/app' : file.endsWith('_api.php') ? '/api' : '';
    const re = /\$api->(get|post|any|resource)\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text))) {
      let route = m[2].replace(/^\/+/, '');
      if (!route || route.includes('{')) continue;
      const method = m[1] === 'any' ? 'GET' : m[1].toUpperCase();
      out.push({ method, path: `${prefix}/${route}`.replace(/\/+/g, '/') });
    }
  }
  return [...new Map(out.map(r => [`${r.method}:${r.path}`, r])).values()];
}

const routes = readRouteFiles();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
function parseQueryAndJson(req, url, bodyBuf) {
  const out = Object.fromEntries(url.searchParams.entries());
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/json') && bodyBuf.length) {
    try { Object.assign(out, JSON.parse(bodyBuf.toString('utf8'))); } catch {}
  }
  if (ct.includes('application/x-www-form-urlencoded') && bodyBuf.length) {
    Object.assign(out, Object.fromEntries(new URLSearchParams(bodyBuf.toString('utf8')).entries()));
  }
  return out;
}
function authUser(req) {
  const h = String(req.headers.authorization || '');
  const token = h.replace(/^Bearer\s+/i, '');
  return tokens.get(token) || null;
}
function parseMultipart(req, bodyBuf) {
  const contentType = String(req.headers['content-type'] || '');
  const boundary = (contentType.match(/boundary=(.+)$/) || [])[1];
  if (!boundary) return [];
  return bodyBuf.toString('binary').split('--' + boundary).filter(p => p.includes('Content-Disposition')).map(p => {
    const name = (p.match(/name="([^"]+)"/) || [])[1] || 'file';
    const filename = (p.match(/filename="([^"]*)"/) || [])[1] || '';
    const ct = (p.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || 'text/plain';
    const body = p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
    return { name, filename, contentType: ct, body: Buffer.from(body, 'binary') };
  });
}
function routeInputs(routePath) {
  if (/uploadImage|upload|avatar|image/i.test(routePath)) return '<input type="file" name="file"><input name="type" value="avatar">';
  if (/paypwd|payPwd|setOrResetPaypwd|passcode|payment.*password|trade.*password/i.test(routePath)) return '<input name="amount" value="10"><input name="paypwd" value="123456"><input name="passcode" value="123456">';
  if (/send(Sms|Email).*Code|send.*Code|loginConfirm|verify|password|bind|unbind|Google/i.test(routePath)) return '<input name="account" value="attacker@example.test"><input name="code" value="123456"><input name="password" value="Password123!">';
  if (/login|register/i.test(routePath)) return '<input name="account" value="attacker@example.test"><input name="password" value="Password123!">';
  if (/dataoperate|ping|host|domain/i.test(routePath)) return '<input name="host" value="127.0.0.1">';
  if (/download|export|file/i.test(routePath)) return '<input name="file" value="report.txt">';
  if (/article|contact|notice|help|college|category|service|search/i.test(routePath)) return '<input name="q" value="hello"><input name="content" value="hello">';
  if (/order|Entrust|entrust|commission|withdraw|transfer|wallet|otc|legal|option|contract|exchange/i.test(routePath)) return '<input name="id" value="1001"><input name="order_id" value="1001"><input name="amount" value="1"><input name="quantity" value="1">';
  if (/admin|user/i.test(routePath)) return '<input name="id" value="attacker-alice"><input name="role" value="user">';
  return '<input name="id" value="1001">';
}
function routeQuery(routePath) {
  if (/dataoperate|ping|host|domain/i.test(routePath)) return '?host=127.0.0.1';
  if (/download|export|file/i.test(routePath)) return '?file=report.txt';
  if (/article|contact|notice|help|college|category|service|search/i.test(routePath)) return '?q=hello';
  if (/paypwd|payPwd|setOrResetPaypwd|passcode|payment.*password|trade.*password/i.test(routePath)) return '?amount=10&paypwd=123456&passcode=123456';
  if (/order|Entrust|entrust|commission|withdraw|transfer|wallet|otc|legal|option|contract|exchange/i.test(routePath)) return '?id=1001&amount=1&quantity=1';
  if (/admin|user/i.test(routePath)) return '?id=attacker-alice&role=user';
  return '?id=1001';
}
function routeIndexHtml() {
  const prioritized = routes.filter(r => /uploadImage|sendSms|sendEmail|login|register|paypwd|Paypwd|passcode|password|article\/detail|orderDetail|cancelOrder|withdraw|transfer|dataoperate|contactUs|option|exchange|wallet|user\/getUserInfo|user\/updateUserInfo|otc|contract|admin|help|notice/i.test(r.path)).slice(0, 120);
  const links = prioritized.map(r => r.method === 'GET'
    ? `<a href="${r.path}${routeQuery(r.path)}">${r.method} ${r.path}</a>`
    : `<form method="POST" action="${r.path}" ${/uploadImage|upload|avatar|image/i.test(r.path) ? 'enctype="multipart/form-data"' : ''}>${routeInputs(r.path)}<button>${r.method} ${r.path}</button></form>`).join('\n');
  const js = prioritized.slice(0, 70).map(r => `fetch('${r.path}${r.method === 'GET' ? routeQuery(r.path) : ''}', {method: '${r.method === 'GET' ? 'GET' : 'POST'}'}).catch(()=>{});`).join('\n');
  return `<!doctype html><title>Laravel Exchange Blackbox Harness</title><h1>Laravel Exchange Blackbox Harness</h1><p>Source-derived routes: ${routes.length}</p>
  <a href="/admin/users?role=user">admin users</a>
  <a href="/api/download?file=report.txt">download file</a>
  <a href="/api/dataoperate?host=127.0.0.1">debug dataoperate</a>
  <a href="/api/otc/orderDetail?id=1001">otc order detail</a>
  <a href="/api/search?q=hello">search</a>
  <form method="POST" action="/api/uploadImage" enctype="multipart/form-data"><input type="file" name="file"><input name="type" value="avatar"><button>uploadImage</button></form>
  ${links}<script>${js}</script>`;
}
function maybeDangerousFilePath(f) { return f.includes('..') || f.includes('/etc/passwd') || f.includes('..%2f') || f.includes('passwd'); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const body = await readBody(req);
  const params = parseQueryAndJson(req, url, body);
  const pathName = url.pathname;

  if (req.method === 'GET' && pathName === '/') return send(res, 200, routeIndexHtml());
  if (req.method === 'GET' && pathName === '/health') return json(res, 200, { ok: true, route_count: routes.length, source: sourceDir });

  if (req.method === 'POST' && /send(Sms|Email).*Code|send.*Code/i.test(pathName)) {
    const account = params.account || params.email || params.phone || 'attacker@example.test';
    issuedCodes.set(account, '123456');
    return json(res, 200, { code: 0, message: 'sent', data: { account, code: '123456', ticket: 'ticket-' + account } });
  }
  if (req.method === 'POST' && /user\/register|agent\/register/i.test(pathName)) {
    return json(res, 200, { code: 0, message: 'registered', data: { user_id: 'attacker-alice', token: 'token-attacker' } });
  }
  if (req.method === 'POST' && /user\/login$/i.test(pathName)) {
    res.setHeader('set-cookie', 'laravel_session=session-attacker; Path=/; HttpOnly');
    return json(res, 200, { code: 0, message: 'login ok', data: { token: 'token-attacker', user_id: 'attacker-alice' } });
  }
  if (req.method === 'POST' && /loginConfirm/i.test(pathName)) {
    return json(res, 200, { code: 0, message: 'confirmed without strict otp binding', data: { token: 'token-attacker', confirmed: true } });
  }
  if (req.method === 'POST' && /logout/i.test(pathName)) return json(res, 200, { code: 0, message: 'logout ok' });

  if (req.method === 'POST' && /uploadImage|upload|avatar|image/i.test(pathName)) {
    const parts = parseMultipart(req, body);
    const file = parts.find(p => p.filename) || { filename: 'upload.bin', contentType: 'application/octet-stream', body: Buffer.from('') };
    const safeName = file.filename.replace(/^.*[\\/]/, '');
    uploads.set(safeName, { contentType: file.contentType, body: file.body });
    return json(res, 200, { code: 0, message: 'uploaded', data: { url: '/uploads/' + safeName, avatar_url: '/uploads/' + safeName, path: '/uploads/' + safeName, filename: file.filename } });
  }
  if (req.method === 'GET' && pathName.startsWith('/uploads/')) {
    const name = decodeURIComponent(pathName.split('/').pop() || '');
    const file = uploads.get(name);
    if (!file) return send(res, 404, 'missing');
    res.writeHead(200, { 'content-type': file.contentType });
    return res.end(file.body);
  }
  if (req.method === 'GET' && /download|rechargeManualLog|export|file/i.test(pathName)) {
    const f = String(params.file || params.path || params.filename || 'report.txt');
    if (maybeDangerousFilePath(f)) return send(res, 200, 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin', { 'content-type': 'text/plain' });
    return send(res, 200, 'exchange report file', { 'content-type': 'text/plain' });
  }
  if (req.method === 'GET' && /dataoperate|ping|host|domain/i.test(pathName)) {
    const host = String(params.host || params.cmd || '127.0.0.1');
    if (/[;|`$]/.test(host)) return send(res, 200, 'PING exchange\nuid=1000(exchange) gid=1000(exchange) groups=1000(exchange)', { 'content-type': 'text/plain' });
    return send(res, 200, 'PING ' + host + ' ok', { 'content-type': 'text/plain' });
  }
  if (req.method === 'GET' && /search|article\/detail|help|contact|notice|college|category|services|marketDynamics/i.test(pathName)) {
    const q = String(params.q || params.keyword || params.title || params.content || params.id || 'hello');
    return send(res, 200, `<title>Exchange Content</title><div>${q}</div>`);
  }
  if (/admin/i.test(pathName)) {
    const user = authUser(req);
    if (!user || user.role !== 'admin') return json(res, 200, { code: 0, admin: true, message: 'admin function accessible without admin role', users: [{ id: 1, email: 'admin@example.com' }] });
    return json(res, 200, { code: 0, admin: true, users: [{ id: 1, email: 'admin@example.com' }] });
  }
  if (/order|Entrust|entrust|commission|withdraw|transfer|wallet|otc|legal|option|contract|exchange/i.test(pathName)) {
    const id = String(params.id || params.order_id || params.entrust_id || '1001');
    const amount = Number(params.amount || params.quantity || '1');
    if (amount < 0) return json(res, 200, { code: 0, ok: true, amount, total: -100, message: 'negative quantity accepted' });
    if (id === '2002' || /victim/i.test(id)) return json(res, 200, { code: 0, data: { id: '2002', owner: 'victim-bob', amount: 999, secret: 'other user order exposed' } });
    return json(res, 200, { code: 0, data: { id, owner: 'attacker-alice', amount: Math.max(1, amount) } });
  }
  if (/paypwd|payPwd|setOrResetPaypwd|passcode|payment.*password|trade.*password/i.test(pathName)) {
    const code = String(params.passcode || params.paypwd || params.password || '');
    if (['000000','123456',''].includes(code)) return json(res, 200, { code: 0, ok: true, passcode_verified: true, message: 'passcode bypass accepted', data: { token: 'token-attacker' } });
    return json(res, 403, { code: 403, ok: false, message: 'bad passcode' });
  }
  if (/user\/getUserInfo|user\/updateUserInfo|user\/security|bind|unbind|verify|password|Google/i.test(pathName)) {
    const user = authUser(req) || { id: 'attacker-alice', role: 'user' };
    if (String(params.id || '').includes('victim')) return json(res, 200, { code: 0, data: { id: 'victim-bob', email: 'victim@example.test', secret: 'other user profile exposed' } });
    return json(res, 200, { code: 0, data: { id: user.id, email: 'attacker@example.test', verified: true } });
  }
  if (routes.some(r => r.path === pathName || r.path.replace(/\{id\}/g, '1') === pathName)) return json(res, 200, { code: 0, message: 'source-derived placeholder', path: pathName, params });
  return send(res, 404, 'not found');
});

server.listen(port, '127.0.0.1', () => console.log(`laravel-exchange-blackbox http://127.0.0.1:${port} source=${sourceDir} routes=${routes.length}`));
