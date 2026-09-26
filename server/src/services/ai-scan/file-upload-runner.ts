import { v4 as uuidv4 } from 'uuid';
import type { DbProvider } from '../../types/index.js';
import { dbRun } from '../../db/sql-helpers.js';
import type { AIScanRepository } from './repository.js';
import type { AIDiscoveredEndpoint, AIScanTask } from './types.js';
import { AIProviderUploadJudgementError, judgeUploadAttempts, type UploadAttemptEvidence } from './ai-judge.js';
import { runNativeBstgOrchestration } from './bstg-native-orchestrator.js';
import { canCreateFindingFromNativeAndJudge, evaluateNativeEvidence } from './native-evidence-gate.js';
import { normalizeOutputLanguage } from '../i18n/language.js';
import { fetchInTargetScope } from './target-scope.js';

interface UploadPayload {
  label: string;
  filename: string;
  content_type: string;
  body: string;
}

const PAYLOADS: UploadPayload[] = [
  {
    label: 'normal',
    filename: 'bstg-safe.png',
    content_type: 'image/png',
    body: '\x89PNG\r\n\x1a\nBSTG_SAFE_IMAGE',
  },
  {
    label: 'svg_xss',
    filename: 'bstg-svg-xss.svg',
    content_type: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>bstg</text></svg>',
  },
  {
    label: 'html_polyglot',
    filename: 'bstg-image.html',
    content_type: 'text/html',
    body: '<!doctype html><script>alert(1)</script>',
  },
  {
    label: 'double_extension',
    filename: 'bstg-avatar.png.php',
    content_type: 'image/png',
    body: '\x89PNG\r\n<?php echo "BSTG"; ?>',
  },
  {
    label: 'mime_bypass',
    filename: 'bstg-avatar.php',
    content_type: 'image/png',
    body: '<?php echo "BSTG"; ?>',
  },
  {
    label: 'filename_traversal',
    filename: '../bstg-traversal.svg',
    content_type: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg"><text>traversal</text></svg>',
  },
];

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bodyPreview(text: string): string {
  return text.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 2500);
}

function findLikelyFileField(endpoint: AIDiscoveredEndpoint): string {
  const summary = endpoint.request_summary || '';
  const matches = [...summary.matchAll(/(?:name|field)\s*[:=]\s*([a-zA-Z0-9_.-]+)/g)];
  const candidate = matches.find(match => /file|upload|avatar|image|media|attachment|excel/i.test(match[1]))?.[1];
  return candidate || 'file';
}

function extractLocation(baseUrl: string, responseHeaders: Record<string, string>, responseText: string): string | undefined {
  const locationHeader = responseHeaders.location;
  if (locationHeader) {
    try { return new URL(locationHeader, baseUrl).toString(); } catch { return locationHeader; }
  }

  const patterns = [
    /"(?:url|file_url|avatar_url|path|location|href|src)"\s*:\s*"([^"]+)"/i,
    /'(?:url|file_url|avatar_url|path|location|href|src)'\s*:\s*'([^']+)'/i,
    /https?:\/\/[^\s"'<>]+/i,
    /\/(?:uploads|upload|files|media|static)\/[^\s"'<>]+/i,
  ];
  for (const pattern of patterns) {
    const match = responseText.match(pattern);
    if (match) {
      const raw = match[1] || match[0];
      try { return new URL(raw, baseUrl).toString(); } catch { return raw; }
    }
  }
  return undefined;
}

