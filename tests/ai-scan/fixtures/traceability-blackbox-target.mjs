#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const port = Number(process.env.PORT || 3370);
const sourceDir = process.env.TARGET_SOURCE_DIR || path.join(
  os.homedir(),
  'Downloads',
  '\u9632\u4f2a\u8ffd\u6eaf\u7cfb\u7edf\u4ea7\u54c1\u6eaf\u6e90\u7cfb\u7edf\u5fae\u5546\u57ce\u6eaf\u6e90\u7cfb\u7edf\u5de5\u4e1a\u4ea7\u54c1\u8ffd\u6eaf\u98df\u54c1\u8ffd\u6eaf\u4e00\u7269\u4e00\u7801\u6570\u5b57\u5316\u5e94\u7528\u5e73\u53f0',
);

const uploads = new Map();
const sessions = new Map([
  ['session-agent', { id: '1', username: '18888888888', role: 'agent', code: 'EW2020093083', txm: 'FW202009300001' }],
  ['session-victim', { id: '2', username: 'victim-agent', role: 'agent', code: 'EW2020093099', txm: 'FW202009300099' }],
  ['session-admin', { id: '99', username: 'admin', role: 'admin', code: 'ADMIN', txm: 'FW202009300999' }],
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const itemPath = path.join(dir, entry.name);
    const rel = path.relative(sourceDir, itemPath);
    if (entry.isDirectory()) {
      if (/\/?(themes\/manage\/assets\/advanced-datatable|upload|font|install\/layer)/.test(rel)) continue;
      walk(itemPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.php')) out.push(itemPath);
  }
  return out;
}

function parseTables() {
  const sqlPath = path.join(sourceDir, 'install', 'install.sql');
  if (!fs.existsSync(sqlPath)) return [];
  const text = fs.readFileSync(sqlPath, 'utf8');
  return [...text.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)`/g)].map(match => match[1]);
}

function readPhpRoutes() {
  const files = walk(sourceDir);
  const routes = [];
  for (const file of files) {
    const rel = `/${path.relative(sourceDir, file).replaceAll(path.sep, '/')}`;
    const base = path.basename(file);
    const text = fs.readFileSync(file, 'utf8');
    const hasWrite = /\$_POST|move_uploaded_file|insert\s+into|update\s+|delete\s+|unlink|fopen|file_put_contents/i.test(text);
    const hasRead = /\$_GET|select\s+|echo|require|include|header/i.test(text);
    if (hasRead || !hasWrite) routes.push({ method: 'GET', path: rel });
    if (hasWrite || /add|edit|del|import|upload|login|set|fh|th|zt|install|dbmanage|export/i.test(base)) {
      routes.push({ method: 'POST', path: rel });
    }
  }
  const extras = [
    { method: 'GET', path: '/manage/dbmanage.php' },
    { method: 'POST', path: '/manage/dbmanage.php' },
    { method: 'GET', path: '/manage/export.php' },
    { method: 'GET', path: '/manage/export_all.php' },
    { method: 'POST', path: '/manage/import_fwm.php' },
    { method: 'POST', path: '/manage/import_agent.php' },
    { method: 'POST', path: '/agent/fahuo_zx.php' },
    { method: 'POST', path: '/agent/tuihuo_zx.php' },
    { method: 'GET', path: '/ts/fwm_ts.php' },
    { method: 'GET', path: '/ts/fwm_ts_wap.php' },
    { method: 'GET', path: '/q.php' },
    { method: 'GET', path: '/txm.php' },
  ];
  return [...new Map([...routes, ...extras].map(route => [`${route.method}:${route.path}`, route])).values()]
    .sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
}

const routes = readPhpRoutes();
const tables = parseTables();

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
  if (token === 'token-agent') return sessions.get('session-agent');
  const session = (cookie.match(/(?:admin|agent|session)=([^;]+)/) || [])[1];
  return sessions.get(session) || sessions.get('session-agent');
}

function query(pathname, params) {
  const search = new URLSearchParams(params).toString();
  return `${pathname}?${search}`;
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
  return ['', '000000', '1111', '123456', 'admin888', '{{previous_code}}', '{{victim_otp_code}}', '{{omit_ticket}}', '{{omit_passcode}}', 'true'].includes(String(value ?? ''));
}

function routeInputs(routePath) {
  if (/upload|upload_pic|editor/i.test(routePath)) return '<input type="file" name="file"><input name="dir" value="image">';
  if (/dbmanage|export|file|backup|down|download/i.test(routePath)) return '<input name="file" value="dbback/bf.sql"><input name="path" value="dbback/bf.sql"><input name="host" value="127.0.0.1"><input name="cmd" value="backup">';
  if (/login|qrcode|admin|session|password/i.test(routePath)) return '<input name="username" value="admin"><input name="password" value="admin888"><input name="code" value="123456"><input name="captcha" value="123456">';
  if (/fahuo|tuihuo|box|zbox|code|fwm|txm|suyuan|lc|cp|pro/i.test(routePath)) return '<input name="id" value="1"><input name="txm" value="FW202009300001"><input name="box" value="BOX2020093001"><input name="agentid" value="EW2020093083"><input name="amount" value="1"><input name="status" value="fahuo">';
  if (/agent|dljb/i.test(routePath)) return '<input name="id" value="1"><input name="phone" value="18888888888"><input name="agentid" value="EW2020093083"><input name="role" value="agent">';
  return '<input name="id" value="1"><input name="keyword" value="hello"><input name="content" value="hello">';
}

function routeForm(route) {
  const p = route.path;
  const multipart = /upload|upload_pic|editor/i.test(p) ? ' enctype="multipart/form-data"' : '';
  return `<form method="POST"${multipart} action="${p}">${routeInputs(p)}<button>POST ${p}</button></form>`;
}

function routeLink(route) {
  const p = route.path;
  if (/upload/i.test(p)) return '';
  if (/dbmanage|export|file|backup|down|download/i.test(p)) return `<a href="${query(p, { file: 'dbback/bf.sql', path: 'dbback/bf.sql', host: '127.0.0.1', cmd: 'backup' })}">GET ${p} export backup file</a>`;
  if (/q\.php|txm|fwm|suyuan|code|ts\//i.test(p)) return `<a href="${query(p, { fwm: 'FW202009300001', txm: 'FW202009300001', id: '1', keyword: 'hello' })}">GET ${p} trace code query</a>`;
  if (/agent|fahuo|tuihuo|box|zbox/i.test(p)) return `<a href="${query(p, { id: '1', txm: 'FW202009300001', agentid: 'EW2020093083', amount: '1' })}">GET ${p} agent logistics state</a>`;
  if (/manage|admin/i.test(p)) return `<a href="${query(p, { id: '1', role: 'agent', checkper: 'yes' })}">GET ${p} management role access</a>`;
  return `<a href="${query(p, { id: '1', keyword: 'hello', content: 'hello' })}">GET ${p}</a>`;
}

function indexPage() {
  const prioritized = routes
    .filter(route => /q\.php|txm|fwm|code|suyuan|agent|fahuo|tuihuo|box|zbox|upload|dbmanage|export|import|login|admin|manage|set|add|edit|del|lc|cp|pro|ts\//i.test(route.path))
    .slice(0, 150);
  const links = prioritized.map(route => route.method === 'GET' ? routeLink(route) : routeForm(route)).filter(Boolean).join('\n');
  const js = prioritized.slice(0, 90).map(route => {
    const target = route.method === 'GET'
      ? query(route.path, { id: '1', fwm: 'FW202009300001', txm: 'FW202009300001', file: 'dbback/bf.sql', keyword: 'hello', host: '127.0.0.1' })
      : route.path;
    const body = "{id:'1',txm:'FW202009300001',agentid:'EW2020093083',amount:'1',status:'fahuo',code:'123456',password:'admin888',content:'hello'}";
    return `fetch('${target}', { method: '${route.method}', headers: {'content-type':'application/json'}, body: ${route.method === 'GET' ? 'undefined' : `JSON.stringify(${body})`} }).catch(()=>{});`;
  }).join('\n');
  return `<!doctype html>
    <title>Traceability Source-Derived Blackbox Target</title>
    <h1>Traceability Source-Derived Blackbox Target</h1>
    <p>Source: ${sourceDir}</p>
    <p>Routes: ${routes.length}</p>
    <p>Tables: ${tables.join(', ')}</p>
    <form method="POST" action="/manage/upload_pic.php" enctype="multipart/form-data"><input type="file" name="file"><input name="dir" value="image"><button>upload product image</button></form>
    <a href="/q.php?fwm=FW202009300001&keyword=hello">public anti-counterfeit code lookup</a>
    <a href="/ts/fwm_ts.php?txm=FW202009300001&content=hello">trace mobile lookup</a>
    <a href="/manage/dbmanage.php?file=dbback/bf.sql&host=127.0.0.1">database backup download</a>
    <form method="POST" action="/agent/fahuo_zx.php"><input name="txm" value="FW202009300001"><input name="agentid" value="EW2020093083"><input name="amount" value="1"><button>agent ship code</button></form>
    ${links}
    <script>${js}</script>`;
}

function handleUpload(req, res, body) {
  const parts = parseMultipart(req, body);
  const file = parts.find(part => part.filename) || { filename: 'trace.html', contentType: 'text/html', body: Buffer.from('<script>alert(1337)</script>') };
  const safeName = file.filename.replace(/^.*[\\/]/, '').replace(/\.\./g, 'traversal');
  uploads.set(safeName, { contentType: file.contentType, body: file.body });
  json(res, 200, {
    state: 1,
    message: 'uploaded product traceability image without strict file validation',
    url: `/upload/image/${encodeURIComponent(safeName)}`,
    path: `/upload/image/${encodeURIComponent(safeName)}`,
    filename: file.filename,
    accepted: true,
  });
}

function handleRoute(req, res, pathname, params, body) {
  const user = currentUser(req);
  const haystack = `${pathname} ${JSON.stringify(params)}`;

  if (/upload|upload_pic|editor/i.test(pathname)) return handleUpload(req, res, body);

  if (/dbmanage|export|file|backup|download|down/i.test(pathname)) {
    const file = params.file || params.path || params.filename || params.id || 'dbback/bf.sql';
    const cmd = params.cmd || params.host || params.action || '';
    if (hasCommand(cmd)) return text(res, 200, 'DB backup ping\nuid=1000(traceability) gid=1000(traceability) groups=1000(traceability)');
    if (hasTraversal(file)) return text(res, 200, 'root:x:0:0:root:/root:/bin/bash\nmysql:x:27:27:MySQL Server:/var/lib/mysql:/sbin/nologin');
    return text(res, 200, 'traceability database backup export: INSERT INTO tgs_admin VALUES admin@example.com');
  }

  if (/install|admin|manage|set_|add_admin|edit_admin|list_admin|sys_|left|main/i.test(pathname)) {
    if (!user || user.role !== 'admin' || params.role === 'admin' || params.checkper === 'yes') {
      return json(res, 200, {
        state: 1,
        admin: true,
        message: 'admin function accessible without admin role',
        users: [{ id: 1, username: 'admin', email: 'admin@example.com', password_hint: 'admin888' }],
      });
    }
  }

  if (/login|qrcode_login|session|password/i.test(pathname)) {
    const code = params.code ?? params.captcha ?? params.password ?? '';
    if (weakCode(code)) {
      return json(res, 200, {
        state: 1,
        message: 'login or password reset accepted without strict captcha/otp binding',
        login_success: true,
        token: 'token-agent',
        code,
      });
    }
    return json(res, 403, { state: -2, message: 'bad verification code' });
  }

  if (/passcode|paypwd|tradepwd|password/i.test(haystack)) {
    const code = params.passcode ?? params.password ?? params.paypwd ?? '';
    if (weakCode(code)) return json(res, 200, { state: 1, passcode_verified: true, token: 'token-agent', message: 'passcode bypass accepted' });
    return json(res, 403, { state: -2, message: 'bad passcode' });
  }

  if (/q\.php|txm|fwm|suyuan|code|ts\/|view_code/i.test(pathname)) {
    const txm = String(params.txm || params.fwm || params.id || 'FW202009300001');
    const reflected = params.keyword || params.content || params.q || params.name || '';
    if (hasXss(reflected)) return html(res, 200, `<title>Trace code query</title><div>${reflected}</div>`);
    if (/99|victim|FW202009300099/i.test(txm)) {
      return json(res, 200, {
        state: 1,
        data: { txm: 'FW202009300099', owner: 'victim-agent', agentid: 'EW2020093099', secret: 'other agent trace code exposed' },
      });
    }
    return json(res, 200, { state: 1, data: { txm, owner: user?.username || '18888888888', product: 'anti-counterfeit food traceability product', source_derived: true } });
  }

  if (/agent|fahuo|tuihuo|box|zbox|fh_|th_|lc|pro|cp|dljb/i.test(pathname)) {
    const id = String(params.id || params.agentid || params.txm || params.box || '1');
    const amount = Number(params.amount ?? params.quantity ?? '1');
    const status = String(params.status || params.zt || '').toLowerCase();
    if (/99|victim|FW202009300099|EW2020093099/i.test(id)) {
      return json(res, 200, { state: 1, data: { id: '2', owner: 'victim-agent', txm: 'FW202009300099', secret: 'other agent shipment exposed' } });
    }
    if (amount < 0 || ['fahuo', 'returned', 'refunded', 'deleted', 'yes'].includes(status)) {
      return json(res, 200, { state: 1, ok: true, message: 'negative quantity accepted and logistics state replayed', total: -100, race_window: true, duplicate_ship: true });
    }
    return json(res, 200, { state: 1, data: { id, owner: user?.username || '18888888888', txm: params.txm || 'FW202009300001', amount } });
  }

  const reflected = params.keyword || params.content || params.q || params.name || '';
  if (hasXss(reflected)) return html(res, 200, `<title>Traceability reflected content</title><div>${reflected}</div>`);
  if (/index|wap|search|view|list/i.test(pathname)) return html(res, 200, `<title>Traceability page</title><div>${reflected || 'hello'}</div>`);

  json(res, 200, { state: 1, path: pathname, params, source_derived: true });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const body = await readBody(req);
    const params = parseParams(req, url, body);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && pathname === '/health') {
      return json(res, 200, { ok: true, route_count: routes.length, table_count: tables.length, tables, source: sourceDir });
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.php')) return html(res, 200, indexPage());
    if (req.method === 'GET' && pathname.startsWith('/upload/image/')) {
      const name = decodeURIComponent(pathname.split('/').pop() || '');
      const file = uploads.get(name);
      if (!file) return text(res, 404, 'missing upload');
      res.writeHead(200, { 'content-type': file.contentType });
      return res.end(file.body);
    }
    if (routes.some(route => route.path === pathname)) return handleRoute(req, res, pathname, params, body);
    return text(res, 404, 'not found');
  } catch (error) {
    return json(res, 500, { error: error.message || String(error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`traceability-blackbox http://127.0.0.1:${port} source=${sourceDir} routes=${routes.length} tables=${tables.length}`);
});
