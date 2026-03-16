import http from 'node:http';

const PORT = 3108;
const HOST = '127.0.0.1';
const history = [];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function normalizeHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  }
  return result;
}

function parseCookies(cookieHeader = '') {
  const cookies = {};
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.split('=');
    const key = name?.trim();
    const value = rest.join('=').trim();
    if (key) {
      cookies[key] = value;
    }
  }
  return cookies;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  const body = await readBody(req);
  const headers = normalizeHeaders(req.headers);

  if (req.method === 'GET' && pathname === '/__history') {
    sendJson(res, 200, { requests: history });
    return;
  }

  if (req.method === 'POST' && pathname === '/__reset') {
    history.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  history.push({
    method: req.method,
    path: pathname + url.search,
    headers,
    body,
  });

  if (req.method === 'GET' && pathname === '/api/profile') {
    const cookies = parseCookies(headers.cookie || '');
    const authorization = headers.authorization || '';
    const userId = url.searchParams.get('userId');

    if (authorization !== 'Bearer token-live-xyz') {
      sendJson(res, 401, { error: 'invalid authorization header' });
      return;
    }

    if (cookies.JSESSIONID !== 'sess-live-abc') {
      sendJson(res, 401, { error: 'invalid session cookie' });
      return;
    }

    if (userId !== 'user-live-001') {
      sendJson(res, 400, { error: 'invalid user id' });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      userId,
      session: cookies.JSESSIONID,
      authorization,
    });
    return;
  }

  sendJson(res, 404, {
    error: `Unhandled route: ${req.method} ${pathname}`,
  });
});

server.listen(PORT, HOST);
