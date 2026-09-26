import type { DbProvider } from '../../types/index.js';
import type { AIScanRepository } from './repository.js';
import { discoverTargetFromHttp, extractForms, type BrowserFormObservation, type BrowserInputObservation, type DiscoveredHttpEndpoint } from './browser-discovery.js';
import { fetchInTargetScope } from './target-scope.js';

export interface AutoAccountBootstrapResult {
  ok: boolean;
  mode: 'http_form' | 'api_json' | 'blocked' | 'not_found' | 'partial';
  closure_state: 'closed' | 'blocked_needs_user_material' | 'not_attemptable' | 'partial';
  requested_roles: string[];
  created_accounts: Array<Record<string, any>>;
  attempts: Array<Record<string, any>>;
  blockers: Array<Record<string, any>>;
  warnings: string[];
  required_user_materials?: Array<Record<string, any>>;
}

interface CredentialSet {
  role: string;
  username: string;
  email: string;
  phone: string;
  password: string;
  displayName: string;
}

interface CookieJar {
  header(): string;
  absorb(headers: Headers): void;
  absorbCookieObject(cookies: Record<string, string>): void;
  snapshot(): Record<string, string>;
}

function createCookieJar(seed: Record<string, string> = {}): CookieJar {
  const jar = new Map<string, string>(Object.entries(seed || {}));
  return {
    header() {
      return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
    },
    absorb(headers: Headers) {
      const rawValues = typeof (headers as any).getSetCookie === 'function'
        ? (headers as any).getSetCookie()
        : [headers.get('set-cookie')].filter(Boolean);
      for (const raw of rawValues) {
        for (const item of splitSetCookieHeader(String(raw || ''))) {
          const first = item.split(';')[0] || '';
          const eq = first.indexOf('=');
          if (eq <= 0) continue;
          jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
        }
      }
    },
    absorbCookieObject(cookies: Record<string, string>) {
      for (const [key, value] of Object.entries(cookies || {})) jar.set(key, value);
    },
    snapshot() {
      return Object.fromEntries(jar.entries());
    },
  };
}

function splitSetCookieHeader(value: string): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,\s]+=)/g).map(item => item.trim()).filter(Boolean);
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/[^a-z0-9]+/gi, '').slice(0, 24).toLowerCase() || 'target';
  } catch {
    return 'target';
  }
}

function credentialFor(baseUrl: string, scanRunId: string, role: string, index: number, overrides: Record<string, any> = {}): CredentialSet {
  const suffix = `${safeHost(baseUrl)}_${scanRunId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || Date.now().toString(36)}_${index}`.toLowerCase();
  const username = String(overrides[`${role}_username`] || overrides.username || `bstg_${role}_${suffix}`).slice(0, 64);
  const email = String(overrides[`${role}_email`] || overrides.email || `${username}@bstg.local.test`).slice(0, 128);
  const password = String(overrides[`${role}_password`] || overrides.password || `Bstg!${suffix}${index}Aa1`).slice(0, 96);
  const phone = String(overrides[`${role}_phone`] || overrides.phone || `188${String(index + 10000000).slice(0, 8)}`);
  return {
    role,
    username,
    email,
    phone,
    password,
    displayName: String(overrides[`${role}_display_name`] || overrides.display_name || `BSTG ${role}`),
  };
}

function formText(form: BrowserFormObservation): string {
  return `${form.method} ${form.action} ${form.source_url} ${form.label || ''} ${form.inputs.map(input => `${input.name || ''} ${input.type || ''} ${input.placeholder || ''}`).join(' ')}`.toLowerCase();
}

function isRegisterForm(form: BrowserFormObservation): boolean {
  const text = formText(form);
  const hasPassword = form.inputs.some(input => /password/i.test(`${input.name || ''} ${input.type || ''} ${input.placeholder || ''}`));
  const hasIdentity = form.inputs.some(input => /(email|mail|user|account|mobile|phone|tel|用户名|邮箱|手机)/i.test(`${input.name || ''} ${input.placeholder || ''}`));
  const registerHint = /(register|signup|sign-up|create.?account|join|注册|创建账号|新用户)/i.test(text);
  const loginHint = /(login|signin|sign-in|登录)/i.test(text);
  const confirmPassword = form.inputs.some(input => /(confirm|repeat|again|确认)/i.test(`${input.name || ''} ${input.placeholder || ''}`));
  return Boolean(registerHint || (hasPassword && hasIdentity && confirmPassword && !loginHint));
}

