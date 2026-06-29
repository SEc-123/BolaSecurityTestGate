#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const requireFromServer = createRequire(path.join(repoRoot, 'server/package.json'));
const { chromium } = requireFromServer('playwright');

const frontendPort = Number(process.env.BSTG_I18N_FRONTEND_PORT || 3482);
const artifactDir = process.env.BSTG_I18N_ARTIFACT_DIR || path.join(
  repoRoot,
  'artifacts',
  `i18n-ui-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

function log(message, data) {
  console.log(`[i18n-ui-smoke] ${data === undefined ? message : `${message} ${JSON.stringify(data)}`}`);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(url, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || lastError}`);
}

function chromiumExecutablePath() {
  const candidates = [
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

function spawnFrontend() {
  const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], {
    cwd: repoRoot,
    env: { ...process.env, VITE_API_URL: `http://127.0.0.1:${frontendPort + 1}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => process.stdout.write(`[i18n-ui-smoke:frontend] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[i18n-ui-smoke:frontend] ${chunk}`));
  return child;
}

async function assertBodyIncludes(page, expected, message) {
  const started = Date.now();
  let bodyText = '';
  while (Date.now() - started < 10000) {
    bodyText = await page.locator('body').innerText();
    if (bodyText.includes(expected)) return;
    await page.waitForTimeout(200);
  }
  assert(false, message, { expected, bodyText: bodyText.slice(0, 1400), url: page.url() });
}

async function assertBodyExcludes(page, unexpected, message) {
  const bodyText = await page.locator('body').innerText();
  assert(!bodyText.includes(unexpected), message, { unexpected, bodyText: bodyText.slice(0, 1000) });
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const frontend = spawnFrontend();
  let browser;
  try {
    const frontendBase = `http://127.0.0.1:${frontendPort}`;
    await waitFor(frontendBase);
    const executablePath = chromiumExecutablePath();
    assert(Boolean(executablePath), 'No Chromium/Chrome executable found for i18n UI smoke');
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1360, height: 920 } });
    page.setDefaultTimeout(30000);

    await page.goto(`${frontendBase}/?lang=zh`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="language-switch"]');
    await assertBodyIncludes(page, '运营控制台', 'URL lang=zh should localize the product shell');
    await assertBodyIncludes(page, '评估', 'URL lang=zh should localize navigation');
    await assertBodyIncludes(page, '发现项', 'URL lang=zh should localize findings labels');
    await assertBodyExcludes(page, 'Operations console', 'Chinese mode should not leave the topbar in English');
    await page.screenshot({ path: path.join(artifactDir, '01-zh-desktop.png'), fullPage: true });

    await page.getByTestId('language-switch').getByRole('button', { name: 'EN', exact: true }).click();
    await assertBodyIncludes(page, 'OPERATIONS CONSOLE', 'Language switch button should change shell back to English');
    await assertBodyIncludes(page, 'Assessment', 'Language switch button should change navigation back to English');
    await assertBodyIncludes(page, 'Autopilot mode', 'Language switch button should translate Chinese-authored scan controls back to English');
    await assertBodyExcludes(page, '自动驾驶模式', 'English mode should not leave Chinese-authored scan controls untranslated');
    await page.screenshot({ path: path.join(artifactDir, '02-en-desktop.png'), fullPage: true });

    await page.keyboard.press('Control+Shift+L');
    await assertBodyIncludes(page, '运营控制台', 'Keyboard shortcut should toggle back to Chinese');
    assert(new URL(page.url()).searchParams.get('lang') === 'zh', 'Keyboard language switch should keep URL language state shareable', { url: page.url() });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    await assertBodyIncludes(page, '运营控制台', 'Narrow viewport should preserve selected language');
    await page.locator('[data-testid="language-switch"]').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(artifactDir, '03-zh-mobile.png'), fullPage: true });

    log('passed', { frontendBase, artifactDir });
  } finally {
    await browser?.close();
    frontend.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error(error);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
