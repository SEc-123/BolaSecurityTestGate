import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Circle, Loader2, Monitor, Smartphone, RefreshCw, Search, XCircle } from 'lucide-react';
import type { AssessmentFrame, BusinessTest, ProductAssessmentState } from '../../types/assessment';
import type { ConnectionState } from '../../lib/assessment-feed';
import { LiveBrowserView } from './LiveBrowserView';
import { assessmentApi } from '../../lib/assessment-api';
const ISSUE_LEVEL: Record<string,string> = {critical:"严重",high:"高危",medium:"中危",low:"低危",info:"提示"};

function TestMark({test}: {test: BusinessTest}) {
  if (test.checked) return <Check size={17} className={test.issue_ids.length ? 'text-red-600' : 'text-emerald-600'} />;
  if (test.status === 'running') return <Loader2 size={17} className="animate-spin text-blue-600" />;
  if (test.status === 'failed') return <XCircle size={17} className="text-red-600" />;
  if (test.status === 'blocked' || test.status === 'review') return <AlertTriangle size={17} className="text-amber-600" />;
  return <Circle size={17} className="text-slate-400" />;
}
const CONNECTION: Record<ConnectionState,string> = {connecting:'正在连接',live:'已连接',polling:'定时更新',reconnecting:'连接中断，正在重连',offline:'暂时离线，显示最后记录'};

