#!/usr/bin/env node
import http from 'http';

const port = Number(process.env.PORT || 3339);

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 10 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function getPayload(reqBody) {
  const msg = reqBody?.messages?.slice().reverse().find(m => m.role === 'user')?.content || '{}';
  try { return JSON.parse(msg); } catch { return {}; }
}

function invoked(ctx, tool) {
  return (ctx.task_tool_invocations || []).some(inv => inv.tool_name === tool && inv.status === 'completed');
}

function lastInv(ctx) {
  const inv = ctx.task_tool_invocations || [];
  return inv[inv.length - 1];
}

function endpointId(ctx, vulnType = '') {
  const relevant = ctx.relevant_endpoints || [];
  const find = (re, method) => relevant.find(endpoint => re.test(String(endpoint.path || endpoint.url || '')) && (!method || String(endpoint.method).toUpperCase() === method));
  if (vulnType === 'email_sms_bypass') return (find(/sms|send.*code|email.*code|otp|captcha|verify|codebeforelogin/i, 'POST') || find(/sms|email|otp|captcha|verify|code/i))?.id || relevant[relevant.length - 1]?.id;
  if (vulnType === 'passcode_bypass') return (find(/withdraw|transfer|wallet|payment|pay/i, 'POST') || find(/passcode|paypwd|pay_password|payment.*password|trade.*password|fund.*password|pin/i, 'POST') || find(/withdraw|transfer|wallet|passcode|paypwd|pin|password/i))?.id || relevant[relevant.length - 1]?.id;
  if (vulnType === 'business_logic') return (find(/cart|quantity/i, 'GET') || find(/refund|cancel|payment|pay|withdraw|transfer/i, 'POST') || find(/cart|quantity|order|amount|payment|withdraw|transfer/i))?.id || relevant[relevant.length - 1]?.id;
  if (vulnType === 'state_machine_race') return (find(/refund/i, 'POST') || find(/cancel/i, 'POST') || find(/payment|pay|withdraw|transfer/i, 'POST') || find(/refund|cancel|payment|pay|withdraw|transfer/i))?.id || relevant[relevant.length - 1]?.id;
  if (vulnType === 'replay_race') return (find(/refund|cancel|payment|pay|withdraw|transfer/i, 'POST') || find(/cart|quantity/i, 'GET') || find(/order|wallet|cart/i))?.id || relevant[relevant.length - 1]?.id;
  if (vulnType === 'bfla') return (find(/admin\/users|admin|manage|role/i) || relevant[relevant.length - 1])?.id;
  if (vulnType === 'bola_idor') return (find(/order|historyorders|withdraw|transfer|wallet|user/i) || relevant[relevant.length - 1])?.id;
  const ids = ctx.task?.endpoint_ids || [];
  return ids[ids.length - 1] || relevant[relevant.length - 1]?.id || ctx.endpoint_inventory_summary?.sample?.[0]?.id;
}

function extractJsonArrayAfter(text, marker) {
  const start = String(text || '').indexOf(marker);
  if (start < 0) return [];
  const arrayStart = String(text).indexOf('[', start);
  if (arrayStart < 0) return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = arrayStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(arrayStart, i + 1)); } catch { return []; }
      }
    }
  }
  return [];
}

