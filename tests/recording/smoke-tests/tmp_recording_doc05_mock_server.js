import http from 'node:http';

const PORT = 3106;
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

  const auth = headers.authorization || '';

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    sendJson(res, 200, {
      token: 'token-live',
      session: 'session-live',
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/orders') {
    if (auth !== 'Bearer token-live') {
      sendJson(res, 401, { error: 'invalid token for list' });
      return;
    }

    sendJson(res, 200, {
      orders: [
        { orderId: 'ord-live' },
      ],
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/orders/ord-live') {
    if (auth !== 'Bearer token-live') {
      sendJson(res, 401, { error: 'invalid token for detail' });
      return;
    }

    sendJson(res, 200, {
      orderId: 'ord-live',
      state: 'draft',
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/orders/ord-live/status') {
    if (auth !== 'Bearer token-live') {
      sendJson(res, 401, { error: 'invalid token for status' });
      return;
    }

    sendJson(res, 200, {
      state: 'processing',
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/orders/ord-live/submit') {
    if (auth !== 'Bearer token-live') {
      sendJson(res, 401, { error: 'invalid token for submit' });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      orderId: 'ord-live',
      submitted: true,
    });
    return;
  }

  sendJson(res, 404, {
    error: `Unhandled route: ${req.method} ${pathname}`,
  });
});

server.listen(PORT, HOST);