export function FrameView({frame, connection, now}: {frame: AssessmentFrame | null; connection: ConnectionState; now: number}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [frame?.image_url]);
  const age = frame ? Math.max(0, Math.floor((now - Date.parse(frame.captured_at)) / 1000)) : 0;
  const live = frame?.state === 'live' && age < 10 && connection === 'live' && frame.source !== 'simulated';
  const label = !frame ? '等待真实画面' : frame.source === 'simulated' ? '模拟画面 · 非真实设备' : live ? '画面更新中 · 逐帧观察' : frame.state === 'recorded' ? '已结束测试的记录画面' : age >= 10 ? '画面已停止更新' : '最近一次页面观察';
  return <div data-testid="live-surface" className="overflow-hidden rounded-lg border border-slate-200 bg-slate-950">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3 text-xs text-slate-200">
      <span className="inline-flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${live ? 'bg-emerald-400' : 'bg-slate-400'}`} />{label}</span>
      {frame && <span data-testid="frame-age">{age < 1 ? '刚刚' : `${age} 秒前`} · {frame.surface === 'android' ? 'App' : 'Web'}</span>}
    </div>
    <div className={`flex min-h-[360px] items-center justify-center p-3 ${frame?.surface === 'android' ? 'h-[560px]' : 'h-[440px]'}`}>
      {frame && !failed ? <img src={assessmentApi.image(frame.image_url)} alt={`${frame.test_name}的实际测试画面`} onError={() => setFailed(true)} className="max-h-full max-w-full rounded object-contain" data-testid="assessment-frame" />
        : <div className="max-w-sm px-6 text-center text-sm leading-7 text-slate-300">
          <Monitor className="mx-auto mb-4 text-slate-500" size={34} />
          {failed ? '当前画面暂时无法读取，测试状态仍会独立更新。' : '此项尚无页面画面。接口检查不一定触发界面操作；不会用其他测试的截图代替。'}
        </div>}
    </div>
    {frame && <div className="border-t border-white/10 px-4 py-2 text-xs text-slate-300">{frame.test_name}</div>}
  </div>;
}
export function AssessmentWorkspace({state, connection, onRefresh}: {state: ProductAssessmentState; connection: ConnectionState; onRefresh: () => void}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [now, setNow] = useState(Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const [showReview, setShowReview] = useState(false);
  const [showBrowserEvidence, setShowBrowserEvidence] = useState(false);
  useEffect(()=>setShowBrowserEvidence(false),[state.run.id,selected]);
  useEffect(() => { setSelected(new URLSearchParams(window.location.search).get('test')); setFilter('all'); setQuery(''); }, [state.run.id]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (selected || !state.current_work[0]) return;
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-test-id="${CSS.escape(state.current_work[0].id)}"]`);
    if (list && item) {
      const offset = item.getBoundingClientRect().top - list.getBoundingClientRect().top;
      if (offset < 0 || offset + item.offsetHeight > list.clientHeight) list.scrollTop += offset;
    }
  }, [state.current_work[0]?.id, selected]);
  const tests = state.business_functions.flatMap(f => f.tests);
  const current = tests.find(t => t.id === (selected || state.current_work[0]?.id));
  const currentFeature = current && state.business_functions.find(f=>f.tests.some(t=>t.id===current.id));
  const frame = selected ? state.frames.find(f => f.test_id === selected) || null : state.live_surface;
  const visibleFunctions = useMemo(() => state.business_functions.map(feature => ({...feature, tests:feature.tests.filter(test =>
    (!query || `${feature.name} ${test.name}`.toLowerCase().includes(query.toLowerCase())) &&
    (filter === 'all' || filter === 'issues' && test.issue_ids.length > 0 || filter === 'unfinished' && !test.checked || filter === 'completed' && test.checked))
  })).filter(f => f.tests.length > 0 || filter === 'all' && !query && state.business_functions.find(original => original.id === f.id)?.tests.length === 0), [state.business_functions, filter, query]);
  const shown = visibleFunctions.reduce((sum,f) => sum + f.tests.length,0);
  return <section className="space-y-4" data-testid="business-assessment-workspace">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4">
      <div><h2 className="text-lg font-semibold text-slate-950">{state.phase_label}</h2><p className="mt-1 text-sm text-slate-500">已完成 {state.totals.completed} / {state.totals.tests} 项 · 已确认 {state.totals.confirmed_risks} 个问题</p></div>
      <div className="flex items-center gap-3"><span data-testid="assessment-connection" role="status" className={`text-xs ${connection === 'live' ? 'text-emerald-700' : 'text-amber-700'}`}>{CONNECTION[connection]}</span><button type="button" onClick={onRefresh} className="rounded border px-3 py-2 text-sm" aria-label="刷新测试状态"><RefreshCw size={16} /></button></div>
      <div className="h-1.5 w-full rounded bg-slate-100" role="progressbar" aria-label="已完成的业务测试" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.totals.progress}><div className="h-full rounded bg-blue-600 transition-[width]" style={{width:`${state.totals.progress}%`}} /></div>
      {state.notice && <p className="w-full text-sm text-amber-700" role="status">{state.notice}</p>}
    </div>
    {!!state.diagnostics?.length && <details open className="rounded-lg border border-amber-200 bg-amber-50 p-4"><summary className="cursor-pointer text-sm font-medium text-amber-900">执行诊断与修复提示</summary>{state.diagnostics.map((item,index)=><p key={item.task_id||index} className="mt-2 break-words text-sm text-amber-900">{item.message}</p>)}</details>}
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.4fr)]">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white" aria-label="业务测试清单">
        <div className="border-b border-slate-200 p-4"><h3 className="font-semibold">业务测试清单</h3><p className="mt-1 text-xs leading-5 text-slate-500">完成后自动划线；确认的问题不会随清单完成而消失。</p>
          <label className="mt-3 flex items-center gap-2 rounded border px-2"><Search size={15} className="text-slate-400" /><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索业务或测试项" aria-label="搜索业务或测试项" className="min-w-0 flex-1 py-2 text-sm outline-none" /></label>
          <select value={filter} onChange={e=>setFilter(e.target.value)} aria-label="筛选测试项" className="mt-2 w-full rounded border p-2 text-sm"><option value="all">全部测试</option><option value="unfinished">未完成</option><option value="issues">已确认问题</option><option value="completed">已完成</option></select>
          <p className="mt-2 text-xs text-slate-500">显示 {shown} / {state.totals.tests} 项</p>
        </div>
        <div ref={listRef} className="max-h-[720px] overflow-y-auto" data-testid="business-test-list">
          {visibleFunctions.map(feature => <section key={feature.id} className="border-b border-slate-100 last:border-0" data-testid="business-function">
            <div className="flex items-center justify-between gap-2 bg-slate-50 px-4 py-3"><h4 className={`text-sm font-semibold ${feature.checked ? 'text-slate-600 line-through' : 'text-slate-900'}`}>{feature.name}</h4><span className="text-xs text-slate-500">{feature.tests.filter(t=>t.checked).length}/{feature.tests.length}</span></div>
            {feature.tests.length ? feature.tests.map(test => <button type="button" key={test.id} onClick={()=>setSelected(test.id)} aria-pressed={selected === test.id} data-testid="business-test" data-test-id={test.id} data-status={test.status} data-checked={String(test.checked)} className={`flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-0 ${selected === test.id ? 'bg-blue-50 ring-1 ring-inset ring-blue-200' : 'hover:bg-slate-50'}`}>
              <span className="mt-0.5 shrink-0"><TestMark test={test}/></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center justify-between gap-2"><span className={`break-words text-sm font-medium ${test.checked ? 'line-through text-slate-500' : 'text-slate-900'}`}>{test.name}</span><span className="text-xs text-slate-500">{test.status_label}</span></span>
              {test.issue_ids.length > 0 && <span className="mt-1 inline-flex rounded bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">发现 {test.issue_ids.length} 个已确认问题</span>}
              {['failed','blocked','review','not_run','skipped'].includes(test.status) && <span className="mt-1 block text-xs leading-5 text-amber-700">{test.summary}</span>}
              </span></button>) : <p className="px-4 py-3 text-xs text-slate-500">已识别此功能，尚未生成可执行的测试项。</p>}
          </section>)}
          {!visibleFunctions.length && <p className="px-4 py-8 text-sm text-slate-500">{tests.length ? '没有匹配的测试项。' : '识别到可执行的业务后，测试清单会出现在这里。'}</p>}
        </div>
      </section>
      <div className="min-w-0 space-y-4 lg:sticky lg:top-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="inline-flex items-center gap-2 font-semibold">{state.active_surface === 'android' ? <Smartphone size={18}/> : <Monitor size={18}/>}实际测试过程</h3><button type="button" onClick={()=>setSelected(null)} aria-pressed={!selected} className={`rounded border px-3 py-1.5 text-xs ${!selected ? 'border-blue-300 bg-blue-50 text-blue-700' : 'bg-white'}`}>跟随当前测试</button></div>
        {current && <div className="rounded-lg border bg-white px-4 py-3 text-sm"><strong>{currentFeature?.name} · {current.name} · {current.status_label}</strong><p className="mt-1 text-xs leading-5 text-slate-600">{current.summary}</p></div>}
        {state.active_surface === 'web' && state.browser_transport === 'novnc' ? <>
          <LiveBrowserView runId={state.run.id} taskIds={current || selected ? (current?.task_ids?.length ? current.task_ids : ['__no_matching_browser__']) : null} ended={['completed','failed'].includes(state.run.status)}/>
          {frame && <details open={showBrowserEvidence} onToggle={e=>setShowBrowserEvidence(e.currentTarget.open)} className="rounded-lg border bg-white p-3"><summary className="cursor-pointer text-sm text-slate-600">查看该项截图证据（静态记录，不是直播）</summary><div className="mt-3">{showBrowserEvidence && <FrameView frame={{...frame,state:'recorded'}} connection="offline" now={now}/>}</div></details>}
        </> : <FrameView frame={frame} connection={connection} now={now}/>}
        <section className="rounded-xl border border-slate-200 bg-white p-4" aria-label="已确认的问题">
          <h3 className="flex items-center gap-2 font-semibold"><AlertTriangle size={17} className="text-red-600"/>已确认的问题 <span className="text-sm text-red-700">{state.risk_evidence.length}</span></h3>
          <div aria-live="polite" aria-atomic="false" data-testid="confirmed-issues">
            {state.risk_evidence.map(issue => <article key={issue.id} className={`mt-3 rounded-lg border p-3 ${issue.test_id === selected ? 'border-red-300 bg-red-50' : 'border-red-100'}`}><button type="button" className="text-left text-sm font-semibold text-red-800" onClick={()=>setSelected(issue.test_id)}>{issue.title}</button><p className="mt-1 text-xs text-slate-500">{issue.feature_name} · {issue.test_name} · {ISSUE_LEVEL[issue.severity]} · {issue.evidence_count} 条验证证据</p><p className="mt-2 text-sm leading-6 text-slate-700">{issue.summary}</p></article>)}
            {!state.risk_evidence.length && <p className="mt-3 text-sm text-slate-500">暂未发现已确认的问题。执行异常与待复核信号不会被算作漏洞。</p>}
          </div>
          {state.review_evidence.length > 0 && <div className="mt-4 border-t pt-3"><button type="button" onClick={()=>setShowReview(!showReview)} aria-expanded={showReview} className="text-sm text-amber-700">待复核信号 {state.review_evidence.length} 个 · {showReview ? '收起' : '查看'}</button>{showReview && state.review_evidence.map(issue=><p key={issue.id} className="mt-2 text-xs leading-5 text-slate-600">{issue.feature_name} · {issue.test_name}：{issue.summary}</p>)}</div>}
        </section>
      </div>
    </div>
  </section>;
}
