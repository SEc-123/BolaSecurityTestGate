#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.BSTG_SIMULATOR_PORT || 4723);
const allowedPackage = process.env.BSTG_MOBILE_ALLOWED_PACKAGE || 'com.example.authorizedapp';
const screenshotBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wlq2wAAAABJRU5ErkJggg==';
const uiSource = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${allowedPackage}" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
    <node index="0" text="Email" resource-id="${allowedPackage}:id/email" class="android.widget.EditText" package="${allowedPackage}" content-desc="email" clickable="true" enabled="true" focusable="true" bounds="[72,320][1008,408]" />
    <node index="1" text="Password" resource-id="${allowedPackage}:id/password" class="android.widget.EditText" package="${allowedPackage}" content-desc="password" clickable="true" enabled="true" password="true" focusable="true" bounds="[72,440][1008,528]" />
    <node index="2" text="Sign in" resource-id="${allowedPackage}:id/loginButton" class="android.widget.Button" package="${allowedPackage}" content-desc="" clickable="true" enabled="true" bounds="[72,640][1008,728]" />
  </node>
</hierarchy>`;

const sessions = new Map();
let sequence = 0;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function notFound(response) {
  json(response, 404, { value: { error: 'unknown command', message: 'BSTG offline simulator route not found' } });
}

function createSession(requestBody) {
  const caps = requestBody?.capabilities?.alwaysMatch || requestBody?.desiredCapabilities || {};
  const packageName = caps['appium:appPackage'] || caps.appPackage || allowedPackage;
  if (packageName !== allowedPackage) {
    return { error: `Package guard rejected ${packageName}; expected ${allowedPackage}.` };
  }
  const id = `bstg-offline-${++sequence}`;
  sessions.set(id, { id, packageName, actions: [] });
  return { id, caps };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString('utf8');
  return value ? JSON.parse(value) : {};
}

function observe() {
  return {
    screen: {
      package: allowedPackage,
      activity: '.LoginActivity',
      screenshot_base64: screenshotBase64
    },
    ui_tree_xml: uiSource,
    ui_tree: [
      {
        className: 'android.widget.EditText',
        text: 'Email',
        resourceId: `${allowedPackage}:id/email`,
        contentDesc: 'email',
        bounds: [72, 320, 1008, 408],
        clickable: true,
        enabled: true,
        input: true
      },
      {
        className: 'android.widget.EditText',
        text: 'Password',
        resourceId: `${allowedPackage}:id/password`,
        contentDesc: 'password',
        bounds: [72, 440, 1008, 528],
        clickable: true,
        enabled: true,
        input: true
      },
      {
        className: 'android.widget.Button',
        text: 'Sign in',
        resourceId: `${allowedPackage}:id/loginButton`,
        bounds: [72, 640, 1008, 728],
        clickable: true,
        enabled: true
      }
    ],
    suggested_actions: [
      { action: 'input', target: `${allowedPackage}:id/email` },
      { action: 'input', target: `${allowedPackage}:id/password` },
      { action: 'tap', target: `${allowedPackage}:id/loginButton` }
    ],
    simulator: true
  };
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  const method = request.method || 'GET';

  if (method === 'GET' && requestUrl.pathname === '/status') {
    return json(response, 200, {
      value: {
        ready: true,
        message: 'BSTG offline Mobile Lab simulator',
        build: { version: '0.2.0-simulator' },
        simulator: true
      }
    });
  }

  if (method === 'GET' && requestUrl.pathname === '/bstg/mobile/observe') {
    return json(response, 200, { data: observe(), error: null });
  }

  if (method === 'GET' && requestUrl.pathname === '/bstg/mobile/capture') {
    const capture = await readFile(path.join(root, 'fixtures', 'burp-history.example.jsonl'), 'utf8');
    return json(response, 200, { data: { accepted_flows: 3, capture }, error: null });
  }

  if (method === 'POST' && requestUrl.pathname === '/session') {
    const body = await readJson(request);
    const session = createSession(body);
    if (session.error) return json(response, 500, { value: { error: 'session not created', message: session.error } });
    return json(response, 200, { value: { sessionId: session.id, capabilities: session.caps } });
  }

  const sessionMatch = requestUrl.pathname.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
  if (!sessionMatch) return notFound(response);
  const [, sessionId, suffix = ''] = sessionMatch;
  const session = sessions.get(sessionId);
  if (!session) return json(response, 404, { value: { error: 'invalid session id', message: 'Unknown simulator session.' } });

  if (method === 'DELETE' && !suffix) {
    sessions.delete(sessionId);
    return json(response, 200, { value: null });
  }
  if (method === 'GET' && suffix === 'screenshot') return json(response, 200, { value: screenshotBase64 });
  if (method === 'GET' && suffix === 'source') return json(response, 200, { value: uiSource });
  if (method === 'GET' && suffix === 'appium/device/current_activity') return json(response, 200, { value: '.LoginActivity' });
  if (method === 'GET' && suffix === 'appium/device/current_package') return json(response, 200, { value: allowedPackage });

  if (method === 'POST' && suffix === 'element') {
    const body = await readJson(request);
    session.actions.push({ action: 'find', selector: body });
    return json(response, 200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'offline-element-1', ELEMENT: 'offline-element-1' } });
  }
  if (method === 'POST' && /^element\/[^/]+\/(click|value|clear)$/.test(suffix)) {
    const body = await readJson(request);
    session.actions.push({ action: suffix.endsWith('click') ? 'tap' : 'input', body });
    return json(response, 200, { value: null });
  }
  if (method === 'POST' && (suffix === 'actions' || suffix === 'execute/sync')) {
    const body = await readJson(request);
    session.actions.push({ action: suffix, body });
    return json(response, 200, { value: null });
  }

  return notFound(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`BSTG offline Mobile Lab simulator listening on http://127.0.0.1:${port}`);
});