function plannerPrompt(text) {
  const endpoints = extractJsonArrayAfter(text, 'Endpoints:').filter(item => item && typeof item === 'object');
  const featureByName = new Map();
  const candidates = [];
  const addFeature = (name, endpoint) => {
    if (!featureByName.has(name)) {
      featureByName.set(name, {
        name,
        node_type: 'feature',
        description: `AI grouped remote target capability around ${name}.`,
        endpoint_paths: [],
        confidence: 0.78,
      });
    }
    if (endpoint?.path && !featureByName.get(name).endpoint_paths.includes(endpoint.path)) {
      featureByName.get(name).endpoint_paths.push(endpoint.path);
    }
  };
  const addCandidate = (vuln_type, title, reason, endpoint, confidence = 0.74, required_accounts = ['anonymous']) => {
    candidates.push({
      vuln_type,
      title,
      reason,
      endpoint_paths: endpoint?.path ? [endpoint.path] : [],
      feature_name: title.split(':')[0],
      confidence,
      required_accounts,
    });
  };
  for (const endpoint of endpoints.slice(0, 120)) {
    const path = String(endpoint.path || endpoint.url || '/');
    const method = String(endpoint.method || 'GET').toUpperCase();
    const featureName = /admin|manage|后台/i.test(path)
      ? 'Administration'
      : /login|logout|session|captcha|code/i.test(path)
        ? 'Authentication'
        : /upload|file|image|avatar|pic/i.test(path)
          ? 'File handling'
          : /qrcode|fwm|query|search|order|room|game|agent/i.test(path)
            ? 'Business workflow'
            : 'Public surface';
    addFeature(featureName, endpoint);
    if (/admin|manage/i.test(path)) addCandidate('bfla', `${featureName}: admin route exposure`, 'Administrative route or management resource should be checked for direct access and role enforcement.', endpoint, 0.82, ['anonymous', 'admin']);
    if (/id=|uid=|user|agent|order|room|member|account|fwm|bianhao|txm/i.test(path)) addCandidate('bola_idor', `${featureName}: object reference boundary`, 'Endpoint contains object identifiers or account-shaped resources that need cross-user object access validation.', endpoint, 0.8, ['attacker', 'victim', 'session']);
    if (/file|download|path|pic|image|avatar|upload/i.test(path)) {
      addCandidate('file_download', `${featureName}: file retrieval boundary`, 'File-like route should be checked for traversal, arbitrary read and unsafe static exposure.', endpoint, 0.76);
      addCandidate('path_traversal', `${featureName}: traversal mutation`, 'File/path parameters should reject traversal payloads and absolute paths.', endpoint, 0.76);
    }
    if (method === 'POST' || /search|query|fwm|login|admin|game/i.test(path)) addCandidate('xss', `${featureName}: reflected input handling`, 'Search, login and query surfaces should be mutated with HTML/script payloads and judged against rendered evidence.', endpoint, 0.72);
    if (/exec|cmd|shell|ping|backup|db|export|import/i.test(path)) addCandidate('command_injection', `${featureName}: command-like operation`, 'Operational route names suggest command or file-system side effects that need metacharacter mutation.', endpoint, 0.7);
    if (/cart|pay|order|room|game|query|agent|fwm|code/i.test(path)) {
      addCandidate('business_logic', `${featureName}: workflow invariant`, 'Business state transitions should be checked for skipped prerequisites, tampered quantities and invalid state changes.', endpoint, 0.78, ['authenticated', 'object_state']);
      addCandidate('replay_race', `${featureName}: replay and concurrency`, 'State-changing workflows should be checked for duplicate submission or concurrent replay effects.', endpoint, 0.72, ['authenticated', 'object_state']);
    }
    if (/captcha|verify|code|otp|sms|email|yzm/i.test(path)) addCandidate('email_sms_bypass', `${featureName}: verification bypass`, 'Verification and captcha surfaces need bypass, replay and missing-code checks.', endpoint, 0.78, ['auth_transition']);
  }
  if (candidates.length === 0 && endpoints[0]) {
    addFeature('Public surface', endpoints[0]);
    addCandidate('xss', 'Public surface: reflected input handling', 'Default public route should be checked for reflected input and unsafe rendering.', endpoints[0], 0.66);
    addCandidate('bfla', 'Public surface: administrative exposure sweep', 'Crawl should attempt common admin routes and verify access controls.', endpoints[0], 0.68);
  }
  return {
    features: [...featureByName.values()],
    vulnerability_candidates: candidates.slice(0, 80),
  };
}

