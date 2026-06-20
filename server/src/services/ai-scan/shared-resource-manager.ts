import { dbAll } from '../../db/sql-helpers.js';
import type { DbProvider } from '../../types/index.js';
import type { AIScanRepository } from './repository.js';
import type { AIDiscoveredEndpoint, AIScanSharedResource, AIScanTask } from './types.js';
import { payloadsForVulnType } from './payload-catalog.js';

function endpointText(endpoint: AIDiscoveredEndpoint): string {
  return `${endpoint.method} ${endpoint.path} ${endpoint.url || ''} ${endpoint.request_summary || ''} ${endpoint.response_summary || ''} ${endpoint.feature_guess || ''}`.toLowerCase();
}

function isLoginLike(endpoint: AIDiscoveredEndpoint): boolean {
  return /login|signin|auth|token|session|captcha|sms|otp|verify|send.*code|codebeforelogin|userinfo|profile|me\b/.test(endpointText(endpoint));
}

function loginOrder(endpoint: AIDiscoveredEndpoint): number {
  const text = endpointText(endpoint);
  if (/captcha|imagecode/.test(text)) return 5;
  if (/send.*code|sms|otp/.test(text)) return 10;
  if (/verify|confirm/.test(text)) return 20;
  if (/login|signin|token|auth/.test(text)) return 30;
  if (/userinfo|profile|me\b/.test(text)) return 40;
  return 100;
}


function chooseCanonicalLoginEndpoints(endpoints: AIDiscoveredEndpoint[]): AIDiscoveredEndpoint[] {
  const sorted = endpoints.filter(isLoginLike).sort((a, b) => loginOrder(a) - loginOrder(b));
  const chosen: AIDiscoveredEndpoint[] = [];
  const addFirst = (re: RegExp, method?: string) => {
    const item = sorted.find(endpoint => re.test(endpointText(endpoint)) && (!method || endpoint.method.toUpperCase() === method) && !chosen.some(existing => existing.id === endpoint.id));
    if (item) chosen.push(item);
  };
  addFirst(/captcha|send.*code|sms|otp/, 'POST');
  addFirst(/login|signin|auth|token/, 'POST');
  addFirst(/loginconfirm|verify|confirm/, 'POST');
  addFirst(/userinfo|profile|me/, 'GET');
  if (chosen.length === 0) chosen.push(...sorted.slice(0, 4));
  return chosen.slice(0, 4);
}

function normalizeFunctionKey(text: string): string {
  return String(text || 'unknown')
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[^a-z0-9_\-/]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 96) || 'unknown';
}

function hasIdentityNeed(vulnType: string): boolean {
  return ['bola_idor', 'bfla', 'business_logic', 'auth_otp', 'email_sms_bypass', 'passcode_bypass', 'replay_race', 'state_machine_race'].includes(vulnType);
}


function parseMaybeJson(text: string): any | null {
  try { return JSON.parse(text); } catch { return null; }
}