function isLoginForm(form: BrowserFormObservation): boolean {
  const text = formText(form);
  const hasPassword = form.inputs.some(input => /password/i.test(`${input.name || ''} ${input.type || ''} ${input.placeholder || ''}`));
  const hasIdentity = form.inputs.some(input => /(email|mail|user|account|mobile|phone|tel|用户名|邮箱|手机)/i.test(`${input.name || ''} ${input.placeholder || ''}`));
  const loginHint = /(login|signin|sign-in|auth|session|登录|登入)/i.test(text);
  return Boolean(hasPassword && hasIdentity && loginHint && !isRegisterForm(form));
}

function hasAutomationBlocker(form: BrowserFormObservation): { blocked: boolean; fields: string[] } {
  const fields = form.inputs
    .map(input => `${input.name || ''} ${input.type || ''} ${input.placeholder || ''}`.trim())
    .filter(value => /(captcha|verify.?code|verification.?code|sms|otp|mfa|2fa|image.?code|验证码|短信|动态码)/i.test(value));
  return { blocked: fields.length > 0, fields };
}

function normalizeInputType(input: BrowserInputObservation): string {
  return String(input.type || 'text').toLowerCase();
}

function valueForInput(input: BrowserInputObservation, credentials: CredentialSet, phase: 'register' | 'login', overrides: Record<string, any>): string | null {
  const name = String(input.name || '').trim();
  const type = normalizeInputType(input);
  const hint = `${name} ${type} ${input.placeholder || ''}`.toLowerCase();
  if (!name) return null;
  if (['submit', 'button', 'reset', 'file', 'image'].includes(type)) return null;
  if (overrides[name] !== undefined) return String(overrides[name]);
  if (type === 'hidden' && input.value !== undefined) return String(input.value);
  if (/csrf|xsrf|token|nonce|state|authenticity/.test(hint) && input.value !== undefined) return String(input.value);
  if (/confirm|repeat|again|确认/.test(hint)) return credentials.password;
  if (/password|passwd|pwd|密码/.test(hint)) return credentials.password;
  if (/email|mail|邮箱|邮件/.test(hint)) return credentials.email;
  if (/mobile|phone|tel|手机号|手机|电话/.test(hint)) return credentials.phone;
  if (/display|nick|real.?name|nickname|full.?name|姓名|昵称/.test(hint)) return credentials.displayName;
  if (/user(name)?|account|login|name|用户名|账号/.test(hint)) return credentials.username;
  if (/role|type|角色/.test(hint)) return credentials.role;
  if (/agree|terms|privacy|policy|tos|协议/.test(hint)) return input.value || 'on';
  if (/captcha|verify.?code|verification.?code|sms|otp|mfa|2fa|image.?code|验证码|短信|动态码/.test(hint)) {
    return overrides[name] !== undefined ? String(overrides[name]) : null;
  }
  if (type === 'checkbox') return input.value || 'on';
  if (type === 'radio') return input.value || 'on';
  if (type === 'select' && input.value !== undefined) return String(input.value);
  if (phase === 'register' && !input.value) return credentials.username;
  return input.value !== undefined ? String(input.value) : '';
}

function buildFormValues(form: BrowserFormObservation, credentials: CredentialSet, phase: 'register' | 'login', overrides: Record<string, any>): URLSearchParams {
  const params = new URLSearchParams();
  for (const input of form.inputs) {
    const value = valueForInput(input, credentials, phase, overrides);
    if (value === null) continue;
    params.set(String(input.name), value);
  }
  return params;
}

async function fetchPageWithJar(url: string, jar: CookieJar, scopeBaseUrl: string): Promise<{ ok: boolean; status: number; url: string; html: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = { 'User-Agent': 'BSTG-AI-Agent/1.0' };
  const cookieHeader = jar.header();
  if (cookieHeader) headers.Cookie = cookieHeader;
  const response = await fetchInTargetScope(url, { method: 'GET', headers }, scopeBaseUrl, { on_response: response => jar.absorb(response.headers) });
  const html = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, url: response.url, html, headers: Object.fromEntries(response.headers.entries()) };
}

