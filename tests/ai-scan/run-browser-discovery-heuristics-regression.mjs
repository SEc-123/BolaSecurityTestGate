#!/usr/bin/env node
import http from 'http';
import { discoverTargetFromHttp } from '../../server/dist/services/ai-scan/browser-discovery.js';

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

const html = `<!doctype html>
<html>
  <head><title>Discovery heuristic regression</title></head>
  <body>
    <form action="/profile/avatar" method="post" enctype="multipart/form-data">
      <input type="file" name="avatar">
    </form>
    <script>
      fetch('/index.php/admin/login/captcha?id=1001&file=report.txt');
      fetch('/index.php/admin/update/down?file=report.txt&path=reports');
      fetch('/index.php/hall/upload', { method: 'POST', body: new FormData() });
    </script>
  </body>
</html>`;

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});

try {
  const address = await listen(server);
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  const discovery = await discoverTargetFromHttp(baseUrl, { max_pages: 1 });
  const findEndpoint = (path, predicate = () => true) => discovery.endpoints.find(endpoint => endpoint.path === path && predicate(endpoint));

  const captcha = findEndpoint('/index.php/admin/login/captcha');
  const download = findEndpoint('/index.php/admin/update/down');
  const inlineUpload = findEndpoint('/index.php/hall/upload');
  const formUpload = findEndpoint('/profile/avatar', endpoint => endpoint.method === 'POST' && endpoint.content_type === 'multipart/form-data');

  assert(captcha, 'captcha endpoint should be discovered');
  assert(captcha.content_type !== 'multipart/form-data', 'GET captcha endpoint with file query must not become multipart upload', captcha);
  assert(!/上传/.test(captcha.feature_guess || ''), 'GET captcha endpoint with file query must not be labeled as upload feature', captcha);

  assert(download, 'download endpoint should be discovered');
  assert(download.content_type !== 'multipart/form-data', 'download endpoint with file/path query must not become multipart upload', download);
  assert(/下载|读取/.test(download.feature_guess || ''), 'download endpoint should keep file-read semantics', download);

  assert(inlineUpload, 'inline upload endpoint should be discovered');
  assert(inlineUpload.method === 'POST', 'inline upload endpoint should infer POST', inlineUpload);
  assert(inlineUpload.content_type === 'multipart/form-data', 'inline upload endpoint using FormData should become multipart upload', inlineUpload);

  assert(formUpload, 'multipart form endpoint should be discovered');
  assert(formUpload.method === 'POST', 'multipart form endpoint should keep POST', formUpload);
  assert(formUpload.content_type === 'multipart/form-data', 'multipart form endpoint should keep multipart content type', formUpload);

  console.log(JSON.stringify({ ok: true, endpoints: discovery.endpoints.map(endpoint => ({ method: endpoint.method, path: endpoint.path, content_type: endpoint.content_type, feature_guess: endpoint.feature_guess })) }, null, 2));
} catch (error) {
  console.error('[browser-discovery-heuristics] FAILED:', error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
} finally {
  server.close();
}
