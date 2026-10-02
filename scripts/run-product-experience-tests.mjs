#!/usr/bin/env node
/** Explicitly separate native-dependency tests from portable SQLite-adapter tests. */
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const adapters=process.argv.includes('--adapters');
const temporary=mkdtempSync(path.join(os.tmpdir(),'bstg-product-experience-'));
const env={...process.env,BSTG_DATA_DIR:temporary};
if(adapters)env.BSTG_TEST_ADAPTERS='1';else delete env.BSTG_TEST_ADAPTERS;
console.log(adapters
  ? 'MODE: explicit TEST adapters (node:sqlite); NOT native-addon, Express/browser, mitmproxy TLS, or Android device acceptance.'
  : 'MODE: production dependencies; Android/Appium test doubles are still NOT device acceptance.');
const allFiles=readdirSync(path.join(root,'tests/product-experience')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>`tests/product-experience/${name}`);
// This test deliberately holds a real navigation open until a policy denial
// aborts it. Start it only after the parallel suite has released its Chromium
// workers, otherwise browser startup contention can consume its finite safety
// deadline before the navigation is ever dispatched.
const isolatedBrowserPolicyTest='tests/product-experience/browser-policy-stop.test.mjs';
// Keyboard dispatch uses a real persistent Chromium session and has a strict
// per-case safety deadline.  Keep it out of the broad file-parallel batch so
// browser startup contention cannot turn a successful single dispatch into a
// timeout/retry artifact.
const isolatedBrowserKeyboardTest='tests/product-experience/browser-keyboard-press.test.mjs';
const files=allFiles.filter(file=>file!==isolatedBrowserPolicyTest&&file!==isolatedBrowserKeyboardTest);
function run(files){
  const child=spawnSync(process.execPath,['--import','./tests/mobile-closure/register.mjs','--test',...files],{cwd:root,env,stdio:'inherit'});
  if(child.error)console.error(child.error.message);
  return child.status??1;
}
try {
  const primaryStatus=run(files);
  const keyboardStatus=run([isolatedBrowserKeyboardTest]);
  const isolatedStatus=run([isolatedBrowserPolicyTest]);
  process.exitCode=primaryStatus||keyboardStatus||isolatedStatus;
} finally {rmSync(temporary,{recursive:true,force:true});}
