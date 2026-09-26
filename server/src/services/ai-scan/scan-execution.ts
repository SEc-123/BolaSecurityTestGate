import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { DbProvider } from '../../types/index.js';
import { dbAll, dbGet, dbRun } from '../../db/sql-helpers.js';
import { AIScanAgentRuntime, type AgentRunOptions, type AgentRunResult } from '../../agent/agent-runtime.js';
import { AIScanRepository } from './repository.js';

const owner=randomUUID(), host=os.hostname();
const active=new Map<string,Promise<AgentRunResult>>();
async function ensureTable(db:DbProvider){
  await dbRun(db,`CREATE TABLE IF NOT EXISTS ai_scan_execution_leases (scan_run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, hostname TEXT NOT NULL, pid INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
}
export function scanRunOptions(body:any):AgentRunOptions {
  const options:AgentRunOptions={};
  for(const [key,max] of [['max_steps',10000],['max_parallel_agents',8]] as const){
    if(body?.[key]===undefined)continue;
    const value=body[key];
    if(!Number.isInteger(value)||value<1||value>max)throw new Error(`${key} must be an integer between 1 and ${max}.`);
    options[key]=value;
  }
  return options;
}

/** One lease for both synchronous and asynchronous entry points. Evidence belongs to one attempt. */
export async function startManagedScan(db:DbProvider,id:string,options:AgentRunOptions={}) {
  if(active.has(id))return {started:false,promise:active.get(id)!};
  const repo=new AIScanRepository(db),run=await repo.getRun(id);
  if(!run)throw new Error('测试记录不存在。');
  if(['completed','failed'].includes(run.status))throw new Error('本轮已经结束。请新建重试记录，保留原始证据。');
  if(run.status==='awaiting_selection')throw new Error('请先确认测试范围。');
  await ensureTable(db);
  await dbRun(db,'INSERT INTO ai_scan_execution_leases (scan_run_id,owner,hostname,pid,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(scan_run_id) DO NOTHING',[id,owner,host,process.pid,new Date().toISOString()]);
  const lease=await dbGet<any>(db,'SELECT owner FROM ai_scan_execution_leases WHERE scan_run_id = ?',[id]);
  if(lease?.owner!==owner)throw new Error('本轮已有执行进程，不能重复启动。');
  // Another call can enter while the database awaits above.
  if(active.has(id))return {started:false,promise:active.get(id)!};
  const promise=Promise.resolve().then(async()=>{
    const heartbeat=setInterval(()=>{void dbRun(db,'UPDATE ai_scan_execution_leases SET updated_at = ? WHERE scan_run_id = ? AND owner = ?',[new Date().toISOString(),id,owner]).catch(()=>undefined);},30000);
    heartbeat.unref();
    try{return await new AIScanAgentRuntime(db).run(id,options);}
    catch(error){
      await repo.updateRun(id,{status:'failed',current_phase:'execution_failed',summary:{...run.summary,execution_error:error instanceof Error?error.message:String(error)}});
      throw error;
    }finally{
      clearInterval(heartbeat);active.delete(id);
      await dbRun(db,'DELETE FROM ai_scan_execution_leases WHERE scan_run_id = ? AND owner = ?',[id,owner]);
    }
  });
  active.set(id,promise);
  // Background routes intentionally do not await the execution; they still retain failures in the run.
  void promise.catch(()=>undefined);
  return {started:true,promise};
}

/** Reconcile only provably dead local workers. Never steal remote or live process ownership. */
export async function recoverInterruptedScans(db:DbProvider):Promise<void>{
  await ensureTable(db);
  const repo=new AIScanRepository(db),leases=await dbAll<any>(db,'SELECT * FROM ai_scan_execution_leases');
  for(const run of await repo.listRuns()){
    const lease=leases.find(l=>l.scan_run_id===run.id);
    if(!['running','discovering','planning'].includes(run.status) && !(run.status==='created'&&lease))continue;
    if(lease){
      if(lease.hostname!==host)continue;
      try{process.kill(lease.pid,0);continue;}catch(error:any){if(error.code!=='ESRCH')continue;}
    }
    const reason='服务进程在执行中退出。本轮已中断，保留原始证据；重新测试会建立独立记录。';
    for(const task of await repo.listTasks(run.id)) if(['running','pending'].includes(task.status))await repo.updateTask(task.id,{status:'failed',phase:'interrupted',error_message:reason,completed_at:new Date().toISOString()});
    await repo.updateRun(run.id,{status:'failed',current_phase:'interrupted',summary:{...run.summary,execution_error:reason}});
    if(lease)await dbRun(db,'DELETE FROM ai_scan_execution_leases WHERE scan_run_id = ? AND owner = ?',[run.id,lease.owner]);
  }
}
