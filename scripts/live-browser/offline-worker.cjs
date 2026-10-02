// Runs inside an existing local Linux runtime. No packages or browsers are downloaded.
const {execFileSync,spawn} = require('node:child_process');
const {randomUUID,createHash,X509Certificate,timingSafeEqual} = require('node:crypto');
const {mkdirSync,readFileSync} = require('node:fs');
const path = require('node:path');

function caBundleFingerprint(file) {
  const pem=readFileSync(file,'utf8');
  const certificates=pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)||[];
  if(!certificates.length)throw Error('BSTG_WORKER_CA contains no parseable certificates.');
  const hashes=certificates.map(certificate=>createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex')).sort();
  return createHash('sha256').update(hashes.join(':')).digest('hex');
}

function exactFingerprint(expected,actual) {
  if(!/^[a-f0-9]{64}$/i.test(expected||''))return false;
  const left=Buffer.from(expected.toLowerCase(),'hex'),right=Buffer.from(actual,'hex');
  return left.length===right.length&&timingSafeEqual(left,right);
}

function privateCapabilityLine(endpoint) {
  return `BSTG_BROWSER_PRIVATE_CAPABILITY=${Buffer.from(JSON.stringify({version:1,browser_ws_endpoint:endpoint})).toString('base64url')}`;
}

function publishServerEndpoint(message, publishPrivateCapability) {
  const match=String(message).match(/ws:\/\/\S+/);
  if(!match)return false;
  publishPrivateCapability(match[0].replace('0.0.0.0','127.0.0.1'));
  return true;
}

async function main() {
  let trustedCaFingerprint;
  if (process.env.BSTG_WORKER_CA) {
    const store = path.join(process.env.HOME, '.pki/nssdb');
    trustedCaFingerprint=caBundleFingerprint(process.env.BSTG_WORKER_CA);
    const expected=process.env.BSTG_WORKER_CA_SHA256;
    if(expected&&!exactFingerprint(expected,trustedCaFingerprint))throw Error('BSTG_WORKER_CA_SHA256 does not match the configured CA bundle.');
    mkdirSync(store, {recursive:true, mode:0o700});
    try {execFileSync('certutil', ['-N', '-d', `sql:${store}`, '--empty-password']);}
    catch {execFileSync('certutil', ['-L', '-d', `sql:${store}`]);}
    execFileSync('certutil', ['-A', '-d', `sql:${store}`, '-n', 'BSTG configured target CA', '-t', 'C,,', '-i', process.env.BSTG_WORKER_CA]);
    execFileSync('certutil', ['-L', '-d', `sql:${store}`, '-n', 'BSTG configured target CA']);
    console.log(`BSTG_BROWSER_TRUSTED_CA_SHA256=${trustedCaFingerprint}`);
  }
  // This stdout pipe is a private controller channel. It is never inherited by
  // the terminal or copied to an artifact. Normal diagnostics only carry state.
  const child=spawn(process.execPath,['/bstg-playwright/node_modules/playwright/cli.js','run-server',
    '--host','0.0.0.0','--port',process.env.BSTG_WORKER_PORT,'--path',`/${randomUUID()}`,'--max-clients','16','--unsafe'],{stdio:['ignore','pipe','inherit']});
  let capabilityPublished=false;
  child.stdout.on('data',data=>{
    const message=data.toString();
    if(!capabilityPublished&&publishServerEndpoint(message,endpoint=>{
      capabilityPublished=true;
      process.stdout.write(`${privateCapabilityLine(endpoint)}\n`);
      process.stdout.write('BSTG_BROWSER_WORKER_READY=1\n');
    }))return;
    // Never relay Playwright server stdout: future versions could include the
    // capability URL. The controller receives only the fixed messages above.
  });
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('exit',code=>{process.exitCode=code??1;});
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>child.kill(signal));
}

module.exports={caBundleFingerprint,exactFingerprint,privateCapabilityLine,publishServerEndpoint};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exit(1);});
