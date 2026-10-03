import type { AIScanRepository } from '../repository.js';
import { assertUrlInTargetScope } from '../target-scope.js';
import { openDesktop, type DesktopSession } from '../../live-browser/desktop-runtime.js';
import { launchAssessmentBrowser } from './browser-provider.js';
import { assertBrowserNavigationUrl, normalizeAuthenticationOrigins } from './authentication-scope.js';
import { installNavigationGuard, type BrowserResponseObserver } from './navigation-guard.js';
import { assertScanActive, scanAbortSignal } from '../run-control.js';
import { createHash, randomUUID } from 'node:crypto';
import {rememberBrowserBody,rememberBrowserSecret,rememberBrowserStructure,redactBrowserObservation,type BrowserObservationSecrets} from './observation-redaction.js';
import { targetTlsTrustMetadata, type TargetTlsTrustMetadata } from '../target-tls-trust.js';
import { projectBrowserToolResult } from './model-observation-projection.js';

export type PersistentBrowserScope = 'scan' | 'task' | 'identity';

/** Why a live business recording ended.  A task reaching a terminal state is
 * deliberately distinct from a model-requested stop: its partial recording
 * must never become a workflow candidate merely because the browser session
 * remains usable for another task. */
export type BusinessCaptureEndReason = 'stopped' | 'context_closed' | 'task_terminal';

/** Complete private recording input. Public/model projections must redact values. */
export interface BusinessBrowserCaptureEvent {
  sequence: number;
  task_id?: string;
  action_id?: string;
  /**
   * Closed semantic class of the live control selected by the model. This is
   * derived inside the browser runtime at dispatch time, bound to the same
   * causal action marker as action_id, and never comes from a model argument.
   * It lets the Workflow compiler preserve an observed transaction chain
   * without retaining private labels, selectors, or DOM attributes.
   */
  action_intent?: "authenticate" | "continue" | "submit" | "cancel" | "add" | "review" | "confirm" | "checkout" | "search" | "navigation" | "generic";
  /**
   * A normal-flow candidate needs more than an action ID.  This proof is set
   * only when Chromium paused an XHR/fetch while the corresponding trusted
   * browser input was being dispatched.  It intentionally cannot be produced
   * by navigation, an action's post-dispatch quiet period, or a helper's
   * generic page callback.
   */
  causal_proof?: 'trusted_browser_interaction_dispatch';
  action: string;
  identity_key: string;
  context_key: string;
  method: string;
  url: string;
  resource_type: string;
  started_at: string;
  completed_at: string;
  request_headers: Record<string, string>;
  request_body_text?: string;
  request_body_base64?: string;
  response_status?: number;
  response_headers: Record<string, string>;
  response_body_text?: string;
  response_body_base64?: string;
  /** Transport provenance is private capture evidence, not model input. */
  tls?: {
    scheme: 'http' | 'https';
    certificate_verified: boolean;
    /** CDP request-level evidence; never inferred from a URL scheme. */
    security_state?: 'secure';
    trust_mode: TargetTlsTrustMetadata['mode'];
    ca_bundle_sha256?: string;
    protocol?: string;
    cipher?: string;
  };
  complete: boolean;
  error?: string;
}

export interface BusinessBrowserCaptureSink {
  id: string;
  sensitiveFieldNames?: string[];
  record: (event: BusinessBrowserCaptureEvent) => Promise<void>;
  ended?: (reason: BusinessCaptureEndReason, errors: string[]) => Promise<void>;
}

interface BusinessRequestObservation {
  capture:ActiveBusinessCapture;
  event:BusinessBrowserCaptureEvent;
  actionCandidate?: { id: string; taskId?: string; action: string; intent?: BusinessBrowserCaptureEvent["action_intent"] };
  done:()=>void;
  settled:boolean;
}

interface CausalBrowserAction {
  id: string;
  taskId?: string;
  action: string;
  intent?: BusinessBrowserCaptureEvent["action_intent"];
  expiresAt: number;
}

const CAUSAL_ACTION_HEADER = 'x-bstg-causal-request';
const CAUSAL_ACTION_LIFETIME_MS = 10_000;

function consumeCausalActionMarker(entry:LiveBrowserContext, paused:any): CausalBrowserAction | undefined {
  const marker = typeof paused?.__bstg_causal_action_marker === 'string' ? paused.__bstg_causal_action_marker : '';
  // The marker is a per-request witness installed by the init script only
  // while an action-derived callback is running.  It is not a general time
  // window: no marker means no proof, even while this map has an entry.
  const action = marker ? entry.causalActions.get(marker) : undefined;
  if (!action || action.expiresAt < Date.now()) {
    if (marker) entry.causalActions.delete(marker);
    return undefined;
  }
  return action;
}

function captureBody(event:BusinessBrowserCaptureEvent,kind:'request'|'response',bytes?:Buffer):void {
  if(!bytes)return;
  if(bytes.length>2*1024*1024){event.complete=false;event.error=`${event.error?event.error+'; ':''}${kind} body exceeds the 2 MiB recording limit`;return;}
  const decoded=bytes.toString('utf8');
  if(Buffer.from(decoded,'utf8').equals(bytes))event[`${kind}_body_text`]=decoded;
  else event[`${kind}_body_base64`]=bytes.toString('base64');
}

function captureTlsEvidence(entry: LiveBrowserContext, url: string, paused: any): BusinessBrowserCaptureEvent['tls'] | undefined {
  let scheme: 'http' | 'https';
  try { scheme = new URL(url).protocol === 'https:' ? 'https' : 'http'; }
  catch { return undefined; }
  const details = paused?.__bstg_tls_security_details || {};
  return {
    scheme,
    // A strict context has no certificate-error bypass, but keep the proof
    // tied to this Network.responseReceived event as well. HTTPS spelling in a
    // URL is never sufficient evidence of a verified peer certificate.
    certificate_verified: scheme === 'https' && details.security_state === 'secure',
    ...(details.security_state === 'secure' ? { security_state: 'secure' as const } : {}),
    trust_mode: entry.targetTlsTrust.mode,
    ...(entry.targetTlsTrust.ca_bundle_sha256 ? { ca_bundle_sha256: entry.targetTlsTrust.ca_bundle_sha256 } : {}),
    ...(typeof details.protocol === 'string' ? { protocol: details.protocol } : {}),
    ...(typeof details.cipher === 'string' ? { cipher: details.cipher } : {}),
  };
}

/** Observe Chromium's original response while it is paused. Reading a body
 * through Playwright after page script runs loses fetch responses when that
 * script immediately navigates; no request is replayed here. */
function businessResponseObserver(entry:LiveBrowserContext,scopeBaseUrl:string):BrowserResponseObserver {
  return {
    start:(paused:any)=>{
      rememberBrowserStructure(entry.observationSecrets,paused.request.headers);
      rememberBrowserBody(entry.observationSecrets,paused.request.postData,Object.entries(paused.request.headers||{}).find(([name])=>name.toLowerCase()==='content-type')?.[1] as string|undefined);
      const capture=entry.businessCapture;
      if(!capture?.accepting || !['Document','XHR','Fetch'].includes(paused.resourceType))return;
      try{assertUrlInTargetScope(paused.request.url,scopeBaseUrl);}catch{return;}
      let done!:()=>void;const pending=new Promise<void>(resolve=>{done=resolve;});
      capture.lastRequestAt=Date.now();
      capture.pending.add(pending);void pending.finally(()=>capture.pending.delete(pending));
      // An action ID is not causal evidence by itself.  The old implementation
      // retained currentAction through navigation and a post-action settle
      // window, which let polling and delayed page work inherit it.  Accept
      // attribution only at Chromium's request boundary while a real browser
      // input is being dispatched, and only for script/network operations.
      const actionCandidate=['XHR','Fetch'].includes(paused.resourceType)
        ? consumeCausalActionMarker(entry,paused):undefined;
      const event:BusinessBrowserCaptureEvent={sequence:++capture.sequence,task_id:actionCandidate?.taskId||capture.ownerTaskId,
        action:'background',identity_key:entry.identityKey,context_key:entry.contextKey,
        method:paused.request.method,url:paused.request.url,resource_type:paused.resourceType.toLowerCase(),started_at:new Date().toISOString(),completed_at:'',
        request_headers:Object.fromEntries(Object.entries(paused.request.headers||{}).map(([name,value])=>[name.toLowerCase(),String(value)])),response_headers:{},complete:true};
      if(paused.request.bodyUnavailable){event.complete=false;event.error='Request body unavailable from Chromium.';}
      if(paused.request.postData!==undefined)captureBody(event,'request',Buffer.from(paused.request.postData,'utf8'));
      // CDP omits file data from multipart postData; it is not a complete input
      // to the existing API executor and must not become a verified baseline.
      if(/multipart\/form-data/i.test(event.request_headers['content-type']||'')){event.complete=false;event.error='Multipart request requires the existing file executor; Chromium postData does not contain complete file bytes.';}
      return {capture,event,actionCandidate,done,settled:false} satisfies BusinessRequestObservation;
    },
    updateHeaders:(value,headers)=>{const tracked=value as BusinessRequestObservation;if(!tracked.settled){
      for(const [name,value] of Object.entries(headers))if(name.toLowerCase()!==CAUSAL_ACTION_HEADER)tracked.event.request_headers[name]=value;
    }},
    finish:async(value,paused:any,bytes,error)=>{
      const tracked=value as BusinessRequestObservation;if(tracked.settled)return;tracked.settled=true;
      const {capture,event}=tracked;
      try {
        if(capture.closed)return;
        // The causal boundary is Chromium's request pause while Playwright is
        // dispatching the actual, already-validated input.  The marker is
        // cleared before the settle wait begins, so a timer/poll or delayed
        // continuation cannot inherit it. Document/navigation requests were
        // excluded at start and can never reach this branch.
        const causalAction=tracked.actionCandidate;
        if(causalAction){event.task_id=causalAction.taskId||capture.ownerTaskId;event.action_id=causalAction.id;event.action=causalAction.action;if(causalAction.intent)event.action_intent=causalAction.intent;event.causal_proof='trusted_browser_interaction_dispatch';}
        event.completed_at=new Date().toISOString();event.response_status=paused.responseStatusCode;
        event.tls=captureTlsEvidence(entry,event.url,paused);
        for(const header of paused.responseHeaders||[]){const name=String(header.name).toLowerCase(),text=String(header.value);event.response_headers[name]=event.response_headers[name]?`${event.response_headers[name]}\n${text}`:text;}
        if(error){event.complete=false;event.error=`${event.error?event.error+'; ':''}${error}`;}
        captureBody(event,'response',bytes);
        rememberBrowserStructure(entry.observationSecrets,event.request_headers);rememberBrowserStructure(entry.observationSecrets,event.response_headers);
        rememberBrowserBody(entry.observationSecrets,event.response_body_text,event.response_headers['content-type']);
        if(!capture.closed)await capture.sink.record(event);
        if(!event.complete)capture.errors.push(`Request ${event.sequence}: ${event.error}`);
      } catch(failure:any){capture.errors.push(`Request ${event.sequence} was not persisted: ${failure?.message||String(failure)}`);}
      finally {tracked.done();}
    },
  };
}

async function safeBrowserObservation<T>(entry:LiveBrowserContext,value:T):Promise<T> {
  // Hidden fields are execution inputs, never model-facing control metadata.
  // Their values also protect aliases rendered elsewhere on the same page.
  const hidden=await entry.page.evaluate((names:string[])=>{
    const doc=(globalThis as any).document,pattern=/password|passwd|secret|token|csrf|ticket|otp|passcode|session|verification|^_g$/i;
    return Array.from(doc.querySelectorAll('input,textarea,select')).filter((element:any)=>
      element.type==='hidden'||element.type==='password'||element.autocomplete==='one-time-code'||pattern.test(element.name||element.id)||names.includes((element.name||element.id||'').toLowerCase()))
      .map((element:any)=>element.value).filter((item:any)=>typeof item==='string'&&item);
  },[...entry.observationSecrets.fields]).catch(()=>[]);
  for(const secret of hidden)rememberBrowserSecret(entry.observationSecrets,secret);
  return redactBrowserObservation(entry.observationSecrets,value);
}

interface ActiveBusinessCapture {
  sink: BusinessBrowserCaptureSink;
  sequence: number;
  accepting: boolean;
  closed: boolean;
  errors: string[];
  pending: Set<Promise<void>>;
  lastRequestAt:number;
  ownerTaskId?: string;
  ending?: Promise<{id:string;errors:string[]}>;
}

export interface PersistentBrowserNavigationResult {
  ok: boolean;
  action_id?: string;
  current_url?: string;
  /** Safe structural controls only; full observations stay in the private context record. */
  observation?: Record<string, unknown>;
  recovered_from_storage_state?: boolean;
  error_code?: string;
  failure_phase?: string;
  /** Private/local callers may use this generic status. Tool persistence
   * projects it away, so browser-originated diagnostics never reach a model. */
  error?: string;
}

