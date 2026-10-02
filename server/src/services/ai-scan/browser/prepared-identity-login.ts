/**
 * Trusted browser-side login primitive for a scan-owned prepared identity.
 *
 * This intentionally receives credentials only from server-side identity
 * material.  Its result contains authentication facts, never username,
 * password, cookies, token values, selector values, or page text.  It is used
 * both by discovery and by the normal-business learning capability so the two
 * paths execute the same real Playwright login behavior.
 */

import { normalizeAuthenticationOrigins } from './authentication-scope.js';

export interface PreparedBrowserIdentity {
  identity_key: string;
  username?: string;
  email?: string;
  phone?: string;
  password?: string;
}

export type PreparedIdentityLoginStatus =
  | 'authenticated'
  | 'credentials_unavailable'
  | 'login_form_not_found'
  | 'credential_form_ambiguous'
  | 'additional_verification_required'
  | 'credential_field_not_found'
  | 'submit_control_not_found'
  | 'credential_destination_not_allowed'
  | 'credential_network_guard_unavailable'
  | 'credential_network_blocked'
  | 'identity_binding_unavailable'
  | 'login_failed';

export interface PreparedIdentityLoginResult {
  authenticated: boolean;
  status: PreparedIdentityLoginStatus;
  login_submitted: boolean;
  session_changed: boolean;
  storage_token_observed: boolean;
  password_control_hidden_after_submit?: boolean;
}

const loginLabel = /login|log in|sign in|signin|登录/i;
const credentialBoundaryMarker = '__bstgPreparedCredentialBoundaryViolations';

/** A browser context is created before the model is allowed to navigate the
 * normal-flow page. Keep this boundary for the lifetime of that fresh task
 * context so page JavaScript never receives an unwrapped WebSocket constructor
 * before credentials are typed. */
interface PersistentCredentialBoundary {
  blocked: boolean;
  allowedOrigins: ReadonlySet<string>;
}

const persistentCredentialBoundaries = new WeakMap<object, PersistentCredentialBoundary>();

function usable(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function failed(status: Exclude<PreparedIdentityLoginStatus, 'authenticated'>, loginSubmitted = false): PreparedIdentityLoginResult {
  return {
    authenticated: false,
    status,
    login_submitted: loginSubmitted,
    session_changed: false,
    storage_token_observed: false,
  };
}

function credentialDestinationAllowed(value: unknown, origins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(String(value || ''));
    if (url.username || url.password) return false;
    const comparableOrigin = url.protocol === 'ws:' ? `http://${url.host}`
      : url.protocol === 'wss:' ? `https://${url.host}`
      : url.origin;
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && origins.has(comparableOrigin);
  } catch {
    return false;
  }
}

/** Resolve the actual form and submitter after every sensitive fill.  Page
 * scripts can change a form's action or a submitter's formaction in response
 * to input events, so checking only before entering credentials is not a
 * sufficient boundary. */
async function credentialFormDestinationAllowed(form: any, submit: any, origins: ReadonlySet<string>): Promise<boolean> {
  const [formAction, submitter] = await Promise.all([
    form.evaluate((element: any) => element.action || ''),
    submit.evaluate((element: any) => {
      const associated = element.form && element.closest('form') === element.form;
      const isSubmit = String(element.type || '').toLowerCase() === 'submit';
      return {
        associated: Boolean(associated && isSubmit),
        has_formaction: element.hasAttribute('formaction'),
        formaction: element.formAction || '',
      };
    }),
  ]);
  if (!submitter.associated || !credentialDestinationAllowed(formAction, origins)) return false;
  return !submitter.has_formaction || credentialDestinationAllowed(submitter.formaction, origins);
}

