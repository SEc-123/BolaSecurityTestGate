import assert from 'node:assert/strict';
import http from 'node:http';
import { bootstrapAutoAccounts } from '../../server/dist/services/ai-scan/account-autobootstrap.js';

const users = new Map();
const sessions = new Map();

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function cookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return v;
  }
  return '';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    res.setHeader('content-type', 'text/html');
    res.end('<a href="/register">Register</a><a href="/login">Login</a>');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/register') {
    const csrf = `csrf-reg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    res.setHeader('set-cookie', `csrf_reg=${csrf}; Path=/; HttpOnly`);
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Register</title><form method="POST" action="/register">
      <input type="hidden" name="csrf" value="${csrf}"><input name="username"><input name="email"><input name="password" type="password"><input name="confirm_password" type="password"><button>Register</button>
    </form>`);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/register') {
    const body = new URLSearchParams(await readBody(req));
    const username = body.get('username');
    const password = body.get('password');
    const email = body.get('email');
    if (!body.get('csrf') || body.get('csrf') !== cookie(req, 'csrf_reg')) {
      res.statusCode = 403;
      res.end('csrf mismatch');
      return;
    }
    if (!username || !password || users.has(username)) {
      res.statusCode = 400;
      res.end('registration rejected');
      return;
    }
    users.set(username, { username, password, email });
    res.end('registered');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/login') {
    const csrf = `csrf-login-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    res.setHeader('set-cookie', `csrf_login=${csrf}; Path=/; HttpOnly`);
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Login</title><form method="POST" action="/login">
      <input type="hidden" name="csrf" value="${csrf}"><input name="username"><input name="password" type="password"><button>Login</button>
    </form>`);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/login') {
    const body = new URLSearchParams(await readBody(req));
    if (!body.get('csrf') || body.get('csrf') !== cookie(req, 'csrf_login')) {
      res.statusCode = 403;
      res.end('csrf mismatch');
      return;
    }
    const user = users.get(body.get('username'));
    if (!user || user.password !== body.get('password')) {
      res.statusCode = 401;
      res.end('invalid login');
      return;
    }
    const sid = `sid-${user.username}`;
    sessions.set(sid, user.username);
    res.setHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly`);
    res.setHeader('content-type', 'text/html');
    res.end('<h1>dashboard</h1><a href="/logout">logout</a>');
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/`;

const accounts = [];
const artifacts = [];
const sharedResources = [];
const fakeDb = {
  repos: {
    accounts: {
      async create(data) {
        const account = { id: `acct-${accounts.length + 1}`, ...data, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        accounts.push(account);
        return account;
      },
    },
  },
};
const fakeRepo = {
  async createArtifact(input) {
    artifacts.push(input);
    return { id: `artifact-${artifacts.length}`, ...input };
  },
  async upsertSharedResource(input) {
    sharedResources.push(input);
    return { id: `resource-${sharedResources.length}`, usage_count: 0, ...input };
  },
};

try {
  const result = await bootstrapAutoAccounts({
    db: fakeDb,
    repo: fakeRepo,
    scanRunId: 'scan-account-bootstrap',
    taskId: 'task-discover',
    baseUrl,
    roles: ['attacker', 'victim'],
    maxPages: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'http_form');
  assert.equal(result.closure_state, 'closed');
  assert.equal(result.created_accounts.length, 2);
  assert.equal(accounts.length, 2);
  assert.ok(accounts.every(account => account.tags.includes('ai_scan_autocreated')));
  assert.ok(accounts.every(account => account.tags.includes('scan:scan-account-bootstrap')));
  assert.ok(accounts.every(account => account.fields?.cookies?.sid));
  assert.ok(accounts.every(account => account.fields?.cookies?.csrf_reg));
  assert.ok(accounts.every(account => account.fields?.cookies?.csrf_login));
  assert.ok(artifacts.some(artifact => artifact.artifact_type === 'account_auto_bootstrap_result'));
  assert.ok(!artifacts.some(artifact => artifact.artifact_type === 'human_input_request'));
  assert.ok(sharedResources.some(resource => resource.resource_type === 'identity_pool' && resource.resource_key === 'auto-executed-registration-accounts'));
  console.log('account auto bootstrap regression passed');
} finally {
  server.close();
}
