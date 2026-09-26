/** Real certificate/process lifecycle; ADB below is an explicit device double. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {profile} from './fixtures.mjs';
import {provisionProxyCertificate,installAndVerifyProxyCertificate} from '../../server/src/services/mobile/android-certificate-manager.ts';
async function certificate(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'bstg-ca-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=BSTG disposable test CA','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'ca.pem')],{stdio:'ignore'});
 const pem=await readFile(path.join(dir,'ca.pem'),'utf8');return {dir,pem,evidence:{ok:true,mode:'preinstalled_system_ca',provisioning:'configured_path',certificate_path:path.join(dir,'ca.pem'),android_ca_hash:'deadbeef',sha256:createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')}};
}
test('cold CA bootstrap waits past the old 2.2s cutoff and reaps the bootstrap process',async t=>{
 const {dir,pem}=await certificate(t),executable=path.join(dir,'mitmdump-fixture');
 await writeFile(executable,`#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(dir,'pid'))},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(path.join(dir,'mitmproxy-ca-cert.pem'))},${JSON.stringify(pem)}),2400);setInterval(()=>{},1000);\n`,{mode:0o700});
 const p=profile();p.config_json={...p.config_json,mitmdump_path:executable,managed_proxy_confdir:dir};
 const result=await provisionProxyCertificate(p);assert.equal(result.ok,true);assert.equal(result.provisioning,'managed_mitmproxy');
 const pid=Number(await readFile(path.join(dir,'pid'),'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
for(const failsAvb of [false,true])test(`AVD remount prepares AVB before its bounded reboot (AVB fails: ${failsAvb})`,async t=>{
 const {pem,evidence}=await certificate(t);const p=profile();p.runtime_type='local_avd';p.android_api_level=30;p.certificate_mode='preinstalled_system_ca';p.config_json.allow_system_ca_install=true;
 const calls=[];let copied=false,mounts=0;
 const driver={waitForDevice:async()=>({ok:true}),runAdb:async args=>{
  calls.push(args.join(' '));let stdout='';
  if(args[0]==='root')stdout='adbd is already running as root';
  if(args[0]==='remount')stdout=++mounts===1?'Now reboot your device for settings to take effect':'remount succeeded';
  if(args.includes('avbctl'))return {ok:!failsAvb,stdout:'',stderr:failsAvb?'fixture denial':''};
  if(args.includes('cp'))copied=true;
  if(args.includes('cat'))stdout=copied?pem:'';
  return {ok:true,stdout,stderr:''};
 }};
 const result=await installAndVerifyProxyCertificate(p,driver,evidence);
 assert.equal(result.install_verified,!failsAvb);
 if(failsAvb){assert.equal(calls.includes('reboot'),false);assert.equal(copied,false);}
 else{assert.equal(calls.filter(x=>x==='reboot').length,1);assert.ok(calls.indexOf('shell avbctl disable-verification')<calls.indexOf('reboot'));}
});
test('a physical-device profile cannot enable automatic AVB/remount changes',async t=>{
 const {evidence}=await certificate(t);const p=profile();p.runtime_type='manual';p.android_api_level=30;p.certificate_mode='preinstalled_system_ca';p.config_json.allow_system_ca_install=true;
 const calls=[];const result=await installAndVerifyProxyCertificate(p,{runAdb:async args=>{calls.push(args);return {ok:false,stdout:'',stderr:'absent'};}},evidence);
 assert.equal(result.ok,false);assert.equal(calls.some(a=>['root','remount','reboot'].includes(a[0])||a.includes('avbctl')),false);
});
