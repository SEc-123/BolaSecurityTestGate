/**
 * Browser pages are private execution surfaces.  This module is deliberately
 * an allowlist, rather than a scrubber: a new page-derived field cannot reach
 * a model until it is explicitly represented here.
 *
 * `control_ref` and `assertion_ref` are opaque, short-lived handles resolved
 * by the persistent browser runtime.  They let a model select a live control
 * without receiving DOM ids, names, labels, text, HTML, or input values.
 */
const CONTROL_REF = /^(?:control|assertion)_[0-9a-f-]{36}$/i;
const ACTION_ID = /^[0-9a-f-]{36}$/i;
const TAGS = new Set(['a', 'button', 'input', 'textarea', 'select']);
const ASSERTION_TAGS = new Set(['div', 'main', 'section', 'article', 'p', 'span', 'strong', 'h1', 'h2', 'h3', 'output']);
const ROLES = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'status', 'alert', 'region']);
const TYPES = new Set(['button', 'submit', 'reset', 'text', 'email', 'search', 'number', 'tel', 'url', 'checkbox', 'radio', 'file', 'date', 'time', 'select-one', 'select-multiple', 'textarea']);
// Intent is a closed, value-free semantic vocabulary.  It is deliberately
// richer than a generic submit action so a browser Agent can distinguish the
// ordered stages of a normal transaction without receiving visible labels,
// page text, or DOM attributes.
const INTENTS = new Set(['authenticate', 'continue', 'submit', 'cancel', 'add', 'review', 'confirm', 'checkout', 'search', 'navigation', 'generic']);
const NAVIGATION_TARGETS = new Set(['profile', 'cart', 'notes', 'settings', 'orders', 'checkout', 'search', 'home', 'authentication', 'other']);

const ROUTE_WORDS = new Set(['api', 'v1', 'v2', 'v3', 'auth', 'login', 'logout', 'register', 'signup', 'profile', 'account', 'accounts', 'user', 'users', 'order', 'orders', 'cart', 'checkout', 'payment', 'payments', 'item', 'items', 'product', 'products', 'search', 'upload', 'download', 'file', 'files', 'note', 'notes', 'settings', 'session', 'sessions', 'health', 'status', 'callback', 'confirm', 'verify', 'reset', 'forgot', 'me', 'self', 'create', 'update', 'delete', 'list', 'detail', 'details', 'history', 'admin', 'management']);

/** A route shape contains no path/query values, fragments, page text, or DOM. */
export function projectBrowserRoute(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let url: URL;
  let absolute = false;
  try { url = new URL(value.trim()); absolute = /^https?:$/i.test(url.protocol); }
  catch {
    if (!value.startsWith('/') && !value.startsWith('?')) return undefined;
    try { url = new URL(value, 'https://browser-model.invalid'); } catch { return undefined; }
  }
  if (!/^https?:$/i.test(url.protocol)) return undefined;
  const path = url.pathname.split('/').map(part => {
    if (!part) return part;
    try { part = decodeURIComponent(part); } catch { return ':value'; }
    return ROUTE_WORDS.has(part.toLowerCase()) ? part.toLowerCase() : ':value';
  }).join('/') || '/';
  const queryNames = [...new Set([...url.searchParams.keys()].map(key => {
    try { key = decodeURIComponent(key); } catch { return ':param'; }
    return /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(key) ? key : ':param';
  }))].slice(0, 32);
  return `${absolute ? url.origin : ''}${path}${queryNames.length ? `?${queryNames.map(encodeURIComponent).join('&')}` : ''}`;
}

function boundedBoolean(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function boundedIndex(value: unknown): number | undefined { return Number.isInteger(value) && Number(value) >= 0 && Number(value) < 1000 ? Number(value) : undefined; }

function projectControl(value: any): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || typeof value.control_ref !== 'string' || !CONTROL_REF.test(value.control_ref)) return undefined;
  const tag = typeof value.tag === 'string' && TAGS.has(value.tag.toLowerCase()) ? value.tag.toLowerCase() : undefined;
  if (!tag) return undefined;
  const result: Record<string, unknown> = { control_ref: value.control_ref, tag };
  if (typeof value.role === 'string' && ROLES.has(value.role.toLowerCase())) result.role = value.role.toLowerCase();
  if (typeof value.type === 'string' && TYPES.has(value.type.toLowerCase())) result.type = value.type.toLowerCase();
  if (typeof value.intent === 'string' && INTENTS.has(value.intent)) result.intent = value.intent;
  if (typeof value.navigation_target === 'string' && NAVIGATION_TARGETS.has(value.navigation_target)) result.navigation_target = value.navigation_target;
  for (const key of ['disabled', 'in_dialog', 'receives_pointer']) { const item = boundedBoolean(value[key]); if (item !== undefined) result[key] = item; }
  const formIndex = boundedIndex(value.form_index); if (formIndex !== undefined) result.form_index = formIndex;
  return result;
}