async function postMultipart(endpoint: AIDiscoveredEndpoint, payload: UploadPayload, fieldName: string): Promise<UploadAttemptEvidence> {
  if (!endpoint.url) throw new Error(`Endpoint URL missing for ${endpoint.method} ${endpoint.path}`);
  const form = new FormData();
  const blob = new Blob([payload.body], { type: payload.content_type });
  form.append(fieldName, blob, payload.filename);

  const formConfig = endpoint.source_type === 'browser_form' ? (endpoint as any).form as { inputs?: Array<{ name?: string; type?: string; value?: string }> } | undefined : undefined;
  for (const input of formConfig?.inputs || []) {
    if (!input.name || input.type === 'file' || form.has(input.name)) continue;
    form.append(input.name, input.value || 'bstg');
  }

  const response = await fetchInTargetScope(endpoint.url, {
    method: endpoint.method.toUpperCase() === 'GET' ? 'POST' : endpoint.method.toUpperCase(),
    body: form,
  }, endpoint.url, { traffic_class: 'upload' });
  const text = await response.text();
  const headers = headersToObject(response.headers);
  const location = extractLocation(endpoint.url, headers, text);
  const accepted = response.status >= 200 && response.status < 400 && !/invalid|forbidden|denied|not allowed|unsupported|error|failed|reject/i.test(text.slice(0, 1000));

  const attempt: UploadAttemptEvidence = {
    label: payload.label,
    filename: payload.filename,
    content_type: payload.content_type,
    accepted,
    status: response.status,
    response_headers: headers,
    response_body_preview: bodyPreview(text),
    location,
  };

  if (location && accepted) {
    try {
      const fetched = await fetchInTargetScope(location, { method: 'GET' }, endpoint.url, { traffic_class: 'read' });
      attempt.fetch_status = fetched.status;
      attempt.fetched_content_type = fetched.headers.get('content-type') || undefined;
      attempt.fetched_body_preview = bodyPreview(await fetched.text());
    } catch (error: any) {
      attempt.error = `fetch_uploaded_location: ${error.message || String(error)}`;
    }
  }

  return attempt;
}


async function createVisualUploadState(repo: AIScanRepository, task: AIScanTask, endpoint: AIDiscoveredEndpoint, phase: string): Promise<void> {
  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'browser_agent_state',
    title: `Visual upload sub-agent state: ${endpoint.method} ${endpoint.path}`,
    content_json: {
      browser_context_id: `browser-${task.id}`,
      agent_role: task.execution_plan?.recommended_agent_role || 'file-upload-subagent',
      campaign_task_id: task.execution_plan?.campaign_task_id,
      function_name: task.execution_plan?.function_name,
      vuln_type: task.vuln_type || 'file_upload',
      current_url: endpoint.url,
      current_endpoint: { id: endpoint.id, method: endpoint.method, path: endpoint.path },
      action: phase,
      status: 'running',
      visual_policy: 'Rendered in the right-side multi-browser panel. This sub-agent is validating normal upload, payload mutation, and post-upload access evidence.',
    },
    source_ref: endpoint.id,
  });
}

async function createSecurityRuleAndTemplate(db: DbProvider, repo: AIScanRepository, endpoint: AIDiscoveredEndpoint, task: AIScanTask, fieldName: string): Promise<{ template_id: string; workflow_id: string; security_rule_id: string; checklist_id: string }> {
  const templateId = uuidv4();
  const workflowId = uuidv4();
  const workflowStepId = uuidv4();
  const variableConfigId = uuidv4();
  const securityRuleId = uuidv4();
  const checklistId = uuidv4();
  const rawRequest = [
    `${endpoint.method.toUpperCase() === 'GET' ? 'POST' : endpoint.method.toUpperCase()} ${endpoint.path} HTTP/1.1`,
    `Host: ${endpoint.url ? new URL(endpoint.url).host : 'target'}`,
    'Content-Type: multipart/form-data; boundary={{boundary}}',
    '',
    `--{{boundary}}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="{{filename}}"`,
    'Content-Type: {{content_type}}',
    '',
    '{{file_content}}',
    `--{{boundary}}--`,
  ].join('\r\n');

  await dbRun(
    db,
    `INSERT INTO api_templates (id, name, group_name, description, raw_request, parsed_structure, variables, failure_patterns, failure_logic, is_active, advanced_config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      templateId,
      `AI ${task.title}`,
      'AI Scan / File Upload',
      `Auto-generated by AI Scan task ${task.id}`,
      rawRequest,
      JSON.stringify({ method: endpoint.method, path: endpoint.path, content_type: 'multipart/form-data' }),
      JSON.stringify([
        { name: 'filename', source: 'security_rule', target: 'multipart.filename' },
        { name: 'content_type', source: 'security_rule', target: 'multipart.content_type' },
        { name: 'file_content', source: 'security_rule', target: 'multipart.content' },
      ]),
      JSON.stringify([]),
      'OR',
      1,
      JSON.stringify({ ai_scan_task_id: task.id, endpoint_id: endpoint.id }),
    ]
  );

  await dbRun(
    db,
    `INSERT INTO workflows (
       id, name, description, is_active, assertion_strategy, enable_extractor, workflow_type, mutation_profile, template_mode
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      workflowId,
      `AI Workflow ${task.title}`,
      `Auto-compiled single-step upload workflow for AI Scan task ${task.id}`,
      1,
      'any_step_pass',
      0,
      'mutation',
      JSON.stringify({
        replay_mode: true,
        lock_variables: ['auth_token', 'csrf_token'],
        reuse_tickets: true,
        ai_strategy: 'normal_upload_then_mutated_uploads',
      }),
      'reference',
    ]
  );

  await dbRun(
    db,
    `INSERT INTO workflow_steps (id, workflow_id, api_template_id, step_order, step_assertions, assertions_mode)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      workflowStepId,
      workflowId,
      templateId,
      1,
      JSON.stringify([{ type: 'status_range', min: 200, max: 399 }]),
      'all',
    ]
  );

  await dbRun(
    db,
    `INSERT INTO workflow_variable_configs (
       id, workflow_id, name, step_variable_mappings, data_source, security_rule_id, advanced_config, account_scope_ids
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      variableConfigId,
      workflowId,
      'file_upload_payload',
      JSON.stringify([{ step_order: 1, variable_name: 'file_content', location: 'request.body', path: fieldName }]),
      'security_rule',
      securityRuleId,
      JSON.stringify({ filename_variable: 'filename', content_type_variable: 'content_type', field_name: fieldName }),
      JSON.stringify([]),
    ]
  );

  await dbRun(
    db,
    `INSERT INTO security_rules (id, name, payloads, description) VALUES (?, ?, ?, ?)`,
    [
      securityRuleId,
      `AI File Upload Payloads - ${endpoint.path}`,
      JSON.stringify(PAYLOADS.map(payload => `${payload.label}|${payload.filename}|${payload.content_type}|${payload.body}`)),
      `Payload set auto-created for AI Scan task ${task.id}`,
    ]
  );

  await dbRun(
    db,
    `INSERT INTO checklists (id, name, config, description) VALUES (?, ?, ?, ?)`,
    [
      checklistId,
      `AI File Upload Fields - ${endpoint.path}`,
      JSON.stringify({ values: [fieldName] }),
      `Inferred upload file field for AI Scan task ${task.id}`,
    ]
  );

  return { template_id: templateId, workflow_id: workflowId, security_rule_id: securityRuleId, checklist_id: checklistId };
}

