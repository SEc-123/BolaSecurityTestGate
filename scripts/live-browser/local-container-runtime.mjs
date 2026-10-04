#!/usr/bin/env node
/** Reuse a complete local Linux image with Chromium, Node and (for private CAs) certutil.
 * No pull/build/install operation. The image runs as its configured non-root user.
 * Playwright JS is mounted from this checkout so the wire protocol version matches. */
import {spawn, execFileSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, renameSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const capabilityPrefix='BSTG_BROWSER_PRIVATE_CAPABILITY=';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

export function redactWorkerCapability(message) {
  return String(message)
    .replace(/wss?:\/\/[^\s'"`]+/gi,'[redacted-browser-capability]')
    .replace(/(?:--path|path=)\s*\/[A-Za-z0-9_-]{12,}/g,'[redacted-browser-capability-path]');
}

export function decodePrivateCapability(line, expectedPort) {
  if(!line.startsWith(capabilityPrefix))return null;
  let decoded;
  try {decoded=JSON.parse(Buffer.from(line.slice(capabilityPrefix.length),'base64url').toString('utf8'));}
  catch {throw Error('Browser worker sent an invalid private capability record.');}
  const endpoint=decoded?.browser_ws_endpoint;
  let url;
  try {url=new URL(endpoint);}
  catch {throw Error('Browser worker sent an invalid capability endpoint.');}
  if(decoded?.version!==1||url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.port!==String(expectedPort)||!/^\/[A-Za-z0-9-]{12,}$/.test(url.pathname)) {
    throw Error('Browser worker capability is outside the local controller contract.');
  }
  return {version:1,browser_ws_endpoint:url.toString()};
}

export function writePrivateCapability(runtimeFile, capability) {
  const directory=path.dirname(runtimeFile);
  mkdirSync(directory,{recursive:true,mode:0o700});
  chmodSync(directory,0o700);
  const temporary=`${runtimeFile}.${process.pid}.tmp`;
  writeFileSync(temporary,`${JSON.stringify(capability)}\n`,{encoding:'utf8',mode:0o600,flag:'w'});
  chmodSync(temporary,0o600);
  renameSync(temporary,runtimeFile);
  chmodSync(runtimeFile,0o600);
}

export function privateCapabilityRuntimeFile() {
  const configured=process.env.BSTG_BROWSER_RUNTIME_FILE?.trim();
  if(configured)return path.resolve(configured);
  const directory=path.join(os.tmpdir(),`bstg-browser-${process.getuid?.()??process.pid}`);
  return path.join(directory,'runtime-capability.json');
}

function relaySafeLine(line, stream=process.stdout) {
  if(/^BSTG_BROWSER_TRUSTED_CA_SHA256=[a-f0-9]{64}$/i.test(line)||line==='BSTG_BROWSER_WORKER_READY=1')stream.write(`${line}\n`);
}

export async function main() {
  const image=process.env.BSTG_RUNTIME_IMAGE?.trim()||'hahawo65/bstg-browser-runtime:pw-1.62.1';
  const port=Number(process.env.BSTG_WORKER_PORT||19446);
  if (!Number.isInteger(port)||port<1024||port>65535) throw Error('Invalid BSTG_WORKER_PORT.');
  const runtimeFile=privateCapabilityRuntimeFile();
  // Remove any stale endpoint before this controller asks Docker to start a new
  // worker. Readers can distinguish the short starting state from readiness.
  writePrivateCapability(runtimeFile,{version:1,status:'starting'});
  const identity=JSON.parse(execFileSync('docker',['image','inspect',image],{encoding:'utf8'}))[0];
  if (!identity.Config.User || ['0','root','0:0','root:root'].includes(identity.Config.User)) throw Error('Use a runtime image configured with a non-root user.');
  const name=`bstg-browser-${process.pid}-${Date.now()}`;
  const args=['run','--rm','--pull=never','--init','--name',name,'--shm-size=512m',
    // Chromium keeps its own sandbox. The local runtime needs user namespace syscalls.
    '--security-opt','seccomp=unconfined','-p',`127.0.0.1:${port}:${port}`,
    '--mount',`type=bind,src=${path.join(root,'server/node_modules/playwright')},dst=/bstg-playwright/node_modules/playwright,readonly`,
    '--mount',`type=bind,src=${path.join(root,'server/node_modules/playwright-core')},dst=/bstg-playwright/node_modules/playwright-core,readonly`,
    '--mount',`type=bind,src=${path.join(root,'scripts/live-browser/offline-worker.cjs')},dst=/bstg-worker.cjs,readonly`,
    '-e',`BSTG_WORKER_PORT=${port}`];
  const configuredCa=process.env.BSTG_WORKER_CA||process.env.BSTG_TARGET_CA_FILE;
  if(configuredCa){
    const ca=path.resolve(configuredCa);if(!existsSync(ca))throw Error('Configured CA file does not exist.');
    args.push('--mount',`type=bind,src=${ca},dst=/bstg-target-ca.pem,readonly`,'-e','BSTG_WORKER_CA=/bstg-target-ca.pem');
    if(process.env.BSTG_WORKER_CA_SHA256)args.push('-e',`BSTG_WORKER_CA_SHA256=${process.env.BSTG_WORKER_CA_SHA256}`);
  }
  args.push('--entrypoint','node',image,'/bstg-worker.cjs');
  // Docker's stdout is the worker's private controller channel. Do not inherit
  // it: it includes a short-lived Playwright capability before it reaches the
  // 0600 local runtime file.
  const child=spawn('docker',args,{stdio:['ignore','pipe','pipe']});
  let bufferedStdout='';
  child.stdout.on('data',data=>{
    bufferedStdout+=data.toString();
    const lines=bufferedStdout.split(/\r?\n/);bufferedStdout=lines.pop()??'';
    for(const line of lines){
      try {
        const capability=decodePrivateCapability(line,port);
        if(capability)writePrivateCapability(runtimeFile,capability);
        else relaySafeLine(line);
      } catch(error) {console.error(redactWorkerCapability(error.message));child.kill('SIGTERM');process.exitCode=1;}
    }
  });
  let bufferedStderr='';
  child.stderr.on('data',data=>{
    bufferedStderr+=data.toString();
    const lines=bufferedStderr.split(/\r?\n/);bufferedStderr=lines.pop()??'';
    for(const line of lines)process.stderr.write(`${redactWorkerCapability(line)}\n`);
  });
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
    if(stopping)return;stopping=true;
    // A detached local worker must not leave its container and CA-backed
    // Chromium alive when its controller is interrupted. Use the Docker API
    // synchronously here so Node cannot exit before the async `docker stop`
    // child has actually issued the request.
    try{execFileSync('docker',['stop','--timeout','10',name],{stdio:'ignore'});}
    catch{child.kill(signal);}
  });
  child.on('error',error=>{console.error(redactWorkerCapability(error.message));process.exitCode=1;});
  child.on('exit',code=>{
    if(bufferedStderr)process.stderr.write(`${redactWorkerCapability(bufferedStderr)}\n`);
    process.exitCode=stopping?0:code??1;
  });
}

if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{console.error(redactWorkerCapability(error.message));process.exit(1);});
