/** Real local TLS sockets. Keys/certs are ephemeral test inputs, never shipped. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createLabBackend } from '../../examples/appium-https/https-backend.mjs';
export async function tlsLab(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bstg-real-tls-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem')], { stdio:'ignore',timeout:20000 });
  const cert = await readFile(path.join(dir,'cert.pem')), key = await readFile(path.join(dir,'key.pem'));
  const server = createLabBackend({key,cert,password:'test-only-password'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  return {server,cert,url:`https://127.0.0.1:${server.address().port}`};
}
export function httpsCall(url,{ca,method='GET',body,headers={},servername}={}) {
  const started_at = new Date().toISOString();
  return new Promise((resolve,reject)=>{
    const req=https.request(url,{ca,method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},rejectUnauthorized:true,servername,timeout:5000},res=>{
      const tls = {version:res.socket.getProtocol(),authorized:res.socket.authorized};
      let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:text,headers:res.headers,tls,started_at}));
    });
    req.on('timeout',()=>req.destroy(new Error('TLS test timeout')));req.on('error',reject);req.end(body);
  });
}