interface LiveBrowserContext {
  scanRunId: string;
  contextKey: string;
  scopeType: PersistentBrowserScope;
  identityKey: string;
  taskOwnerId?: string;
  browserContext: any;
  browser: any;
  desktop?: DesktopSession;
  page: any;
  networkEvents: Record<string, any>[];
  lastUsedAt: number;
  operationTail: Promise<void>;
  pendingCaptures: Set<Promise<unknown>>;
  authenticationOrigins: string[];
  navigationError?: string;
  operationSignal?: AbortSignal;
  rejectedInteraction?: { signature:string; result:BrowserInteractionResult };
  /** Short-lived opaque handles resolve model choices without exposing DOM selectors. */
  modelControlRefs: Map<string, { selector:string; kind:'control'|'assertion_target'; element:any; tag:string; type:string; role:string; intent?: BusinessBrowserCaptureEvent["action_intent"]; anchorSafetyFingerprint?:string }>;
  businessCapture?: ActiveBusinessCapture;
  currentAction?: { id: string; taskId?: string; action: string; dispatching: boolean };
  /** Authoritative server-side action records for page-local request witnesses. */
  causalActions: Map<string, CausalBrowserAction>;
  observationSecrets:BrowserObservationSecrets;
  targetTlsTrust: TargetTlsTrustMetadata;
  setResponseObservation?:(enabled:boolean)=>Promise<void>;
}

const liveContexts = new Map<string, LiveBrowserContext>();
const contextCreationPromises = new Map<string, Promise<{ entry: LiveBrowserContext; recovered: boolean; recordId?: string } | null>>();
const closingContextKeys = new Set<string>();

/**
 * Propagate an action only through callbacks that were scheduled while that
 * action's trusted DOM event (or an already-derived callback) was active.
 * Every callback scheduled outside that context explicitly runs with an empty
 * action, so an old polling timer cannot borrow an event that happens to be
 * dispatching when it fires. `setInterval` is always empty by policy.
 *
 * Fetch/XHR carry the opaque action ID in a header solely until the CDP request
 * pause. navigation-guard removes it before Chromium sends the request, so it
 * never reaches the app or captured request headers.
 */
function causalActionInitScript(): void {
  const global:any = globalThis as any;
  const state = { expectedActionId: '', expectedEvent: '', activeActionId: '', dispatchingActionId: '', pendingSubmitActionId: '', pendingSubmitForm: null as any, pendingSubmitter: null as any, suppressedSubmitActionId: '' };
  Object.defineProperty(global, '__bstgCausalActionState', { value: state, configurable: true });
  const marker = 'x-bstg-causal-request';
  const active = () => state.activeActionId || '';
  const run = (actionId:string, callback:any, receiver:any, args:any[]) => {
    const previous = state.activeActionId;
    state.activeActionId = actionId;
    try { return callback.apply(receiver, args); }
    finally { state.activeActionId = previous; }
  };
  const wrapped = (actionId:string, callback:any) => typeof callback !== 'function' ? callback : function(this:any, ...args:any[]) {
    return run(actionId, callback, this, args);
  };
  const queueMicrotaskNative = global.queueMicrotask.bind(global);
  const setTimeoutNative = global.setTimeout.bind(global);
  const armDispatch = (actionId:string) => {
    state.activeActionId = actionId; state.dispatchingActionId = actionId;
    setTimeoutNative(() => {
      if (state.dispatchingActionId === actionId) {
        state.dispatchingActionId = '';
        if (state.activeActionId === actionId) state.activeActionId = '';
      }
      // A native form submit is the default action of the immediately
      // preceding click/Enter. It must occur in this task; no later submit
      // may reuse this one-shot capability.
      if (state.pendingSubmitActionId === actionId) {
        state.pendingSubmitActionId = '';
        state.pendingSubmitForm = null;
        state.pendingSubmitter = null;
      }
    }, 0);
  };
  const immediateSubmitForm = (event:any,eventName:string):any => {
    const target:any = event?.target;
    if (!target || typeof target.closest !== 'function') return null;
    if (eventName === 'click') {
      const control = target.closest('button,input');
      if (!control) return null;
      const type = String(control.type || (String(control.tagName).toLowerCase()==='button' ? 'submit' : '')).toLowerCase();
      return type === 'submit' && control.form ? {form:control.form,submitter:control} : null;
    }
    const form = eventName === 'keydown' && event?.key === 'Enter' ? target.closest('input,select,textarea,button')?.form : null;
    return form ? {form,submitter:null} : null;
  };
  for (const eventName of ['click','input','change','keydown','wheel','submit']) {
    global.addEventListener(eventName, (event:any) => {
      if (eventName === 'submit') {
        const actionId = state.pendingSubmitActionId;
        if (!event.isTrusted || !actionId) return;
        const submitPath = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
        const sameForm = (value:any) => state.pendingSubmitForm === value ||
          (typeof state.pendingSubmitForm?.isSameNode === 'function' && state.pendingSubmitForm.isSameNode(value));
        const matchesPendingForm = Boolean(state.pendingSubmitForm) && submitPath.some(sameForm) &&
          (!state.pendingSubmitter || event.submitter === state.pendingSubmitter);
        if (!matchesPendingForm) {
          // A nested submit can be trusted yet belong to a different form.
          // Suspend the parent click context while that handler runs; restoring
          // it at this event's bubble boundary still lets the matched default
          // submit consume the one-shot proof later in the same task.
          state.suppressedSubmitActionId = state.activeActionId;
          state.activeActionId = '';
          return;
        }
        state.pendingSubmitActionId = '';
        state.pendingSubmitForm = null;
        state.pendingSubmitter = null;
        armDispatch(actionId);
        return;
      }
      if (!event.isTrusted || state.expectedEvent !== eventName || !state.expectedActionId) return;
      const actionId = state.expectedActionId;
      state.expectedActionId = ''; state.expectedEvent = '';
      const submitForm = immediateSubmitForm(event,eventName);
      if (submitForm) { state.pendingSubmitActionId = actionId; state.pendingSubmitForm = submitForm.form; state.pendingSubmitter = submitForm.submitter; }
      armDispatch(actionId);
      // A microtask queued from a capture listener can run before the target's
      // property handler in Chromium.  Clear at the end of this *same trusted
      // event* instead, so synchronous fetch/XHR in that handler gets proof.
      // The timeout is only a stop-propagation failsafe; setInterval wrappers
      // always run without an action and cannot borrow it.
    }, true);
    global.addEventListener(eventName, (event:any) => {
      if (eventName === 'submit' && state.suppressedSubmitActionId) {
        const suppressed = state.suppressedSubmitActionId;
        state.suppressedSubmitActionId = '';
        if (state.dispatchingActionId === suppressed) state.activeActionId = suppressed;
      }
      const actionId = state.dispatchingActionId;
      if (!event.isTrusted || !actionId) return;
      state.dispatchingActionId = '';
      if (state.activeActionId === actionId) state.activeActionId = '';
    }, false);
  }
  global.queueMicrotask = (callback:any) => queueMicrotaskNative(wrapped(active(), callback));
  global.setTimeout = (callback:any, delay?:number, ...args:any[]) => {
    const actionId = Number(delay || 0) <= 250 ? active() : '';
    return setTimeoutNative(wrapped(actionId, callback), delay, ...args);
  };
  const setIntervalNative = global.setInterval.bind(global);
  global.setInterval = (callback:any, delay?:number, ...args:any[]) =>
    setIntervalNative(wrapped('', callback), delay, ...args);
  if (typeof global.requestAnimationFrame === 'function') {
    const requestAnimationFrameNative = global.requestAnimationFrame.bind(global);
    global.requestAnimationFrame = (callback:any) => requestAnimationFrameNative(wrapped(active(), callback));
  }
  const promisePrototype:any = global.Promise.prototype;
  const thenNative:any = promisePrototype.then;
  promisePrototype.then = function(this:any, fulfilled?:any, rejected?:any) {
    const actionId = active();
    return thenNative.call(this, wrapped(actionId, fulfilled), wrapped(actionId, rejected));
  };
  // Native async/await may bypass Promise.prototype.then for an ordinary
  // Promise. A Promise subclass is assimilated as a thenable, which lets us
  // restore the captured context exactly while its await continuation is
  // queued. Keep that context through one queued continuation only; timers
  // and callbacks that were not derived from it still run with an empty ID.
  const continuation = (actionId:string, callback:any) => typeof callback !== 'function' ? callback : function(this:any, ...args:any[]) {
    const previous = state.activeActionId;
    state.activeActionId = actionId;
    try { return callback.apply(this, args); }
    finally { queueMicrotaskNative(() => { if (state.activeActionId === actionId) state.activeActionId = previous; }); }
  };
  class CausalPromise extends Promise<any> {
    actionId:string;
    static get [Symbol.species](): PromiseConstructor { return Promise; }
    constructor(source:Promise<any>, actionId:string) {
      super((resolve,reject) => thenNative.call(source,resolve,reject));
      this.actionId=actionId;
    }
    then(fulfilled?:any,rejected?:any):any {
      return new CausalPromise(thenNative.call(this,continuation(this.actionId,fulfilled),continuation(this.actionId,rejected)),this.actionId);
    }
    catch(rejected?:any):any { return this.then(undefined,rejected); }
    finally(callback?:any):any {
      return new CausalPromise(thenNative.call(this,
        continuation(this.actionId,(value:any)=>Promise.resolve(callback?.()).then(()=>value)),
        continuation(this.actionId,(error:any)=>Promise.resolve(callback?.()).then(()=>{throw error;}))),this.actionId);
    }
  }
  const causalPromise = (promise:Promise<any>, actionId:string):any => new CausalPromise(promise,actionId);
  const annotate = (input:any, init:any, actionId:string) => {
    // An intercepted header would change CORS request classification before
    // CDP can remove it. Same-origin business calls are sufficient for this
    // browser runtime and keep cross-origin application semantics untouched.
    let url = '';
    try { url = input instanceof Request ? input.url : new URL(String(input), global.location.href).href; }
    catch { return init; }
    if (new URL(url).origin !== global.location.origin) return init;
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set(marker, actionId);
    return { ...(init || {}), headers };
  };
  const fetchNative = global.fetch.bind(global);
  global.fetch = function(input:any, init?:any) {
    const actionId = active();
    const result = fetchNative(input, actionId ? annotate(input, init, actionId) : init);
    return actionId ? causalPromise(result,actionId) : result;
  };
  for (const method of ['arrayBuffer','blob','formData','json','text']) {
    const native = (Response.prototype as any)[method];
    if (typeof native !== 'function') continue;
    (Response.prototype as any)[method] = function(this:any, ...args:any[]) {
      const actionId = active(); const result = native.apply(this,args);
      return actionId ? causalPromise(result,actionId) : result;
    };
  }
  const XMLHttpRequestPrototype:any = global.XMLHttpRequest?.prototype;
  if (!XMLHttpRequestPrototype) return;
  const xhrOpen = XMLHttpRequestPrototype.open;
  const xhrSend = XMLHttpRequestPrototype.send;
  XMLHttpRequestPrototype.open = function(this:any, method:any, url:any, ...args:any[]) {
    this.__bstgCausalMethod = String(method || 'GET').toUpperCase();
    this.__bstgCausalUrl = String(url || '');
    return xhrOpen.call(this, method, url, ...args);
  };
  XMLHttpRequestPrototype.send = function(this:any, body?:any) {
    const actionId = active();
    if (actionId) {
      try {
        const url = new URL(this.__bstgCausalUrl || '', global.location.href);
        if (url.origin === global.location.origin) this.setRequestHeader(marker, actionId);
      } catch { /* native XHR retains its normal validation behavior */ }
    }
    return xhrSend.call(this, body);
  };
}

async function armCausalAction(entry:LiveBrowserContext, action:{id:string;taskId?:string;action:string;intent?:BusinessBrowserCaptureEvent["action_intent"]}, event:string):Promise<void> {
  const expiresAt = Date.now() + CAUSAL_ACTION_LIFETIME_MS;
  entry.causalActions.set(action.id, {...action,expiresAt});
  setTimeout(() => {
    const current = entry.causalActions.get(action.id);
    if (current?.expiresAt === expiresAt) entry.causalActions.delete(action.id);
  }, CAUSAL_ACTION_LIFETIME_MS + 50);
  await entry.page.evaluate(({id,eventName}:{id:string;eventName:string}) => {
    const state = (globalThis as any).__bstgCausalActionState;
    if (state) { state.expectedActionId=id; state.expectedEvent=eventName; }
  }, {id:action.id,eventName:event});
}

