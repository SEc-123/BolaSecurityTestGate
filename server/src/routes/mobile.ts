import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import { getMobileProfile, listMobileProfiles, upsertMobileProfile } from '../services/mobile/mobile-profile-service.js';
import { createMobileSession, getMobileSession, listMobileActions, listMobileSessions } from '../services/mobile/mobile-session-service.js';
import { exportAndImportMobileCapture, installMobileApp, launchMobileApp, observeMobileApp, prepareMobileLab, runConfiguredMobileFlow, runMobileAction, verifyMobileLabHealth, stopMobileLab, exportMobileCaptureEvidence, getMobileTestReport, runMobileAppTest } from '../services/mobile/mobile-lab-service.js';
import { AIScanRepository } from '../services/ai-scan/repository.js';
import { attestMobileApk, importMobileApp, importMobileAppStream, MAX_APK_BYTES } from '../services/mobile/mobile-app-service.js';

import { publicMobileProfile } from '../services/mobile/mobile-business-scenarios.js';
import { businessText } from '../services/ai-scan/product-state-service.js';

import { verifyEvidenceFile } from '../services/mobile/mobile-test-evidence.js';

const router = Router();

function db() { return dbManager.getActive(); }
function id(req: Request): string { return String(req.params.id || ''); }


router.post('/apps/upload', async (req: Request,res: Response) => {
  try {
    if(!['application/vnd.android.package-archive','application/octet-stream'].includes(String(req.headers['content-type']||'').split(';')[0])) return res.status(415).json({data:null,error:'请上传 APK 二进制文件。'});
    if(Number(req.headers['content-length']||0)>MAX_APK_BYTES)return res.status(413).json({data:null,error:'安装包超过 256 MiB 上限。'});
    const profile=req.query.profile_id?await getMobileProfile(db(),String(req.query.profile_id)):undefined;
    if(profile && !profile.is_enabled)throw new Error('测试设备已停用。');
    const app=await importMobileAppStream(req,{filename:String(req.query.filename||'app.apk'),apk_source:'operator_authorized_browser_upload'},
      {aapt_path:profile?.config_json?.aapt_path,apksigner_path:profile?.config_json?.apksigner_path});
    res.status(201).json({data:{id:app.id,name:app.app_label||app.original_filename,package_name:app.package_name,ready:true,
      endpoint_candidates:app.endpoint_candidates||[],warnings:app.inspection_warnings||[],size_bytes:app.size_bytes},error:null});
  }catch(error:any){if(!res.destroyed)res.status(400).json({data:null,error:error.message});}
});

