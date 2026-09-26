import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { AssessmentRun } from '../../types/assessment';
import { assessmentApi } from '../../lib/assessment-api';
import { useAssessmentFeed } from '../../hooks/useAssessmentFeed';
import { businessReport } from '../../lib/business-report';
const ISSUE_LEVEL: Record<string,string> = {critical:"严重",high:"高危",medium:"中危",low:"低危",info:"提示"};

/** Findings and reports share exactly the same verified, per-run product projection. */
export function AssessmentResults({mode}: {mode:'issues'|'report'}) {
  const [runs,setRuns] = useState<AssessmentRun[]>([]);
  const [runId,setRunId] = useState(()=>{try{return localStorage.getItem('bstg_business_run')||'';}catch{return '';}});
  const [error,setError] = useState('');
  const {state,connection,refresh} = useAssessmentFeed(runId);
  useEffect(()=>{let closed=false;assessmentApi.list().then(rows=>{
    if(closed) return; setRuns(rows);setRunId(id=>rows.some(r=>r.id===id)?id:rows[0]?.id||'');
  }).catch(()=>{if(!closed)setError('暂时无法读取测试记录。');});return()=>{closed=true;};},[]);
  const download = () => {
    if(!state) return;
    const url = URL.createObjectURL(new Blob([businessReport(state)],{type:'text/markdown;charset=utf-8'}));
    const a = document.createElement('a');a.href=url;a.download=`business-test-${state.run.id}.md`;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <div className="mx-auto max-w-6xl space-y-5 p-5 md:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">{mode==='issues'?'测试发现的问题':'业务测试报告'}</h1><p className="mt-2 text-sm text-slate-500">仅呈现所选测试的业务覆盖、实际结论与待处理事项。</p></div><div className="flex w-full flex-wrap gap-2 md:w-auto"><select aria-label="选择报告的测试记录" value={runId} onChange={e=>setRunId(e.target.value)} className="min-w-0 max-w-full rounded border bg-white p-2 text-sm sm:max-w-[320px]"><option value="">选择测试记录</option>{runs.map(r=><option value={r.id} key={r.id}>{r.name}</option>)}</select><button type="button" onClick={refresh} aria-label="刷新结果" className="rounded border bg-white p-2"><RefreshCw size={17}/></button>{mode==='report'&&<button type="button" onClick={download} disabled={!state} className="inline-flex items-center gap-2 rounded bg-blue-700 px-3 py-2 text-sm text-white disabled:opacity-40"><Download size={17}/>导出报告</button>}{state&&<a href={assessmentApi.evidence(runId)} className="inline-flex items-center gap-2 rounded border bg-white px-3 py-2 text-sm"><Download size={17}/>导出证据</a>}</div></div>
    {error && <p role="alert" className="text-sm text-amber-700">{error}</p>}
    {!state ? <p className="rounded-lg border bg-white p-8 text-sm text-slate-500">{runId?(connection==='offline'?'连接暂时不可用，请重试。':'正在读取本轮测试结果…'):'尚无测试结果。'}</p> : <>
      <div className="rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">{state.run.name}</h2><p className="mt-2 text-sm text-slate-600">{state.run.status_label} · 已完成 {state.totals.completed}/{state.totals.tests} 项 · 已确认 {state.totals.confirmed_risks} 个问题</p><p className="mt-1 break-all text-xs text-slate-500">{state.run.target}</p>{state.notice&&<p className="mt-3 text-sm text-amber-700">{state.notice}</p>}</div>
      {!!state.diagnostics?.length&&<section className="rounded-xl border border-amber-200 bg-white p-5"><h2 className="font-semibold">执行诊断与覆盖缺口</h2>{state.diagnostics.map((d,i)=><p key={i} className="mt-2 break-words text-sm text-amber-800">{d.message}</p>)}</section>}
      {mode==='report'&&<section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">业务覆盖</h2>{state.business_functions.map(f=><div key={f.id} className="mt-4"><h3 className="text-sm font-semibold">{f.name}</h3>{f.tests.map(t=><div key={t.id} className="mt-2 flex flex-wrap justify-between gap-2 text-sm"><span className={t.checked?'line-through text-slate-500':''}>{t.name}</span><span>{t.status_label}{t.issue_ids.length?` · ${t.issue_ids.length} 个问题`:''}</span></div>)}</div>)}</section>}
      <section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">已确认的问题</h2>{state.risk_evidence.map(i=><article key={i.id} className="mt-4 rounded border border-red-100 p-4"><h3 className="text-sm font-semibold text-red-800">{i.title}</h3><p className="mt-1 text-xs text-slate-500">{i.feature_name} · {i.test_name} · {ISSUE_LEVEL[i.severity]} · {i.evidence_count} 条验证证据</p><p className="mt-2 text-sm leading-6">{i.summary}</p><a href={`/?run=${encodeURIComponent(runId)}&test=${encodeURIComponent(i.test_id)}`} className="mt-3 inline-block text-sm text-blue-700 underline">查看对应测试与实际画面</a></article>)}{!state.risk_evidence.length&&<p className="mt-3 text-sm text-slate-500">尚未发现已确认的问题。未确认的信号不计入漏洞数量。</p>}</section>
      {state.review_evidence.length>0&&<section className="rounded-xl border border-amber-200 bg-white p-5"><h2 className="font-semibold text-amber-800">待复核信号</h2>{state.review_evidence.map(i=><article key={i.id} className="mt-3 text-sm leading-6 text-slate-600"><p>{i.feature_name} · {i.test_name}：{i.summary}</p><a href={`/?run=${encodeURIComponent(runId)}&test=${encodeURIComponent(i.test_id)}`} className="mt-2 inline-block text-blue-700 underline">核对本项测试证据</a></article>)}</section>}
      <p className="text-xs leading-5 text-slate-500">完成不等于无漏洞；没有发现已确认问题也不等于应用安全。测试范围、未执行项和待复核项应一起审阅。</p>
    </>}
  </div>;
}