async function chromiumBrowser(scanRunId: string, taskId?: string): Promise<{browser: any; desktop?: DesktopSession}> {
  const mode = process.env.BSTG_BROWSER_MODE || 'headless';
  if (!['headless', 'headed', 'novnc'].includes(mode)) throw new Error('BSTG_BROWSER_MODE must be headless, headed or novnc.');
  const desktop = mode === 'novnc' ? await openDesktop({runId: scanRunId, taskId}) : undefined;
  try {
    const browser = await launchAssessmentBrowser({
      headless: mode === 'headless',
      chromiumSandbox: process.env.BSTG_BROWSER_ALLOW_NO_SANDBOX !== '1',
      ...(process.env.BSTG_CHROMIUM_EXECUTABLE ? {executablePath:process.env.BSTG_CHROMIUM_EXECUTABLE} : {}),
      ...(desktop ? {env: {...process.env, DISPLAY: desktop.display, XAUTHORITY: desktop.authority}} : {}),
      args: ['--window-size=1440,1000', '--window-position=0,0'],
    });
    browser.on('disconnected', () => { if (desktop && !desktop.closed) void desktop.close(); });
    return {browser, desktop};
  } catch (error) { await desktop?.close(); throw error; }
}

function liveKey(scanRunId: string, contextKey: string): string {
  return `${scanRunId}:${contextKey}`;
}

function assertContextBinding(input: { contextKey: string; scopeType: PersistentBrowserScope; identityKey: string }, actual: { scopeType: PersistentBrowserScope; identityKey: string }): void {
  if (actual.scopeType !== input.scopeType || actual.identityKey !== input.identityKey) {
    throw new Error(`Browser context binding mismatch for ${input.contextKey}: existing ${actual.scopeType}:${actual.identityKey || '-'} cannot be reused as ${input.scopeType}:${input.identityKey || '-'}`);
  }
}

export function isRecoverableBrowserContextRecord(record: { status?: string; expires_at?: string | null } | null | undefined, nowMs = Date.now()): boolean {
  if (!record || record.status !== 'active') return false;
  if (!record.expires_at) return true;
  return new Date(record.expires_at).getTime() > nowMs;
}

const CONTEXT_COMPONENT_LIMIT = 200;
// URI encoding can expand a single Unicode code point to twelve ASCII bytes.
// Keep the raw component limit as the authority, while allowing its canonical
// encoded representation to round-trip without treating valid identities as
// malformed context keys.
const CONTEXT_KEY_LIMIT = CONTEXT_COMPONENT_LIMIT * 12 + 'identity:'.length;

function contextComponent(value: unknown, label: string): string {
  const component = String(value ?? '');
  if (!component || component !== component.trim() || component.length > CONTEXT_COMPONENT_LIMIT || /[\u0000-\u001f\u007f]/.test(component)) {
    throw new Error(`${label} must be a bounded, canonical browser-context component`);
  }
  return component;
}

function canonicalContextKey(prefix: 'identity:' | 'task:', value: unknown, label: string): string {
  return `${prefix}${encodeURIComponent(contextComponent(value, label))}`;
}

function canonicalContextKeyValue(contextKey: string, prefix: 'identity:' | 'task:', label: string): string {
  const encoded = contextKey.slice(prefix.length);
  if (!encoded) throw new Error(`${label}-scoped browser context key requires a ${label}`);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new Error(`${label}-scoped browser context key is not valid URI encoding`);
  }
  const canonical = canonicalContextKey(prefix, decoded, label);
  if (contextKey !== canonical) throw new Error(`${label}-scoped browser context key must use canonical encoding`);
  return decoded;
}

export function browserContextKey(input: {
  scope_type?: PersistentBrowserScope;
  /**
   * A caller's policy default. It is deliberately distinct from scope_type:
   * canonical context keys such as identity:victim must retain their stored
   * binding when the caller did not explicitly ask to change it.
   */
  default_scope?: PersistentBrowserScope;
  task_id?: string;
  identity_key?: string;
  context_key?: string;
}): { key: string; scope: PersistentBrowserScope; identity: string } {
  const rawContextKey = input.context_key === undefined ? '' : String(input.context_key);
  if (rawContextKey && (rawContextKey !== rawContextKey.trim() || rawContextKey.length > CONTEXT_KEY_LIMIT || /[\u0000-\u001f\u007f]/.test(rawContextKey))) {
    throw new Error('browser context key must be bounded and canonical');
  }
  const contextKey = rawContextKey;
  const explicitScope = input.scope_type;
  const suppliedIdentity = input.identity_key === undefined ? '' : contextComponent(input.identity_key, 'identity');
  const suppliedTask = input.task_id === undefined ? '' : contextComponent(input.task_id, 'task');

  // Context keys are persisted audit identities, rather than opaque labels.
  // A subsequent model decision commonly carries only the key it learned from
  // browser evidence. Preserve that canonical binding before applying a tool
  // default; otherwise identity:victim could incorrectly become task-scoped.
  if (contextKey.startsWith('identity:')) {
    const identity = canonicalContextKeyValue(contextKey, 'identity:', 'identity');
    if (explicitScope && explicitScope !== 'identity') throw new Error(`Browser context scope conflicts with ${contextKey}`);
    if (suppliedIdentity && suppliedIdentity !== identity) throw new Error(`Browser context identity conflicts with ${contextKey}`);
    return { key: contextKey, scope: 'identity', identity };
  }
  if (contextKey.startsWith('task:')) {
    const task = canonicalContextKeyValue(contextKey, 'task:', 'task');
    if (explicitScope && explicitScope !== 'task') throw new Error(`Browser context scope conflicts with ${contextKey}`);
    if (!suppliedTask || suppliedTask !== task) throw new Error(`Browser task context ${contextKey} does not belong to the current task`);
    return { key: contextKey, scope: 'task', identity: suppliedIdentity };
  }
  if (contextKey.startsWith('scan:')) {
    if (contextKey !== 'scan:default') throw new Error('scan-scoped browser context key must be scan:default');
    if (explicitScope && explicitScope !== 'scan') throw new Error(`Browser context scope conflicts with ${contextKey}`);
    return { key: contextKey, scope: 'scan', identity: suppliedIdentity };
  }

  const scope = explicitScope || input.default_scope || (suppliedIdentity ? 'identity' : suppliedTask ? 'task' : 'scan');
  if (!['scan', 'task', 'identity'].includes(scope)) throw new Error('Browser context scope is invalid');
  const identity = suppliedIdentity;
  if (scope === 'identity' && !identity) throw new Error('identity_key is required for identity-scoped browser context');
  if (scope === 'task' && !suppliedTask) throw new Error('task_id is required for task-scoped browser context');
  if (contextKey) return { key: contextKey, scope, identity };
  if (scope === 'identity') {
    return { key: canonicalContextKey('identity:', identity, 'identity'), scope, identity };
  }
  if (scope === 'task') {
    return { key: canonicalContextKey('task:', suppliedTask, 'task'), scope, identity };
  }
  return { key: 'scan:default', scope: 'scan', identity };
}

async function closeLiveEntry(entry: LiveBrowserContext): Promise<void> {
  liveContexts.delete(liveKey(entry.scanRunId, entry.contextKey));
  // Close the page before draining requests so hanging HTTP bodies cannot keep
  // a cancelled desktop alive indefinitely.
  if (entry.businessCapture) entry.businessCapture.accepting = false;
  await entry.browserContext.close().catch(() => undefined);
  if (entry.businessCapture) await finishBusinessCapture(entry, 'context_closed');
  await Promise.allSettled([...entry.pendingCaptures]);
  await entry.browser.close().catch(() => undefined);
  await entry.desktop?.close();
}

async function finishBusinessCapture(entry: LiveBrowserContext, reason: BusinessCaptureEndReason): Promise<{id:string;errors:string[]}> {
  const capture = entry.businessCapture;
  if (!capture) throw new Error('No business capture is active in this browser context.');
  if(capture.ending)return capture.ending;
  capture.ending=(async()=>{
  capture.accepting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    Promise.allSettled([...capture.pending]).then(() => true),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 10000); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!drained) capture.errors.push('Capture ended with unfinished requests; the normal flow is incomplete.');
  capture.closed = true;
  if (entry.businessCapture === capture) entry.businessCapture = undefined;
  // The browser context survives a task-terminal interruption when it is an
  // identity/scan context.  Always release response observation in that case
  // so a subsequent normal flow starts from a clean capture boundary.  A
  // context that is already closing cannot reliably accept the CDP command.
  if(reason!=='context_closed')await entry.setResponseObservation?.(false).catch(error=>capture.errors.push(`Capture response observation could not be disabled: ${error?.message||String(error)}`));
  await capture.sink.ended?.(reason, [...capture.errors]);
  return {id:capture.sink.id,errors:[...capture.errors]};
  })();
  return capture.ending;
}

/** Attach to the owned context without navigating first; the first business
 * request is therefore recorded too. Input actions and capture changes share
 * the same lock. A task cannot replace another task's active capture. */
export async function startPersistentBusinessCapture(input: {
  repo:AIScanRepository; scanRunId:string; taskId?:string; scope_base_url:string;
  scope_type?:PersistentBrowserScope; identity_key?:string; context_key?:string;
  sink:BusinessBrowserCaptureSink; signal?:AbortSignal;
  /** Only prepared normal-flow captures install the restrictive credential boundary. */
  credential_boundary?: boolean;
  authentication_origins?: string[];
}):Promise<{context_key:string;capture_id:string}> {
  assertScanActive();
  const context=browserContextKey({scope_type:input.scope_type,task_id:input.taskId,identity_key:input.identity_key,context_key:input.context_key});
  const acquired=await getOrCreateLiveContext({repo:input.repo,scanRunId:input.scanRunId,taskId:input.taskId,scopeBaseUrl:input.scope_base_url,contextKey:context.key,scopeType:context.scope,identityKey:context.identity});
  if(!acquired)throw new Error('Browser capture runtime is unavailable.');
  const entry=acquired.entry,previous=entry.operationTail;let release!:()=>void;
  entry.operationTail=new Promise<void>(resolve=>{release=resolve;});await previous;
  try {
    assertScanActive();
    if(input.signal?.aborted || closingContextKeys.has(liveKey(input.scanRunId,context.key)) || liveContexts.get(liveKey(input.scanRunId,context.key))!==entry)throw new Error('Browser capture context ended.');
    if(entry.businessCapture)throw new Error('Stop the existing business capture before starting another flow.');
    if (input.credential_boundary) {
      const { installPersistentCredentialNetworkBoundary } = await import('./prepared-identity-login.js');
      // The context is a fresh blank task page at this point. Install before
      // capture.start returns, so the model's first browser.navigate cannot
      // let the login page cache an unguarded WebSocket/Worker constructor.
      await installPersistentCredentialNetworkBoundary({ browser_context: entry.browserContext, base_url: input.scope_base_url,
        authentication_origins: input.authentication_origins || entry.authenticationOrigins });
    }
    entry.businessCapture={sink:input.sink,sequence:0,accepting:true,closed:false,errors:[],pending:new Set(),lastRequestAt:Date.now(),ownerTaskId:input.taskId};
    for(const name of input.sink.sensitiveFieldNames||[])entry.observationSecrets.fields.add(name.toLowerCase());
    try{await entry.setResponseObservation?.(true);}catch(error){await finishBusinessCapture(entry,'context_closed');throw error;}
    return {context_key:context.key,capture_id:input.sink.id};
  } finally {release();}
}

export async function stopPersistentBusinessCapture(input: {
  scanRunId:string; taskId?:string; scope_type?:PersistentBrowserScope; identity_key?:string;
  context_key?:string; capture_id:string;
}):Promise<{id:string;errors:string[]}> {
  const context=browserContextKey({scope_type:input.scope_type,task_id:input.taskId,identity_key:input.identity_key,context_key:input.context_key});
  const entry=liveContexts.get(liveKey(input.scanRunId,context.key));
  if(!entry)throw new Error('Business capture browser context is no longer available.');
  assertContextBinding({contextKey:context.key,scopeType:context.scope,identityKey:context.identity},entry);
  if(context.scope==='task' && entry.taskOwnerId!==input.taskId)throw new Error('Browser task owner binding mismatch');
  const previous=entry.operationTail;let release!:()=>void;
  entry.operationTail=new Promise<void>(resolve=>{release=resolve;});await previous;
  try {
    if(entry.businessCapture?.sink.id!==input.capture_id || entry.businessCapture.ownerTaskId!==input.taskId)throw new Error('Business capture binding mismatch');
    return await finishBusinessCapture(entry,'stopped');
  } finally {release();}
}

/**
 * End recordings owned by a task without closing their browser context.
 *
 * Identity and scan contexts are deliberately shared across normal flows. A
 * terminal task therefore cannot use closeTaskBrowserContexts to release an
 * active capture there: that helper closes task-scoped contexts only. Serialize
 * against the same per-context lease as actions and explicit capture stops,
 * then mark the capture interrupted while keeping the authenticated browser
 * session available to the next task.
 */