function scoreFreshForm(candidate: BrowserFormObservation, original: BrowserFormObservation, phase: 'register' | 'login'): number {
  let score = 0;
  const normalized = (value: string) => {
    try { return new URL(value).pathname.toLowerCase(); } catch { return String(value || '').toLowerCase(); }
  };
  if (candidate.method === original.method) score += 2;
  if (normalized(candidate.action) === normalized(original.action)) score += 5;
  if (phase === 'register' && isRegisterForm(candidate)) score += 4;
  if (phase === 'login' && isLoginForm(candidate)) score += 4;
  const originalNames = new Set(original.inputs.map(input => input.name).filter(Boolean));
  for (const input of candidate.inputs) if (input.name && originalNames.has(input.name)) score += 0.2;
  return score;
}

async function refreshForm(original: BrowserFormObservation, jar: CookieJar, phase: 'register' | 'login', scopeBaseUrl: string): Promise<BrowserFormObservation> {
  const page = await fetchPageWithJar(original.source_url || original.action, jar, scopeBaseUrl);
  if (!page.ok || !page.html) return original;
  const forms = extractForms(page.html, page.url || original.source_url || original.action);
  if (forms.length === 0) return original;
  return forms.sort((a, b) => scoreFreshForm(b, original, phase) - scoreFreshForm(a, original, phase))[0] || original;
}

