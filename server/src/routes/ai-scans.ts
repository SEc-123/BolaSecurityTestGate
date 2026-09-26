import { buildProductEvidence } from '../services/ai-scan/product-evidence.js';
import { appendMobileTestEvidence } from '../services/ai-scan/product-mobile-evidence.js';
import { createHash } from 'node:crypto';
import { sanitizeForAIModel } from '../agent/model-context-sanitizer.js';
import { startManagedScan, scanRunOptions } from '../services/ai-scan/scan-execution.js';
import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import { AIScanAgentRuntime } from '../agent/agent-runtime.js';
import { buildProductAssessmentState, productRun } from '../services/ai-scan/product-state-service.js';
import { localText, requestLanguage } from '../services/i18n/language.js';
import { normalizeTargetBaseUrl } from '../services/ai-scan/target-scope.js';
import { normalizeAuthenticationOrigins } from '../services/ai-scan/browser/authentication-scope.js';
import { closePersistentBrowserContext } from '../services/ai-scan/browser/persistent-browser-runtime.js';
import { rememberAgentObservation } from '../services/ai-scan/agent-memory.js';

import { productEventHub } from '../services/ai-scan/product-event-hub.js';
import { streamProductState } from '../services/ai-scan/product-stream.js';
import { resolveMobileBusinessSelection } from '../services/mobile/mobile-business-scenarios.js';
import { getMobileProfile } from '../services/mobile/mobile-profile-service.js';
import { getImportedMobileApp } from '../services/mobile/mobile-app-service.js';

const router = Router();


function runtime() {
  return new AIScanAgentRuntime(dbManager.getActive());
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('base_url is required');
  return normalizeTargetBaseUrl(value);
}

function selectedTypesFromBody(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item).trim()).filter(Boolean);
}


const ALL_VULN_TYPES = [
  'file_upload',
  'file_download',
  'path_traversal',
  'bola_idor',
  'bfla',
  'business_logic',
  'xss',
  'command_injection',
  'auth_otp',
  'email_sms_bypass',
  'passcode_bypass',
  'replay_race',
  'state_machine_race',
];


function hasConfiguredManualAccounts(config: any): boolean {
  return Boolean(config?.accounts && typeof config.accounts === 'object' && Object.keys(config.accounts).length > 0);
}

function hasRawAccountRequests(config: any): boolean {
  if (Array.isArray(config?.account_raw_requests)) return config.account_raw_requests.length > 0;
  return typeof config?.account_raw_requests === 'string' && config.account_raw_requests.trim().length > 0;
}

function normalizeScanConfig(value: any): Record<string, any> {
  const config = value && typeof value === 'object' ? { ...value } : {};
  config.authentication_origins = normalizeAuthenticationOrigins(config.authentication_origins);
  const inferredAccountMode = config.account_mode || (hasConfiguredManualAccounts(config) ? 'manual' : hasRawAccountRequests(config) ? 'raw' : 'auto_execute');
  config.account_mode = inferredAccountMode;
  config.request_evidence_required = config.request_evidence_required !== false;
  if (config.enable_account_auto_execution === undefined) {
    config.enable_account_auto_execution = inferredAccountMode === 'auto_execute';
  }
  if (config.enable_autonomous_account_discovery === undefined) {
    config.enable_autonomous_account_discovery = inferredAccountMode === 'auto_execute' || inferredAccountMode === 'autonomous';
  }
  if (!Array.isArray(config.auto_account_roles) || config.auto_account_roles.length === 0) {
    config.auto_account_roles = ['attacker', 'victim', 'admin'];
  }
  if (config.account_bootstrap_max_pages === undefined) {
    config.account_bootstrap_max_pages = 40;
  }
  const memoryConfig = config.agent_memory && typeof config.agent_memory === 'object' ? config.agent_memory : {};
  config.agent_memory = {
    max_context_memories: Math.max(4, Math.min(50, Number(memoryConfig.max_context_memories || 20))),
    default_ttl_seconds: Math.max(300, Math.min(604800, Number(memoryConfig.default_ttl_seconds || 86400))),
  };
  const browserConfig = config.browser_runtime && typeof config.browser_runtime === 'object' ? config.browser_runtime : {};
  config.browser_runtime = {
    persist_contexts: browserConfig.persist_contexts !== false,
    default_scope: ['scan', 'task'].includes(browserConfig.default_scope) ? browserConfig.default_scope : 'task',
    context_ttl_seconds: Math.max(60, Math.min(86400, Number(browserConfig.context_ttl_seconds || 3600))),
  };
  return config;
}

function isAutopilotScan(config: any): boolean {
  return config?.driving_mode === 'autopilot' || config?.auto_start === true || config?.selected_scope_strategy === 'all_vulnerability_types';
}