export async function interruptPersistentBusinessCapturesForTask(input: {
  scanRunId: string;
  taskId: string;
}): Promise<{ interrupted: number; errors: string[] }> {
  const entries = [...liveContexts.values()].filter(entry =>
    entry.scanRunId === input.scanRunId && entry.businessCapture?.ownerTaskId === input.taskId,
  );
  let interrupted = 0;
  const errors: string[] = [];
  for (const entry of entries) {
    const previous = entry.operationTail;
    let release!: () => void;
    entry.operationTail = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      // Another terminal cleanup or an explicit stop may have settled the
      // capture while this task waited for the lease.
      if (entry.businessCapture?.ownerTaskId !== input.taskId) continue;
      await finishBusinessCapture(entry, 'task_terminal');
      interrupted += 1;
    } catch (error: any) {
      errors.push(`${entry.contextKey}: ${error?.message || String(error)}`);
    } finally {
      release();
    }
  }
  return { interrupted, errors };
}

async function createLiveContext(input: {
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  scopeBaseUrl: string;
  contextKey: string;
  scopeType: PersistentBrowserScope;
  identityKey: string;
}): Promise<{ entry: LiveBrowserContext; recovered: boolean; recordId?: string } | null> {
  const run = await input.repo.getRun(input.scanRunId);
  const authenticationOrigins = normalizeAuthenticationOrigins(run?.scan_config?.authentication_origins);
  const persisted = await input.repo.getBrowserContext(input.scanRunId, input.contextKey);
  if (persisted) {
    assertContextBinding(input, { scopeType: persisted.scope_type, identityKey: String(persisted.identity_key || '') });
    if(input.scopeType==='task' && persisted.task_id!==input.taskId)throw new Error('Browser task owner binding mismatch');
  }
  const recoverable = isRecoverableBrowserContextRecord(persisted);
  const expired = Boolean(persisted?.status === 'active' && !recoverable);
  if (expired && persisted) await input.repo.closeBrowserContextRecord(input.scanRunId, input.contextKey, 'expired').catch(() => undefined);
  const storageState = recoverable && persisted?.storage_state_json && Object.keys(persisted.storage_state_json).length > 0 ? persisted.storage_state_json : undefined;
  const {browser, desktop} = await chromiumBrowser(input.scanRunId, input.taskId);
  let browserContext: any; let page: any;
  try {
    browserContext = await browser.newContext({viewport:{width:desktop?.view.width || 1440, height:(desktop?.view.height || 1000) - 100},
      // Keep Chromium's default explicit. A private CA must be installed in
      // the worker/system trust store; there is no Playwright error bypass.
      ignoreHTTPSErrors:false, ...(storageState ? {storageState} : {})});
    await browserContext.addInitScript(causalActionInitScript);
    page = await browserContext.newPage();
  } catch (error) { await browser.close().catch(() => undefined); await desktop?.close(); throw error; }
  const entry: LiveBrowserContext = {
    scanRunId: input.scanRunId,
    contextKey: input.contextKey,
    scopeType: input.scopeType,
    identityKey: input.identityKey,
    taskOwnerId: input.taskId,
    browserContext, browser, desktop,
    page,
    networkEvents: [],
    lastUsedAt: Date.now(),
    operationTail: Promise.resolve(),
    pendingCaptures:new Set(),
    authenticationOrigins,
    observationSecrets:{fields:new Set(),values:new Set()},
    modelControlRefs:new Map(),
    causalActions:new Map(),
    targetTlsTrust:targetTlsTrustMetadata(),
  };
  try {
    entry.setResponseObservation=(await installNavigationGuard(browserContext,page,input.scopeBaseUrl,authenticationOrigins,message=>{entry.navigationError=message;},()=>entry.operationSignal,businessResponseObserver(entry,input.scopeBaseUrl))).setResponseObservation;
  }
  catch(error){await closeLiveEntry(entry);throw error;}
  const captureTask = input.taskId ? await input.repo.getTask(input.taskId) : null;
  const captureRequests = captureTask?.execution_plan?.intent === 'discover_target';
  function observePage(observed: any): void {
    const push = (event: Record<string, any>) => {
      entry.networkEvents.push({...event, at:new Date().toISOString()});
      if(entry.networkEvents.length>500)entry.networkEvents.splice(0,entry.networkEvents.length-500);
    };
    observed.on('request', (request:any)=>{
      push({type:'request',method:request.method(),url:request.url(),resource_type:request.resourceType()});
    });
    observed.on('response', (response:any)=>push({type:'response',status:response.status(),url:response.url(),content_type:response.headers()?.['content-type']}));
    observed.on('response',(response:any)=>{
      // A shared context can have originated in discovery. Once a normal
      // business capture owns it, its traffic belongs exclusively to the
      // task-bound private recorder and later selected-step promotion; never
      // also persist it as a generic raw endpoint baseline.
      if(entry.businessCapture?.accepting)return;
      if(!captureRequests || !['document','xhr','fetch'].includes(response.request().resourceType()))return;
      try{assertUrlInTargetScope(response.url(),input.scopeBaseUrl);}catch{return;}
      const save=(async()=>{
        const request=response.request(),url=new URL(request.url());
        const rawBody=request.postDataBuffer();
        const body=rawBody?.toString('utf8')??null;
        if(rawBody && !Buffer.from(body!,'utf8').equals(rawBody))return;
        if(body && Buffer.byteLength(body)>1024*1024)return;
        const headers=await request.allHeaders();
        // Discovery needs a durable distinction between document navigation
        // and an XHR/fetch operation. Both are useful context, but only the
        // latter can be a normal-business coverage target. Existing rows that
        // predate this provenance remain browser_network for compatibility.
        const sourceType=String(request.resourceType()||'').toLowerCase()==='document'?'browser_navigation':'browser_network';
        const endpoint=await input.repo.upsertEndpoint({scan_run_id:input.scanRunId,method:request.method(),path:url.pathname,url:url.toString(),
          source_type:sourceType,auth_required:!!(headers.authorization||headers.cookie),content_type:headers['content-type'],
          request_summary:`Observed ${request.method()} request`,response_summary:`HTTP ${response.status()}`});
        await input.repo.saveCapturedRequest(endpoint,{method:request.method(),url:url.toString(),headers,body:body??null,response_status:response.status(),captured_at:new Date().toISOString(),source:'browser'});
      })();
      entry.pendingCaptures.add(save);
      void save.catch(()=>undefined).finally(()=>entry.pendingCaptures.delete(save));
    });
    observed.on('requestfailed',(request:any)=>{
      const failure=request.failure()?.errorText||'unknown';
      push({type:'request_failed',method:request.method(),url:request.url(),failure});
    });
    observed.on('close',()=>{
      if(entry.page===observed){const remaining=browserContext.pages().filter((p:any)=>!p.isClosed());if(remaining.length){entry.page=remaining[remaining.length-1];void entry.page.bringToFront().catch(()=>undefined);}}
    });
  }
  observePage(page);
  desktop?.onClose(async () => {
    if (liveContexts.get(liveKey(entry.scanRunId, entry.contextKey)) === entry) liveContexts.delete(liveKey(entry.scanRunId, entry.contextKey));
    await browser.close().catch(() => undefined);
    if(entry.businessCapture)await finishBusinessCapture(entry,'context_closed');
  });
  // Popups are real pages in this same isolated desktop, never another tenant's browser.
  browserContext.on('page', (opened: any) => { observePage(opened); entry.page = opened; void opened.bringToFront().catch(() => undefined); });
  liveContexts.set(liveKey(input.scanRunId, input.contextKey), entry);
  return { entry, recovered: Boolean(storageState), recordId: persisted?.id };
}

async function getOrCreateLiveContext(input: {
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  scopeBaseUrl: string;
  contextKey: string;
  scopeType: PersistentBrowserScope;
  identityKey: string;
}): Promise<{ entry: LiveBrowserContext; recovered: boolean; recordId?: string } | null> {
  const key = liveKey(input.scanRunId, input.contextKey);
  if (closingContextKeys.has(key)) throw new Error(`Browser context is closing: ${input.contextKey}`);
  const existing = liveContexts.get(key);
  if (existing) {
    assertContextBinding(input, existing);
    if(input.scopeType==='task' && existing.taskOwnerId!==input.taskId)throw new Error('Browser task owner binding mismatch');
    // Do not evaluate TTL here: another Sub-Agent may currently be refreshing the
    // same context. Expiry is checked only after acquiring the per-context operation
    // lock so a queued caller can never close a page underneath an active navigation.
    existing.lastUsedAt = Date.now();
    const persisted = await input.repo.getBrowserContext(input.scanRunId, input.contextKey);
    return { entry: existing, recovered: false, recordId: persisted?.id };
  }
  const pending = contextCreationPromises.get(key);
  if (pending) {
    const result = await pending;
    if (result) {assertContextBinding(input, result.entry);if(input.scopeType==='task' && result.entry.taskOwnerId!==input.taskId)throw new Error('Browser task owner binding mismatch');}
    return result;
  }
  const creation = createLiveContext(input).finally(() => {
    if (contextCreationPromises.get(key) === creation) contextCreationPromises.delete(key);
  });
  contextCreationPromises.set(key, creation);
  return creation;
}