export async function runFileUploadTask(input: {
  db: DbProvider;
  repo: AIScanRepository;
  task: AIScanTask;
  endpoint: AIDiscoveredEndpoint;
}): Promise<Record<string, any>> {
  const { db, repo, task, endpoint } = input;
  const fieldName = findLikelyFileField(endpoint);
  await createVisualUploadState(repo, task, endpoint, 'starting_upload_baseline_and_mutations');
  const assets = await createSecurityRuleAndTemplate(db, repo, endpoint, task, fieldName);
  await repo.updateTask(task.id, {
    phase: 'assets_prepared',
    created_assets_json: assets,
  });

  const native = await runNativeBstgOrchestration({
    db,
    repo,
    task,
    endpoints: [endpoint],
    payloads: PAYLOADS.map(payload => ({
      label: payload.label,
      value: payload.filename,
      description: `${payload.content_type} ${payload.body.slice(0, 80)}`,
    })),
    paramName: fieldName,
    mode: 'file_upload',
  });
  await repo.updateTask(task.id, {
    phase: 'native_bstg_executed',
    created_assets_json: { ...assets, native_bstg: native.assets, native_api_mode: native.api_mode, native_counts: native.native_counts },
  });

  const attempts: UploadAttemptEvidence[] = [];
  for (const payload of PAYLOADS) {
    try {
      const attempt = await postMultipart(endpoint, payload, fieldName);
      attempts.push(attempt);
      await repo.createArtifact({
        scan_run_id: task.scan_run_id,
        task_id: task.id,
        artifact_type: 'upload_attempt',
        title: `${payload.label}: ${payload.filename}`,
        content_json: attempt as unknown as Record<string, any>,
        source_ref: endpoint.id,
      });
    } catch (error: any) {
      const attempt: UploadAttemptEvidence = {
        label: payload.label,
        filename: payload.filename,
        content_type: payload.content_type,
        accepted: false,
        error: error.message || String(error),
      };
      attempts.push(attempt);
      await repo.createArtifact({
        scan_run_id: task.scan_run_id,
        task_id: task.id,
        artifact_type: 'upload_attempt_error',
        title: `${payload.label}: ${payload.filename}`,
        content_json: attempt as unknown as Record<string, any>,
        source_ref: endpoint.id,
      });
    }
  }

  const run = await repo.getRun(task.scan_run_id).catch(() => null);
  const language = normalizeOutputLanguage(run?.language);
  let judge: Awaited<ReturnType<typeof judgeUploadAttempts>>;
  try {
    judge = await judgeUploadAttempts(db, endpoint.path, attempts, language);
  } catch (error: any) {
    if (error instanceof AIProviderUploadJudgementError) {
      await repo.createArtifact({
        scan_run_id: task.scan_run_id,
        task_id: task.id,
        artifact_type: 'ai_provider_judgement_failed',
        title: `AI provider upload judgement failed for ${endpoint.path}`,
        content_json: {
          error: error.message,
          provider_id: error.provider_id,
          model: error.model,
          provider_response: error.provider_response,
          endpoint: { id: endpoint.id, method: endpoint.method, path: endpoint.path },
          policy: 'pause_task_no_heuristic_fallback_no_finding',
        } as unknown as Record<string, any>,
        source_ref: endpoint.id,
      });
    }
    throw error;
  }
  const nativeGate = canCreateFindingFromNativeAndJudge(native, judge, language);
  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'ai_judgement',
    title: judge.title,
    content_json: { ...judge, native_evidence_gate: nativeGate } as unknown as Record<string, any>,
    source_ref: endpoint.id,
  });

  let findingId: string | undefined;
  if (judge.verdict === 'vulnerable') {
    findingId = uuidv4();
    const strongest = attempts.find(attempt => attempt.label !== 'normal' && attempt.accepted) || attempts[0];
    const provenance = await repo.resolveFindingProvenance(task, endpoint.id);
    await dbRun(
      db,
      `INSERT INTO findings (
        id, source_type, api_template_id, template_id, workflow_id,
        ai_scan_run_id, ai_scan_task_id, ai_campaign_task_id, ai_candidate_id, ai_feature_id, ai_endpoint_id, ai_evidence_contract,
        severity, status, title, description, template_name,
        request_raw, response_status, response_headers, response_body, request_evidence, response_evidence, ai_analysis,
        notes, discovered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        findingId,
        'ai_scan',
        native.assets.template_ids[0] || assets.template_id,
        native.assets.template_ids[0] || assets.template_id,
        native.assets.mutation_workflow_id || assets.workflow_id,
        provenance.ai_scan_run_id,
        provenance.ai_scan_task_id,
        provenance.ai_campaign_task_id || null,
        provenance.ai_candidate_id || null,
        provenance.ai_feature_id || null,
        provenance.ai_endpoint_id || null,
        null,
        judge.severity,
        'new',
        judge.title,
        judge.reason,
        `AI ${task.title}`,
        `multipart upload to ${endpoint.method} ${endpoint.path}; native_template_run=${native.assets.template_test_run_id}; native_baseline_workflow_run=${native.assets.baseline_workflow_test_run_id}; native_mutation_workflow_run=${native.assets.mutation_workflow_test_run_id}`,
        strongest?.status || null,
        JSON.stringify(strongest?.response_headers || {}),
        strongest?.response_body_preview || '',
        JSON.stringify({ endpoint, field_name: fieldName, native_bstg: { assets: native.assets, api_mode: native.api_mode, template_run: native.template_run, baseline_workflow_run: native.baseline_workflow_run, mutation_workflow_run: native.mutation_workflow_run }, attempts }),
        JSON.stringify({ judgement: judge, native_evidence_gate: nativeGate, uploaded_location: strongest?.location }),
        JSON.stringify(judge),
        `Created by AI Scan run ${task.scan_run_id} task ${task.id}`,
        new Date().toISOString(),
      ]
    );
    await repo.recordFindingProvenance(findingId!, provenance);
  }

  if (judge.verdict === 'vulnerable' && nativeGate.verdict !== 'confirmed') {
    await repo.createArtifact({
      scan_run_id: task.scan_run_id,
      task_id: task.id,
      artifact_type: 'finding_created_with_replay_gap',
      title: 'Created file upload finding with replay gap',
      content_json: nativeGate as unknown as Record<string, any>,
      source_ref: endpoint.id,
    });
  }

  return {
    endpoint,
    field_name: fieldName,
    assets: { ...assets, native_bstg: native.assets },
    native_bstg: native,
    attempts,
    judge,
    finding_id: findingId,
  };
}