router.get('/product-runs', async (_req: Request, res: Response) => {
  try { res.json({ data: (await runtime().getRepository().listRuns()).map(productRun), error: null }); }
  catch { res.status(500).json({ data: null, error: '暂时无法读取测试记录。' }); }
});

router.get('/tools', async (req: Request, res: Response) => {
  try {
    const tools = runtime().listTools(String(req.query.q || '')).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      side_effects: tool.side_effects || [],
    }));
    res.json({ data: tools, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/', async (_req: Request, res: Response) => {
  try {
    const rt = runtime();
    const runs = await rt.getRepository().listRuns();
    res.json({ data: runs, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const rt = runtime();
    const repo = rt.getRepository();
    const baseUrl = normalizeBaseUrl(req.body?.base_url);
    const scanConfig = normalizeScanConfig(req.body?.scan_config || {});
    if (req.query.view === 'product' && scanConfig.authorization_acknowledged !== true) throw new Error('请确认目标测试授权。');
    if(req.query.view==='product'){scanConfig.request_evidence_required=true;if(scanConfig.surface==='android'&&!scanConfig.mobile?.app_asset_id)throw new Error('请先上传有效 APK。');}
    if (!['web','android',undefined].includes(scanConfig.surface)) throw new Error('不支持的测试类型。');
    if (scanConfig.surface === 'android' && scanConfig.mobile?.app_asset_id) {
      scanConfig.mobile = resolveMobileBusinessSelection({
        profile: await getMobileProfile(dbManager.getActive(), String(scanConfig.mobile.lab_profile_id || '')),
        app: await getImportedMobileApp(String(scanConfig.mobile.app_asset_id || '')),
        scenarioIds: scanConfig.mobile.scenario_ids, authorized: scanConfig.mobile.authorization_acknowledged === true, baseUrl,
      });
    }
    const language = requestLanguage({ body: req.body, query: req.query, headers: req.headers as any });
    const selectedFromBody = selectedTypesFromBody(req.body?.selected_vuln_types);
    if(selectedFromBody.some(t=>!ALL_VULN_TYPES.includes(t)))throw new Error('包含不支持的测试类别。');
    const selected = selectedFromBody.length > 0 ? selectedFromBody : (isAutopilotScan(scanConfig) ? ALL_VULN_TYPES : []);
    const db = dbManager.getActive();

    const env = await db.repos.environments.create({
      name: req.body?.name || `AI Scan Target ${new URL(baseUrl).host}`,
      description: localText(language, `Auto-created by AI Scan for ${baseUrl}`, `AI 扫描自动创建：${baseUrl}`),
      base_url: new URL(baseUrl).origin,
      is_active: true,
    } as any);

    const run = await repo.createRun({
      base_url: baseUrl,
      name: req.body?.name,
      user_prompt: req.body?.user_prompt || req.body?.prompt || '',
      language,
      selected_vuln_types: selected,
      scan_config: scanConfig,
      environment_id: env.id,
    });
    await rt.bootstrapRun(run);
    if(req.query.view==='product' && scanConfig.auto_start===true)await startManagedScan(db,run.id);
    res.status(201).json({ data: req.query.view === 'product' ? buildProductAssessmentState(await repo.getProductSnapshot(run.id)) : await repo.getSnapshot(run.id), error: null });
  } catch (error: any) {
    res.status(400).json({ data: null, error: error.message });
  }
});


router.get('/:id/memories', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const memories = await repo.listAgentMemories(String(req.params.id), { status: req.query.status ? String(req.query.status) : undefined, memory_type: req.query.type ? String(req.query.type) : undefined, include_expired: req.query.include_expired === 'true' });
    res.json({ data: memories, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.get('/:id/memories/:memoryId/revisions', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const scanRunId = String(req.params.id);
    const memory = await repo.getAgentMemory(String(req.params.memoryId));
    if (!memory || memory.scan_run_id !== scanRunId) return res.status(404).json({ data: null, error: 'Agent memory not found in this scan' });
    const revisions = await repo.listAgentMemoryRevisions(memory.id);
    res.json({ data: revisions, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.post('/:id/memories', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const scanRunId = String(req.params.id);
    const run = await repo.getRun(scanRunId);
    if (!run) return res.status(404).json({ data: null, error: `AI scan run not found: ${scanRunId}` });
    if (!req.body?.memory_type || !req.body?.memory_key || !req.body?.summary) return res.status(400).json({ data: null, error: 'memory_type, memory_key and summary are required' });
    const memory = await rememberAgentObservation({ repo, scanRunId, taskId: req.body?.task_id ? String(req.body.task_id) : undefined, memoryType: String(req.body.memory_type), memoryKey: String(req.body.memory_key), scopeType: req.body?.scope_type, scopeRef: req.body?.scope_ref ? String(req.body.scope_ref) : undefined, title: req.body?.title ? String(req.body.title) : undefined, summary: String(req.body.summary), content: req.body?.content && typeof req.body.content === 'object' ? req.body.content : {}, confidence: req.body?.confidence === undefined ? undefined : Number(req.body.confidence), ttlSeconds: req.body?.ttl_seconds === undefined ? Number(run.scan_config?.agent_memory?.default_ttl_seconds || 86400) : Number(req.body.ttl_seconds), dependsOn: Array.isArray(req.body?.depends_on) ? req.body.depends_on.map(String) : [], provenance: { source: 'ai_scan_api', operator_supplied: true } });
    res.status(201).json({ data: memory, error: null });
  } catch (error: any) {
    res.status(400).json({ data: null, error: error.message });
  }
});

router.get('/:id/browser-contexts', async (req: Request, res: Response) => {
  try {
    const contexts = await runtime().getRepository().listBrowserContexts(String(req.params.id));
    res.json({ data: contexts, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.post('/:id/browser-contexts/:contextKey/close', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const scanRunId = String(req.params.id);
    const contextKey = decodeURIComponent(String(req.params.contextKey));
    await closePersistentBrowserContext(repo, scanRunId, contextKey, 'closed');
    res.json({ data: { context_key: contextKey, status: 'closed' }, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.get('/:id/planner-decisions', async (req: Request, res: Response) => {
  try {
    const repo = runtime().getRepository();
    const decisions = await repo.listPlannerDecisions(String(req.params.id), req.query.task_id ? String(req.query.task_id) : undefined);
    res.json({ data: decisions, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});




router.get('/:id/product-events', async (req: Request, res: Response) => {
  try {
  const runId = String(req.params.id), repo = runtime().getRepository();
  if (!await repo.getRun(runId)) return res.status(404).json({ data: null, error: '未找到测试记录。' });
  if (productEventHub.count(runId) >= 32) return res.status(429).json({ data: null, error: '当前查看连接过多，请稍后重试。' });
  streamProductState({ req, res, read: async () => buildProductAssessmentState(await repo.getProductSnapshot(runId)),
    subscribe: listener => productEventHub.subscribe(runId, listener) });
  } catch { if (!res.headersSent) res.status(503).json({data:null,error:'暂时无法读取测试状态。'}); }
});

router.get('/:id/frames/:frameId', async (req: Request, res: Response) => {
  try {
    const frame = await runtime().getRepository().getProductFrame(String(req.params.id), String(req.params.frameId));
    if (!frame?.content_text || frame.content_text.length > 12 * 1024 * 1024) return res.sendStatus(404);
    const bytes = Buffer.from(frame.content_text, 'base64');
    const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if ((!png && !jpeg) || bytes.length > 8 * 1024 * 1024) return res.sendStatus(404);
    res.setHeader('Content-Type', png ? 'image/png' : 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  } catch { res.sendStatus(404); }
});

router.get('/:id/product-state', async (req: Request, res: Response) => {
  try {
    const snapshot = await runtime().getRepository().getProductSnapshot(String(req.params.id));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: buildProductAssessmentState(snapshot), error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.get('/:id/evidence-export',async(req:Request,res:Response)=>{
  try {
    const repo=runtime().getRepository(),snapshot=await repo.getSnapshot(String(req.params.id));
    const allowed=new Set(['endpoint_request','baseline_http_response','generic_mutation_attempt','generic_payload_coverage','ai_judgement','mobile_capture_import','mobile_discovery_result','mobile_appium_test_report','mobile_cleanup','workflow_precondition_block','web_discovery_coverage','browser_execution_proof','upload_execution_plan','upload_request','upload_attempt','upload_attempt_error','mobile_action_progress']);
    const records=snapshot.artifacts.filter(a=>allowed.has(a.artifact_type)).map(a=>({id:a.id,task_id:a.task_id,endpoint_id:a.source_ref,type:a.artifact_type,created_at:a.created_at,
      source_sha256:createHash('sha256').update(JSON.stringify(a.content_json)).digest('hex'),content:sanitizeForAIModel(a.content_json)}));
    const product=buildProductAssessmentState(await repo.getProductSnapshot(snapshot.run.id));
    res.setHeader('Content-Disposition',`attachment; filename="bstg-evidence-${snapshot.run.id}.json"`);
    res.json({format:'bstg-evidence-v1',exported_at:new Date().toISOString(),assessment:product,records,
      notice:'Contains recorded request/response evidence with known credential fields redacted. Scope and incomplete checks are part of this report.'});
  }catch(error:any){res.status(404).json({data:null,error:error.message});}
});

router.get('/:id/tests/:testId/evidence', async (req:Request,res:Response)=>{
  try{
    const snapshot=await runtime().getRepository().getSnapshot(String(req.params.id));
    const evidence=buildProductEvidence(snapshot,String(req.params.testId));
    if(!evidence)return res.status(404).json({data:null,error:'该测试不属于当前记录。'});
    await appendMobileTestEvidence(dbManager.getActive(),snapshot,evidence);
    res.setHeader('Cache-Control','private, no-store');
    res.json({data:evidence,error:null});
  }catch{res.status(404).json({data:null,error:'本轮测试证据暂时无法读取。'});}
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const snapshot = await runtime().getRepository().getSnapshot(String(req.params.id));
    res.json({ data: snapshot, error: null });
  } catch (error: any) {
    res.status(404).json({ data: null, error: error.message });
  }
});

router.post('/:id/run', async (req:Request,res:Response)=>{
  try {
    const started=await startManagedScan(dbManager.getActive(),String(req.params.id),scanRunOptions(req.body));
    const result=await started.promise;
    res.json({data:result,error:null});
  }catch(error:any){res.status(409).json({data:null,error:error.message});}
});

router.post('/:id/run-async',async(req:Request,res:Response)=>{
  try {
    const id=String(req.params.id),repo=runtime().getRepository();
    const execution=await startManagedScan(dbManager.getActive(),id,scanRunOptions(req.body));
    res.status(202).json({data:{scan_run_id:id,running:true,started:execution.started,
      snapshot:req.query.view==='product'?buildProductAssessmentState(await repo.getProductSnapshot(id)):await repo.getSnapshot(id)},error:null});
  }catch(error:any){res.status(409).json({data:null,error:error.message});}
});

router.post('/:id/retry',async(req:Request,res:Response)=>{
  try {
    const rt=runtime(),repo=rt.getRepository(),prior=await repo.getRun(String(req.params.id));
    if(!prior)throw new Error('原测试不存在。');
    if(!['failed','completed'].includes(prior.status))throw new Error('请等待当前测试结束，避免重复业务操作。');
    const config={...prior.scan_config};
    if(req.body?.authentication_origins!==undefined)config.authentication_origins=normalizeAuthenticationOrigins(req.body.authentication_origins);
    if(config.surface==='android' && config.mobile?.app_asset_id)config.mobile=resolveMobileBusinessSelection({
      profile:await getMobileProfile(dbManager.getActive(),config.mobile.lab_profile_id),
      app:await getImportedMobileApp(config.mobile.app_asset_id),scenarioIds:config.mobile.scenario_ids,authorized:config.mobile.authorization_acknowledged===true,baseUrl:prior.base_url});
    const environment=await dbManager.getActive().repos.environments.create({name:prior.name||'Assessment retry',base_url:new URL(prior.base_url).origin,is_active:true} as any);
    const run=await repo.createRun({name:prior.name,base_url:prior.base_url,user_prompt:prior.user_prompt,language:prior.language,
      selected_vuln_types:prior.selected_vuln_types,environment_id:environment.id,scan_config:{...config,retry_of:prior.id}});
    await rt.bootstrapRun(run);
    await startManagedScan(dbManager.getActive(),run.id);
    res.status(201).json({data:buildProductAssessmentState(await repo.getProductSnapshot(run.id)),error:null});
  }catch(error:any){res.status(409).json({data:null,error:error.message});}
});

router.post('/:id/select-vulns', async (req: Request, res: Response) => {
  try {
    const rt = runtime();
    const repo = rt.getRepository();
    const scanRunId = String(req.params.id);
    const language = requestLanguage({ body: req.body, query: req.query, headers: req.headers as any });
    const selected = selectedTypesFromBody(req.body?.selected_vuln_types);
    if (selected.length === 0) {
      res.status(400).json({ data: null, error: 'selected_vuln_types must be a non-empty array' });
      return;
    }
    await repo.updateRun(scanRunId, { selected_vuln_types: selected, language, status: 'planning', current_phase: 'expanding_selected_vulnerabilities' } as any);

    const tasks = await repo.listTasks(scanRunId);
    for (const task of tasks.filter(task => task.status === 'waiting_selection')) {
      await repo.updateTask(task.id, {
        status: 'completed',
        phase: 'selection_completed',
        result_summary: localText(language, `Selected: ${selected.join(', ')}`, `已选择：${selected.join(', ')}`),
      });
    }

    await rt.expandSelectedVulnerabilities(scanRunId, selected);

    res.json({ data: req.query.view === 'product' ? buildProductAssessmentState(await repo.getProductSnapshot(scanRunId)) : await repo.getSnapshot(scanRunId), error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

export default router;
