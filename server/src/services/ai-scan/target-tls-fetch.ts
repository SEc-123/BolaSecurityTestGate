import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { resolveTargetTlsTrust } from './target-tls-trust.js';

type SerializedBody = { headers: Headers; body?: Buffer };

function abortError(): Error {
  const error = new Error('The request was aborted.');
  error.name = 'AbortError';
  return error;
}

async function serializeBody(url: string, init: RequestInit): Promise<SerializedBody> {
  const method = String(init.method || 'GET').toUpperCase();
  if (['GET', 'HEAD'].includes(method) || init.body === undefined || init.body === null) {
    return { headers: new Headers(init.headers || {}) };
  }
  // Request performs the same standards-based FormData/URLSearchParams body
  // serialization used by fetch, including a generated multipart boundary.
  const request = new Request(url, {
    method,
    headers: init.headers,
    body: init.body,
    // Required by Node when a caller supplies a ReadableStream. It is ignored
    // for ordinary string, URLSearchParams, FormData and byte-array bodies.
    duplex: 'half' as any,
  } as RequestInit);
  return { headers: new Headers(request.headers), body: Buffer.from(await request.arrayBuffer()) };
}

function responseHeaders(headers: http.IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) out.append(name, String(item));
  }
  return out;
}

/**
 * Node's built-in fetch reads NODE_EXTRA_CA_CERTS only during process startup.
 * Native Test Run and Workflow execution need a per-process explicit trust
 * bundle that is also available to the browser worker, so use a strict
 * https.request transport when BSTG_TARGET_CA_FILE is configured. Public CA
 * traffic remains on native fetch and its platform trust store.
 */
export async function fetchWithTargetTlsTrust(url: string, init: RequestInit = {}): Promise<Response> {
  const trust = resolveTargetTlsTrust();
  const configuredCa = trust.ca_pem;
  if (!configuredCa) return fetch(url, init);

  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError(`Unsupported protocol: ${parsed.protocol}`);
  if (init.signal?.aborted) throw abortError();
  const serialized = await serializeBody(url, init);
  const method = String(init.method || 'GET').toUpperCase();
  const headers = Object.fromEntries(serialized.headers.entries());
  const secure = parsed.protocol === 'https:';
  // WHATWG URL preserves brackets in hostname for an IPv6 literal, while
  // node:http expects the unbracketed address in its hostname option.
  const hostname = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const authorities = [...tls.rootCertificates, configuredCa];
  const agent = secure
    ? new https.Agent({ keepAlive: false, rejectUnauthorized: true, ca: authorities })
    : undefined;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const complete = (callback: () => void) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      request.destroy(abortError());
      agent?.destroy();
    };
    const request = (secure ? https : http).request({
      protocol: parsed.protocol,
      hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      ...(secure ? { agent, rejectUnauthorized: true, ca: authorities } : {}),
    }, response => {
      response.once('close', () => agent?.destroy());
      const body = Readable.toWeb(response as any) as any;
      const result = new Response(body, {
        status: response.statusCode || 500,
        statusText: response.statusMessage || '',
        headers: responseHeaders(response.headers),
      });
      // Response.url is normally populated by fetch. Keep the existing native
      // executor evidence contract when this strict transport is active.
      Object.defineProperty(result, 'url', { value: parsed.toString(), configurable: true });
      complete(() => resolve(result));
    });
    request.once('error', error => complete(() => { agent?.destroy(); reject(error); }));
    init.signal?.addEventListener('abort', onAbort, { once: true });
    if (serialized.body) request.end(serialized.body);
    else request.end();
  });
}
