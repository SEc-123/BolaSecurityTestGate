#!/usr/bin/env node
import assert from 'node:assert/strict';

const baseUrl = String(process.env.BSTG_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${options.method || 'GET'} ${path} returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (!response.ok || json.error) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${response.status} ${json.error || text}`);
  }
  return json.data;
}

function byTitle(issues, title) {
  const issue = issues.find(item => item.title === title);
  assert.ok(issue, `Missing issue group: ${title}`);
  return issue;
}

async function main() {
  const issues = await api('/api/findings/issues');
  assert.equal(issues.length, 9, 'DeepSeek 25 raw findings should collapse to 9 unique issue groups');

  const pathTraversal = byTitle(issues, '任意文件读取 / Path Traversal');
  assert.equal(pathTraversal.raw_count, 2, 'Path Traversal duplicate findings should merge');
  assert.equal(pathTraversal.affected_endpoint_count, 1, 'Path Traversal should point to one endpoint');

  const uploadXss = byTitle(issues, '上传 SVG/HTML 导致 Stored XSS');
  assert.equal(uploadXss.raw_count, 6, 'Upload XSS findings should merge by root cause');

  const paypwd = byTitle(issues, '支付密码/OTP 重置绕过');
  assert.equal(paypwd.raw_count, 2, 'setOrResetPaypwd findings should merge');

  const negativeReview = byTitle(issues, '负数金额：订单/撤单/日志/管理类接口');
  assert.equal(negativeReview.raw_count, 8, 'negative amount non-funds-action group should retain raw evidence count');
  assert.equal(negativeReview.business_impact_review_required, true, 'read/history/admin-like negative amount group should require business impact review');

  const pathView = await api(`/api/findings/${pathTraversal.representative_finding_id}/evidence-view`);
  assert.equal(pathView.issue_title, '任意文件读取 / Path Traversal');
  assert.equal(pathView.duplicate_count, 2);
  assert.equal(pathView.parsed_request.query.file, 'report.txt');
  assert.match(JSON.stringify(pathView.summary.how_found), /\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/etc\/passwd/);
  assert.match(String(pathView.parsed_response.body_text || pathView.parsed_response.body || ''), /root:x:0:0/);
  assert.ok(pathView.workflow.target_step, 'Path Traversal should expose target workflow step');

  const xssView = await api(`/api/findings/${uploadXss.representative_finding_id}/evidence-view`);
  assert.equal(xssView.issue_title, '上传 SVG/HTML 导致 Stored XSS');
  assert.equal(xssView.duplicate_count, 6);
  assert.match(JSON.stringify(xssView.summary.how_found), /Content-Type: (image\/svg\+xml|text\/html)/);
  assert.match(JSON.stringify(xssView.summary.why_vulnerable), /直接访问|对外访问|text\/html|image\/svg\+xml/);

  const negativeView = await api(`/api/findings/${negativeReview.representative_finding_id}/evidence-view`);
  assert.equal(negativeView.summary.business_impact_review_required, true);
  assert.match(JSON.stringify(negativeView.summary.false_positive_checks), /只读|日志|业务|流水/);

  const assistant = await api(`/api/findings/${pathTraversal.representative_finding_id}/assistant`, {
    method: 'POST',
    body: JSON.stringify({
      mode: 'false_positive',
      provider_id: 'missing-provider-for-fallback-test',
    }),
  });
  assert.equal(assistant.cached, false);
  assert.equal(assistant.mode, 'false_positive');
  assert.ok(assistant.answer.summary);
  assert.ok(assistant.answer.false_positive_checks.length > 0);

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    unique_issues: issues.length,
    raw_counts: {
      path_traversal: pathTraversal.raw_count,
      upload_xss: uploadXss.raw_count,
      paypwd: paypwd.raw_count,
      negative_review: negativeReview.raw_count,
    },
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