function extractFieldsFromPacket(raw: string): Record<string, any> {
  const fields: Record<string, any> = {};
  const text = String(raw || '');
  const auth = text.match(/^Authorization:\s*([^\r\n]+)/im)?.[1];
  const cookie = text.match(/^Cookie:\s*([^\r\n]+)/im)?.[1];
  if (auth) fields.auth_token = auth.trim();
  if (cookie) fields.cookie = cookie.trim();
  const body = text.split(/\r?\n\r?\n/).slice(1).join('\n\n').trim();
  const json = body ? parseMaybeJson(body) : null;
  const harvest = (obj: any, prefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) harvest(value, path);
      else if (/^(username|user(name)?|account|email|mail|mobile|phone|tel|password|passwd|pwd|token|access_token|csrf|_token|role|user_id|uid|id|otp|code|passcode|paypwd)$/i.test(key)) fields[key] = value;
      if (/token|csrf|session|cookie|authorization/i.test(path) && typeof value === 'string') fields[path] = value;
    }
  };
  if (json) harvest(json);
  else {
    for (const pair of body.split(/[&\n]/)) {
      const [k, v] = pair.split('=');
      if (k && /username|user|account|email|mail|mobile|phone|password|passwd|pwd|token|csrf|role|uid|id|otp|code|passcode|paypwd/i.test(k)) fields[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return fields;
}

function normalizeAccountConfig(scanConfig: Record<string, any> | undefined): Record<string, any> {
  const cfg = scanConfig || {};
  const manual = cfg.accounts || cfg.identities || {};
  const rawPackets = Array.isArray(cfg.account_raw_requests) ? cfg.account_raw_requests : (typeof cfg.account_raw_requests === 'string' && cfg.account_raw_requests.trim() ? [cfg.account_raw_requests] : []);
  const parsedPackets = rawPackets.map((raw: string, index: number) => ({ source: `raw_request_${index + 1}`, fields: extractFieldsFromPacket(raw) })).filter((item: any) => Object.keys(item.fields || {}).length > 0);
  return {
    input_modes: {
      manual_accounts: Object.keys(manual || {}).length > 0,
      raw_request_packets: rawPackets.length > 0,
      auto_executed_registration: Boolean(cfg.account_mode === 'auto_execute' || cfg.enable_account_auto_execution),
      autonomous_registration: Boolean(cfg.enable_autonomous_account_discovery || cfg.enable_ai_registration || cfg.account_mode === 'auto_execute' || cfg.enable_account_auto_execution),
      human_assisted_registration: Boolean(cfg.enable_human_assisted_registration),
    },
    account_mode: cfg.account_mode || (cfg.enable_account_auto_execution ? 'auto_execute' : undefined),
    manual_accounts: manual,
    raw_request_accounts: parsedPackets,
    requested_roles: Array.isArray(cfg.auto_account_roles) && cfg.auto_account_roles.length ? cfg.auto_account_roles : ['attacker', 'victim', 'admin'],
  };
}

async function existingAccounts(db: DbProvider, scanRunId: string): Promise<any[]> {
  try {
    const rows = await dbAll<any>(db, `SELECT id, name, username, tags, fields FROM accounts WHERE tags LIKE ? AND tags LIKE ? ORDER BY created_at ASC`, ['%ai_scan%', `%scan:${scanRunId}%`]);
    return rows.map(row => {
      const parse = (value: any) => {
        if (!value || typeof value !== 'string') return value || {};
        try { return JSON.parse(value); } catch { return {}; }
      };
      return { ...row, tags: parse(row.tags), fields: parse(row.fields) };
    });
  } catch {
    return [];
  }
}

export async function prepareSharedAgentResources(input: {
  db: DbProvider;
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  selectedVulnTypes?: string[];
}): Promise<{ resources: AIScanSharedResource[]; summary: Record<string, any> }> {
  const { db, repo, scanRunId, taskId } = input;
  const [run, endpoints, candidates, features] = await Promise.all([
    repo.getRun(scanRunId),
    repo.listEndpoints(scanRunId),
    repo.listCandidates(scanRunId),
    repo.listFeatures(scanRunId),
  ]);
  const selected = input.selectedVulnTypes?.length ? input.selectedVulnTypes : (run?.selected_vuln_types || []);
  const created: AIScanSharedResource[] = [];

  const accountConfig = normalizeAccountConfig(run?.scan_config);
  const identityPool = await repo.upsertSharedResource({
    scan_run_id: scanRunId,
    resource_type: 'identity_pool',
    resource_key: 'default-attacker-victim-admin',
    title: 'Reusable attacker/victim/admin identity pool',
    owner_task_id: taskId,
    content_json: {
      purpose: 'Shared by all sub-agents that require account binding, session material, anchor_attacker, or object ownership checks.',
      roles: ['attacker', 'victim', 'admin'],
      configured_accounts: accountConfig.manual_accounts,
      raw_request_accounts: accountConfig.raw_request_accounts,
      input_modes: accountConfig.input_modes,
      existing_bstg_accounts: await existingAccounts(db, scanRunId),
      reuse_policy: 'Do not recreate accounts per sub-agent. Reuse this identity pool and let BSTG account binding choose role-specific fields.',
    },
  });
  created.push(identityPool);

  created.push(await repo.upsertSharedResource({
    scan_run_id: scanRunId,
    resource_type: 'identity_acquisition_plan',
    resource_key: 'account-input-and-autonomous-registration',
    title: 'Account acquisition options for AI-driven testing',
    owner_task_id: taskId,
    content_json: {
      purpose: 'Defines how the AI Agent obtains or asks for attacker/victim/admin accounts: default auto-executed registration/login, autonomous discovery planning, manual fields, raw request packets, or browser-driven registration with human assistance.',
      account_config: accountConfig,
      supported_modes: ['auto_executed_registration_login', 'autonomous_browser_registration_planning', 'manual_accounts', 'raw_request_packets', 'human_assisted_otp_or_sms'],
      user_prompt_policy: 'When an OTP/SMS/email/passcode or phone-number step blocks automation, create a human_input_request artifact and wait for user input instead of silently failing.',
      browser_registration_policy: 'In auto_execute mode, call bstg.identity.bootstrap_accounts to submit registration/login forms and save account/session material before downstream sub-agents ask for accounts. In autonomous planning mode, only describe the acquisition path and ask for assistance when blocked.',
    },
  }));

  const loginEndpoints = chooseCanonicalLoginEndpoints(endpoints);
  const loginBlueprint = await repo.upsertSharedResource({
    scan_run_id: scanRunId,
    resource_type: 'workflow_blueprint',
    resource_key: 'canonical-login-session-flow',
    title: 'Canonical reusable login/session workflow blueprint',
    owner_task_id: taskId,
    content_json: {
      purpose: 'Reusable by all sub-agents that need session/cookie/token/csrf prerequisites. It avoids rediscovering the same login ABCDE flow per function.',
      endpoint_ids: loginEndpoints.map(endpoint => endpoint.id),
      steps: loginEndpoints.map((endpoint, index) => ({ step_order: index + 1, endpoint_id: endpoint.id, method: endpoint.method, path: endpoint.path, reason: 'login/session/auth-related endpoint' })),
      session_material: ['cookie', 'set-cookie', 'authorization', 'token', 'csrf', 'otp_ticket', 'session'],
      recommended_bstg_capabilities: ['workflow_steps', 'workflow_extractors', 'workflow_mappings', 'workflow_variables', 'session_jar', 'learning_engine'],
      reuse_policy: 'Sub-agents should prepend these endpoints when their vulnerability requires authentication, object ownership, BOLA/BFLA, OTP, or business state.',
    },
  });
  created.push(loginBlueprint);

  const sessionStrategy = await repo.upsertSharedResource({
    scan_run_id: scanRunId,
    resource_type: 'session_strategy',
    resource_key: 'default-session-jar-and-token-propagation',
    title: 'Shared session jar and token propagation strategy',
    owner_task_id: taskId,
    content_json: {
      enable_session_jar: true,
      cookie_mode: true,
      header_mode: true,
      propagation_targets: ['Cookie', 'Authorization', 'X-CSRF-TOKEN', 'X-XSRF-TOKEN'],
      extractor_candidates: ['set-cookie', 'data.token', 'access_token', 'token', 'csrf_token', '_token', 'X-CSRF-TOKEN'],
      reuse_policy: 'Every workflow-capable sub-agent should reuse this strategy unless it has stronger evidence.',
    },
  });
  created.push(sessionStrategy);

  const vulnTypes = Array.from(new Set([...(selected || []), ...candidates.map(candidate => candidate.vuln_type), 'email_sms_bypass', 'passcode_bypass'].filter(Boolean))).filter(Boolean);
  for (const vulnType of vulnTypes) {
    const payloads = payloadsForVulnType(vulnType);
    created.push(await repo.upsertSharedResource({
      scan_run_id: scanRunId,
      resource_type: 'payload_plan',
      resource_key: vulnType,
      title: `Reusable payload plan for ${vulnType}`,
      owner_task_id: taskId,
      content_json: {
        vuln_type: vulnType,
        payload_count: payloads.length,
        payloads,
        reuse_policy: 'Use this payload plan to create BSTG security_rules/checklists once per campaign or per compatible endpoint class, not by ad hoc per sub-agent guessing.',
      },
    }));
  }

  const objectEndpoints = endpoints.filter(endpoint => /\b(id|user|order|wallet|transfer|withdraw|file|address|record|cart|payment|trade|sms|email|otp|passcode|paypwd)\b/i.test(endpointText(endpoint))).slice(0, 120);
  created.push(await repo.upsertSharedResource({
    scan_run_id: scanRunId,
    resource_type: 'object_inventory',
    resource_key: 'observed-object-and-owner-fields',
    title: 'Observed object IDs, owner fields and business object surfaces',
    owner_task_id: taskId,
    content_json: {
      purpose: 'Shared by access-control, BOLA, BFLA and business-logic sub-agents for object ownership reasoning.',
      endpoint_ids: objectEndpoints.map(endpoint => endpoint.id),
      object_field_candidates: ['id', 'user_id', 'uid', 'order_id', 'wallet_id', 'file_id', 'address_id', 'record_id', 'cart_id', 'otp_ticket', 'captcha_key', 'email_code_id', 'sms_code_id', 'passcode_verified'],
      endpoints: objectEndpoints.map(endpoint => ({ id: endpoint.id, method: endpoint.method, path: endpoint.path, feature_guess: endpoint.feature_guess })),
      reuse_policy: 'Sub-agents should reuse observed object candidates and enrich this resource after extracting real object values.',
    },
  }));

  for (const candidate of candidates) {
    const feature = features.find(item => item.id === candidate.feature_id);
    const functionName = feature?.name || candidate.title || candidate.vuln_type;
    const key = `${candidate.vuln_type}:${normalizeFunctionKey(functionName)}`;
    created.push(await repo.upsertSharedResource({
      scan_run_id: scanRunId,
      resource_type: 'feature_attack_context',
      resource_key: key,
      title: `${candidate.vuln_type} shared attack context for ${functionName}`,
      owner_task_id: taskId,
      content_json: {
        vuln_type: candidate.vuln_type,
        feature_id: candidate.feature_id,
        function_name: functionName,
        candidate_id: candidate.id,
        endpoint_ids: candidate.endpoint_ids,
        requires_identity_context: hasIdentityNeed(candidate.vuln_type),
        shared_resource_refs: {
          identity_pool: 'identity_pool:default-attacker-victim-admin',
          login_flow: hasIdentityNeed(candidate.vuln_type) ? 'workflow_blueprint:canonical-login-session-flow' : undefined,
          session_strategy: hasIdentityNeed(candidate.vuln_type) ? 'session_strategy:default-session-jar-and-token-propagation' : undefined,
          payload_plan: `payload_plan:${candidate.vuln_type}`,
          object_inventory: hasIdentityNeed(candidate.vuln_type) ? 'object_inventory:observed-object-and-owner-fields' : undefined,
        },
      },
    }));
  }

  const resources = await repo.listSharedResources(scanRunId);
  if ((accountConfig.input_modes.autonomous_registration && !accountConfig.input_modes.auto_executed_registration) || accountConfig.input_modes.human_assisted_registration) {
    await repo.createArtifact({
      scan_run_id: scanRunId,
      task_id: taskId,
      artifact_type: 'human_input_request',
      title: '测试账号/验证码/注册流程需要用户协助',
      content_json: {
        request_type: 'account_or_otp_assistance',
        message: 'AI 可以继续用浏览器探索注册/登录流程；如果遇到手机号、邮箱验证码、短信验证码或支付密码，需要用户在右侧浏览器或表单里提供测试信息。',
        expected_inputs: ['attacker/victim/admin account', 'phone/email for registration', 'SMS/email OTP', 'passcode if test-owned'],
        account_config: accountConfig,
      },
    });
  }

  const summary = {
    total_resources: resources.length,
    by_type: resources.reduce<Record<string, number>>((acc, resource) => {
      acc[resource.resource_type] = (acc[resource.resource_type] || 0) + 1;
      return acc;
    }, {}),
    login_blueprint_steps: loginEndpoints.length,
    payload_plans: vulnTypes.length,
    object_context_endpoints: objectEndpoints.length,
  };
  await repo.createArtifact({
    scan_run_id: scanRunId,
    task_id: taskId,
    artifact_type: 'agent_shared_context_inventory',
    title: 'Reusable cross-agent context inventory',
    content_json: { summary, resources: resources.map(resource => ({ id: resource.id, type: resource.resource_type, key: resource.resource_key, title: resource.title, usage_count: resource.usage_count, content_json: resource.content_json })) },
  });
  return { resources, summary };
}

export async function getSharedLoginEndpointIds(repo: AIScanRepository, scanRunId: string): Promise<string[]> {
  const login = await repo.getSharedResource(scanRunId, 'workflow_blueprint', 'canonical-login-session-flow');
  return Array.isArray(login?.content_json?.endpoint_ids) ? login.content_json.endpoint_ids.map(String) : [];
}

export async function markSharedResourcesUsed(input: {
  repo: AIScanRepository;
  scanRunId: string;
  refs: string[];
}): Promise<void> {
  for (const ref of input.refs) {
    const [resourceType, ...rest] = String(ref).split(':');
    const resourceKey = rest.join(':');
    if (resourceType && resourceKey) await input.repo.touchSharedResource(input.scanRunId, resourceType, resourceKey).catch(() => undefined);
  }
}
