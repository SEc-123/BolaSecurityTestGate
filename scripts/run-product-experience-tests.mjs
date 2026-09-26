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
const files=readdirSync(path.join(root,'tests/product-experience')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>`tests/product-experience/${name}`);
try {
  const child=spawnSync(process.execPath,['--import','./tests/mobile-closure/register.mjs','--test',...files],{cwd:root,env,stdio:'inherit'});
  if(child.error)console.error(child.error.message);
  process.exitCode=child.status??1;
} finally {rmSync(temporary,{recursive:true,force:true});}
