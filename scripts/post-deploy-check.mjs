#!/usr/bin/env node
import process from 'process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const part = process.argv[i];
  if (part.startsWith('--')) {
    const next = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
    args.set(part.slice(2), next);
  }
}

const baseUrl = String(args.get('base-url') || process.env.BSTG_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const retries = Number(args.get('retries') || 30);
const delayMs = Number(args.get('delay-ms') || 2000);

const checks = [
  ['/', 200, 'text/html'],
  ['/health', 200, 'application/json'],
  ['/api/dashboard/summary', 200, 'application/json'],
  ['/api/dictionary', 200, 'application/json'],
  ['/api/recordings/config', 200, 'application/json'],
  ['/api/recordings/sessions', 200, 'application/json'],
  ['/api/ai/providers', 200, 'application/json'],
  ['/api/environments', 200, 'application/json'],
  ['/api/accounts', 200, 'application/json'],
  ['/api/workflows', 200, 'application/json'],
  ['/api/api-templates', 200, 'application/json'],
  ['/admin/db/status', 200, 'application/json'],
  ['/this-route-should-fallback', 200, 'text/html'],
  ['/api/__route_that_should_not_exist__', 404, 'application/json'],
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonAware(url) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, contentType, body };
}

async function waitForHealth() {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const { response } = await fetchJsonAware(`${baseUrl}/health`);
      if (response.status === 200) {
        return { attempt, ok: true };
      }
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(delayMs);
  }
  throw new Error(`Server did not become healthy after ${retries} attempts: ${lastError}`);
}

async function checkEndpoint(routePath, expectedStatus, expectedContentType) {
  const url = `${baseUrl}${routePath}`;
  try {
    const { response, contentType, body } = await fetchJsonAware(url);
    const statusOk = response.status === expectedStatus;
    const typeOk = expectedContentType ? contentType.includes(expectedContentType) : true;
    return { path: routePath, status: response.status, ok: statusOk && typeOk, contentType, body };
  } catch (error) {
    return { path: routePath, status: 'ERR', ok: false, contentType: '', body: String(error?.message || error) };
  }
}

await waitForHealth();

const results = [];
for (const [routePath, expectedStatus, expectedContentType] of checks) {
  results.push(await checkEndpoint(routePath, expectedStatus, expectedContentType));
}

const failed = results.filter((item) => !item.ok);
console.log(JSON.stringify({ baseUrl, passed: failed.length === 0, checked: results.length, failed: failed.length, results }, null, 2));
if (failed.length > 0) process.exit(1);
