import { MobileSetup } from '../components/assessment/MobileSetup';
import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Plus, RefreshCw, ShieldCheck, Smartphone, Monitor } from 'lucide-react';
import { assessmentApi, type BusinessApp, type BusinessProfile } from '../lib/assessment-api';
import { useAssessmentFeed } from '../hooks/useAssessmentFeed';
import { AssessmentWorkspace } from '../components/assessment/AssessmentWorkspace';
import type { AssessmentRun } from '../types/assessment';

const CHECKS = [
  ['bola_idor', '跨账号越权'], ['bfla', '角色权限'], ['auth_otp', '登录与身份验证'],
  ['email_sms_bypass', '验证码校验'], ['business_logic', '业务规则'], ['replay_race', '重复提交'],
  ['file_upload', '文件上传'], ['file_download', '文件下载'], ['path_traversal', '文件访问范围'],
  ['xss', '页面脚本注入'], ['command_injection', '命令注入'], ['passcode_bypass', '支付密码'],
  ['state_machine_race', '业务操作顺序'],
];
const ACTIVE = new Set(['discovering', 'planning', 'running']);
function initialRun(): string {
  try { return new URLSearchParams(window.location.search).get('run') || localStorage.getItem('bstg_business_run') || ''; }
  catch { return ''; }
}
/** The default product screen deliberately has no orchestration/tool trace fallback. */
export function AIScans() {
  const [runs, setRuns] = useState<AssessmentRun[]>([]);
  const [selectedId, setSelectedId] = useState(initialRun);
  const [showSetup, setShowSetup] = useState(!selectedId);
  const [listError, setListError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [surface, setSurface] = useState<'web'|'android'>('web');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [goal, setGoal] = useState('检查登录、验证码、找回密码和账号权限等实际业务。');
  const [authorized, setAuthorized] = useState(false);
  const [checks, setChecks] = useState(CHECKS.map(([id])=>id));
  const [profiles, setProfiles] = useState<BusinessProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [app, setApp] = useState<BusinessApp|null>(null);
  const [scenarioIds, setScenarioIds] = useState<string[]>([]);
  const [profileRevision,setProfileRevision]=useState(0);
  const [profilesError, setProfilesError] = useState('');
  const [accountA, setAccountA] = useState({ username:'', password:'', user_id:'', object_id:'', authorization:'' });
  const [accountB, setAccountB] = useState({ username:'', password:'', user_id:'', object_id:'', authorization:'' });
  const [useAccounts, setUseAccounts] = useState(false);
  const [authenticationOrigins,setAuthenticationOrigins]=useState('');
  const uploadVersion = useRef(0);
  const mounted = useRef(true);
  const listRequest = useRef(0);
  const { state, connection, refresh } = useAssessmentFeed(selectedId);
  const profile = profiles.find(p=>p.id === profileId);
  const availableScenarios = (profile?.scenarios || []).filter(s=>s.app_package === app?.package_name);
  const currentRun = state?.run || runs.find(r=>r.id === selectedId);
  const running = Boolean(currentRun && ACTIVE.has(currentRun.status));

  const loadRuns = async () => {
    const seq = ++listRequest.current;
    try {
      const rows = await assessmentApi.list();
      if (!mounted.current || seq !== listRequest.current) return;
      setRuns(rows); setListError('');
      setSelectedId(id => rows.some(r=>r.id===id) ? id : rows.find(r=>ACTIVE.has(r.status))?.id || rows[0]?.id || '');
    } catch { if (mounted.current) setListError('测试记录暂时无法读取，请检查服务连接后重试。'); }
  };
  useEffect(()=> { mounted.current = true; void loadRuns(); return ()=>{ mounted.current=false; uploadVersion.current++; listRequest.current++; }; }, []);
  useEffect(()=> {
    try {
      if (selectedId) localStorage.setItem('bstg_business_run',selectedId);
      const url = new URL(window.location.href);
      if(selectedId) url.searchParams.set('run', selectedId); else url.searchParams.delete('run');
      window.history.replaceState({},'',url);
    } catch { /* Browser storage may be disabled. */ }
  }, [selectedId]);
  useEffect(()=> {
    const pop = () => setSelectedId(new URLSearchParams(window.location.search).get('run') || '');
    window.addEventListener('popstate',pop); return ()=>window.removeEventListener('popstate',pop);
  },[]);
  useEffect(()=> {
    if (surface !== 'android') return;
    let stopped = false;
    assessmentApi.profiles().then(rows=>{
      if(stopped) return;
      const usable=rows.filter(p=>p.enabled && !p.simulated);setProfiles(usable);setProfileId(id=>id||usable[0]?.id||'');setProfilesError('');
    }).catch(()=>{ if(!stopped) setProfilesError('无法读取测试设备，请检查服务连接。'); });
    return ()=>{stopped=true;};
  },[surface,profileRevision]);
  // Refresh the run selector from the same live state without restarting its subscription.
  useEffect(()=> {
    if (!state) return;
    setRuns(rows => [state.run, ...rows.filter(r=>r.id !== state.run.id)]);
  },[state?.run.id,state?.run.status]);

  const chooseProfile = (id:string) => {
    uploadVersion.current++; setProfileId(id); setApp(null); setScenarioIds([]); setUploading(false); setError('');
  };
  const upload = async (file?:File) => {
    if(!file || !profileId) return;
    const version = ++uploadVersion.current;
    setUploading(true); setApp(null); setScenarioIds([]); setError('');
    try {
      if(file.size>256*1024*1024)throw new Error('APK_TOO_LARGE');
      const value = await assessmentApi.uploadApp(profileId,file);
      if (!mounted.current || version !== uploadVersion.current) return;
      if(!value.ready) { setError('安装包未通过设备校验，请使用已授权、签名完整的测试安装包。'); return; }
      setApp(value);
      if(!target && value.endpoint_candidates?.length===1)setTarget(value.endpoint_candidates[0]);
    } catch (err) {
      if(mounted.current && version === uploadVersion.current) setError(err instanceof Error && err.message==='APK_TOO_LARGE'
        ? '安装包超过 256 MiB 上传上限。' : err instanceof Error ? err.message : '安装包导入失败。');
    } finally { if(mounted.current && version === uploadVersion.current) setUploading(false); }
  };
  const start = async () => {
    setError('');
    if(!authorized) {setError('请先确认你有权测试该目标及测试账号。');return;}
    try {
      const url = new URL(target);
      if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {setError('请填写有效的测试地址，不要在地址中包含密码。');return;}
    if(!checks.length) {setError('请至少选择一类安全检查。');return;}
    if(surface==='android' && (!profile || !app?.ready)) {setError('请选择设备并上传有效安装包。');return;}
    if(useAccounts && [accountA,accountB].some(a=>!a.username.trim() || !a.password)) {setError('请完整填写两个隔离的测试账号。');return;}
    setBusy(true);
    try {
      const created = await assessmentApi.create({
        name:name.trim() || (surface==='android' ? 'App 安全测试' : 'Web 安全测试'),
        base_url:target.trim(),user_prompt:goal,selected_vuln_types:checks,language:'zh',
        scan_config:{ surface, driving_mode:'autopilot', auto_start:true, selected_scope_strategy:'selected_vulnerability_types',
          max_parallel_agents:surface==='android'?1:3,
          account_mode:useAccounts?'manual':'auto_execute',
          authentication_origins:surface==='web'?authenticationOrigins.split(/[\s,，]+/).filter(Boolean):[],
          ...(useAccounts ? {accounts:{attacker:{...accountA},victim:{...accountB}}} : {}),
          authorization_acknowledged:true,
          ...(surface==='android'? {mobile:{lab_profile_id:profileId,app_asset_id:app!.id,scenario_ids:scenarioIds,authorization_acknowledged:true}} : {}),
        },
      });
      if(!mounted.current) return;
      listRequest.current++;
      setRuns(rows=>[created.run,...rows.filter(r=>r.id!==created.run.id)]);
      setSelectedId(created.run.id); setShowSetup(false);
      setAccountA({username:'',password:'',user_id:'',object_id:'',authorization:''}); setAccountB({username:'',password:'',user_id:'',object_id:'',authorization:''});
    } catch (error) {if(mounted.current) setError(error instanceof Error ? error.message : '无法创建测试。');}
    finally {if(mounted.current) setBusy(false);}
  };
  const resume = async () => {
    if(!selectedId) return;
    setBusy(true);setError('');
    try {
      if(currentRun?.status==='failed'){const retried=await assessmentApi.retry(selectedId);setSelectedId(retried.run.id);setRuns(rows=>[retried.run,...rows]);return;}
      if(currentRun?.status==='awaiting_selection') await assessmentApi.select(selectedId,checks);
      await assessmentApi.run(selectedId); refresh();
    } catch {setError('无法继续测试，请检查服务和目标连接后重试。');}
    finally {if(mounted.current) setBusy(false);}
  };
  const canResume = currentRun && ['created','awaiting_selection','failed'].includes(currentRun.status);

  return <div className="mx-auto max-w-[1680px] space-y-5 p-4 md:p-6" data-testid="assessment-page">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">业务安全测试</h1><p className="mt-1 text-sm text-slate-500">选择业务、查看实际操作、核对发现的问题。</p></div>
      <div className="flex flex-wrap gap-2">
        <select aria-label="选择测试记录" value={selectedId} onChange={e=>{setSelectedId(e.target.value);setShowSetup(false);setError('');}} className="min-w-0 max-w-full rounded-lg border bg-white p-2 text-sm sm:max-w-[320px]"><option value="">选择测试记录</option>{runs.map(r=><option key={r.id} value={r.id}>{r.name} · {r.status_label}</option>)}</select>
        <button type="button" onClick={()=>{void loadRuns();refresh();}} aria-label="刷新测试记录" className="rounded-lg border bg-white p-2"><RefreshCw size={18}/></button>
        <button type="button" onClick={()=>setShowSetup(!showSetup)} aria-expanded={showSetup} className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white"><Plus size={17}/>{showSetup?'收起新建':'新建测试'}</button>
      </div>
    </div>
    {(error || listError) && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error || listError}</div>}
    {(showSetup || (!selectedId && !runs.length)) && <section className="rounded-xl border bg-white p-5" aria-label="新建业务测试">
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="flex gap-2">{(['web','android'] as const).map(s=><button key={s} type="button" disabled={busy} aria-pressed={surface===s} onClick={()=>{setSurface(s);setError('');}} className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm ${surface===s?'border-blue-400 bg-blue-50 text-blue-800':''}`}>{s==='web'?<Monitor size={17}/>:<Smartphone size={17}/>} {s==='web'?'Web 网站':'Android App'}</button>)}</div>
          <label className="block text-sm font-medium">测试名称<input disabled={busy} value={name} onChange={e=>setName(e.target.value)} placeholder="例如：账号中心安全测试" className="mt-1 block w-full rounded-lg border p-2.5"/></label>
          <label className="block text-sm font-medium">{surface==='web'?'网站地址':'App 业务服务地址'}<input disabled={busy} value={target} onChange={e=>setTarget(e.target.value)} placeholder="https://test.example.com" type="url" className="mt-1 block w-full rounded-lg border p-2.5"/></label>
          <label className="block text-sm font-medium">测试目标<textarea disabled={busy} value={goal} onChange={e=>setGoal(e.target.value)} rows={3} className="mt-1 block w-full rounded-lg border p-2.5"/></label>
          <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">提供隔离测试账号（越权验证需要不同身份）</summary>
            <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={useAccounts} disabled={busy} onChange={e=>setUseAccounts(e.target.checked)}/>使用已授权的两个测试账号</label>
            {surface==='web'&&<label className="mt-3 block text-sm">统一登录地址（可选）<input disabled={busy} value={authenticationOrigins} onChange={e=>setAuthenticationOrigins(e.target.value)} placeholder="https://login.example.com" className="mt-1 block w-full rounded border p-2 text-sm"/><span className="mt-1 block text-xs text-slate-500">用于目标跳转后的账号登录，多个地址用空格分隔；安全检查仍限于网站地址。</span></label>}
            {useAccounts && <div className="mt-3 grid gap-3 sm:grid-cols-2">{[{label:'账号 A',value:accountA,set:setAccountA},{label:'账号 B',value:accountB,set:setAccountB}].map(a=><fieldset key={a.label} className="space-y-2"><legend className="text-sm">{a.label}</legend><input aria-label={`${a.label}用户名`} value={a.value.username} disabled={busy} onChange={e=>a.set({...a.value,username:e.target.value})} placeholder="用户名" autoComplete="off" className="w-full rounded border p-2 text-sm"/><input aria-label={`${a.label}密码`} value={a.value.password} disabled={busy} onChange={e=>a.set({...a.value,password:e.target.value})} type="password" autoComplete="new-password" placeholder="密码" className="w-full rounded border p-2 text-sm"/><details className="text-xs text-slate-600"><summary>越权测试材料（可选）</summary><p className="my-2">填写真实用户标识、该用户拥有的对象标识和已登录会话，可用于核对跨账号访问。未知时留空。</p>{(['user_id','object_id','authorization'] as const).map(key=><input key={key} aria-label={`${a.label} ${key}`} value={a.value[key]} disabled={busy} onChange={e=>a.set({...a.value,[key]:e.target.value})} type={key==='authorization'?'password':'text'} placeholder={key==='user_id'?'用户标识':key==='object_id'?'该用户拥有的对象标识':'Authorization 会话值'} autoComplete="off" className="mb-2 w-full rounded border p-2 text-sm"/>)}</details></fieldset>)}</div>}
            <p className="mt-2 text-xs leading-5 text-slate-500">仅使用测试账号和可重复数据。缺少有效身份时，相应检查可能受阻，不会自动判定通过。</p>
          </details>
        </div>
        <div className="space-y-4">
          <fieldset><legend className="mb-2 text-sm font-medium">安全检查范围</legend><div className="grid grid-cols-2 gap-2">{CHECKS.map(([id,label])=><label key={id} className="flex gap-2 text-sm text-slate-700"><input type="checkbox" disabled={busy} checked={checks.includes(id)} onChange={e=>setChecks(xs=>e.target.checked?[...xs,id]:xs.filter(x=>x!==id))}/>{label}</label>)}</div></fieldset>
          {surface==='android' && <div className="space-y-3 rounded-lg border p-3">
            <MobileSetup onSaved={()=>{setProfileRevision(v=>v+1);setProfileId('android-burp-ready-default');}}/>
            <label className="block text-sm font-medium">测试设备<select aria-label="测试设备" disabled={busy} value={profileId} onChange={e=>chooseProfile(e.target.value)} className="mt-1 w-full rounded border p-2"><option value="">选择已准备的设备</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {p.device_label}</option>)}</select></label>
            {profilesError && <p role="alert" className="text-sm text-amber-700">{profilesError}</p>}
            {!profiles.length && !profilesError && <p className="text-xs text-slate-500">尚无可用的真实测试设备。请由环境管理员完成设备准备。</p>}
            <label className="block text-sm font-medium">授权测试安装包<input key={profileId} type="file" accept=".apk" disabled={!profileId || busy || uploading} onChange={e=>void upload(e.target.files?.[0])} className="mt-2 w-full text-sm"/></label>
            {uploading && <p className="text-sm text-blue-700">正在校验安装包签名与启动信息…</p>}
            {app && <p className="text-xs text-slate-600">已准备：{app.name}</p>}
            {app?.endpoint_candidates?.length ? <label className="block text-sm">从安装包发现的服务地址<select aria-label="选择 App 业务服务" value={target} onChange={e=>setTarget(e.target.value)} className="mt-1 w-full rounded border p-2"><option value="">选择已授权的业务服务</option>{app.endpoint_candidates.map(url=><option key={url} value={url}>{url}</option>)}</select><span className="mt-1 block text-xs text-slate-500">安装包可能包含第三方服务；请核对本轮测试地址，也可在左侧填写。</span></label> : app && <p className="text-xs text-amber-700">安装包未暴露服务地址，请填写实际业务服务地址。</p>}
            {app?.warnings?.map(w=><p key={w} className="text-xs text-amber-700">{w}</p>)}
            <fieldset><legend className="text-sm font-medium">业务回归场景（可选）</legend>
              {availableScenarios.map(s=><label key={s.id} className="mt-2 flex items-start gap-2 rounded border p-2 text-sm"><input disabled={busy} type="checkbox" checked={scenarioIds.includes(s.id)} onChange={e=>setScenarioIds(xs=>e.target.checked?[...xs,s.id]:xs.filter(x=>x!==s.id))}/><span>{s.business_name} · {s.test_name}{s.description && <span className="mt-1 block text-xs text-slate-500">{s.description}</span>}</span></label>)}
              {!availableScenarios.length && <p className="mt-2 text-xs leading-5 text-slate-500">{app?'将自动探索实际界面、采集业务请求并执行所选安全检查。登录、验证码及未触达页面会明确列为覆盖缺口。':'上传后可直接自动探索；已配置的业务场景可选，用于精确回归。'}</p>}
            </fieldset>
          </div>}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t pt-4"><label className="flex max-w-3xl items-start gap-2 text-sm text-slate-600"><input type="checkbox" disabled={busy} checked={authorized} onChange={e=>setAuthorized(e.target.checked)} className="mt-1"/><span>我已获得目标、安装包与账号的测试授权，并使用隔离环境及可重复数据。测试可能发送请求和改变业务状态。</span></label><button type="button" disabled={busy || uploading || !authorized} onClick={()=>void start()} className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40">{busy?<Loader2 size={17} className="animate-spin"/>:<Play size={17}/>}开始测试</button></div>
    </section>}
    {canResume && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-white p-4"><p className="text-sm text-slate-600">{currentRun.status==='awaiting_selection'?'已识别业务，请确认检查范围后继续。':'本轮尚未完成。失败后重新测试会建立独立记录，并重新执行业务操作。'}</p><button disabled={busy || !checks.length} type="button" onClick={()=>void resume()} className="rounded-lg bg-blue-700 px-4 py-2 text-sm text-white disabled:opacity-40">{currentRun.status==='failed'?'重新测试':'继续测试'}</button></div>}
    {state ? <AssessmentWorkspace state={state} connection={connection} onRefresh={refresh}/> : selectedId ? <div className="rounded-xl border bg-white p-10 text-center"><Loader2 size={24} className="mx-auto mb-3 animate-spin text-blue-600"/><p className="text-sm text-slate-500">{connection==='offline'?'暂时无法连接测试记录，正在等待连接恢复。':'正在读取本轮测试状态…'}</p></div> : <div className="rounded-xl border border-dashed p-10 text-center text-slate-500"><ShieldCheck size={30} className="mx-auto mb-3"/><p>创建测试后，这里显示实际业务清单和测试画面。</p><p className="mt-2 text-xs">不会预先显示未执行的结果或模拟画面。</p></div>}
    {running && <p className="text-xs text-slate-500">切换页面或刷新后会重新连接本轮状态。关闭页面不会自动停止已经提交的测试。</p>}
  </div>;
}
