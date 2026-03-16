import http from 'node:http';

const PORT = 3107;
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

  if (req.method === 'GET' && pathname === '/api/users') {
    if (url.searchParams.get('userId') !== 'user-live-001') {
      sendJson(res, 404, { error: 'user not found' });
      return;
    }

    sendJson(res, 200, {
      userId: 'user-live-001',
      displayName: 'Recorded User',
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/orders/order-live-001') {
    sendJson(res, 200, {
      orderId: 'order-live-001',
      state: 'ready',
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/orders/order-live-001/submit') {
    if (!body.includes('"userId":"user-live-001"')) {
      sendJson(res, 400, { error: 'invalid submit payload' });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      orderId: 'order-live-001',
      submitted: true,
    });
    return;
  }

  sendJson(res, 404, {
    error: `Unhandled route: ${req.method} ${pathname}`,
  });
});

server.listen(PORT, HOST);