export async function navigatePersistentBrowser(input: {
  url: string;
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  timeout_ms?: number;
  scope_base_url: string;
  signal?: AbortSignal;
  scope_type?: PersistentBrowserScope;
  identity_key?: string;
  context_key?: string;
  ttl_seconds?: number;
  /** Install the prepared-credential boundary before this context first visits a login page. */
  credential_boundary?: boolean;
  /** Explicit SSO/login origins allowed only while prepared credentials are handled. */
  authentication_origins?: string[];
}): Promise<PersistentBrowserNavigationResult | null> {
  input={...input,signal:scanAbortSignal(input.signal)};
  assertUrlInTargetScope(input.url, input.scope_base_url);
  const context = browserContextKey({ scope_type: input.scope_type, task_id: input.taskId, identity_key: input.identity_key, context_key: input.context_key });
  const contextLiveKey = liveKey(input.scanRunId, context.key);
  if (closingContextKeys.has(contextLiveKey)) {
    return { ok: false, error_code:'browser_context_closing', error: 'Persistent browser context is closing' };
  }
  let acquired: Awaited<ReturnType<typeof getOrCreateLiveContext>>;
  try {
    acquired = await getOrCreateLiveContext({ repo: input.repo, scanRunId: input.scanRunId, taskId: input.taskId, scopeBaseUrl: input.scope_base_url, contextKey: context.key, scopeType: context.scope, identityKey: context.identity });
  } catch (error: any) {
    assertScanActive();
    const message = error?.message || String(error);
    if (/binding mismatch|context is closing/i.test(message)) {
      return { ok: false, error_code:'browser_context_binding_mismatch', error: message };
    }
    throw error;
  }
  if (!acquired) return null;
  if (closingContextKeys.has(contextLiveKey)) {
    return { ok: false, error_code:'browser_context_closing', error: 'Persistent browser context is closing' };
  }
  let { entry } = acquired;
  if(entry.businessCapture && entry.businessCapture.ownerTaskId!==input.taskId)return {ok:false,error_code:'browser_capture_owned_elsewhere',error:'Browser is recording another task\'s business flow.'};
  const previousOperation = entry.operationTail;
  let releaseOperation!: () => void;
  entry.operationTail = new Promise<void>(resolve => { releaseOperation = resolve; });
  await previousOperation;
  // A capture can begin while this caller waits behind another operation. Check
  // after acquiring the serial operation lease as well as before queueing so a
  // second task cannot inject requests into the first task's recording.
  if(entry.businessCapture && entry.businessCapture.ownerTaskId!==input.taskId) {
    releaseOperation();
    return {ok:false,error_code:'browser_capture_owned_elsewhere',error:'Browser is recording another task\'s business flow.'};
  }
  if (input.signal?.aborted) {
    releaseOperation();
    return { ok: false, error_code:'browser_navigation_aborted', error: 'Persistent browser navigation aborted before execution' };
  }
  // A previous queued operation may have closed/expired this context. Reacquire a fresh
  // context before touching its page; do not continue on a stale Playwright object.
  if (liveContexts.get(liveKey(input.scanRunId, context.key)) !== entry) {
    releaseOperation();
    return navigatePersistentBrowser(input);
  }
  // TTL is deliberately checked inside the operation lock. The preceding operation
  // may have just refreshed expires_at; checking before the lock could close an active
  // shared scan/identity context and cross-contaminate parallel Agent evidence.
  const persistedAfterWait = await input.repo.getBrowserContext(input.scanRunId, context.key);
  const expiredAfterWait = Boolean(persistedAfterWait?.status === 'active' && !isRecoverableBrowserContextRecord(persistedAfterWait));
  if (expiredAfterWait) {
    await closeLiveEntry(entry).catch(() => undefined);
    await input.repo.closeBrowserContextRecord(input.scanRunId, context.key, 'expired').catch(() => undefined);
    releaseOperation();
    return navigatePersistentBrowser(input);
  }
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void entry.browserContext.close().catch(() => undefined);
  };
  entry.operationSignal=input.signal;
  input.signal?.addEventListener('abort', onAbort, { once: true });
  entry.desktop?.activity(input.taskId, true);
  const actionId=randomUUID();
  try {
    entry.navigationError=undefined;
    if (input.credential_boundary) {
      const { installPersistentCredentialNetworkBoundary } = await import('./prepared-identity-login.js');
      // This is inside the serialized context lease and immediately precedes
      // page.goto. The installer rejects a previously navigated unguarded
      // context, so credential handling never starts after page scripts had an
      // opportunity to retain native network constructors.
      await installPersistentCredentialNetworkBoundary({
        browser_context: entry.browserContext,
        base_url: input.scope_base_url,
        authentication_origins: input.authentication_origins || entry.authenticationOrigins,
      });
    }
    const navigationStart=entry.networkEvents.length;
    await entry.page.bringToFront();
    await entry.page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: input.timeout_ms || 45000 });
    entry.rejectedInteraction=undefined;
    if (aborted) throw new Error('Persistent browser navigation aborted');
    await entry.page.waitForLoadState('networkidle',{timeout:3000}).catch(()=>undefined);
    if(entry.navigationError)throw new Error(entry.navigationError);
    if(entry.page.url().startsWith('chrome-error:')){
      const failure=entry.networkEvents.slice(navigationStart).filter(event=>event.type==='request_failed').at(-1);
      throw new Error(`浏览器未能加载目标页面：${failure?.failure || 'Chromium navigation failed'}`);
    }
    assertBrowserNavigationUrl(entry.page.url(), input.scope_base_url, entry.authenticationOrigins);
    await Promise.allSettled([...entry.pendingCaptures]);
    assertScanActive();
    const title = await entry.page.title();
    const screenshot = await entry.page.screenshot({ type: 'png', fullPage: false, mask: [entry.page.locator('input[type="password"],input[autocomplete="one-time-code"],[data-sensitive],pre,code')] }).catch(() => null);
    const domSummary = await safeBrowserObservation(entry,await entry.page.evaluate(() => {
      const doc = (globalThis as any).document;
      const loc = (globalThis as any).location;
      return {
        title: doc.title,
        url: loc.href,
        links: Array.from(doc.querySelectorAll('a[href]')).slice(0, 100).map((a: any) => a.href),
        forms: Array.from(doc.querySelectorAll('form')).map((form: any) => ({ method: form.method, action: form.action, enctype: form.enctype, inputs: Array.from(form.querySelectorAll('input,textarea,select')).map((i: any) => ({ name: i.name, type: i.type, placeholder: i.placeholder })) })),
        buttons: Array.from(doc.querySelectorAll('button,input[type=button],input[type=submit]')).slice(0, 80).map((b: any) => b.innerText || b.value || b.getAttribute('aria-label')),
        local_storage_keys: Object.keys((globalThis as any).localStorage || {}),
        session_storage_keys: Object.keys((globalThis as any).sessionStorage || {}),
      };
    }));
    const storageState = await entry.browserContext.storageState();
    const ttlSeconds = Math.max(60, Number(input.ttl_seconds || 3600));
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const record = await input.repo.upsertBrowserContext({
      scan_run_id: input.scanRunId,
      task_id: input.taskId,
      context_key: context.key,
      scope_type: context.scope,
      identity_key: context.identity,
      status: 'active',
      storage_state_json: storageState,
      current_url: domSummary.url || input.url,
      title,
      dom_summary_json: domSummary,
      network_summary_json: redactBrowserObservation(entry.observationSecrets,{ recent_events: entry.networkEvents.slice(-120), total_buffered: entry.networkEvents.length }),
      ttl_seconds: ttlSeconds,
      expires_at: expiresAt,
    });
    entry.lastUsedAt = Date.now();
    const observation = await observeInteractionRecovery(entry, entry.page);
    await input.repo.createArtifact({scan_run_id:input.scanRunId,task_id:input.taskId,artifact_type:'browser_state',title:'Private browser navigation evidence',
      content_json:{private:true,mode:'playwright',ok:true,action:'navigate',action_id:actionId,current_url:domSummary.url || input.url,
        title,dom_summary:domSummary,network_events:redactBrowserObservation(entry.observationSecrets,entry.networkEvents.slice(-300)),context_id:record.id},
      content_text:screenshot?.toString('base64'),source_ref:actionId});
    return projectBrowserToolResult({
      ok: true,
      action_id:actionId,
      current_url: domSummary.url || input.url,
      observation,
      recovered_from_storage_state: acquired.recovered,
    }) as unknown as PersistentBrowserNavigationResult;
  } catch (error: any) {
    assertScanActive();
    const failureStorageState = await entry.browserContext.storageState().catch(() => ({}));
    await input.repo.upsertBrowserContext({
      scan_run_id: input.scanRunId,
      task_id: input.taskId,
      context_key: context.key,
      scope_type: context.scope,
      identity_key: context.identity,
      status: aborted ? 'failed' : 'active',
      storage_state_json: failureStorageState,
      last_error: entry.navigationError || error.message || String(error),
    }).catch(() => undefined);
    if (aborted) await closeLiveEntry(entry).catch(() => undefined);
    return projectBrowserToolResult({ ok: false, error_code: 'browser_navigation_failed', failure_phase:'pre_action' }) as unknown as PersistentBrowserNavigationResult;
  } finally {
    entry.currentAction=undefined;
    if (entry.operationSignal === input.signal) entry.operationSignal=undefined;
    entry.desktop?.activity(input.taskId, false);
    input.signal?.removeEventListener('abort', onAbort);
    releaseOperation();
  }
}

export async function closePersistentBrowserContext(repo: AIScanRepository, scanRunId: string, contextKey: string, markStatus: 'closed' | 'expired' | 'failed' = 'closed'): Promise<void> {
  const key = liveKey(scanRunId, contextKey);
  closingContextKeys.add(key);
  try {
    const pending = contextCreationPromises.get(key);
    if (pending) await pending.catch(() => null);
    const entry = liveContexts.get(key);
    if (entry) {
      await entry.operationTail.catch(() => undefined);
      const current = liveContexts.get(key);
      if (current) await closeLiveEntry(current);
    }
    await repo.closeBrowserContextRecord(scanRunId, contextKey, markStatus);
  } finally {
    closingContextKeys.delete(key);
  }
}

/** Agent tasks can only release their own task-scoped context. Shared scan and
 * identity contexts are owned by the scan lifecycle, so a model cannot close
 * another task's active recording or session. Operator/API cleanup continues
 * to use closePersistentBrowserContext directly. */
export async function closeAgentTaskBrowserContext(repo: AIScanRepository, scanRunId: string, taskId: string | undefined, contextKey: string): Promise<void> {
  if (!taskId) throw new Error('A task-owned browser context requires a task id.');
  const key = liveKey(scanRunId, contextKey);
  closingContextKeys.add(key);
  try {
    const pending = contextCreationPromises.get(key);
    if (pending) await pending.catch(() => null);
    const entry = liveContexts.get(key);
    if (entry) await entry.operationTail.catch(() => undefined);
    const current = liveContexts.get(key);
    const persisted = await repo.getBrowserContext(scanRunId, contextKey);
    if (!current && !persisted) throw new Error('Browser context was not found.');
    const scope = current?.scopeType || persisted?.scope_type;
    const owner = current?.taskOwnerId || persisted?.task_id;
    if (scope !== 'task') throw new Error('Shared scan and identity browser contexts are closed by scan lifecycle cleanup.');
    if (owner !== taskId) throw new Error('Browser task owner binding mismatch.');
    if (current?.businessCapture && current.businessCapture.ownerTaskId !== taskId) throw new Error('Browser is recording another task\'s business flow.');
    if (current) await closeLiveEntry(current);
    await repo.closeBrowserContextRecord(scanRunId, contextKey, 'closed');
  } finally {
    closingContextKeys.delete(key);
  }
}

export async function closePersistentBrowserContextsForScan(repo: AIScanRepository, scanRunId: string, markStatus: 'closed' | 'expired' | 'failed' = 'closed'): Promise<number> {
  const prefix = `${scanRunId}:`;
  const keys = new Set<string>([
    ...[...liveContexts.keys()].filter(key => key.startsWith(prefix)),
    ...[...contextCreationPromises.keys()].filter(key => key.startsWith(prefix)),
  ]);
  for (const key of keys) closingContextKeys.add(key);
  try {
    const pending = [...contextCreationPromises.entries()].filter(([key]) => key.startsWith(prefix)).map(([, promise]) => promise.catch(() => null));
    if (pending.length > 0) await Promise.all(pending);
    const entries = [...liveContexts.values()].filter(entry => entry.scanRunId === scanRunId);
    for (const entry of entries) await entry.operationTail.catch(() => undefined);
    const currentEntries = [...liveContexts.values()].filter(entry => entry.scanRunId === scanRunId);
    for (const entry of currentEntries) await closeLiveEntry(entry);
    const records = await repo.listBrowserContexts(scanRunId);
    for (const record of records.filter(item => item.status === 'active')) await repo.closeBrowserContextRecord(scanRunId, record.context_key, markStatus);
    return currentEntries.length;
  } finally {
    for (const key of keys) closingContextKeys.delete(key);
  }
}

/** Release completed task-owned desktops promptly. Scan/identity contexts remain
 * shared and are released at scan completion or the bounded idle timeout. */
export async function closeTaskBrowserContexts(repo:AIScanRepository, scanRunId:string, taskId:string):Promise<number> {
  const contextKeys=new Set<string>([
    ...[...liveContexts.values()]
      .filter(entry=>entry.scanRunId===scanRunId && entry.scopeType==='task' && entry.taskOwnerId===taskId)
      .map(entry=>entry.contextKey),
    ...(await repo.listBrowserContexts(scanRunId))
      .filter(record=>record.scope_type==='task' && record.task_id===taskId && record.status==='active')
      .map(record=>record.context_key),
  ]);
  for(const contextKey of contextKeys)await closePersistentBrowserContext(repo,scanRunId,contextKey,'closed');
  return contextKeys.size;
}

export function getLiveBrowserContextCount(scanRunId?: string): number {
  return [...liveContexts.values()].filter(entry => !scanRunId || entry.scanRunId === scanRunId).length;
}

/** A trusted identity transition can replace the whole authenticated document.
 * Drop pre-login opaque handles before the next model turn; they must never
 * resolve against post-login structure. */
export async function invalidatePersistentBrowserObservationRefs(input: {
  scanRunId:string; taskId?:string; context_key?:string; scope_type?:PersistentBrowserScope; identity_key?:string;
}): Promise<void> {
  const context=browserContextKey({context_key:input.context_key,scope_type:input.scope_type,task_id:input.taskId,identity_key:input.identity_key});
  const entry=liveContexts.get(liveKey(input.scanRunId,context.key));
  if (!entry) return;
  for (const candidate of entry.modelControlRefs.values()) await candidate.element?.dispose?.().catch(() => undefined);
  entry.modelControlRefs.clear();
  entry.rejectedInteraction=undefined;
}

export type BrowserInteraction =
  | {action:'click'; selector?:string; control_ref?:string}
  | {action:'fill' | 'select'; selector?:string; control_ref?:string; value:string}
  // Omit selector to send a key to the page's current focus. A supplied
  // selector must resolve to one visible control and is never a page fallback.
  | {action:'press'; selector?:string; control_ref?:string; key:string}
  | {action:'scroll'; x?:number; y:number}
  | {action:'assert'; selector?:string; assertion_ref?:string; text?:string}
  | {action:'observe'};

interface BrowserInteractionResult {
  ok:boolean; current_url?:string; observation?:Record<string,unknown>;
  action_id?:string;
  error?:string; error_code?:string; match_count?:number; failure_phase?:string;
  action_performed?:boolean; retryable?:boolean; recovery_hint?:string;
  /**
   * Internal-only durable guard material for a dispatched action whose
   * post-action observation failed.  It is deliberately omitted by
   * projectBrowserToolResult, so it never enters model-visible invocation
   * history.  Agent lifecycle code persists it in a private, task-bound
   * recovery artifact and supplies it back to this trusted runtime before a
   * later operation can dispatch.
   */
  post_action_replay_guard?: { fingerprint: string };
}

const POST_ACTION_REPLAY_FINGERPRINT = /^[a-f0-9]{64}$/i;

/** A private structural identity for an actual browser control. It uses the
 * resolved server-side selector and closed observation metadata, never a
 * model-supplied label or page text.  Deliberately do not include the input
 * action: clicking a submit control and pressing Enter on that same control
 * can cause the same mutation, so a post-dispatch guard must cover both. The
 * digest is only an execution guard; the selector itself never leaves this
 * module. */
function postActionReplayFingerprint(operation: any, referenced?: LiveBrowserContext['modelControlRefs'] extends Map<string, infer T> ? T : never): string {
  const resolved = referenced ? {
    selector: referenced.selector,
    kind: referenced.kind,
    tag: referenced.tag,
    type: referenced.type,
    intent: referenced.intent || '',
  } : {
    selector: typeof operation?.selector === 'string' ? operation.selector : '',
    key: typeof operation?.key === 'string' ? operation.key : '',
    x: Number.isFinite(operation?.x) ? Number(operation.x) : 0,
    y: Number.isFinite(operation?.y) ? Number(operation.y) : 0,
  };
  return createHash('sha256').update(JSON.stringify({ resolved })).digest('hex');
}

