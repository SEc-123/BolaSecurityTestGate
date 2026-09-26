import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.BSTG_SIMULATOR_PORT || 4723);
const baseUrl = `http://127.0.0.1:${port}`;
const packageName = process.env.BSTG_MOBILE_ALLOWED_PACKAGE || 'com.example.authorizedapp';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  assert(response.ok, `${pathname} failed: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const status = await request('/status');
  assert(status.value.ready === true && status.value.simulator === true, 'Simulator status is invalid.');

  const observe = await request('/bstg/mobile/observe');
  assert(observe.data.screen.package === packageName, 'Unexpected observed package.');
  assert(observe.data.ui_tree.length === 3, 'Expected three observed UI nodes.');
  assert(observe.data.screen.screenshot_base64.length > 20, 'Screenshot fixture is missing.');

  const created = await request('/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          platformName: 'Android',
          'appium:automationName': 'UiAutomator2',
          'appium:appPackage': packageName,
          'appium:appActivity': '.LoginActivity'
        }
      }
    })
  });
  const sessionId = created.value.sessionId;
  assert(sessionId.startsWith('bstg-offline-'), 'Unexpected session identifier.');

  const source = await request(`/session/${sessionId}/source`);
  assert(source.value.includes(`${packageName}:id/loginButton`), 'UI source fixture is incomplete.');
  const screenshot = await request(`/session/${sessionId}/screenshot`);
  assert(screenshot.value.length > 20, 'Session screenshot fixture is missing.');

  const element = await request(`/session/${sessionId}/element`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: 'id', value: `${packageName}:id/loginButton` })
  });
  const elementId = element.value['element-6066-11e4-a52e-4f735466cecf'];
  await request(`/session/${sessionId}/element/${elementId}/click`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  const capture = await request('/bstg/mobile/capture');
  assert(capture.data.accepted_flows === 3, 'Expected three simulated decrypted flows.');
  const fixture = await readFile(path.join(root, 'simulator', 'fixtures', 'burp-history.example.jsonl'), 'utf8');
  assert(fixture.trim().split('\n').length === 3, 'Capture fixture is incomplete.');

  const adb = spawnSync(path.join(root, 'simulator', 'adb'), ['-s', 'emulator-5554', 'get-state'], { encoding: 'utf8' });
  assert(adb.status === 0 && adb.stdout.trim() === 'device', 'ADB simulator did not report an online device.');

  await request(`/session/${sessionId}`, { method: 'DELETE' });
  console.log(JSON.stringify({
    ok: true,
    profile: 'offline-simulator-v0.2.0',
    observedNodes: observe.data.ui_tree.length,
    acceptedFlows: capture.data.accepted_flows,
    sessionId
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
