import http from 'http';

const port = Number(process.env.PORT || 3300);

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'x-powered-by': 'Express 4.17.1',
    server: 'nginx/1.18.0',
    ...headers,
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (request.method === 'GET' && url.pathname === '/') {
    return send(response, 200, `<!doctype html>
      <html>
        <head>
          <title>Historical Vulnerability Fixture</title>
          <script src="/assets/jquery-3.5.1.min.js"></script>
        </head>
        <body>
          <h1>Historical Vulnerability Fixture</h1>
          <a href="/health">Health</a>
          <script>fetch('/api/status')</script>
        </body>
      </html>`);
  }
  if (request.method === 'GET' && url.pathname === '/assets/jquery-3.5.1.min.js') {
    return send(response, 200, '/*! jQuery JavaScript Library v3.5.1 */\nwindow.jQuery = {};', { 'content-type': 'application/javascript' });
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    return send(response, 200, JSON.stringify({ ok: true }), { 'content-type': 'application/json' });
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    return send(response, 200, 'ok', { 'content-type': 'text/plain' });
  }
  if (request.method === 'GET' && url.pathname === '/__bstg-poc/cve-2099-0001') {
    return send(response, 200, 'BSTG-MOCK-CVE-2099-0001 vulnerable express proof', { 'content-type': 'text/plain' });
  }
  return send(response, 404, `Cannot ${request.method} ${url.pathname}`);
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`historical-vuln-target http://127.0.0.1:${address.port}`);
});