async function submitForm(form: BrowserFormObservation, values: URLSearchParams, jar: CookieJar, scopeBaseUrl: string, phase: 'register' | 'login'): Promise<{ ok: boolean; status: number; url: string; body: string; headers: Record<string, string> }> {
  const method = String(form.method || 'GET').toUpperCase();
  const target = new URL(form.action || form.source_url);
  const headers: Record<string, string> = { 'User-Agent': 'BSTG-AI-Agent/1.0', Referer: form.source_url };
  const cookieHeader = jar.header();
  if (cookieHeader) headers.Cookie = cookieHeader;
  const init: RequestInit = { method, headers };
  if (method === 'GET') {
    for (const [key, value] of values.entries()) target.searchParams.set(key, value);
  } else {
    headers['Content-Type'] = /multipart\/form-data/i.test(form.enctype || '') ? 'application/x-www-form-urlencoded' : 'application/x-www-form-urlencoded';
    init.body = values.toString();
  }
  const response = await fetchInTargetScope(target.toString(), init, scopeBaseUrl, { on_response: response => jar.absorb(response.headers), traffic_class: phase === 'register' ? 'account_creation' : 'mutation' });
  const body = await response.text().catch(() => '');
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    body: body.slice(0, 20000),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function failureLike(body: string): boolean {
  return /(invalid|incorrect|failed|failure|error|denied|forbidden|captcha|csrf|token|验证码错误|密码错误|失败|错误|无效|不正确|已存在|令牌|过期)/i.test(body || '');
}

function loginSuccess(result: { ok: boolean; url: string; body: string }, loginForm: BrowserFormObservation, jar: CookieJar): boolean {
  const cookieCount = Object.keys(jar.snapshot()).length;
  const loginPath = (() => {
    try { return new URL(loginForm.action).pathname; } catch { return ''; }
  })();
  const currentPath = (() => {
    try { return new URL(result.url).pathname; } catch { return ''; }
  })();
  if (!result.ok || failureLike(result.body)) return false;
  if (/(logout|sign.?out|dashboard|profile|account|我的|退出|个人中心|控制台)/i.test(result.body)) return true;
  if (cookieCount > 0 && currentPath !== loginPath) return true;
  return cookieCount > 0 && !/(login|signin|登录)/i.test(currentPath);
}

function extractAuthMaterial(result: { body: string; headers: Record<string, string> }, jar: CookieJar): Record<string, any> {
  const auth: Record<string, any> = { cookies: jar.snapshot() };
  const authorization = result.headers.authorization || result.headers.Authorization;
  if (authorization) auth.auth_token = authorization;
  try {
    const json = JSON.parse(result.body);
    for (const key of ['token', 'access_token', 'auth_token', 'jwt', 'session', 'csrf', 'csrf_token', 'user_id', 'id']) {
      if (json?.[key] !== undefined) auth[key] = json[key];
      if (json?.data?.[key] !== undefined) auth[key] = json.data[key];
    }
  } catch {
    const token = result.body.match(/(?:access_token|auth_token|token|csrf)["'\s:=]+([A-Za-z0-9._\-]+)/i)?.[1];
    if (token) auth.auth_token = token;
  }
  return auth;
}

function materialRequestForBlockers(blockers: Array<Record<string, any>>, options: { reason?: string; baseUrl: string; roles: string[]; observedForms?: BrowserFormObservation[]; observedApis?: DiscoveredHttpEndpoint[] }): Record<string, any> {
  const reason = options.reason || blockers[0]?.reason || 'account_auto_bootstrap_blocked';
  const expectedInputs = [
    { key: 'attacker_account', required: true, fields: ['username/email/phone', 'password', 'Cookie or Authorization token after login'] },
    { key: 'victim_account', required: true, fields: ['username/email/phone', 'password', 'Cookie or Authorization token after login', 'one owned object id if BOLA/IDOR testing is required'] },
    { key: 'admin_or_privileged_account', required: false, fields: ['username/email/phone', 'password', 'Cookie or Authorization token', 'admin/back-office URL if BFLA testing is required'] },
    { key: 'otp_captcha_passcode_material', required: false, fields: ['test OTP/SMS/email code', 'captcha bypass/fixed value in test env', 'payment/passcode if passcode testing is in scope'] },
    { key: 'raw_login_packets', required: false, fields: ['complete login request/response', 'CSRF/XSRF token source', 'Set-Cookie/Authorization header'] },
  ];
  return {
    request_type: 'account_closure_materials',
    closure_state: 'blocked_needs_user_material',
    reason,
    target: options.baseUrl,
    requested_roles: options.roles,
    blockers,
    expected_inputs: expectedInputs,
    fallback_modes: ['Requests', 'Accounts', 'manual assisted browser'],
    observed_forms: (options.observedForms || []).map(form => ({ action: form.action, method: form.method, source_url: form.source_url, inputs: form.inputs.map(field => ({ name: field.name, type: field.type, placeholder: field.placeholder })) })).slice(0, 20),
    observed_api_candidates: (options.observedApis || []).map(api => ({ method: api.method, url: api.url, path: api.path, source_type: api.source_type, request_summary: api.request_summary })).slice(0, 20),
  };
}

async function saveAccount(db: DbProvider, input: {
  baseUrl: string;
  scanRunId: string;
  credentials: CredentialSet;
  authMaterial: Record<string, any>;
  registrationUrl?: string;
  loginUrl?: string;
  accountMode: string;
}): Promise<Record<string, any>> {
  const fields = {
    username: input.credentials.username,
    email: input.credentials.email,
    phone: input.credentials.phone,
    password: input.credentials.password,
    role: input.credentials.role,
    base_url: input.baseUrl,
    registration_url: input.registrationUrl,
    login_url: input.loginUrl,
    ...input.authMaterial,
  };
  const account = await db.repos.accounts.create({
    name: `AI Scan ${input.credentials.role} ${safeHost(input.baseUrl)}`,
    username: input.credentials.username,
    display_name: input.credentials.displayName,
    status: 'active',
    tags: ['ai_scan', 'ai_scan_autocreated', `scan:${input.scanRunId}`, `role:${input.credentials.role}`, input.accountMode],
    auth_profile: {
      type: 'ai_scan_auto_registration',
      account_mode: input.accountMode,
      session_cookie_keys: Object.keys(input.authMaterial.cookies || {}),
      created_by_scan_run_id: input.scanRunId,
    },
    variables: {},
    fields,
    notes: `Auto-created by AI Scan account bootstrap for ${input.baseUrl}. Use only on test-owned targets.`,
  } as any);
  return { id: account.id, name: account.name, username: account.username, role: input.credentials.role, fields };
}

function isRegisterApiEndpoint(endpoint: DiscoveredHttpEndpoint): boolean {
  const text = `${endpoint.method} ${endpoint.path} ${endpoint.url} ${endpoint.request_summary || ''}`.toLowerCase();
  return endpoint.method.toUpperCase() !== 'GET' && /(register|signup|sign-up|create.?account|join|注册)/i.test(text);
}

function isLoginApiEndpoint(endpoint: DiscoveredHttpEndpoint): boolean {
  const text = `${endpoint.method} ${endpoint.path} ${endpoint.url} ${endpoint.request_summary || ''}`.toLowerCase();
  return endpoint.method.toUpperCase() !== 'GET' && /(login|signin|sign-in|auth|session|token|登录)/i.test(text) && !isRegisterApiEndpoint(endpoint);
}

function jsonPayload(credentials: CredentialSet, phase: 'register' | 'login', overrides: Record<string, any>): Record<string, any> {
  const payload: Record<string, any> = {
    username: credentials.username,
    email: credentials.email,
    password: credentials.password,
  };
  if (phase === 'register') {
    payload.phone = credentials.phone;
    payload.password_confirmation = credentials.password;
    payload.confirm_password = credentials.password;
    payload.display_name = credentials.displayName;
    payload.role = credentials.role;
  }
  return { ...payload, ...(overrides.json_payload || {}), ...(overrides[`${phase}_json_payload`] || {}) };
}

async function submitJsonEndpoint(endpoint: DiscoveredHttpEndpoint, payload: Record<string, any>, jar: CookieJar, referer: string, scopeBaseUrl: string, phase: 'register' | 'login'): Promise<{ ok: boolean; status: number; url: string; body: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = { 'User-Agent': 'BSTG-AI-Agent/1.0', 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', Referer: referer };
  const cookieHeader = jar.header();
  if (cookieHeader) headers.Cookie = cookieHeader;
  const response = await fetchInTargetScope(endpoint.url, { method: endpoint.method.toUpperCase(), headers, body: JSON.stringify(payload) }, scopeBaseUrl, { on_response: response => jar.absorb(response.headers), traffic_class: phase === 'register' ? 'account_creation' : 'mutation' });
  const body = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, url: response.url, body: body.slice(0, 20000), headers: Object.fromEntries(response.headers.entries()) };
}

async function publishResult(input: {
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  baseUrl: string;
  result: AutoAccountBootstrapResult;
  title?: string;
  humanRequest?: Record<string, any>;
}): Promise<void> {
  if (input.humanRequest) {
    await input.repo.createArtifact({
      scan_run_id: input.scanRunId,
      task_id: input.taskId,
      artifact_type: 'human_input_request',
      title: '账号自动闭环被阻断：需要用户提供测试账号/会话材料',
      content_json: input.humanRequest,
      source_ref: input.baseUrl,
    });
  }
  await input.repo.createArtifact({
    scan_run_id: input.scanRunId,
    task_id: input.taskId,
    artifact_type: 'account_auto_bootstrap_result',
    title: input.title || (input.result.created_accounts.length > 0 ? `自动账号注册登录闭环完成：${input.result.created_accounts.length} 个账号` : '自动账号注册登录闭环未创建账号'),
    content_json: input.result as unknown as Record<string, any>,
    source_ref: input.baseUrl,
  });
}

async function upsertIdentityPool(input: { repo: AIScanRepository; scanRunId: string; taskId?: string; accountMode?: string; createdAccounts: Array<Record<string, any>>; attempts: Array<Record<string, any>>; blockers: Array<Record<string, any>> }): Promise<void> {
  await input.repo.upsertSharedResource({
    scan_run_id: input.scanRunId,
    resource_type: 'identity_pool',
    resource_key: 'auto-executed-registration-accounts',
    title: 'Auto-executed registration/login identity pool',
    owner_task_id: input.taskId,
    content_json: {
      purpose: 'Accounts created by the default auto account execution mode. Reuse these attacker/victim/admin sessions before asking the user for manual accounts.',
      account_mode: input.accountMode || 'auto_execute',
      closure_state: input.createdAccounts.length > 0 ? 'closed_or_partial' : 'blocked_needs_user_material',
      created_accounts: input.createdAccounts.map(account => ({ id: account.id, username: account.username, role: account.role, cookie_keys: Object.keys(account.fields?.cookies || {}), has_auth_token: Boolean(account.fields?.auth_token || account.fields?.access_token || account.fields?.token) })),
      attempts: input.attempts,
      blockers: input.blockers,
    },
  });
}

export async function bootstrapAutoAccounts(input: {
  db: DbProvider;
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  baseUrl: string;
  roles?: string[];
  maxPages?: number;
  formValueOverrides?: Record<string, any>;
  accountMode?: string;
  manualAccounts?: Record<string, any>;
}): Promise<AutoAccountBootstrapResult> {
  const roles = (input.accountMode === 'manual' ? Object.keys(input.manualAccounts || {}) : input.roles?.length ? input.roles : ['attacker', 'victim', 'admin']).map(String);
  const attempts: Array<Record<string, any>> = [];
  const blockers: Array<Record<string, any>> = [];
  const warnings: string[] = [];
  const createdAccounts: Array<Record<string, any>> = [];
  const overrides = input.formValueOverrides || {};
  const discovery = await discoverTargetFromHttp(input.baseUrl, { max_pages: input.maxPages || 40 });
  const forms = discovery.observations.flatMap(observation => observation.forms);
  const registerForms = forms.filter(isRegisterForm);
  const loginForms = forms.filter(isLoginForm);
  const registerApis = discovery.endpoints.filter(isRegisterApiEndpoint);
  const loginApis = discovery.endpoints.filter(isLoginApiEndpoint);
  warnings.push(...discovery.warnings);

  const humanAndReturn = async (result: AutoAccountBootstrapResult, reason: string, title: string) => {
    const humanRequest = materialRequestForBlockers(result.blockers, { reason, baseUrl: input.baseUrl, roles, observedForms: forms, observedApis: [...registerApis, ...loginApis] });
    result.required_user_materials = humanRequest.expected_inputs;
    await publishResult({ repo: input.repo, scanRunId: input.scanRunId, taskId: input.taskId, baseUrl: input.baseUrl, result, title, humanRequest });
    await upsertIdentityPool({ repo: input.repo, scanRunId: input.scanRunId, taskId: input.taskId, accountMode: input.accountMode, createdAccounts, attempts, blockers });
    return result;
  };

  if(input.accountMode==='manual') {
    for(const [index,role] of roles.entries()) {
      const supplied=input.manualAccounts?.[role]||{};
      const existing=(await input.db.repos.accounts.findAll()).find(a=>a.tags?.includes(`scan:${input.scanRunId}`)&&a.tags?.includes(`role:${role}`)&&(a.fields?.auth_token||Object.keys(a.fields?.cookies||{}).length));
      if(existing){createdAccounts.push({...existing,role});continue;}
      if(!supplied.username || !supplied.password){blockers.push({role,reason:'missing_manual_credentials'});continue;}
      const credentials=credentialFor(input.baseUrl,input.scanRunId,role,index+1,supplied),jar=createCookieJar();
      try {
        if(!loginForms.length){blockers.push({role,reason:'login_form_not_found',message:'未识别标准登录表单，请提供已登录请求或适配登录场景。'});continue;}
        const form=await refreshForm(loginForms[0],jar,'login',input.baseUrl);
        const blocked=hasAutomationBlocker(form);
        if(blocked.blocked){blockers.push({role,reason:'otp_captcha_mfa_field_present',fields:blocked.fields});continue;}
        const values=buildFormValues(form,credentials,'login',supplied);
        const login=await submitForm(form,values,jar,input.baseUrl,'login');
        const ok=loginSuccess(login,form,jar);
        attempts.push({role,phase:'login',ok,status:login.status});
        if(!ok){blockers.push({role,reason:'login_failed_or_session_not_observed'});continue;}
        createdAccounts.push(await saveAccount(input.db,{baseUrl:input.baseUrl,scanRunId:input.scanRunId,credentials,
          authMaterial:{...supplied,...extractAuthMaterial(login,jar)},loginUrl:form.action,accountMode:'manual'}));
      }catch(error:any){blockers.push({role,reason:'login_failed',message:error.message});}
    }
    const result:AutoAccountBootstrapResult={ok:true,mode:createdAccounts.length?'http_form':'blocked',closure_state:createdAccounts.length===roles.length&&roles.length>0?'closed':createdAccounts.length?'partial':'blocked_needs_user_material',requested_roles:roles,created_accounts:createdAccounts,attempts,blockers,warnings};
    if(result.closure_state!=='closed')return humanAndReturn(result,'manual_login_incomplete','提供的账号未全部建立有效登录状态');
    await upsertIdentityPool({repo:input.repo,scanRunId:input.scanRunId,taskId:input.taskId,accountMode:'manual',createdAccounts,attempts,blockers});
    await publishResult({repo:input.repo,scanRunId:input.scanRunId,taskId:input.taskId,baseUrl:input.baseUrl,result,title:'测试账号登录状态已建立'});
    return result;
  }

  if (registerForms.length > 0 && loginForms.length > 0) {
    const registerBlocker = hasAutomationBlocker(registerForms[0]);
    const loginBlocker = hasAutomationBlocker(loginForms[0]);
    if ((registerBlocker.blocked || loginBlocker.blocked) && !overrides.allow_blocked_form_submission) {
      blockers.push(
        ...(registerBlocker.blocked ? [{ phase: 'register', reason: 'otp_captcha_mfa_field_present', fields: registerBlocker.fields }] : []),
        ...(loginBlocker.blocked ? [{ phase: 'login', reason: 'otp_captcha_mfa_field_present', fields: loginBlocker.fields }] : []),
      );
      return humanAndReturn({ ok: true, mode: 'blocked', closure_state: 'blocked_needs_user_material', requested_roles: roles, created_accounts: [], attempts, blockers, warnings }, 'otp_captcha_mfa_field_present', '自动账号注册登录闭环被二次校验阻断');
    }

    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index];
      const credentials = credentialFor(input.baseUrl, input.scanRunId, role, index + 1, overrides);
      const jar = createCookieJar();
      try {
        const registerForm = await refreshForm(registerForms[0], jar, 'register', input.baseUrl);
        const registrationValues = buildFormValues(registerForm, credentials, 'register', overrides);
        const registration = await submitForm(registerForm, registrationValues, jar, input.baseUrl, 'register');
        const registrationOk = registration.ok && !failureLike(registration.body);
        attempts.push({ role, mode: 'http_form', phase: 'register', ok: registrationOk, status: registration.status, url: registration.url, submitted_fields: [...registrationValues.keys()], cookie_keys: Object.keys(jar.snapshot()) });
        if (!registrationOk) {
          blockers.push({ role, mode: 'http_form', phase: 'register', reason: 'registration_failed_or_rejected', status: registration.status, url: registration.url, response_excerpt: registration.body.slice(0, 500) });
          continue;
        }

        const loginForm = await refreshForm(loginForms[0], jar, 'login', input.baseUrl);
        const loginValues = buildFormValues(loginForm, credentials, 'login', overrides);
        const login = await submitForm(loginForm, loginValues, jar, input.baseUrl, 'login');
        const loggedIn = loginSuccess(login, loginForm, jar);
        attempts.push({ role, mode: 'http_form', phase: 'login', ok: loggedIn, status: login.status, url: login.url, submitted_fields: [...loginValues.keys()], cookie_keys: Object.keys(jar.snapshot()) });
        if (!loggedIn) {
          blockers.push({ role, mode: 'http_form', phase: 'login', reason: 'login_failed_or_session_not_observed', status: login.status, url: login.url, response_excerpt: login.body.slice(0, 500) });
          continue;
        }

        const saved = await saveAccount(input.db, {
          baseUrl: input.baseUrl,
          scanRunId: input.scanRunId,
          credentials,
          authMaterial: extractAuthMaterial(login, jar),
          registrationUrl: registerForm.action,
          loginUrl: loginForm.action,
          accountMode: input.accountMode || 'auto_execute',
        });
        createdAccounts.push(saved);
      } catch (error: any) {
        blockers.push({ role, mode: 'http_form', reason: 'exception', message: error.message || String(error) });
      }
    }
  } else if (registerApis.length > 0 && loginApis.length > 0) {
    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index];
      const credentials = credentialFor(input.baseUrl, input.scanRunId, role, index + 1, overrides);
      const jar = createCookieJar();
      try {
        const registration = await submitJsonEndpoint(registerApis[0], jsonPayload(credentials, 'register', overrides), jar, input.baseUrl, input.baseUrl, 'register');
        const registrationOk = registration.ok && !failureLike(registration.body);
        attempts.push({ role, mode: 'api_json', phase: 'register', ok: registrationOk, status: registration.status, url: registration.url, cookie_keys: Object.keys(jar.snapshot()) });
        if (!registrationOk) {
          blockers.push({ role, mode: 'api_json', phase: 'register', reason: 'registration_failed_or_rejected', status: registration.status, url: registration.url, response_excerpt: registration.body.slice(0, 500) });
          continue;
        }
        const login = await submitJsonEndpoint(loginApis[0], jsonPayload(credentials, 'login', overrides), jar, input.baseUrl, input.baseUrl, 'login');
        const auth = extractAuthMaterial(login, jar);
        const loggedIn = login.ok && !failureLike(login.body) && (Object.keys(auth.cookies || {}).length > 0 || Boolean(auth.auth_token || auth.access_token || auth.token || auth.jwt || auth.session));
        attempts.push({ role, mode: 'api_json', phase: 'login', ok: loggedIn, status: login.status, url: login.url, cookie_keys: Object.keys(jar.snapshot()) });
        if (!loggedIn) {
          blockers.push({ role, mode: 'api_json', phase: 'login', reason: 'login_failed_or_session_not_observed', status: login.status, url: login.url, response_excerpt: login.body.slice(0, 500) });
          continue;
        }
        const saved = await saveAccount(input.db, {
          baseUrl: input.baseUrl,
          scanRunId: input.scanRunId,
          credentials,
          authMaterial: auth,
          registrationUrl: registerApis[0].url,
          loginUrl: loginApis[0].url,
          accountMode: input.accountMode || 'auto_execute',
        });
        createdAccounts.push(saved);
      } catch (error: any) {
        blockers.push({ role, mode: 'api_json', reason: 'exception', message: error.message || String(error) });
      }
    }
  } else {
    blockers.push({ reason: 'register_or_login_entrypoint_not_found', register_forms: registerForms.length, login_forms: loginForms.length, register_api_candidates: registerApis.length, login_api_candidates: loginApis.length });
    return humanAndReturn({ ok: true, mode: 'not_found', closure_state: 'not_attemptable', requested_roles: roles, created_accounts: [], attempts, blockers, warnings }, 'register_or_login_entrypoint_not_found', '自动账号注册登录闭环未执行：未找到可自动执行的注册或登录入口');
  }

  const closureState: AutoAccountBootstrapResult['closure_state'] = createdAccounts.length >= roles.length ? 'closed' : (createdAccounts.length > 0 ? 'partial' : 'blocked_needs_user_material');
  const result: AutoAccountBootstrapResult = {
    ok: true,
    mode: registerForms.length > 0 && loginForms.length > 0 ? 'http_form' : 'api_json',
    closure_state: closureState,
    requested_roles: roles,
    created_accounts: createdAccounts,
    attempts,
    blockers,
    warnings,
  };
  if (closureState === 'blocked_needs_user_material' || closureState === 'partial') {
    return humanAndReturn(result, 'account_auto_bootstrap_incomplete', createdAccounts.length > 0 ? '自动账号注册登录闭环部分完成：仍需用户补充账号材料' : '自动账号注册登录闭环未创建账号：需要用户补充账号材料');
  }
  await upsertIdentityPool({ repo: input.repo, scanRunId: input.scanRunId, taskId: input.taskId, accountMode: input.accountMode, createdAccounts, attempts, blockers });
  await publishResult({ repo: input.repo, scanRunId: input.scanRunId, taskId: input.taskId, baseUrl: input.baseUrl, result, title: `自动账号注册登录闭环完成：${createdAccounts.length} 个账号` });
  return result;
}