function credentialBoundaryInitScript(origins: string[]): string {
  // This runs before every document's own JavaScript.  Do not export the
  // native constructors or a reset function: scripts on the tested page must
  // not be able to recover an unguarded WebSocket after capturing it early.
  return `(() => {
    const marker = ${JSON.stringify(credentialBoundaryMarker)};
    if (Object.prototype.hasOwnProperty.call(globalThis, marker)) return;
    const allowed = new Set(${JSON.stringify(origins)});
    const state = { violations: 0 };
    const fail = () => { state.violations += 1; };
    const allowedSocket = (candidate) => {
      try {
        const url = new URL(String(candidate), globalThis.location?.href);
        if (url.username || url.password) return false;
        const origin = url.protocol === 'ws:' ? 'http://' + url.host
          : url.protocol === 'wss:' ? 'https://' + url.host : url.origin;
        return (url.protocol === 'ws:' || url.protocol === 'wss:') && allowed.has(origin);
      } catch { return false; }
    };
    const blocked = (message) => {
      fail();
      throw new DOMException(message, 'SecurityError');
    };
    try {
      Object.defineProperty(globalThis, marker, { configurable: false, enumerable: false, get: () => state.violations });
      const NativeWebSocket = globalThis.WebSocket;
      if (typeof NativeWebSocket !== 'function') throw new Error('WebSocket constructor unavailable');
      const GuardedWebSocket = function(url, protocols) {
        if (!allowedSocket(url)) return blocked('WebSocket is outside the prepared-credential origin boundary.');
        return arguments.length > 1 ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
      };
      Object.setPrototypeOf(GuardedWebSocket, NativeWebSocket);
      GuardedWebSocket.prototype = NativeWebSocket.prototype;
      Object.defineProperty(globalThis, 'WebSocket', { configurable: false, enumerable: true, writable: false, value: GuardedWebSocket });
      // A same-origin worker can otherwise retain a native WebSocket
      // constructor outside this document's guard. Normal prepared login does
      // not need workers; reject their creation rather than silently allowing
      // an unobservable network escape hatch.
      for (const name of ['Worker', 'SharedWorker']) {
        const NativeWorker = globalThis[name];
        if (typeof NativeWorker !== 'function') continue;
        const GuardedWorker = function() { return blocked(name + ' is disabled during prepared credential handling.'); };
        Object.setPrototypeOf(GuardedWorker, NativeWorker);
        GuardedWorker.prototype = NativeWorker.prototype;
        Object.defineProperty(globalThis, name, { configurable: false, enumerable: true, writable: false, value: GuardedWorker });
      }
      const container = globalThis.navigator?.serviceWorker;
      if (container && typeof container.register === 'function') {
        Object.defineProperty(container, 'register', { configurable: false, enumerable: false, writable: false,
          value: () => Promise.reject((fail(), new DOMException('Service workers are disabled during prepared credential handling.', 'SecurityError'))) });
      }
    } catch {
      // A page whose built-ins cannot be protected is not safe for prepared
      // credentials. The trusted caller reads this immutable marker and exits
      // without submitting the form.
      fail();
    }
  })();`;
}

/** Install the credential boundary while the task context is still blank,
 * before Agent-controlled navigation reaches the login page. The route stays
 * live until context close, so delayed fetch/XHR, ping/beacon, image and other
 * non-Document requests cannot resume after a failed credential transition. */
