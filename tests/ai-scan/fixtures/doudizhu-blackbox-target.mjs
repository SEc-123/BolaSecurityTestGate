#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const port = Number(process.env.PORT || 3360);
const sourceDir = process.env.TARGET_SOURCE_DIR || path.join(os.homedir(), 'Downloads', '\u6597\u5730\u4e3b\u5c0f\u6e38\u620f\u6e90\u7801');
const uploads = new Map();
const sessions = new Map([
  ['session-attacker', { id: '1', name: 'alice', role: 'member', room_id: '1001' }],
  ['session-victim', { id: '2', name: 'bob', role: 'member', room_id: '2002' }],
  ['session-admin', { id: '99', name: 'admin', role: 'admin', room_id: '9001' }],
]);

function readPhpRoutes() {
  const controllerRoot = path.join(sourceDir, 'server', 'controller');
  const routes = [];
  if (!fs.existsSync(controllerRoot)) return routes;
  for (const area of ['index', 'admin', 'install']) {
    const dir = path.join(controllerRoot, area);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.php'))) {
      const controller = file.replace(/\.php$/, '');
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      const functions = [...text.matchAll(/public\s+static\s+function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)].map(match => match[1]);
      for (const fn of functions) {
        const method = /init|read|warn|captcha/.test(fn) ? 'GET' : 'POST';
        const prefix = area === 'index' ? '/index.php' : `/index.php/${area}`;
        routes.push({ method, path: `${prefix}/${controller}/${fn}`.replace(/\/+/g, '/') });
        if (fn === 'init') routes.push({ method: 'GET', path: `${prefix}/${controller}`.replace(/\/+/g, '/') });
      }
    }
  }
  const extras = [
    { method: 'GET', path: '/index.php/admin/update/down' },
    { method: 'GET', path: '/index.php/admin/command/exec' },
    { method: 'POST', path: '/index.php/hall/upload' },
    { method: 'POST', path: '/index.php/hall/pw' },
    { method: 'POST', path: '/index.php/hall/put' },
    { method: 'POST', path: '/index.php/hall/get' },
    { method: 'POST', path: '/index.php/room/play' },
  ];
  return [...new Map([...routes, ...extras].map(route => [`${route.method}:${route.path}`, route])).values()];
}

const routes = readPhpRoutes();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseMultipart(req, body) {
  const contentType = String(req.headers['content-type'] || '');
  const boundary = (contentType.match(/boundary=(.+)$/) || [])[1];
  if (!boundary) return [];
  return body.toString('binary').split(`--${boundary}`)
    .filter(part => part.includes('Content-Disposition'))
    .map(part => {
      const name = (part.match(/name="([^"]+)"/) || [])[1] || 'file';
      const filename = (part.match(/filename="([^"]*)"/) || [])[1] || '';
      const partType = (part.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || 'text/plain';
      const value = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      return { name, filename, contentType: partType, value, body: Buffer.from(value, 'binary') };
    });
}

function parseParams(req, url, body) {
  const out = Object.fromEntries(url.searchParams.entries());
  const contentType = String(req.headers['content-type'] || '');
  if (contentType.includes('application/json') && body.length) {
    try { Object.assign(out, JSON.parse(body.toString('utf8'))); } catch {}
  } else if (contentType.includes('application/x-www-form-urlencoded') && body.length) {
    Object.assign(out, Object.fromEntries(new URLSearchParams(body.toString('utf8')).entries()));
  } else if (contentType.includes('multipart/form-data')) {
    for (const part of parseMultipart(req, body)) {
      if (!part.filename) out[part.name] = part.value.trim();
    }
  }
  return out;
}

function currentUser(req) {
  const cookie = String(req.headers.cookie || '');
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token === 'token-admin') return sessions.get('session-admin');
  if (token === 'token-victim') return sessions.get('session-victim');
  if (token === 'token-attacker') return sessions.get('session-attacker');
  const member = (cookie.match(/member=([^;]+)/) || [])[1];
  const account = (cookie.match(/account=([^;]+)/) || [])[1];
  return sessions.get(member) || sessions.get(account) || sessions.get('session-attacker');
}

function query(pathname, params) {
  const search = new URLSearchParams(params).toString();
  return `${pathname}?${search}`;
}

function routeLink(route) {
  const p = route.path;
  if (/upload/i.test(p)) return '';
  if (/update\/down|read|file|download|flush|plant/i.test(p)) return `<a href="${query(p, { file: 'report.txt', path: 'report.txt' })}">GET ${p} file download</a>`;
  if (/command\/exec/i.test(p)) return `<a href="${query(p, { host: '127.0.0.1', cmd: 'ping' })}">GET ${p} command check</a>`;
  if (/score|member|account|order/i.test(p)) return `<a href="${query(p, { id: '1', mid: '1', role: 'user' })}">GET ${p} object access</a>`;
  return `<a href="${query(p, { id: '1001', q: 'hello', amount: '1', quantity: '1' })}">GET ${p}</a>`;
}