/**
 * Direct runtime users (recording and local regression callers) need a stable
 * diagnosis, but raw Playwright exceptions are page-derived and must never be
 * handed to a model.  Agent persistence applies projectBrowserToolResult at
 * the tool boundary; this local shape keeps only server-authored constants.
 */
function localBrowserInteractionResult(value: Record<string, any>): BrowserInteractionResult {
  const result = projectBrowserToolResult(value) as unknown as BrowserInteractionResult;
  // This is intentionally attached only after the model-facing projection.
  // AgentToolRegistry applies the projection again before persistence, while
  // the immediate trusted caller can create the private replay guard.
  const fingerprint = typeof value.post_action_replay_guard?.fingerprint === 'string'
    ? value.post_action_replay_guard.fingerprint : '';
  if (POST_ACTION_REPLAY_FINGERPRINT.test(fingerprint)) {
    result.post_action_replay_guard = { fingerprint: fingerprint.toLowerCase() };
  }
  const recoveryHints = new Set([
    'The observed control reference is no longer current. Observe again before choosing an action.',
    'The observed reference cannot perform this action. Observe the current controls and choose a matching reference.',
    'Selector must identify exactly one visible control. Choose from observed controls; do not repeat the rejected selector or invent a label.',
    'The observed control is disabled; do not force the action.',
    'No click was dispatched: readiness checks timed out. Inspect dialog controls and receives_pointer; choose an observed safe close/cancel action or another reachable control. Do not force clicks or replay unchanged actions.',
    'The expected page text was not observed. No browser action was dispatched. Review the current visible state and choose a current evidence-backed action or assertion; do not repeat the unchanged assertion.',
    'No browser action was dispatched. Review the current browser state before choosing another action.',
    'The browser action may have occurred. Do not retry it; verify the resulting state.',
    'A prior browser action may already have occurred. Do not dispatch the same operation again; inspect or verify the recorded outcome.',
  ]);
  if (typeof value.recovery_hint === 'string' && recoveryHints.has(value.recovery_hint)) result.recovery_hint = value.recovery_hint;
  if (value.error === 'Unsupported business key') result.error = value.error;
  else if (value.error === 'Browser operation failed before dispatch.') result.error = value.error;
  else if (value.error === 'Browser action may have failed after dispatch.') result.error = value.error;
  return result;
}

const SAFE_OBSERVED_SELECTOR_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,119}$/;
const SAFE_OBSERVED_SELECTOR_NAME = /^[A-Za-z0-9_.:-]{1,120}$/;
const SAFE_STRUCTURAL_SELECTOR = /^(?:[a-z][a-z0-9-]*:nth-of-type\([1-9][0-9]{0,3}\))(?: > [a-z][a-z0-9-]*:nth-of-type\([1-9][0-9]{0,3}\)){0,11}$/;

/**
 * Model-visible controls need an exact, live-checked selector candidate. A
 * tag/name/text description alone invites a model to synthesize a selector
 * that is stale, overly broad, or simply not part of the observed page. The
 * candidate is deliberately derived only from non-sensitive visible metadata,
 * and it is published only after the same visible-locator contract used by an
 * interaction proves that it currently has one match.
 */
function observedSelectorSeeds(item: Record<string, any>, kind: 'control' | 'assertion_target'): string[] {
  const tag = String(item.tag || '').toLowerCase();
  // Anchor eligibility is decided inside the private DOM observation. Apply it
  // before considering stable ids/names as well as structural fallbacks: a
  // dangerous or off-origin link must never receive an opaque model ref.
  if (kind === 'control' && tag === 'a' && item.navigation_eligible !== true) return [];
  const id = String(item.id || '');
  const name = String(item.name || '');
  const seeds: string[] = [];
  if (SAFE_OBSERVED_SELECTOR_ID.test(id)) seeds.push(`#${id}`);
  if (kind === 'control' && tag && SAFE_OBSERVED_SELECTOR_NAME.test(name)) seeds.push(`${tag}[name=${JSON.stringify(name)}]`);
  // Id- and name-less controls are common after a prepared login. A bounded
  // nth-of-type path is generated inside the private page evaluation below;
  // it carries structure only, never a DOM value, label, href, or selector to
  // the model. Keep it as a fallback so stable public ids remain preferred.
  const structural = String(item.structure_selector || '');
  if (!seeds.length && SAFE_STRUCTURAL_SELECTOR.test(structural)) seeds.push(structural);
  return [...new Set(seeds)];
}

/** Convert private DOM wording to a closed, non-content action class.  This
 * is a classifier for model usability, not a redaction rule: the source words
 * never leave this process and only one finite enum value is emitted. */
export function localControlIntent(item: Record<string, any>): 'authenticate'|'continue'|'submit'|'cancel'|'add'|'review'|'confirm'|'checkout'|'search'|'navigation'|'generic' {
  if (String(item.tag || '').toLowerCase() === 'a') return 'navigation';
  const source = [item.type, item.role, item.label, item.text, item.name, item.id].filter(value => typeof value === 'string').join(' ').toLowerCase();
  if (/login|log[ _-]?in|sign[ _-]?in|authenticate|auth/.test(source)) return 'authenticate';
  // These source words are used only inside the private browser runtime.  The
  // model receives the resulting finite enum, never the label/text/name that
  // selected it.  Keep review and final confirmation separate: treating both
  // as `checkout` forces an Agent to guess an ordered transaction from two
  // otherwise indistinguishable opaque controls.
  if (/confirm|place[ _-]?(?:order|purchase)|complete[ _-]?(?:order|purchase)|finali[sz]e/.test(source)) return 'confirm';
  if (/review|preview|quote|summary/.test(source)) return 'review';
  if (/checkout|purchase|pay|payment/.test(source)) return 'checkout';
  if (/add|cart|basket/.test(source)) return 'add';
  if (/search|find|query/.test(source)) return 'search';
  if (/cancel|close|dismiss|back/.test(source)) return 'cancel';
  if (/continue|next|proceed|forward/.test(source)) return 'continue';
  if (/submit|save|confirm|send|apply|update/.test(source)) return 'submit';
  return 'generic';
}

function localNavigationTarget(item: Record<string, any>): 'profile'|'cart'|'notes'|'settings'|'orders'|'checkout'|'search'|'home'|'authentication'|'other'|undefined {
  if (String(item.tag || '').toLowerCase() !== 'a') return undefined;
  let path = '';
  try { path = new URL(String(item.href || ''), 'https://browser-model.invalid').pathname.toLowerCase(); }
  catch { return 'other'; }
  // These private DOM attributes are deliberately classified here, before
  // projection.  A model receives only the closed enum below, never the
  // href, accessible name, title, or visible text used to select it.
  const words = [item.label, item.text, item.title, item.name, item.id]
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const source = `${path} ${words}`;
  if (/(?:^|\/)profile(?:\/|$)|(?:^|\/)account(?:\/|$)|\b(?:personal details|my details|my profile)\b/.test(source)) return 'profile';
  if (/(?:^|\/)cart(?:\/|$)|(?:^|\/)basket(?:\/|$)|\b(?:desk supplies|supplies|shopping cart|my cart)\b/.test(source)) return 'cart';
  if (/(?:^|\/)notes?(?:\/|$)|\b(?:notebook|my notes?)\b/.test(source)) return 'notes';
  if (/(?:^|\/)settings?(?:\/|$)|\b(?:preferences|configuration)\b/.test(source)) return 'settings';
  if (/(?:^|\/)orders?(?:\/|$)|\b(?:purchases|purchase history|order history)\b/.test(source)) return 'orders';
  if (/(?:^|\/)checkout(?:\/|$)|(?:^|\/)payment(?:\/|$)|\b(?:check out|payment)\b/.test(source)) return 'checkout';
  if (/(?:^|\/)search(?:\/|$)|\b(?:search|find)\b/.test(source)) return 'search';
  if (path === '/' || path === '') return 'home';
  if (/(?:^|\/)(?:login|log-in|signin|sign-in|auth)(?:\/|$)|\b(?:log[ -]?in|sign[ -]?in)\b/.test(source)) return 'authentication';
  return 'other';
}

/** Private semantic binding for an anchor. The source route and attributes
 * never leave the runtime; the digest lets dispatch prove they did not mutate
 * after the opaque ref was issued. */
function anchorSafetyFingerprint(item: Record<string, any>): string | undefined {
  if (String(item.tag || '').toLowerCase() !== 'a' || item.navigation_eligible !== true) return undefined;
  const source = item.navigation_fingerprint_source;
  if (!source || typeof source !== 'object' || typeof source.href !== 'string' ||
      typeof source.target !== 'string' || typeof source.download !== 'boolean' ||
      typeof source.label !== 'string' || typeof source.title !== 'string' ||
      typeof source.text !== 'string') return undefined;
  return createHash('sha256').update(JSON.stringify([
    true, source.href, source.target, source.download,
    localNavigationTarget({tag:'a', href:source.href, label:source.label, title:source.title, text:source.text}),
  ])).digest('hex');
}

function opaqueReferenceActionCompatible(reference: { kind:'control'|'assertion_target'; tag:string; type:string; role:string }, action: string): boolean {
  if (reference.kind === 'assertion_target') return action === 'assert';
  if (action === 'assert') return false;
  const tag = reference.tag.toLowerCase();
  const type = reference.type.toLowerCase();
  const interactive = ['a','button','input','textarea','select'].includes(tag) || ['button','link'].includes(reference.role.toLowerCase());
  if (action === 'click' || action === 'press') return interactive;
  if (action === 'select') return tag === 'select';
  if (action === 'fill') return tag === 'textarea' || (tag === 'input' && !['button','checkbox','file','hidden','image','radio','reset','submit'].includes(type));
  return false;
}

async function attachObservedSelectorCandidates(entry: LiveBrowserContext, page: any, observation: Record<string, any>): Promise<Record<string, any>> {
  for (const candidate of entry.modelControlRefs.values()) await candidate.element?.dispose?.().catch(() => undefined);
  entry.modelControlRefs.clear();
  const projected: Record<string, any> = {};
  for (const [property, kind] of [['controls', 'control'], ['assertion_targets', 'assertion_target']] as const) {
    const items = Array.isArray(observation[property]) ? observation[property] : [];
    const safeItems: Record<string, any>[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      // Eligibility is a collection boundary, rather than merely a structural
      // selector fallback. This prevents #id and [name] from reviving an
      // unsafe anchor as an opaque model control.
      if (kind === 'control' && String(item.tag || '').toLowerCase() === 'a' && item.navigation_eligible !== true) continue;
      for (const selector of observedSelectorSeeds(item, kind)) {
        try {
          // The candidate must obey the exact same live visible-uniqueness
          // rule as browser.interact. It remains advisory evidence, and the
          // action path repeats this guard immediately before dispatch.
          const locator = page.locator(selector).and(page.locator(':visible'));
          const matches = await locator.count();
          if (matches === 1) {
            const element = await locator.elementHandle();
            if (!element) continue;
            const ref = `${kind === 'control' ? 'control' : 'assertion'}_${randomUUID()}`;
            const intent = kind === 'control' ? localControlIntent(item) : undefined;
            entry.modelControlRefs.set(ref, { selector, kind, element,
              tag:String(item.tag || '').toLowerCase(), type:String(item.type || '').toLowerCase(), role:String(item.role || '').toLowerCase(), intent,
              anchorSafetyFingerprint:anchorSafetyFingerprint(item) });
            safeItems.push(kind === 'control'
              ? { control_ref: ref, tag: item.tag, role: item.role, type: item.type, disabled: item.disabled,
                intent, navigation_target: localNavigationTarget(item), in_dialog: item.in_dialog, receives_pointer: item.receives_pointer, form_index: item.form_index }
              : { assertion_ref: ref, tag: item.tag, role: item.role });
            break;
          }
        } catch {
          // A page-originated label can still form an unsupported locator on a
          // particular Playwright engine. Omit it rather than exposing a
          // candidate the action layer cannot prove unique.
        }
      }
    }
    if (safeItems.length) projected[property] = safeItems;
  }
  return projected;
}

/** Bounded metadata only. Prioritize dialog controls so an overlay's close action
 * survives projection even when the underlying page contains many controls. */