function projectAssertionTarget(value: any): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || typeof value.assertion_ref !== 'string' || !CONTROL_REF.test(value.assertion_ref)) return undefined;
  const tag = typeof value.tag === 'string' && ASSERTION_TAGS.has(value.tag.toLowerCase()) ? value.tag.toLowerCase() : undefined;
  if (!tag) return undefined;
  const result: Record<string, unknown> = { assertion_ref: value.assertion_ref, tag };
  if (typeof value.role === 'string' && ROLES.has(value.role.toLowerCase())) result.role = value.role.toLowerCase();
  return result;
}

/** Safe, model-facing browser observation.  Unknown fields are always omitted. */
export function projectBrowserObservation(value: any): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const controls = (Array.isArray(value.controls) ? value.controls : []).map(projectControl).filter(Boolean).slice(0, 20);
  const assertionTargets = (Array.isArray(value.assertion_targets) ? value.assertion_targets : []).map(projectAssertionTarget).filter(Boolean).slice(0, 20);
  return controls.length || assertionTargets.length ? {
    ...(controls.length ? { controls } : {}),
    ...(assertionTargets.length ? { assertion_targets: assertionTargets } : {}),
  } : undefined;
}

/** The only browser result shape that may be persisted in model-visible history. */
export function projectBrowserToolResult(value: any): Record<string, unknown> {
  const source = value && typeof value === 'object' ? value : {};
  const result: Record<string, unknown> = {};
  for (const key of ['ok', 'action_performed', 'retryable']) {
    const item = boundedBoolean(source[key]); if (item !== undefined) result[key] = item;
  }
  for (const key of ['match_count']) {
    const item = boundedIndex(source[key]); if (item !== undefined) result[key] = item;
  }
  if (typeof source.action_id === 'string' && ACTION_ID.test(source.action_id)) result.action_id = source.action_id;
  if (typeof source.error_code === 'string' && /^[a-z_]{1,96}$/.test(source.error_code)) result.error_code = source.error_code;
  if (typeof source.failure_phase === 'string' && ['pre_action', 'action_or_after'].includes(source.failure_phase)) result.failure_phase = source.failure_phase;
  const route = projectBrowserRoute(source.current_url); if (route) result.current_url = route;
  const observation = projectBrowserObservation(source.observation); if (observation) result.observation = observation;
  return result;
}

/** Invocation inputs are also model history. Preserve protocol shape only. */
export function projectBrowserToolInput(value: any): Record<string, unknown> {
  const source = value && typeof value === 'object' ? value : {};
  const operation = source.operation && typeof source.operation === 'object' ? source.operation : undefined;
  if (!operation || typeof operation.action !== 'string') return {};
  const actions = new Set(['click', 'fill', 'select', 'press', 'scroll', 'assert', 'observe']);
  if (!actions.has(operation.action)) return {};
  const safe: Record<string, unknown> = { action: operation.action };
  if (typeof operation.control_ref === 'string' && CONTROL_REF.test(operation.control_ref)) safe.control_ref = operation.control_ref;
  if (typeof operation.assertion_ref === 'string' && CONTROL_REF.test(operation.assertion_ref)) safe.assertion_ref = operation.assertion_ref;
  if (typeof operation.key === 'string' && ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space'].includes(operation.key)) safe.key = operation.key;
  if (Number.isFinite(operation.x)) safe.x = Math.max(-3000, Math.min(3000, Number(operation.x)));
  if (Number.isFinite(operation.y)) safe.y = Math.max(-3000, Math.min(3000, Number(operation.y)));
  if (operation.value !== undefined) safe.value_provided = true;
  if (operation.text !== undefined) safe.expected_text_provided = true;
  return { operation: safe };
}

export function isBrowserObservationTool(name: string): boolean {
  return name === 'browser.navigate' || name === 'browser.interact';
}