function routeForm(route) {
  const p = route.path;
  if (/upload/i.test(p)) {
    return `<form method="POST" enctype="multipart/form-data" action="${p}"><input type="file" name="avatar"><input name="token" value="session-attacker"><button>POST ${p} avatar upload</button></form>`;
  }
  if (/sign|reg|lost|send|captcha|login/i.test(p)) {
    return `<form method="POST" action="${p}"><input name="name" value="alice"><input name="password" value="AlicePass123"><input name="captcha" value="123456"><input name="code" value="123456"><input name="email" value="alice@example.test"><button>POST ${p} auth captcha otp</button></form>`;
  }
  if (/pw|pass|command\/exec/i.test(p)) {
    return `<form method="POST" action="${p}"><input name="member_mpw" value="AlicePass123"><input name="member_rpw" value="NewPass123"><input name="passcode" value="123456"><input name="host" value="127.0.0.1"><button>POST ${p} password passcode command</button></form>`;
  }
  if (/buy|gift|put|get|fast|ready|lord|play|quit|kick|talk|room|hall/i.test(p)) {
    return `<form method="POST" action="${p}"><input name="id" value="1001"><input name="rid" value="1001"><input name="room_id" value="1001"><input name="amount" value="1"><input name="quantity" value="1"><input name="order_id" value="1001"><input name="status" value="ready"><button>POST ${p} game room order amount</button></form>`;
  }
  if (/admin|member|account|manage|param/i.test(p)) {
    return `<form method="POST" action="${p}"><input name="id" value="1"><input name="role" value="user"><input name="is_admin" value="false"><input name="content" value="hello"><button>POST ${p} admin role object</button></form>`;
  }
  return `<form method="POST" action="${p}"><input name="id" value="1001"><input name="content" value="hello"><button>POST ${p}</button></form>`;
}

function indexPage() {
  const prioritized = routes
    .filter(route => /sign|reg|send|login|captcha|upload|update\/down|command\/exec|member|account|manage|score|buy|gift|put|get|fast|ready|lord|play|room|hall|param|pw/i.test(route.path))
    .slice(0, 120);
  const links = prioritized.map(route => route.method === 'GET' ? routeLink(route) : routeForm(route)).filter(Boolean).join('\n');
  const js = prioritized.slice(0, 80).map(route => {
    const target = route.method === 'GET'
      ? query(route.path, { id: '1001', file: 'report.txt', host: '127.0.0.1', amount: '1', quantity: '1' })
      : route.path;
    return `fetch('${target}', { method: '${route.method}', headers: {'content-type':'application/json'}, body: ${route.method === 'GET' ? 'undefined' : "JSON.stringify({id:'1001',amount:'1',quantity:'1',role:'user',code:'123456',passcode:'123456',content:'hello'})"} }).catch(()=>{});`;
  }).join('\n');
  return `<!doctype html>
    <title>Doudizhu Source-Derived Blackbox Target</title>
    <h1>Doudizhu Source-Derived Blackbox Target</h1>
    <p>Source: ${sourceDir}</p>
    <p>Routes: ${routes.length}</p>
    <form method="POST" action="/index.php/hall/info"><input name="member_nick" value="alice"><input name="content" value="hello"><button>profile content xss</button></form>
    ${links}
    <script>${js}</script>`;
}

function hasTraversal(value) {
  return /\.\.|passwd|win\.ini|%2f|%5c/i.test(String(value || ''));
}