async function observeInteractionRecovery(entry:LiveBrowserContext, page:any):Promise<Record<string,unknown>> {
  const observation = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const clip = (value:any) => typeof value === 'string' ? value.slice(0,80) : null;
    const sensitive = /password|passwd|secret|token|csrf|ticket|otp|passcode|session|verification|^_g$/i;
    const visible = (e:any) => {
      const style = (globalThis as any).getComputedStyle(e);
      return !e.closest('[data-sensitive], [aria-hidden="true"]') &&
        !e.querySelector('[data-sensitive],input,textarea,select') && e.type !== 'password' &&
        e.autocomplete !== 'one-time-code' && !sensitive.test(e.name || e.id || '') &&
        style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
        Array.from(e.getClientRects()).some((r:any) => r.width > 0 && r.height > 0);
    };
    const dialogSelector = 'dialog[open],[role="dialog"],[aria-modal="true"]';
    const safeNavigationAnchor = (element:any) => {
      if (element.tagName.toLowerCase() !== 'a' || element.hasAttribute('download')) return false;
      const target = String(element.getAttribute('target') || '').toLowerCase();
      if (target && target !== '_self') return false;
      let url:any;
      try { url = new URL(String(element.getAttribute('href') || ''), (globalThis as any).location.href); } catch { return false; }
      if (!['http:','https:'].includes(url.protocol) || url.origin !== (globalThis as any).location.origin) return false;
      return !/(?:^|\/)(?:logout|log-out|signout|sign-out|delete|remove|destroy|terminate|close-account)(?:\/|$)/i.test(url.pathname);
    };
    const structureSelector = (element:any) => {
      const parts:string[]=[];let current=element;
      while(current && current.nodeType===1 && parts.length<12) {
        const tag=String(current.tagName||'').toLowerCase();
        if(!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
        let index=1,sibling=current.previousElementSibling;
        while(sibling){if(String(sibling.tagName||'').toLowerCase()===tag)index++;sibling=sibling.previousElementSibling;}
        if(index>9999)return null;
        parts.unshift(`${tag}:nth-of-type(${index})`);
        if(tag==='html')break;
        current=current.parentElement;
      }
      return parts[0]?.startsWith('html:nth-of-type(1)') ? parts.join(' > ') : null;
    };
    const controls = Array.from(doc.querySelectorAll('button,a[href],input,textarea,select,[role="button"]'))
      .filter(visible).sort((a:any,b:any) => Number(!!b.closest(dialogSelector))-Number(!!a.closest(dialogSelector)))
      .slice(0,20).map((e:any) => {
        const rect=e.getBoundingClientRect(),hit=doc.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
        const form=e.closest('form');
        const tag=e.tagName.toLowerCase(),href=String(e.getAttribute('href')||''),target=String(e.getAttribute('target')||'');
        const navigationEligible=tag!=='a'||safeNavigationAnchor(e);
        return {tag,id:clip(e.id),role:clip(e.getAttribute('role')),
          label:clip(e.getAttribute('aria-label')),title:clip(e.getAttribute('title')),text:clip(['INPUT','TEXTAREA','SELECT'].includes(e.tagName)?'':e.innerText),
          name:clip(e.getAttribute('name')),type:clip(e.getAttribute('type')),disabled:!!e.disabled,in_dialog:!!e.closest(dialogSelector),
          href:clip(href),navigation_eligible:navigationEligible,
          navigation_fingerprint_source:tag==='a'?{
            href,target,download:e.hasAttribute('download'),
            label:String(e.getAttribute('aria-label')||''),title:String(e.getAttribute('title')||''),
            text:String(e.innerText||''),
          }:undefined,
          structure_selector:navigationEligible?structureSelector(e):null,
          form_index:form ? Array.from(doc.querySelectorAll('form')).indexOf(form) : undefined,
          receives_pointer:!!hit && (hit===e || e.contains(hit))};
      });
    // State assertions often target a visible status element rather than a
    // clickable control. Keep only non-sensitive, non-form, non-code IDs; an
    // exact selector is attached below after live uniqueness verification.
    const assertion_targets = Array.from(doc.querySelectorAll('[id]')).filter((e:any) => {
      const tag = e.tagName.toLowerCase();
      return !['button','a','input','textarea','select','pre','code','script','style'].includes(tag) && visible(e);
    }).slice(0,20).map((e:any) => ({
      tag:e.tagName.toLowerCase(),id:clip(e.id),role:clip(e.getAttribute('role')),label:clip(e.getAttribute('aria-label')),
    }));
    return {controls,assertion_targets}; // Private source data; only opaque references are returned below.
  });
  return attachObservedSelectorCandidates(entry, page, observation);
}

