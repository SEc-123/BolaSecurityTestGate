import {useEffect,useState} from 'react';
import {assessmentApi} from '../../lib/assessment-api';
import type {AssessmentEvidence} from '../../types/assessment';
export function EvidenceReview({runId,testId,refreshKey}:{runId:string;testId:string;refreshKey?:string}){
  const [data,setData]=useState<AssessmentEvidence|null>(null),[error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  useEffect(()=>{const abort=new AbortController();setData(null);setError('');
    assessmentApi.testEvidence(runId,testId,abort.signal).then(value=>{if(!abort.signal.aborted)setData(value);}).catch(()=>{if(!abort.signal.aborted)setError('证据暂时无法读取，请重试。');});
    return()=>abort.abort();
  },[runId,testId,revision,refreshKey]);
  return <section aria-label="测试证据核对" className="rounded-xl border bg-white p-4" data-testid="evidence-review">
    <div className="flex items-center justify-between"><h3 className="font-semibold">测试证据核对</h3><button type="button" onClick={()=>setRevision(v=>v+1)} className="text-sm text-blue-700">刷新证据</button></div>
    {error?<p role="alert" className="mt-3 text-sm text-amber-700">{error}</p>:!data?<p className="mt-3 text-sm text-slate-500">正在读取本项验证记录…</p>:<>
      <p className="mt-2 text-sm">{data.test.name} · {data.test.status_label}</p><p className="mt-2 text-sm">{data.test.summary}</p><p className="mt-2 text-xs leading-5 text-slate-500">{data.notice}</p>
      {data.decisions.map(d=><p key={d.id} className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{d.reason}</p>)}
      {!data.items.length&&!data.steps?.length&&<p className="mt-3 text-sm text-amber-700">尚无可展示的请求对照记录。请结合当前状态与执行诊断核对，不能据此判断通过。</p>}
      {data.steps?.map(step=><article key={step.id} data-testid="mobile-step-evidence" className="mt-4 rounded-lg border p-3">
        <h4 className="text-sm font-semibold">{step.title}</h4>
        <p className="mt-2 text-sm">证据完整性：{step.integrity_verified?'已核对':'未通过'} · 页面断言：{step.ui_verified?'已核对':'未通过'} · HTTPS 断言：{step.network_verified?'已核对':'未验证'}</p>
        <p className="mt-1 text-xs text-slate-500">{step.started_at} — {step.completed_at}</p>
        {step.checks.map((check,i)=><p key={i} className="mt-2 text-sm">{check.name}：{check.passed?'已满足':'未满足'}</p>)}
        {step.notes.map((note,i)=><p key={i} className="mt-2 text-sm text-amber-800">{note}</p>)}
        <details className="mt-2 text-xs"><summary>核对步骤证据摘要</summary>{step.hashes.map(file=><p key={file.name} className="mt-1 break-all">{file.name}：{file.sha256}</p>)}</details>
      </article>)}
      {data.items.map(item=><article key={item.id} className="mt-4 rounded-lg border p-3">
        <h4 className="text-sm font-semibold">{item.title}</h4><p className="mt-1 break-all text-xs text-slate-500">{item.method} {item.url}</p>
        <div className="mt-2 flex flex-wrap gap-4 text-sm">{item.baseline&&<span>对照响应：{item.baseline.status??'未取得'}</span>}<span>测试响应：{item.result.status??'未取得'}</span>{item.followup&&<span>回访响应：{item.followup.status??'未取得'}</span>}</div>
        {item.proof.map((p,i)=><p key={i} className="mt-2 text-sm text-emerald-800">{p}</p>)}
        {item.notes.map((p,i)=><p key={i} className="mt-2 break-words text-xs text-amber-800">{p}</p>)}
        <details className="mt-3 text-xs"><summary className="cursor-pointer text-slate-600">核对响应内容与证据编号</summary>
          <p className="mt-2 break-all text-slate-500">记录：{item.id}</p>
          {[{label:'对照响应',value:item.baseline},{label:'测试响应',value:item.result},{label:'文件回访',value:item.followup}].filter(part=>part.value).map(part=><div key={part.label} className="mt-2"><p>{part.label}</p><pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2">{part.value?.body||'无响应正文'}</pre><p className="mt-1 break-all text-slate-500">摘要：{part.value?.hash||'未取得'}</p></div>)}
        </details>
      </article>)}
    </>}
  </section>;
}