function hasCommand(value) {
  return /[;|`$]|\$\(.*\)|\bid\b|whoami/i.test(String(value || ''));
}

function hasXss(value) {
  return /<script|onerror=|onload=|<svg/i.test(String(value || ''));
}

function weakCode(value) {
  return ['', '000000', '1111', '123456', '{{previous_code}}', '{{victim_otp_code}}', '{{omit_ticket}}', '{{omit_passcode}}', 'true'].includes(String(value ?? ''));
}

function vulnerableBusiness(params) {
  const amount = Number(params.amount ?? params.quantity ?? params.price ?? '1');
  return amount < 0 || ['paid', 'refunded', 'cancelled'].includes(String(params.status || '').toLowerCase());
}

function handleUpload(req, res, body) {
  const parts = parseMultipart(req, body);
  const file = parts.find(part => part.filename) || { filename: 'empty.bin', contentType: 'application/octet-stream', body: Buffer.from('') };
  const safeName = file.filename.replace(/^.*[\\/]/, '').replace(/\.\./g, 'traversal');
  uploads.set(safeName, { contentType: file.contentType, body: file.body });
  json(res, 200, {
    state: 1,
    message: 'uploaded avatar without strict file type validation',
    url: `/uploads/${encodeURIComponent(safeName)}`,
    avatar_url: `/uploads/${encodeURIComponent(safeName)}`,
    filename: file.filename,
    accepted: true,
  });
}

function handleRoute(req, res, pathname, params, body) {
  const user = currentUser(req);
  const haystack = `${pathname} ${JSON.stringify(params)}`;

  if (/upload/i.test(pathname)) return handleUpload(req, res, body);

  if (/update\/down|download|file|read|flush|plant/i.test(pathname)) {
    const file = params.file || params.path || params.filename || params.id;
    if (hasTraversal(file)) return text(res, 200, 'root:x:0:0:root:/root:/bin/bash\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin');
    return text(res, 200, 'doudizhu report file for game operations');
  }

  if (/command\/exec/i.test(pathname)) {
    const host = params.host || params.cmd || params.id || '127.0.0.1';
    if (hasCommand(host)) return text(res, 200, 'PING doudizhu\nuid=1000(doudizhu) gid=1000(doudizhu) groups=1000(doudizhu)');
    return text(res, 200, `PING ${host} ok`);
  }

  if (/admin|manage|account|member|param/i.test(pathname)) {
    const elevated = params.role === 'admin' || params.is_admin === 'true' || params.id === '1' || user?.role !== 'admin';
    if (elevated) {
      return json(res, 200, { state: 1, admin: true, message: 'admin function accessible without admin role', users: [{ id: 99, email: 'admin@example.com' }] });
    }
  }

  if (/sign|reg|lost|send|captcha|login|verify|password/i.test(pathname)) {
    const code = params.code ?? params.captcha ?? params.passcode ?? params.id ?? '';
    if (weakCode(code)) return json(res, 200, { state: 1, message: 'otp code accepted without strict binding', login_success: true, token: 'token-attacker', code });
    return json(res, 403, { state: -2, message: 'bad code' });
  }

  if (/pw|passcode|paypwd/i.test(haystack)) {
    const code = params.passcode ?? params.member_mpw ?? params.id ?? '';
    if (weakCode(code)) return json(res, 200, { state: 1, passcode_verified: true, token: 'token-attacker', message: 'passcode bypass accepted' });
    return json(res, 403, { state: -2, message: 'bad passcode' });
  }

  if (/score|order|room|hall|buy|gift|put|get|fast|ready|lord|play|kick|quit|talk/i.test(pathname)) {
    const id = String(params.id || params.mid || params.rid || params.room_id || params.order_id || '1001');
    if (id === '2' || id === '2002' || /victim/i.test(id)) {
      return json(res, 200, { state: 1, data: { id: '2002', owner: 'victim-bob', room_id: '2002', secret: 'other user room exposed' } });
    }
    if (vulnerableBusiness(params)) {
      return json(res, 200, { state: 1, ok: true, message: 'negative quantity accepted and replayed into game room', total: -100, race_window: true });
    }
    return json(res, 200, { state: 1, data: { id, owner: user?.name || 'alice', room_id: id, amount: Number(params.amount || 1) } });
  }

  const reflected = params.q || params.content || params.member_nick || params.title || '';
  if (hasXss(reflected)) return html(res, 200, `<title>Doudizhu reflected content</title><div>${reflected}</div>`);
  if (/info|search|notice|index/i.test(pathname)) return html(res, 200, `<title>Doudizhu page</title><div>${reflected || 'hello'}</div>`);

  json(res, 200, { state: 1, path: pathname, params, source_derived: true });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const body = await readBody(req);
    const params = parseParams(req, url, body);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, route_count: routes.length, source: sourceDir });
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.php')) return html(res, 200, indexPage());
    if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
      const name = decodeURIComponent(pathname.split('/').pop() || '');
      const file = uploads.get(name);
      if (!file) return text(res, 404, 'missing upload');
      res.writeHead(200, { 'content-type': file.contentType });
      return res.end(file.body);
    }
    if (routes.some(route => route.path === pathname) || pathname.startsWith('/index.php/')) {
      return handleRoute(req, res, pathname, params, body);
    }
    return text(res, 404, 'not found');
  } catch (error) {
    return json(res, 500, { error: error.message || String(error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`doudizhu-blackbox http://127.0.0.1:${port} source=${sourceDir} routes=${routes.length}`);
});