function completeAfterLast(ctx) {
  const last = lastInv(ctx);
  if (!last || last.status !== 'completed') return null;
  const completeTools = new Set([
    'bstg.capabilities.inventory',
    'browser.discover_target',
    'vuln.generate_candidates',
    'agent.shared_context.prepare',
    'task.expand_selected_vulnerabilities',
    'task.summarize_vulnerability_campaign',
    'bstg.file_upload.run_test',
    'bstg.generic_vuln.run_test',
  ]);
  if (!completeTools.has(last.tool_name)) return null;
  if (last.tool_name === 'bstg.capabilities.inventory' && !(ctx.task?.execution_plan?.intent === 'inventory_bstg_capabilities')) return null;
  const selected = ctx.selected_vuln_types || [];
  if (/candidate|feature|漏洞候选|功能树/i.test(`${ctx.task?.task_type || ''} ${ctx.task?.title || ''}`) && last.tool_name === 'vuln.generate_candidates' && !invoked(ctx, 'agent.shared_context.prepare')) return null;
  if (/candidate|feature|漏洞候选|功能树/i.test(`${ctx.task?.task_type || ''} ${ctx.task?.title || ''}`) && selected.length === 0 && !invoked(ctx, 'task.expand_selected_vulnerabilities')) {
    return { action: 'wait_for_user_selection', summary: 'Feature tree and vulnerability candidates are ready; waiting for user vulnerability selection.', rationale: 'The scan has generated candidates and the user has not selected vulnerability classes yet.' };
  }
  return { action: 'complete_task', summary: last.output_summary || `${last.tool_name} completed.`, rationale: 'The required tool evidence for this task is present.' };
}

