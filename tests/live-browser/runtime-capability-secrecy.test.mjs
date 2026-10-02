import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createRequire} from 'node:module';
import {decodePrivateCapability,redactWorkerCapability,writePrivateCapability} from '../../scripts/live-browser/local-container-runtime.mjs';

const require=createRequire(import.meta.url);
const {privateCapabilityLine,publishServerEndpoint}=require('../../scripts/live-browser/offline-worker.cjs');
const endpoint='ws://127.0.0.1:19446/opaque-browser-capability-1234';

test('worker negotiates the Playwright capability over a private controller record and emits no endpoint log',()=>{
  let privateEndpoint;
  const publicWorkerLogs=[];
  assert.equal(publishServerEndpoint(`Listening on ${endpoint}\n`,value=>{privateEndpoint=value;}),true);
  publicWorkerLogs.push('BSTG_BROWSER_WORKER_READY=1');
  const privateLine=privateCapabilityLine(privateEndpoint);
  assert.ok(privateLine.startsWith('BSTG_BROWSER_PRIVATE_CAPABILITY='));
  assert.equal(publicWorkerLogs.join('\n').includes(endpoint),false);
  assert.equal(publicWorkerLogs.join('\n').includes('/opaque-browser-capability-1234'),false);
});

test('controller persists the private capability in a mode-0600 runtime file while public logs stay capability-free',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'bstg-capability-test-'));
  const runtimeFile=path.join(directory,'worker.json');
  const privateLine=privateCapabilityLine(endpoint);
  const capability=decodePrivateCapability(privateLine,19446);
  writePrivateCapability(runtimeFile,capability);
  const mode=statSync(runtimeFile).mode&0o777;
  const saved=JSON.parse(readFileSync(runtimeFile,'utf8'));
  const publicOutput=['BSTG_BROWSER_WORKER_READY=1',`worker error: ${redactWorkerCapability(`failed ${endpoint}`)}`].join('\n');
  assert.equal(mode,0o600);
  assert.equal(saved.browser_ws_endpoint,endpoint);
  assert.equal(publicOutput.includes(endpoint),false);
  assert.equal(publicOutput.includes('/opaque-browser-capability-1234'),false);
  assert.equal(publicOutput.includes('[redacted-browser-capability]'),true);
});

test('controller rejects a private record that is not its loopback worker capability',()=>{
  const record=privateCapabilityLine('ws://example.test:19446/opaque-browser-capability-1234');
  assert.throws(()=>decodePrivateCapability(record,19446),/outside the local controller contract/);
});


test('controller captures a worker capability without leaking it to ordinary stdout or stderr',async t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'bstg-controller-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const bin=path.join(directory,'bin');
  const runtimeFile=path.join(directory,'runtime','worker.json');
  const docker=path.join(bin,'docker');
  const privateLine=privateCapabilityLine(endpoint);
  await import('node:fs/promises').then(({mkdir})=>mkdir(bin));
  writeFileSync(docker,`#!/bin/sh
if [ "$1" = image ]; then
  printf '%s\\n' '[{"Config":{"User":"1000"}}]'
  exit 0
fi
if [ "$1" = run ]; then
  printf '%s\\n' '${privateLine}'
  printf '%s\\n' 'BSTG_BROWSER_WORKER_READY=1'
  exit 0
fi
exit 1
`,{mode:0o700});
  chmodSync(docker,0o700);
  const script=fileURLToPath(new URL('../../scripts/live-browser/local-container-runtime.mjs',import.meta.url));
  const child=spawn(process.execPath,[script],{env:{...process.env,PATH:`${bin}:${process.env.PATH}`,BSTG_RUNTIME_IMAGE:'fixture/runtime:local',BSTG_BROWSER_RUNTIME_FILE:runtimeFile},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0);
  assert.equal(stdout.includes(endpoint),false);
  assert.equal(stdout.includes('/opaque-browser-capability-1234'),false);
  assert.equal(stderr.includes(endpoint),false);
  assert.equal(stderr.includes('/opaque-browser-capability-1234'),false);
  assert.match(stdout,/BSTG_BROWSER_WORKER_READY=1/);
  assert.equal(JSON.parse(readFileSync(runtimeFile,'utf8')).browser_ws_endpoint,endpoint);
  assert.equal(statSync(runtimeFile).mode&0o777,0o600);
});