/** Actions execute inside the already-created, streamed browser, never a viewer-owned copy. */
export async function interactPersistentBrowser(input: {
  repo: AIScanRepository; scanRunId:string; taskId?:string; context_key?:string;
  scope_type?:PersistentBrowserScope; identity_key?:string; scope_base_url:string;
  operation:BrowserInteraction; signal?:AbortSignal; timeout_ms?:number;
  /** Trusted lifecycle input only; never accepted from the model tool schema. */
  post_action_replay_fingerprints?: string[];
}): Promise<BrowserInteractionResult> {
  input={...input,signal:scanAbortSignal(input.signal)};
  const context=browserContextKey({context_key:input.context_key,scope_type:input.scope_type,task_id:input.taskId,identity_key:input.identity_key}); const key=liveKey(input.scanRunId,context.key);
  const entry=liveContexts.get(key);
  if(!entry || entry.desktop?.closed || closingContextKeys.has(key))return localBrowserInteractionResult({ok:false,error_code:'browser_context_unavailable'});
  assertContextBinding({contextKey:context.key,scopeType:context.scope,identityKey:context.identity},entry);
  if(context.scope==='task' && entry.taskOwnerId!==input.taskId)return localBrowserInteractionResult({ok:false,error_code:'browser_context_binding_mismatch'});
  if(entry.businessCapture && entry.businessCapture.ownerTaskId!==input.taskId)return localBrowserInteractionResult({ok:false,error_code:'browser_capture_owned_elsewhere'});
  const previous=entry.operationTail;let release!:()=>void;
  entry.operationTail=new Promise<void>(resolve=>{release=resolve;});await previous;
  if(entry.businessCapture && entry.businessCapture.ownerTaskId!==input.taskId) {
    release();
    return localBrowserInteractionResult({ok:false,error_code:'browser_capture_owned_elsewhere'});
  }
  const aborted=()=>{void entry.page.close().catch(()=>undefined);};
  const actionId=randomUUID();
  let actionStarted=false,actionCompleted=false,actionReplayFingerprint='';
  try {
    entry.operationSignal=input.signal;
    if(input.signal?.aborted || entry.desktop?.closed || liveContexts.get(key)!==entry)throw new Error('Browser operation cancelled or context ended');
    assertUrlInTargetScope(entry.page.url(),input.scope_base_url);
    input.signal?.addEventListener('abort',aborted,{once:true});
    const requestedOperation=input.operation;
    const ref = typeof (requestedOperation as any).control_ref === 'string' ? (requestedOperation as any).control_ref
      : typeof (requestedOperation as any).assertion_ref === 'string' ? (requestedOperation as any).assertion_ref : undefined;
    const referenced = ref ? entry.modelControlRefs.get(ref) : undefined;
    const op:any = referenced ? {...requestedOperation,selector:referenced.selector} : requestedOperation;
    actionReplayFingerprint = postActionReplayFingerprint(op, referenced as any);
    const guardedFingerprints = new Set((Array.isArray(input.post_action_replay_fingerprints)
      ? input.post_action_replay_fingerprints : []).filter((fingerprint): fingerprint is string =>
        typeof fingerprint === 'string' && POST_ACTION_REPLAY_FINGERPRINT.test(fingerprint)).map(fingerprint => fingerprint.toLowerCase()));
    const timeout=Math.max(500,Math.min(30000,Number(input.timeout_ms)||10000));
    if(op.action==='press' && !['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Space'].includes(op.key))
      return localBrowserInteractionResult({ok:false,error:'Unsupported business key',error_code:'browser_key_unsupported',failure_phase:'pre_action',action_performed:false,retryable:false,
        recovery_hint:'No browser action was dispatched. Review the current browser state before choosing another action.'});
    entry.desktop?.activity(input.taskId,true);await entry.page.bringToFront();
    // Keep a retry marker for the exact failed assertion without retaining its
    // text in the live browser state. An assertion with a revised expected
    // value remains a new model decision; repeating the same assertion is not.
    const assertionTextDigest=op.action==='assert'&&typeof op.text==='string'
      ? createHash('sha256').update(op.text).digest('hex') : null;
    const signature=JSON.stringify([entry.page.url(),op.action,ref || ('selector' in op?op.selector:null),assertionTextDigest]);
    const rejectBeforeAction=async(errorCode:string,hint:string,matches?:number,retryable=true):Promise<BrowserInteractionResult> => {
      const observation=await observeInteractionRecovery(entry,entry.page);
      if(input.signal?.aborted)throw new Error('Browser operation cancelled');
      assertUrlInTargetScope(entry.page.url(),input.scope_base_url);
      const result=localBrowserInteractionResult({ok:false,error_code:errorCode,
        match_count:matches,failure_phase:'pre_action',action_performed:false,retryable,recovery_hint:hint,observation});
      entry.rejectedInteraction={signature,result:result as unknown as BrowserInteractionResult};
      return result as unknown as BrowserInteractionResult;
    };
    if (ref && !referenced) return await rejectBeforeAction('observation_reference_expired','The observed control reference is no longer current. Observe again before choosing an action.');
    if (referenced) {
      try {
        const locator = entry.page.locator(referenced.selector).and(entry.page.locator(':visible'));
        if (await locator.count() !== 1) return await rejectBeforeAction('observation_reference_expired','The observed control reference is no longer current. Observe again before choosing an action.');
        const currentElement = await locator.elementHandle();
        const bound = currentElement && await referenced.element.evaluate((element:any, expected:any) => element === expected, currentElement);
        await currentElement?.dispose?.().catch(() => undefined);
        if (!bound) return await rejectBeforeAction('observation_reference_expired','The observed control reference is no longer current. Observe again before choosing an action.');
        if (referenced.anchorSafetyFingerprint) {
          const anchor = await referenced.element.evaluate((element:any) => {
            if (String(element.tagName || '').toLowerCase() !== 'a' || element.hasAttribute('download')) return {tag:'a', navigation_eligible:false};
            const target = String(element.getAttribute('target') || '');
            if (target && target.toLowerCase() !== '_self') return {tag:'a', navigation_eligible:false};
            let url:any;
            try { url = new URL(String(element.getAttribute('href') || ''), (globalThis as any).location.href); }
            catch { return {tag:'a', navigation_eligible:false}; }
            const eligible = ['http:','https:'].includes(url.protocol) && url.origin === (globalThis as any).location.origin &&
              !/(?:^|\/)(?:logout|log-out|signout|sign-out|delete|remove|destroy|terminate|close-account)(?:\/|$)/i.test(url.pathname);
            return {tag:'a', navigation_eligible:eligible,
              navigation_fingerprint_source:{
                href:String(element.getAttribute('href') || ''), target, download:false,
                label:String(element.getAttribute('aria-label') || ''), title:String(element.getAttribute('title') || ''),
                text:String(element.innerText || ''),
              }};
          });
          if (anchorSafetyFingerprint(anchor) !== referenced.anchorSafetyFingerprint)
            return await rejectBeforeAction('observation_reference_expired','The observed control reference is no longer current. Observe again before choosing an action.');
        }
      } catch {
        return await rejectBeforeAction('observation_reference_expired','The observed control reference is no longer current. Observe again before choosing an action.');
      }
    }
    if (referenced && !opaqueReferenceActionCompatible(referenced, requestedOperation.action)) {
      return await rejectBeforeAction('observation_reference_action_mismatch','The observed reference cannot perform this action. Observe the current controls and choose a matching reference.',undefined,false);
    }
    // An earlier action crossed the dispatch boundary but lost its observation.
    // Re-resolving a fresh opaque handle is not enough to make the same
    // private control safe to press again.  Reject before locator dispatch;
    // a different model-selected control can still advance the active Flow.
    if (!['observe', 'assert'].includes(op.action) && guardedFingerprints.has(actionReplayFingerprint.toLowerCase())) {
      return localBrowserInteractionResult({
        ok: false,
        error_code: 'post_action_replay_blocked',
        failure_phase: 'pre_action',
        action_performed: false,
        retryable: false,
        recovery_hint: 'A prior browser action may already have occurred. Do not dispatch the same operation again; inspect or verify the recorded outcome.',
      });
    }
    // Do not spend another visibility/actionability timeout on an unchanged bad
    // action. A successful observe or different action clears this guard.
    if(entry.rejectedInteraction?.signature===signature) return localBrowserInteractionResult({...entry.rejectedInteraction.result,retryable:false,
      error_code:'selector_correction_repeated'});
    let locator:any;
    if('selector' in op) {
      if(typeof op.selector!=='string' || !op.selector || op.selector.length>1000)throw new Error('A bounded, unique selector is required');
      const allMatches=entry.page.locator(op.selector);
      // Intersect the original selector with visibility, including non-CSS
      // engines and CSS unions. Keep this live locator for readiness AND
      // dispatch so hidden copies do not count and later duplicates stay strict.
      locator=allMatches.and(entry.page.locator(':visible'));
      let matches:number;
      try {
        matches=await locator.count();
      } catch(error:any) {
        if(/(?:Unexpected token|not a valid (?:selector|XPath expression)|Error while parsing selector|Unknown engine|Unknown attribute|Invalid regular expression|InvalidSelectorError)/i.test(error?.message||''))
          return await rejectBeforeAction('selector_invalid','Selector syntax is invalid. Use a unique selector from the observed control metadata; do not guess labels.');
        throw error;
      }
      if(matches<=1) {
        try {await locator.waitFor({state:'visible',timeout});}
        catch(error:any) {if(error?.name!=='TimeoutError')throw error;}
        matches=await locator.count();
      }
      const selectorError = matches === 0
        ? ((await allMatches.count()) === 0 ? 'selector_no_match' : 'selector_not_visible')
        : matches > 1 ? 'selector_ambiguous'
        : !(await locator.isVisible()) ? 'selector_not_visible' : undefined;
      if(selectorError) return await rejectBeforeAction(selectorError,
        'Selector must identify exactly one visible control. Choose from observed controls; do not repeat the rejected selector or invent a label.',matches);
      if(op.action==='click') {
        // Playwright trial performs readiness checks without dispatching a click.
        // Never classify a timeout from the actual click by its error wording:
        // navigation may time out after the business action already happened.
        if(!(await locator.isEnabled())) return await rejectBeforeAction('selector_not_enabled','The observed control is disabled; do not force the action.',matches,false);
        try {await locator.click({timeout,trial:true});}
        catch(error:any) {
          if(error?.name!=='TimeoutError')throw error;
          return await rejectBeforeAction('selector_actionability_timeout',
            'No click was dispatched: readiness checks timed out. Inspect dialog controls and receives_pointer; choose an observed safe close/cancel action or another reachable control. Do not force clicks or replay unchanged actions.',matches);
        }
      }
    }
    if(input.signal?.aborted)throw new Error('Browser operation cancelled');
    assertUrlInTargetScope(entry.page.url(),input.scope_base_url);
    actionStarted=!['observe','assert'].includes(op.action);
    // The marker begins immediately before Playwright crosses the actual input
    // dispatch boundary.  It is cleared immediately afterwards; waiting for
    // a response is deliberately not an attribution window.
    if(actionStarted){
      entry.currentAction={id:actionId,taskId:input.taskId,action:op.action,dispatching:true};
      const eventName = op.action === 'click' ? 'click'
        : op.action === 'press' ? 'keydown'
        : op.action === 'scroll' ? 'wheel' : 'input';
      await armCausalAction(entry,{id:actionId,taskId:input.taskId,action:op.action,
        ...(op.action==='click'&&referenced?.kind==='control'&&referenced.intent?{intent:referenced.intent}:{})},eventName);
    }
    if(op.action==='click')await locator.click({timeout});
    else if(op.action==='fill' || op.action==='select') {
      if(typeof op.value!=='string' || op.value.length>10000)throw new Error('Invalid input length');
      const sensitive=await locator.evaluate((element:any)=>element.type==='password'||element.type==='hidden'||element.autocomplete==='one-time-code'||/password|passwd|secret|token|csrf|ticket|otp|passcode|session|verification|^_g$/i.test(element.name||element.id));
      if(sensitive)rememberBrowserSecret(entry.observationSecrets,op.value);
      if(op.action==='fill')await locator.fill(op.value,{timeout});else await locator.selectOption(op.value,{timeout});
    } else if(op.action==='press') {
      // Both calls cross the dispatch boundary exactly once. Never fall back
      // or retry if a key was sent but transport/navigation/observation failed.
      if('selector' in op)await locator.press(op.key,{timeout});
      else await entry.page.keyboard.press(op.key);
    } else if(op.action==='scroll') {
      if(!Number.isFinite(op.y) || (op.x!==undefined && !Number.isFinite(op.x)))throw new Error('Invalid scroll amount');
      await entry.page.mouse.wheel(Math.max(-3000,Math.min(3000,op.x||0)),Math.max(-3000,Math.min(3000,op.y)));
    } else if(op.action==='assert') {
      if(op.text!==undefined) {
        // Retry the assertion; a successful click alone is not a successful business test.
        const deadline=Date.now()+timeout;let matched=false;
        while(Date.now()<deadline && !input.signal?.aborted) {
          if((await locator.innerText()).includes(op.text)){matched=true;break;}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        if(!matched)return await rejectBeforeAction('assertion_not_observed',
          'The expected page text was not observed. No browser action was dispatched. Review the current visible state and choose a current evidence-backed action or assertion; do not repeat the unchanged assertion.');
      }
    } else if(op.action!=='observe')throw new Error('Unsupported browser action');
    actionCompleted=actionStarted;
    if(actionStarted){
      entry.currentAction=undefined;
      await entry.page.evaluate(()=>{const state=(globalThis as any).__bstgCausalActionState;if(state){state.expectedActionId='';state.activeActionId='';}}).catch(()=>undefined);
    }
    // Wait only for persistence of requests that were already attributed at
    // their Chromium request boundary.  This must never keep an attribution
    // marker alive for polling or delayed work.
    if(actionStarted&&entry.businessCapture){
      const capture=entry.businessCapture,started=Date.now(),deadline=started+3000;
      // waitForLoadState may already be resolved from the previous navigation;
      // require a fresh quiet window after this actual input dispatch.
      while(Date.now()<deadline&&!input.signal?.aborted&&entry.businessCapture===capture){
        await new Promise(resolve=>setTimeout(resolve,50));
        if(!capture.pending.size&&Date.now()-Math.max(started,capture.lastRequestAt)>=300)break;
      }
    }
    entry.rejectedInteraction=undefined;
    if(input.signal?.aborted)throw new Error('Browser operation cancelled');
    assertUrlInTargetScope(entry.page.url(),input.scope_base_url);
    const currentUrl=entry.page.url();const title=await entry.page.title();
    const observation = await observeInteractionRecovery(entry,entry.page);
    await input.repo.upsertBrowserContext({scan_run_id:input.scanRunId,task_id:input.taskId,context_key:context.key,
      scope_type:context.scope,identity_key:context.identity,status:'active',current_url:currentUrl,title,
      storage_state_json:await entry.browserContext.storageState(),expires_at:new Date(Date.now()+3600000).toISOString()});
    const screenshot=await entry.page.screenshot({type:'png',fullPage:false,mask:[entry.page.locator('input[type="password"],input[autocomplete="one-time-code"],[data-sensitive],pre,code')]}).catch(()=>null);
    await input.repo.createArtifact({scan_run_id:input.scanRunId,task_id:input.taskId,artifact_type:'browser_state',title:'Business browser action evidence',
      // Screenshots and raw route/session details are private audit evidence.
      // The model-facing invocation retains only projectBrowserToolResult.
      content_json:{private:true,mode:'playwright',ok:true,action:op.action,action_id:actionId,current_url:currentUrl,observed_at:new Date().toISOString(),live_session_id:entry.desktop?.view.id},
      content_text:screenshot?.toString('base64'),source_ref:actionId});
    return localBrowserInteractionResult({ok:true,action_id:actionId,current_url:currentUrl,observation});
  } catch(error:any) {assertScanActive();return localBrowserInteractionResult({ok:false,
    failure_phase:actionStarted?'action_or_after':'pre_action',action_performed:actionCompleted?true:actionStarted?undefined:false,
    error_code:actionStarted?'browser_action_failed':'browser_operation_failed',retryable:false,
    recovery_hint:actionStarted?'The browser action may have occurred. Do not retry it; verify the resulting state.':'No browser action was dispatched. Review the current browser state before choosing another action.',
    ...(actionStarted&&POST_ACTION_REPLAY_FINGERPRINT.test(actionReplayFingerprint)?{post_action_replay_guard:{fingerprint:actionReplayFingerprint}}:{}),
    error:actionStarted?'Browser action may have failed after dispatch.':'Browser operation failed before dispatch.'});}
  finally {entry.currentAction=undefined;if(entry.operationSignal===input.signal)entry.operationSignal=undefined;entry.desktop?.activity(input.taskId,false);input.signal?.removeEventListener('abort',aborted);release();}
}

/**
 * Run a trusted server-side operation in the already-owned persistent browser
 * context. This is intentionally not an Agent tool: callers must keep private
 * values (such as prepared credentials) inside the callback and return only a
 * safe projection. It shares the action lease, identity binding, capture owner
 * check and persisted storage state used by ordinary browser operations.
 */
export async function withPersistentBrowserPage<T>(input: {
  repo:AIScanRepository;scanRunId:string;taskId?:string;scope_base_url:string;
  scope_type?:PersistentBrowserScope;identity_key?:string;context_key?:string;
  action?:string;signal?:AbortSignal;missing_context_message?:string;
}, operation:(page:any,context:any,armTrustedAction?:(event:'click'|'input'|'keydown'|'wheel')=>Promise<void>)=>Promise<T>):Promise<T> {
  assertScanActive();
  const signal=scanAbortSignal(input.signal);
  const key=browserContextKey({scope_type:input.scope_type,task_id:input.taskId,identity_key:input.identity_key,context_key:input.context_key});
  const entry=liveContexts.get(liveKey(input.scanRunId,key.key));
  if(!entry)throw new Error(input.missing_context_message||'Navigate this browser context before using a trusted browser operation.');
  assertContextBinding({contextKey:key.key,scopeType:key.scope,identityKey:key.identity},entry);
  if(key.scope==='task'&&entry.taskOwnerId!==input.taskId)throw new Error('Browser task owner binding mismatch.');
  const previous=entry.operationTail;
  let release!:()=>void;entry.operationTail=new Promise<void>(resolve=>{release=resolve;});
  await previous;
  const aborted=()=>{void entry.browserContext.close().catch(()=>undefined);};
  try {
    assertScanActive();
    if(entry.businessCapture&&entry.businessCapture.ownerTaskId!==input.taskId)throw new Error('Browser is recording another task\'s business flow.');
    entry.operationSignal=signal;
    const trustedAction=String(input.action||'trusted_browser_operation').slice(0,120);
    signal?.addEventListener('abort',aborted,{once:true});
    if(liveContexts.get(liveKey(input.scanRunId,key.key))!==entry)throw new Error('Browser context was closed.');
    // A capture can begin while this caller waits for the operation lease.
    // Recheck after acquiring it so no trusted helper can inject a request into
    // another task's recording.
    if(entry.businessCapture&&entry.businessCapture.ownerTaskId!==input.taskId)throw new Error('Browser is recording another task\'s business flow.');
    assertBrowserNavigationUrl(entry.page.url(),input.scope_base_url,entry.authenticationOrigins);
    const actionId=randomUUID();
    const armTrustedAction=async(event:'click'|'input'|'keydown'|'wheel')=>{
      await armCausalAction(entry,{id:actionId,taskId:input.taskId,action:trustedAction},event);
    };
    const value=await operation(entry.page,entry.browserContext,armTrustedAction);
    assertScanActive();
    assertBrowserNavigationUrl(entry.page.url(),input.scope_base_url,entry.authenticationOrigins);
    await entry.page.waitForLoadState('networkidle',{timeout:2000}).catch(()=>undefined);
    await Promise.allSettled([...entry.pendingCaptures]);
    const frame=await entry.page.screenshot({type:'png',mask:[entry.page.locator('input[type="password"],input[autocomplete="one-time-code"],[data-sensitive],pre,code')]}).catch(()=>null);
    if(frame)await input.repo.createArtifact({scan_run_id:input.scanRunId,task_id:input.taskId,artifact_type:'browser_state',title:'Trusted browser interaction',content_text:frame.toString('base64'),content_json:{current_url:entry.page.url(),observed_at:new Date().toISOString(),mode:'playwright',action:trustedAction}});
    await input.repo.upsertBrowserContext({scan_run_id:input.scanRunId,task_id:input.taskId,context_key:key.key,scope_type:key.scope,identity_key:key.identity,status:'active',storage_state_json:await entry.browserContext.storageState(),current_url:entry.page.url(),ttl_seconds:3600,expires_at:new Date(Date.now()+3600000).toISOString()});
    return await safeBrowserObservation(entry,value);
  } catch(error) {assertScanActive();throw error;}
  finally {entry.currentAction=undefined;if(entry.operationSignal===signal)entry.operationSignal=undefined;signal?.removeEventListener('abort',aborted);entry.lastUsedAt=Date.now();release();}
}

/** Serialize discovery actions against the same real page used by navigation.
 * The callback is trusted application code, never page-provided JavaScript. */
export async function withPersistentDiscoveryPage<T>(input: {
  repo:AIScanRepository;scanRunId:string;taskId?:string;scope_base_url:string;identity_key?:string;
}, operation:(page:any,context:any)=>Promise<T>):Promise<T> {
  return withPersistentBrowserPage({...input,action:'discovery_operation',missing_context_message:'Navigate before interacting with the discovery browser.'},operation);
}