router.post('/apps/import', async (req: Request, res: Response) => {
  try {
    const profile = req.body?.profile_id ? await getMobileProfile(db(), String(req.body.profile_id)) : undefined;
    if (profile && !profile.is_enabled) throw new Error('Mobile profile is disabled.');
    const app = await importMobileApp({ filename: String(req.body?.filename || 'app.apk'), base64: String(req.body?.base64 || ''), apk_source: req.body?.apk_source ? String(req.body.apk_source) : undefined }, { aapt_path: profile?.config_json?.aapt_path, apksigner_path: profile?.config_json?.apksigner_path });
    res.status(201).json({ data: req.query.view === 'product' ? { id: app.id, name: businessText(app.app_label || app.original_filename, '测试应用'), package_name: app.package_name, ready: app.signature_verified && !!app.package_name && !!app.launch_activity } : app, error: null });
  } catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.post('/setup',async(req:Request,res:Response)=>{
  try {
    const {serial,appium_url,proxy_host,proxy_port,install_ca}=req.body||{};
    if(typeof serial!=='string'||!serial.trim()||/[\s\x00-\x1f]/.test(serial))throw new Error('请输入有效的设备序列号。');
    if(typeof proxy_host!=='string'||!proxy_host.trim()||/[\s/\x00-\x1f]/.test(proxy_host))throw new Error('请输入设备可访问的代理地址。');
    const profile=await upsertMobileProfile(db(),{id:'android-burp-ready-default',name:'Android 测试设备',adb_serial:serial,
      appium_server_url:String(appium_url||''),proxy_host,proxy_port:Number(proxy_port),proxy_type:'mitmproxy',
      certificate_mode:'preinstalled_system_ca',is_enabled:true,config_json:{strict_real_e2e:true,offline_simulator:false,managed_proxy:true,mitm_proxy_mode:'regular',
        appium_server_url:String(appium_url||''),allow_system_ca_install:install_ca===true,
        proxy_listen_host:proxy_host==='10.0.2.2'?'127.0.0.1':'0.0.0.0'}});
    res.json({data:publicMobileProfile(profile),error:null});
  }catch(error:any){res.status(400).json({data:null,error:error.message});}
});

router.get('/business-profiles', async (_req: Request, res: Response) => {
  try { res.json({ data: (await listMobileProfiles(db())).filter(p => p.is_enabled).map(publicMobileProfile), error: null }); }
  catch { res.status(500).json({ data: null, error: '暂时无法读取测试环境，请稍后重试。' }); }
});

router.get('/profiles', async (_req: Request, res: Response) => {
  try { res.json({ data: await listMobileProfiles(db()), error: null }); }
  catch (error: any) { res.status(500).json({ data: null, error: error.message }); }
});

router.post('/profiles', async (req: Request, res: Response) => {
  try { res.status(201).json({ data: await upsertMobileProfile(db(), req.body), error: null }); }
  catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.get('/sessions', async (req: Request, res: Response) => {
  try { res.json({ data: await listMobileSessions(db(), req.query.scan_run_id ? String(req.query.scan_run_id) : undefined), error: null }); }
  catch (error: any) { res.status(500).json({ data: null, error: error.message }); }
});

router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const apkPath = req.body?.apk_path ? String(req.body.apk_path) : undefined;
    const declaredSource = req.body?.apk_source ? String(req.body.apk_source) : undefined;
    const profileId = String(req.body?.profile_id || 'android-burp-ready-default');
    const profile = await getMobileProfile(db(), profileId);
    if (!profile.is_enabled) throw new Error('Mobile profile is disabled.');
    const attestation = apkPath ? await attestMobileApk(apkPath, { aapt_path: profile.config_json?.aapt_path, apksigner_path: profile.config_json?.apksigner_path }) : undefined;
    if (attestation && req.body?.apk_sha256 && String(req.body.apk_sha256).toLowerCase() !== attestation.sha256.toLowerCase()) {
      throw new Error('Declared apk_sha256 does not match the submitted APK file.');
    }
    if (attestation && req.body?.apk_signer_sha256 && String(req.body.apk_signer_sha256).replace(/:/g, '').toLowerCase() !== String(attestation.signer_sha256 || '').replace(/:/g, '').toLowerCase()) {
      throw new Error('Declared apk_signer_sha256 does not match the submitted APK signature.');
    }
    if (attestation?.package_name && req.body?.app_package && String(req.body.app_package) !== attestation.package_name) {
      throw new Error(`Declared app_package does not match APK metadata: ${attestation.package_name}.`);
    }
    const session = await createMobileSession(db(), {
      scan_run_id: req.body?.scan_run_id ? String(req.body.scan_run_id) : undefined,
      profile_id: profileId,
      device_id: req.body?.device_id ? String(req.body.device_id) : undefined,
      app_package: req.body?.app_package ? String(req.body.app_package) : attestation?.package_name,
      app_activity: req.body?.app_activity ? String(req.body.app_activity) : attestation?.launch_activity,
      apk_path: apkPath,
      apk_source: declaredSource,
      apk_sha256: attestation?.sha256 || (req.body?.apk_sha256 ? String(req.body.apk_sha256) : undefined),
      apk_signer_sha256: attestation?.signer_sha256 || (req.body?.apk_signer_sha256 ? String(req.body.apk_signer_sha256) : undefined),
      apk_package_name: attestation?.package_name || (req.body?.apk_package_name ? String(req.body.apk_package_name) : undefined),
      apk_launch_activity: attestation?.launch_activity || (req.body?.apk_launch_activity ? String(req.body.apk_launch_activity) : undefined),
      apk_native_abis: attestation?.native_abis,
      screen_stream_url: req.body?.screen_stream_url ? String(req.body.screen_stream_url) : undefined,
    });
    res.status(201).json({ data: session, error: null });
  } catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.get('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const session = await getMobileSession(db(), id(req));
    if (!session) return res.status(404).json({ data: null, error: 'Mobile session not found' });
    const actions = await listMobileActions(db(), session.id);
    res.json({ data: { session, actions }, error: null });
  } catch (error: any) { res.status(500).json({ data: null, error: error.message }); }
});

router.post('/sessions/:id/start', async (req: Request, res: Response) => {
  try {
    const existing = await getMobileSession(db(), id(req));
    if (!existing) return res.status(404).json({ data: null, error: 'Mobile session not found' });
    const result = await prepareMobileLab(db(), {
      session_id: existing.id,
      scan_run_id: existing.scan_run_id,
      profile_id: existing.profile_id,
      app_package: req.body?.app_package || existing.app_package,
      app_activity: req.body?.app_activity || existing.app_activity,
      apk_path: req.body?.apk_path || existing.apk_path,
    });
    res.status(result.health.status === 'blocked' ? 422 : 200).json({ data: result, error: result.health.status === 'blocked' ? result.health.summary : null });
  } catch (error: any) { res.status(500).json({ data: null, error: error.message }); }
});

router.post('/sessions/:id/install-apk', async (req: Request, res: Response) => {
  try { res.json({ data: await installMobileApp(db(), id(req), req.body?.apk_path ? String(req.body.apk_path) : undefined), error: null }); }
  catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.post('/sessions/:id/launch', async (req: Request, res: Response) => {
  try { res.json({ data: await launchMobileApp(db(), id(req), req.body?.app_package ? String(req.body.app_package) : undefined, req.body?.app_activity ? String(req.body.app_activity) : undefined), error: null }); }
  catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.get('/sessions/:id/observe', async (req: Request, res: Response) => {
  try {
    const session = await getMobileSession(db(), id(req));
    const repo = session?.scan_run_id ? new AIScanRepository(db()) : undefined;
    res.json({ data: await observeMobileApp(db(), id(req), repo, req.query.task_id ? String(req.query.task_id) : undefined), error: null });
  } catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.get('/sessions/:id/screenshot', async (req: Request, res: Response) => {
  try {
    const observation = await observeMobileApp(db(), id(req));
    if (!observation.screenshot_base64) return res.status(404).json({ data: null, error: 'No screenshot available' });
    const buffer = Buffer.from(observation.screenshot_base64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  } catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.post('/sessions/:id/action', async (req: Request, res: Response) => {
  try {
    const session = await getMobileSession(db(), id(req));
    const repo = session?.scan_run_id ? new AIScanRepository(db()) : undefined;
    const result = await runMobileAction(db(), id(req), req.body || {}, repo, req.body?.task_id ? String(req.body.task_id) : undefined);
    res.status(result.ok ? 200 : 422).json({ data: result, error: result.ok ? null : result.result?.error || 'Mobile action failed.' });
  } catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.post('/sessions/:id/test', async (req: Request, res: Response) => {
  try {
    if (!Array.isArray(req.body?.steps)) return res.status(400).json({ data: null, error: 'steps must be a JSON array.' });
    if (req.body?.authorized !== true) return res.status(400).json({ data: null, error: 'Explicit authorized=true is required for APK/device/backend business testing.' });
    const report = await runMobileAppTest(db(), id(req), req.body.steps, { import_capture: req.body.import_capture !== false });
    res.status(report.acceptance_complete ? 200 : 422).json({ data: report, error: report.acceptance_complete ? null : 'Appium HTTPS test BLOCK; inspect report and evidence.' });
  } catch (error: any) { res.status(/MOBILE_BUSY/.test(error.message) ? 409 : 400).json({ data: null, error: error.message }); }
});

router.post('/sessions/:id/flow', async (req: Request, res: Response) => {
  try {
    const session = await getMobileSession(db(), id(req));
    const repo = session?.scan_run_id ? new AIScanRepository(db()) : undefined;
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
    const result = await runConfiguredMobileFlow(db(), id(req), steps, repo, req.body?.task_id ? String(req.body.task_id) : undefined);
    res.status(result.ok ? 200 : 422).json({ data: result, error: result.ok ? null : 'Mobile flow failed; inspect persisted action results.' });
  } catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.get('/sessions/:id/health', async (req: Request, res: Response) => {
  try { res.json({ data: await verifyMobileLabHealth(db(), id(req)), error: null }); }
  catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.post('/sessions/:id/import-capture', async (req: Request, res: Response) => {
  try { res.json({ data: await exportAndImportMobileCapture(db(), id(req), { export_path: req.body?.export_path, flows: Array.isArray(req.body?.flows) ? req.body.flows : undefined, regenerate: req.body?.regenerate !== false }), error: null }); }
  catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

router.post('/sessions/:id/stop', async (req: Request, res: Response) => {
  try { const result = await stopMobileLab(db(), id(req)); res.status(result.ok ? 200 : 409).json({ data: result, error: result.ok ? null : 'Runtime cleanup failed; inspect cleanup evidence.' }); }
  catch (error: any) { res.status(400).json({ data: null, error: error.message }); }
});

// Evidence is selected through the session's persisted action record, never a
// caller-supplied filesystem path. Retains the application's existing API auth.
router.get('/sessions/:id/test-report', async (req: Request, res: Response) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await getMobileTestReport(db(), id(req)), error: null }); }
  catch (error: any) { res.status(409).json({ data: null, error: error.message }); }
});
router.get('/sessions/:id/actions/:actionId/evidence/:kind', async (req: Request, res: Response) => {
  try {
    const kinds: Record<string, [string, string]> = { screen: ['screen.png','image/png'], ui: ['ui.json','application/json'], network: ['network.json','application/json'], appium: ['appium.json','application/json'] };
    const kind = kinds[String(req.params.kind)];
    if (!kind) return res.status(400).json({ data: null, error: 'Unsupported evidence kind.' });
    const action = (await listMobileActions(db(), id(req))).find(a => a.id === String(req.params.actionId));
    const file = action?.result_json?.evidence?.files?.[kind[0]];
    if (!file) return res.status(404).json({ data: null, error: 'Evidence does not belong to this session/action.' });
    const bytes = await verifyEvidenceFile(file);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', kind[1]);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Evidence-SHA256', file.sha256);
    res.send(bytes);
  } catch (error: any) { res.status(409).json({ data: null, error: error.message }); }
});

router.get('/sessions/:id/capture-evidence', async (req: Request, res: Response) => {
  try { res.json({ data: await exportMobileCaptureEvidence(db(), id(req)), error: null }); }
  catch (error: any) { res.status(409).json({ data: null, error: error.message }); }
});

export default router;
