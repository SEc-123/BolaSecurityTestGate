export type NativeRequestPatch = {
  location: 'query' | 'header' | 'json_body' | 'form_body' | 'path';
  operation: 'set' | 'delete' | 'append';
  path: string;
  value?: unknown;
};

export interface MutableNativeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

const EXECUTOR_OWNED_HEADERS = /^(host|cookie|authorization|proxy-authorization|content-length|connection)$/i;
const JSON_PATH = /^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\d+))*$/;

function scalar(value: unknown): string {
  if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 4000) {
    throw new Error('A request patch value must be a bounded string, number, or boolean.');
  }
  return String(value);
}

function jsonLocation(root: unknown, path: string): { parent: Record<string, any> | any[]; key: string; value: any } {
  if (!JSON_PATH.test(path)) throw new Error('JSON field paths must address an observed dotted field path.');
  const parts = path.split('.');
  let current: any = root;
  for (const part of parts.slice(0, -1)) {
    if ((!current || typeof current !== 'object') || current[part] === undefined || current[part] === null) {
      throw new Error(`Request JSON path "${path}" was not observed.`);
    }
    current = current[part];
  }
  const key = parts.at(-1)!;
  if ((!current || typeof current !== 'object') || !Object.prototype.hasOwnProperty.call(current, key)) {
    throw new Error(`Request JSON path "${path}" was not observed.`);
  }
  return { parent: current as any, key, value: (current as any)[key] };
}

/** Apply a validated model request mutation to the mutable request object. */
export function applyNativeRequestPatch(request: MutableNativeRequest, patch: NativeRequestPatch): unknown {
  const path = typeof patch.path === 'string' ? patch.path.trim() : '';
  if (!path || path.length > 300) throw new Error('Patch path must be a nonempty string of at most 300 characters.');
  if (!['set', 'delete', 'append'].includes(patch.operation)) throw new Error('Unsupported patch operation.');
  if (!['query', 'header', 'json_body', 'form_body', 'path'].includes(patch.location)) throw new Error('Unsupported patch location.');
  if (patch.operation !== 'delete' && patch.value === undefined) throw new Error('A set or append patch requires a value.');
  const value = patch.operation === 'delete' ? '' : scalar(patch.value);

  if (patch.location === 'query') {
    const url = new URL(request.path, 'http://bstg.local');
    if (!url.searchParams.has(path)) throw new Error(`Query field "${path}" was not observed in this request.`);
    const before = url.searchParams.get(path) || '';
    if (patch.operation === 'delete') url.searchParams.delete(path);
    else url.searchParams.set(path, patch.operation === 'append' ? `${before}${value}` : value);
    request.path = `${url.pathname}${url.search}`;
    return before;
  }

  if (patch.location === 'header') {
    if (EXECUTOR_OWNED_HEADERS.test(path)) throw new Error('Identity, host, and transport headers are bound by the native account/session executor and cannot be patched directly.');
    const key = Object.keys(request.headers || {}).find(name => name.toLowerCase() === path.toLowerCase());
    if (!key) throw new Error(`Header "${path}" was not observed in this request.`);
    const before = request.headers[key];
    if (patch.operation === 'delete') delete request.headers[key];
    else request.headers[key] = patch.operation === 'append' ? `${before}${value}` : value;
    return before;
  }

  if (patch.location === 'json_body') {
    if (!request.body) throw new Error(`JSON field "${path}" was not observed because the request has no body.`);
    let body: any;
    try { body = JSON.parse(request.body); } catch { throw new Error('The request body is not JSON; use form_body or a supported observed request type.'); }
    const node = jsonLocation(body, path);
    const before = node.value;
    if (patch.operation === 'delete') delete (node.parent as any)[node.key];
    else if (patch.operation === 'append') (node.parent as any)[node.key] = `${String(before)}${value}`;
    else if (typeof before === 'number' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) (node.parent as any)[node.key] = Number(value);
    else if (typeof before === 'boolean' && ['true', 'false'].includes(value)) (node.parent as any)[node.key] = value === 'true';
    else (node.parent as any)[node.key] = value;
    request.body = JSON.stringify(body);
    return before;
  }

  if (patch.location === 'form_body') {
    if (!request.body) throw new Error(`Form field "${path}" was not observed because the request has no body.`);
    const form = new URLSearchParams(request.body);
    if (!form.has(path)) throw new Error(`Form field "${path}" was not observed in this request.`);
    const before = form.get(path) || '';
    if (patch.operation === 'delete') form.delete(path);
    else form.set(path, patch.operation === 'append' ? `${before}${value}` : value);
    request.body = form.toString();
    return before;
  }

  const match = path.match(/^(?:segment\.|__bstg_segment_)(\d+)$/);
  if (!match) throw new Error('Path patches must use an observed segment.N or __bstg_segment_N location.');
  if (patch.operation === 'delete') throw new Error('Deleting a path segment is not supported because it changes request routing; choose an observed field mutation instead.');
  const index = Number(match[1]);
  const queryAt = request.path.indexOf('?');
  const pathOnly = queryAt < 0 ? request.path : request.path.slice(0, queryAt);
  const segments = pathOnly.split('/');
  if (!Number.isInteger(index) || index < 1 || index >= segments.length || !segments[index]) throw new Error(`Path segment ${index} was not observed.`);
  const before = decodeURIComponent(segments[index]);
  segments[index] = encodeURIComponent(patch.operation === 'append' ? `${before}${value}` : value);
  request.path = segments.join('/') + (queryAt < 0 ? '' : request.path.slice(queryAt));
  return before;
}
