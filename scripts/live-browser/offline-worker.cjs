// Runs inside an existing local Linux runtime. No packages or browsers are downloaded.
const {execFileSync,spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {mkdirSync} = require('node:fs');
const path = require('node:path');
(async () => {
  if (process.env.BSTG_WORKER_CA) {
    const store = path.join(process.env.HOME, '.pki/nssdb');
    mkdirSync(store, {recursive:true, mode:0o700});
    execFileSync('certutil', ['-N', '-d', `sql:${store}`, '--empty-password']);
    execFileSync('certutil', ['-A', '-d', `sql:${store}`, '-n', 'BSTG configured target CA', '-t', 'C,,', '-i', process.env.BSTG_WORKER_CA]);
  }
  // The controller is trusted, local-only, and must select the already installed
  // Chromium path. --unsafe permits that launch option; no package install occurs.
  const child=spawn(process.execPath,['/bstg-playwright/node_modules/playwright/cli.js','run-server',
    '--host','0.0.0.0','--port',process.env.BSTG_WORKER_PORT,'--path',`/${randomUUID()}`,'--max-clients','16','--unsafe'],{stdio:['ignore','pipe','inherit']});
  child.stdout.on('data',data=>{
    const message=data.toString();const match=message.match(/ws:\/\/\S+/);
    if(match)console.log(`BSTG_BROWSER_WS_ENDPOINT=${match[0].replace('0.0.0.0','127.0.0.1')}`);
    else process.stdout.write(data);
  });
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('exit',code=>{process.exitCode=code??1;});
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>child.kill(signal));
})().catch(error=>{console.error(error.message);process.exit(1);});
