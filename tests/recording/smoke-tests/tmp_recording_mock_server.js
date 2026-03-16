import http from 'node:http';

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const payload = JSON.stringify({
      ok: true,
      path: req.url,
      method: req.method,
      echoedBody: body,
      token: 'token-xyz',
      user_id: 'user-123',
      step: req.url && req.url.includes('api') ? 'api' : 'workflow',
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Set-Cookie', 'session_id=session-abc; Path=/; HttpOnly');
    res.end(payload);
  });
});

server.listen(3105, '127.0.0.1');