export async function installPersistentCredentialNetworkBoundary(input: {
  browser_context: any;
  base_url: string;
  authentication_origins?: string[];
}): Promise<void> {
  const browserContext = input.browser_context;
  if (!browserContext || typeof browserContext.route !== 'function' || typeof browserContext.addInitScript !== 'function') {
    throw new Error('Credential network guard is unavailable.');
  }
  if (persistentCredentialBoundaries.has(browserContext)) return;
  // An init script only protects documents created after it is registered.
  // Refuse to retrofit the guard onto an already navigated context: page code
  // may have cached a native WebSocket/Worker constructor before this call.
  const pages = typeof browserContext.pages === 'function' ? browserContext.pages() : [];
  const hasNavigatedPage = pages.some((page: any) => {
    try { return String(page?.url?.() || '') !== 'about:blank'; }
    catch { return true; }
  });
  if (hasNavigatedPage) throw new Error('Credential network guard must be installed before browser navigation.');
  const baseOrigin = new URL(input.base_url).origin;
  const allowedOrigins = new Set([baseOrigin, ...normalizeAuthenticationOrigins(input.authentication_origins)]);
  const boundary: PersistentCredentialBoundary = { blocked: false, allowedOrigins };
  const handler = async (route: any) => {
    const request = route.request();
    const resourceType = String(request.resourceType ? request.resourceType() : '').toLowerCase();
    if (resourceType !== 'document' && !credentialDestinationAllowed(request.url(), boundary.allowedOrigins)) {
      boundary.blocked = true;
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    // Preserve the existing navigation guard and response observer behind
    // this context-lifetime credential boundary.
    if (typeof route.fallback === 'function') await route.fallback();
    else await route.continue();
  };
  // Register the preload before the first user-controlled navigation. The
  // caller creates a fresh blank task page, so every tested document receives
  // the guarded constructors before its own scripts can cache the native one.
  await browserContext.addInitScript({ content: credentialBoundaryInitScript([...allowedOrigins]) });
  await browserContext.route('**/*', handler);
  persistentCredentialBoundaries.set(browserContext, boundary);
}

async function credentialBoundaryBlocked(browserContext: any, page: any): Promise<boolean> {
  const boundary = browserContext && persistentCredentialBoundaries.get(browserContext);
  if (!boundary) return true;
  if (boundary.blocked) return true;
  // The immutable per-document marker catches constructors blocked before a
  // browser request exists (notably WebSocket and Worker creation).
  const violations = await page.evaluate((marker: string) => Number((globalThis as any)[marker] || 0), credentialBoundaryMarker).catch(() => Number.NaN);
  return !Number.isFinite(violations) || violations > 0;
}

/** The context-lifetime boundary is intentionally installed before navigation;
 * this narrow facade simply observes it during the credential transition.
 * Installing a WebSocket route after a page has loaded is unsafe because page
 * code may already have captured the original constructor. */
async function installCredentialNetworkGuard(browserContext: any, page: any): Promise<{
  blocked: () => Promise<boolean>;
  release: () => Promise<void>;
}> {
  if (!persistentCredentialBoundaries.has(browserContext)) throw new Error('Credential network guard is unavailable.');
  return { blocked: () => credentialBoundaryBlocked(browserContext, page), release: async () => undefined };
}

/** Keep form-control discovery shared between normal discovery and normal
 * learning.  This is deliberately bounded to standard credential forms; OTP,
 * captcha and MFA are blockers rather than something the agent guesses or
 * bypasses. */
export async function applyPreparedIdentityBrowserLogin(input: {
  page: any;
  browser_context: any;
  base_url: string;
  identity: PreparedBrowserIdentity;
  /** Explicit SSO/login origins, normalized from the scan configuration. */
  authentication_origins?: string[];
  timeout_ms?: number;
  /** Called at the trusted, actual submit dispatch boundary.  The caller
   * keeps the causal capability private; credentials never leave this helper. */
  before_submit?: () => Promise<void>;
}): Promise<PreparedIdentityLoginResult> {
  const usernameValue = usable(input.identity.username) || usable(input.identity.email) || usable(input.identity.phone);
  const passwordValue = usable(input.identity.password);
  if (!usernameValue || !passwordValue) {
    return failed('credentials_unavailable');
  }

  const timeout = Math.max(1_000, Math.min(30_000, Number(input.timeout_ms) || 10_000));
  const page = input.page;
  let origin = '';
  let allowedOrigins: Set<string>;
  try {
    origin = new URL(input.base_url).origin;
    allowedOrigins = new Set([origin, ...normalizeAuthenticationOrigins(input.authentication_origins)]);
  } catch {
    return failed('login_failed');
  }
  // Never independently pick a username field, password field, and "Sign in"
  // button from the page. A page with multiple forms can otherwise receive the
  // username in one form and the password in another or redirect submission.
  const forms = page.locator('form:visible').filter({ has: page.locator('input[type="password"]:visible') });
  const formCount = await forms.count();
  if (!formCount) return failed('login_form_not_found');
  if (formCount !== 1) return failed('credential_form_ambiguous');
  const form = forms.first();
  const password = form.locator('input[type="password"]:visible');
  if ((await password.count()) !== 1) return failed('credential_field_not_found');
  if (await page.locator('input[autocomplete="one-time-code"]:visible, iframe[src*="captcha"]:visible').count()) {
    return failed('additional_verification_required');
  }

  const username = form.locator([
    'input[autocomplete="username"]:visible',
    'input[type="email"]:visible',
    'input[name*="user" i]:visible',
    'input[name*="email" i]:visible',
    'input[type="tel"]:visible',
    'input[type="text"]:visible',
  ].join(','));
  if ((await username.count()) !== 1) return failed('credential_field_not_found');
  const namedSubmit = form.getByRole('button', { name: loginLabel });
  const genericSubmit = form.locator('button:visible,input[type="submit"]:visible');
  const namedCount = await namedSubmit.count();
  if (namedCount > 1) return failed('submit_control_not_found');
  const submit = namedCount === 1 ? namedSubmit : genericSubmit;
  if ((await submit.count()) !== 1) return failed('submit_control_not_found');
  if (!(await credentialFormDestinationAllowed(form, submit, allowedOrigins))) return failed('credential_destination_not_allowed');

  const before = JSON.stringify(await input.browser_context.cookies(origin));
  let guard: Awaited<ReturnType<typeof installCredentialNetworkGuard>>;
  try {
    guard = await installCredentialNetworkGuard(input.browser_context, page);
  } catch {
    return failed('credential_network_guard_unavailable');
  }
  try {
    await username.fill(usernameValue, { timeout });
    if (await guard.blocked()) return failed('credential_network_blocked');
    if (!(await credentialFormDestinationAllowed(form, submit, allowedOrigins))) return failed('credential_destination_not_allowed');
    await password.fill(passwordValue, { timeout });
    if (await guard.blocked()) return failed('credential_network_blocked');
    // Re-check after the password input event, immediately before dispatch.
    if (!(await credentialFormDestinationAllowed(form, submit, allowedOrigins))) return failed('credential_destination_not_allowed');
    await input.before_submit?.();
    await submit.click({ timeout });
    await password.waitFor({ state: 'hidden', timeout: Math.min(20_000, timeout * 2) }).catch(() => undefined);
    await page.waitForURL((url: URL) => url.origin === origin, { timeout: Math.min(20_000, timeout * 2) }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
    if (await guard.blocked()) return failed('credential_network_blocked', true);
  } catch {
    return failed('login_failed');
  } finally {
    await guard.release();
  }

  const cookies = await input.browser_context.cookies(origin);
  const storageTokenObserved = await page.evaluate(() => {
    for (const storage of [(globalThis as any).localStorage, (globalThis as any).sessionStorage]) {
      for (const key of ['access_token', 'auth_token', 'token']) {
        const value = storage.getItem(key);
        if (value && value.length > 8) return true;
      }
    }
    return false;
  }).catch(() => false);
  const passwordHidden = !(await password.isVisible().catch(() => true));
  const sessionChanged = cookies.length > 0 && JSON.stringify(cookies) !== before;
  const authenticated = new URL(page.url()).origin === origin && passwordHidden && Boolean(storageTokenObserved || sessionChanged);
  return {
    authenticated,
    status: authenticated ? 'authenticated' : 'login_failed',
    login_submitted: true,
    session_changed: sessionChanged,
    storage_token_observed: storageTokenObserved,
    password_control_hidden_after_submit: passwordHidden,
  };
}