function decide(ctx) {
  ctx = ctx && typeof ctx === 'object' ? ctx : {};
  ctx.task = ctx.task && typeof ctx.task === 'object' ? ctx.task : {};
  ctx.scan = ctx.scan && typeof ctx.scan === 'object' ? ctx.scan : {};
  const maybeComplete = completeAfterLast(ctx);
  if (maybeComplete) return maybeComplete;
  const taskText = `${ctx.task?.task_type || ''} ${ctx.task?.title || ''} ${ctx.task?.agent_goal || ''} ${JSON.stringify(ctx.task?.execution_plan || {})}`;
  const selected = ctx.selected_vuln_types || [];
  const vulnType = String(ctx.task?.vuln_type || ctx.task?.execution_plan?.vuln_type || 'generic');

  if ((ctx.task?.execution_plan?.intent === 'inventory_bstg_capabilities' || /^梳理 BSTG 原生能力/.test(String(ctx.task?.title || ''))) && !invoked(ctx, 'bstg.capabilities.inventory')) {
    return { action: 'tool_call', tool_name: 'bstg.capabilities.inventory', arguments: {}, rationale: 'Load the native BSTG capability inventory before driving tests.' };
  }
  if ((ctx.task?.execution_plan?.intent === 'discover_target') || (/discover|understand|目标|发现/i.test(taskText) && !/candidate|feature|漏洞候选|功能树/i.test(taskText))) {
    if (!invoked(ctx, 'browser.navigate')) {
      return { action: 'tool_call', tool_name: 'browser.navigate', arguments: { url: ctx.scan.base_url, timeout_ms: ctx.scan.scan_config?.timeout_ms || 45000 }, rationale: 'Navigate the target to capture a browser state and network observation.' };
    }
    if (!invoked(ctx, 'browser.discover_target')) {
      return { action: 'tool_call', tool_name: 'browser.discover_target', arguments: { max_pages: ctx.scan.scan_config?.max_pages || 1000 }, rationale: 'Discover endpoints, forms, upload controls and API references.' };
    }
  }
  if (ctx.task?.execution_plan?.intent === 'expand_selected_vulnerabilities') {
    const selectedForExpansion = Array.isArray(ctx.task?.execution_plan?.selected_vuln_types) && ctx.task.execution_plan.selected_vuln_types.length ? ctx.task.execution_plan.selected_vuln_types : selected;
    if (!invoked(ctx, 'task.expand_selected_vulnerabilities')) return { action: 'tool_call', tool_name: 'task.expand_selected_vulnerabilities', arguments: { selected_vuln_types: selectedForExpansion }, rationale: 'Expand selected vulnerability types into persistent executable tasks.' };
    return { action: 'complete_task', summary: `Expanded selected vulnerability types: ${selectedForExpansion.join(', ')}`, rationale: 'The selected vulnerability classes have been expanded.' };
  }

  if (ctx.task?.execution_plan?.intent === 'model_features_and_candidates' || /candidate|feature|漏洞候选|功能树/i.test(`${ctx.task?.task_type || ''} ${ctx.task?.title || ''}`)) {
    if (!invoked(ctx, 'feature.extract_tree')) return { action: 'tool_call', tool_name: 'feature.extract_tree', arguments: {}, rationale: 'Build the feature tree first.' };
    if (!invoked(ctx, 'vuln.generate_candidates')) return { action: 'tool_call', tool_name: 'vuln.generate_candidates', arguments: {}, rationale: 'Generate vulnerability candidates from features and endpoints.' };
    if (!invoked(ctx, 'agent.shared_context.prepare')) return { action: 'tool_call', tool_name: 'agent.shared_context.prepare', arguments: { selected_vuln_types: selected }, rationale: 'Prepare reusable cross-agent shared context: identity pool, login/session workflow, object inventory and payload plans before expanding sub-agent tasks.' };
    if (selected.length > 0 && !invoked(ctx, 'task.expand_selected_vulnerabilities')) return { action: 'tool_call', tool_name: 'task.expand_selected_vulnerabilities', arguments: { selected_vuln_types: selected }, rationale: 'Selected vulnerability types exist; expand candidates into persistent tasks.' };
    return { action: 'wait_for_user_selection', summary: 'Candidates generated; waiting for selected vulnerability types.', rationale: 'The user must choose vulnerability classes before executable tasks are created.' };
  }
  if (ctx.task?.execution_plan?.intent === 'summarize_vulnerability_campaign' || ctx.task?.task_type === 'summarize_vulnerability_campaign') {
    if (!invoked(ctx, 'task.summarize_vulnerability_campaign')) return { action: 'tool_call', tool_name: 'task.summarize_vulnerability_campaign', arguments: { campaign_task_id: ctx.task?.execution_plan?.campaign_task_id, child_task_ids: ctx.task?.execution_plan?.child_task_ids || [], vuln_type: vulnType }, rationale: 'All child sub-agent tasks for this vulnerability campaign have completed; summarize campaign evidence and residual gaps.' };
    return { action: 'complete_task', summary: `${vulnType} campaign summarized.`, rationale: 'The vulnerability campaign summary artifact has been created.' };
  }
  if (vulnType === 'file_upload' || /file upload|文件上传/i.test(taskText)) {
    return { action: 'tool_call', tool_name: 'bstg.file_upload.run_test', arguments: { endpoint_id: endpointId(ctx, vulnType), endpoint_ids: ctx.task.endpoint_ids || [] }, rationale: 'File upload requires upload baseline, mutation payloads, post-upload access and native evidence.' };
  }
  if (/^test_/i.test(ctx.task?.task_type || '') || vulnType) {
    const simple = new Set(['xss', 'command_injection', 'file_download', 'path_traversal', 'email_sms_bypass', 'passcode_bypass']);
    if (simple.has(vulnType) && !invoked(ctx, 'bstg.api_test.run')) {
      return { action: 'tool_call', tool_name: 'bstg.api_test.run', arguments: { endpoint_id: endpointId(ctx, vulnType), vuln_type: vulnType }, rationale: 'This is a single-interface vulnerability; first drive native API test-run mode.' };
    }
    return { action: 'tool_call', tool_name: 'bstg.generic_vuln.run_test', arguments: { endpoint_id: endpointId(ctx, vulnType), endpoint_ids: ctx.task?.endpoint_ids || [] }, rationale: 'Execute the full native BSTG vulnerability runner with workflow/API evidence and finding gate.' };
  }
  return { action: 'complete_task', summary: 'No further tool calls are required.', rationale: 'No matching autonomous action remains.' };
}


