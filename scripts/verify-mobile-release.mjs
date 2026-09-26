#!/usr/bin/env node
/** Production release checks. Does not install dependencies or silently use adapters. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const npm=process.platform==='win32'?'npm.cmd':'npm';
const env={...process.env};delete env.BSTG_TEST_ADAPTERS;
for(const name of ['typecheck','typecheck:server','build','test:mobile:closure','test:mobile-lab:closed-loop-static','test:product:e2e-contract']){
 console.log(`\n=== ${name} ===`);
 const result=spawnSync(npm,['run',name],{cwd:root,env,stdio:'inherit',shell:process.platform==='win32'});
 if(result.status!==0){process.exitCode=result.status??1;break;}
}

if (!process.exitCode) {
  console.log('\n=== Production capture-addon regression ===');
  const py = spawnSync(process.env.PYTHON || 'python3', ['-m','unittest','discover','-s','tests/mobile-closure','-p','capture_addon_test.py','-v'], {cwd:root,env,stdio:'inherit'});
  if (py.status !== 0) process.exitCode = py.status ?? 1;
}
if (!process.exitCode) {
  console.log('\n=== Mandatory actual Appium HTTPS acceptance (authorized device required) ===');
  const real = spawnSync(npm, ['run','test:mobile:real'], {cwd:root,env,stdio:'inherit',shell:process.platform==='win32'});
  process.exitCode = real.status ?? 1;
}
