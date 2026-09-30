import type { ProductAssessmentState } from '../types/assessment';
const escape = (text: string) => text.replace(/[\\`*_{}[\]<>#|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
export function businessReport(state: ProductAssessmentState): string {
  return ['# 业务安全测试报告', '', `测试：${escape(state.run.name)}`, `记录编号：${state.run.id}`, `目标：${escape(state.run.target)}`,
    `当前状态：${escape(state.run.status_label)}`, `导出时间：${new Date().toISOString()}`, '',
    '## 执行覆盖', '', `已完成 ${state.totals.completed} / ${state.totals.tests} 项，已确认 ${state.totals.confirmed_risks} 个问题。`,
    '完成表示已执行并核对声明的检查，不表示不存在其他风险。跳过、未执行、失败和待复核项不计入完成。', '',
    ...(state.totals.normal_flows ? [`正常流程已验证 ${state.totals.verified_flows || 0} / ${state.totals.normal_flows} 项；模型实验 ${state.totals.experiments || 0} 项。`, '正常流程完成不等于安全测试通过，实验执行不等于确认漏洞。', ''] : []),
    ...state.business_functions.flatMap(f=>[`### ${escape(f.name)}`,
      ...(f.normal_flows?.length ? ['正常流程：', ...f.normal_flows.flatMap(flow=>[
        `- [${flow.status==='verified'?'x':' '}] ${escape(flow.name)} — ${escape(flow.status_label)}；${escape(flow.goal)}`,
        ...flow.blockers.map(blocker=>`  - 条件与证据缺口：${escape(blocker)}`),
        ...flow.references.map(reference=>`  - ${escape(reference.title)}：${escape(reference.id)}`),
      ])] : []),
      ...(f.experiments?.length ? ['模型实验：', ...f.experiments.flatMap(experiment=>[
        `- ${escape(experiment.name)} — ${escape(experiment.status_label)}；假设：${escape(experiment.hypothesis)}`,
        ...experiment.blockers.map(blocker=>`  - 条件与证据缺口：${escape(blocker)}`),
        ...experiment.references.map(reference=>`  - ${escape(reference.title)}：${escape(reference.id)}`),
      ])] : []),
      ...f.tests.map(t=>`- [${t.checked?'x':' '}] ${escape(t.name)} — ${escape(t.status_label)}${t.issue_ids.length?`；确认 ${t.issue_ids.length} 个问题`:''}`), '']),
    '## 已确认的问题', '', ...(state.risk_evidence.length ? state.risk_evidence.flatMap(i=>[`### ${escape(i.title)}`, `${escape(i.feature_name)} · ${escape(i.test_name)}`, escape(i.summary), `验证证据：${i.evidence_count} 条；问题引用：${i.id}；测试引用：${i.test_id}`, '']) : ['本轮尚无已确认的问题。', '']),
    '## 未完成与待复核', '', ...state.business_functions.flatMap(f=>f.tests.filter(t=>!t.checked).map(t=>`- ${escape(f.name)} / ${escape(t.name)}：${escape(t.summary)}`)),
    ...state.review_evidence.map(i=>`- ${escape(i.feature_name)} / ${escape(i.test_name)}：${escape(i.summary)}`),
    '', '## 应用操作记录', '', ...(state.operations||[]).map(o=>`- ${escape(o.title)}：${escape(o.status_label)}；${escape(o.summary)}`),
    '', '## 执行诊断', '', ...(state.diagnostics||[]).map(d=>`- ${escape(d.message)}`),
    '', state.notice, '', '本报告对应所选单次测试，不混入其他测试记录。',
  ].join('\n');
}