function judgePrompt(text) {
  const lower = String(text || '').toLowerCase();
  const vuln = (lower.match(/vuln_type=([a-z0-9_]+)/) || [])[1] || 'generic';
  const responseText = [
    ...String(text || '').matchAll(/"mutated_body":"((?:\\.|[^"\\])*)"/g),
    ...String(text || '').matchAll(/"mutated_headers":(\{(?:\\.|[^}])*\})/g),
  ].map(match => match[1]).join(' ');
  const positive = /root:x:0:0|uid=1000|gid=1000|<script>alert\(1337\)<\/script>|admin@example\.com|admin function|user management|victim-bob|other user|secret|negative quantity|total\\":-100|replayed|uploaded|svg-xss|verified\\?[:=]true|login_success/i.test(responseText) || (vuln === 'bola_idor' && /other user|victim|owner mismatch|secret/i.test(responseText)) || (vuln === 'bfla' && /admin\/users|user management|role=admin|permission denied bypassed/i.test(responseText));
  if (positive) {
    const severity = vuln === 'command_injection' ? 'critical' : ['bola_idor','bfla','path_traversal','file_download','email_sms_bypass','passcode_bypass'].includes(vuln) ? 'high' : 'medium';
    return {
      verdict: 'vulnerable',
      confidence: 0.88,
      severity,
      title: `AI-confirmed ${vuln} evidence`,
      reason: 'The supplied baseline/mutation evidence contains a strong security signal for this vulnerability type.',
      evidence: [String(text).match(/root:x:0:0|uid=1000|admin@example\.com|victim-bob|other user|<script>alert\(1337\)<\/script>|negative quantity|replayed|uploaded|svg-xss/i)?.[0] || 'positive security signal'],
    };
  }
  if (/mutated_status|comparison|changed/i.test(text)) {
    return { verdict: 'inconclusive', confidence: 0.55, severity: 'low', title: `Observable ${vuln} difference`, reason: 'The evidence is observable but lacks a strong vulnerability signal.', evidence: ['observable response difference'] };
  }
  return { verdict: 'not_vulnerable', confidence: 0.65, severity: 'low', title: `No confirmed ${vuln}`, reason: 'No strong signal in provided evidence.', evidence: [] };
}

function judgeUploadPrompt(text) {
  const positive = /accepted=true|svg|html|php|image\/svg\+xml|text\/html|<script|onload=|location=/i.test(String(text || ''));
  if (positive) {
    return {
      verdict: 'vulnerable',
      confidence: 0.88,
      severity: /php|jsp|aspx|phtml/i.test(String(text || '')) ? 'high' : 'medium',
      title: 'AI-confirmed file_upload evidence',
      reason: 'The upload evidence shows dangerous file content or extension accepted by the target.',
      evidence: ['dangerous upload accepted'],
    };
  }
  return { verdict: 'not_vulnerable', confidence: 0.7, severity: 'low', title: 'No confirmed file_upload', reason: 'No dangerous upload was accepted.', evidence: [] };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) return json(res, 200, { ok: true });
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await parseBody(req);
      const lastUser = body?.messages?.slice().reverse().find(m => m.role === 'user')?.content || '';
      const content = /^respond with ok\.?$/i.test(String(lastUser).trim())
        ? 'OK'
        : String(lastUser).includes('You are the planning layer of an autonomous web security testing agent')
          ? JSON.stringify(plannerPrompt(lastUser))
        : String(lastUser).includes('You are judging pre-finding web security evidence')
        ? JSON.stringify(judgePrompt(lastUser))
        : String(lastUser).includes('You are judging a web security file upload test')
          ? JSON.stringify(judgeUploadPrompt(lastUser))
          : JSON.stringify(decide((getPayload(body).context || getPayload(body))));
      return json(res, 200, {
        id: `local-ai-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'local-autonomous-ai-provider',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    return json(res, 500, { error: error.message || String(error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[local-ai-provider] listening on http://127.0.0.1:${port}/v1`);
});
