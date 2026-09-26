#!/usr/bin/env node
/** Reuse a complete local Linux image with Chromium, Node and (for private CAs) certutil.
 * No pull/build/install operation. The image runs as its configured non-root user.
 * Playwright JS is mounted from this checkout so the wire protocol version matches. */
import {spawn, execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const image=process.env.BSTG_RUNTIME_IMAGE;
if (!image) throw Error('Set BSTG_RUNTIME_IMAGE to an already imported local image.');
const port=Number(process.env.BSTG_WORKER_PORT||19446);
if (!Number.isInteger(port)||port<1024||port>65535) throw Error('Invalid BSTG_WORKER_PORT.');
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
if(process.env.BSTG_WORKER_CA){
  const ca=path.resolve(process.env.BSTG_WORKER_CA);if(!existsSync(ca))throw Error('Configured CA file does not exist.');
  args.push('--mount',`type=bind,src=${ca},dst=/bstg-target-ca.pem,readonly`,'-e','BSTG_WORKER_CA=/bstg-target-ca.pem');
}
args.push('--entrypoint','node',image,'/bstg-worker.cjs');
const child=spawn('docker',args,{stdio:'inherit'});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
  if(stopping)return;stopping=true;
  const stop=spawn('docker',['stop','--time','10',name],{stdio:'ignore'});stop.on('error',()=>child.kill(signal));
});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=stopping?0:code??1;});
