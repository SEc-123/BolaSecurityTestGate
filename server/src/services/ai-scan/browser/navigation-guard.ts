import {assertBrowserNavigationUrl} from './authentication-scope.js';
import {scanAbortSignal} from '../run-control.js';

export interface BrowserResponseObserver {
  /** Synchronous request-stage attribution before Chromium dispatch. */
  start: (event:any) => unknown;
  finish: (token:unknown,event:any,body?:Buffer,error?:string) => Promise<void>;
  updateHeaders?: (token:unknown,headers:Record<string,string>) => void;
}
export interface BrowserNavigationGuardController {setResponseObservation:(enabled:boolean)=>Promise<void>}

/** A page-local causal marker is only an interception rendezvous.  It must
 * never become an application header, an extra-info header, or capture data. */
const CAUSAL_ACTION_HEADER = 'x-bstg-causal-request';

function removeCausalActionHeader(event:any): Array<{name:string;value:string}> | undefined {
  const headers = event?.request?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  let marker: string | undefined;
  const cleaned: Array<{name:string;value:string}> = [];
  let removed = false;
  for (const [name, value] of Object.entries(headers)) {
    if (String(name).toLowerCase() === CAUSAL_ACTION_HEADER) {
      marker = typeof value === 'string' ? value : String(value);
      removed = true;
    } else cleaned.push({name:String(name),value:String(value)});
  }
  if (!removed) return undefined;
  // This private field is consumed immediately by the capture observer. It is
  // deliberately non-enumerable so generic diagnostic copies cannot expose it.
  Object.defineProperty(event, '__bstg_causal_action_marker', { value: marker, configurable: true });
  event.request.headers = Object.fromEntries(cleaned.map(header => [header.name, header.value]));
  return cleaned;
}

/** CDP exposes these only after Chromium has completed the TLS handshake. Keep
 * the bounded transport facts with the private capture; certificate subjects,
 * issuer names and raw certificate data are intentionally not copied. */
function tlsSecurityDetails(value: any): { protocol?: string; cipher?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const protocol = typeof value.protocol === 'string' ? value.protocol.slice(0, 80) : undefined;
  const cipher = typeof value.cipher === 'string' ? value.cipher.slice(0, 160) : undefined;
  return protocol || cipher ? { ...(protocol ? { protocol } : {}), ...(cipher ? { cipher } : {}) } : undefined;
}

/** Playwright routing does not revisit each HTTP redirect. Chromium Fetch checks
 * every document request in an initialized page before network dispatch. A new
 * popup's initial request precedes its public Page/Frame, so reject that request
 * explicitly instead of pretending its redirect chain can already be guarded. */
export async function installNavigationGuard(
  context:any,initialPage:any,baseUrl:string,authenticationOrigins:string[],
  onBlocked:(message:string)=>void,
  currentSignal?:()=>AbortSignal|undefined,
  observer?:BrowserResponseObserver,
):Promise<BrowserNavigationGuardController>{
  const signal=scanAbortSignal();
  const isCancelled=()=>Boolean(signal?.aborted || currentSignal?.()?.aborted);
  const cancelled=()=>{void context.close().catch(()=>undefined);};
  signal?.addEventListener('abort',cancelled,{once:true});
  const guarded=new WeakMap<object,Promise<void>>();
  const sessions=new Set<any>();let responseObservationEnabled=false;
  const patterns=()=>responseObservationEnabled?['Document','XHR','Fetch'].flatMap(resourceType=>[
    {urlPattern:'*',resourceType,requestStage:'Request'},{urlPattern:'*',resourceType,requestStage:'Response'},
  ]):[{urlPattern:'*',resourceType:'Document',requestStage:'Request'}];
  let closed=false;
  context.on('close',()=>{closed=true;signal?.removeEventListener('abort',cancelled);});
  const guardPage=(page:any):Promise<void>=>{
    const existing=guarded.get(page);if(existing)return existing;
    const installing=(async()=>{
      const session=await context.newCDPSession(page);
      sessions.add(session);page.on('close',()=>sessions.delete(session));
      const {frameTree}=await session.send('Page.getFrameTree');
      const mainFrameId=frameTree.frame.id;
      const requests=new Map<string,{token:unknown;event:any}>();
      const byNetwork=new Map<string,string>(),extraHeaders=new Map<string,Record<string,string>>();
      const responseHeaders=new Map<string,Record<string,string>>(),responseHeaderWaiters=new Map<string,()=>void>();
      const responseTls=new Map<string,{protocol?:string;cipher?:string}>(),responseTlsWaiters=new Map<string,()=>void>();
      if(observer){
        await session.send('Network.enable');
        session.on('Network.requestWillBeSentExtraInfo',(event:any)=>{
          const headers=Object.fromEntries(Object.entries(event.headers||{})
            .filter(([key])=>key.toLowerCase()!==CAUSAL_ACTION_HEADER)
            .map(([key,value])=>[key.toLowerCase(),String(value)]));
          extraHeaders.set(event.requestId,headers);
          // ExtraInfo also arrives for unrecorded assets. Bound the staging
          // buffer while allowing headers that precede Fetch.requestPaused.
          while(extraHeaders.size>500)extraHeaders.delete(extraHeaders.keys().next().value!);
          const tracked=requests.get(byNetwork.get(event.requestId)||'');
          if(tracked)observer.updateHeaders?.(tracked.token,headers);
        });
        session.on('Network.loadingFailed',(event:any)=>{
          const id=byNetwork.get(event.requestId),tracked=id?requests.get(id):undefined;
          if(!tracked)return;
          requests.delete(id!);byNetwork.delete(event.requestId);extraHeaders.delete(event.requestId);responseTls.delete(event.requestId);
          void observer.finish(tracked.token,tracked.event,undefined,event.errorText||'Browser request failed').catch(()=>undefined);
        });
        session.on('Network.responseReceivedExtraInfo',(event:any)=>{
          responseHeaders.set(event.requestId,Object.fromEntries(Object.entries(event.headers||{}).map(([key,value])=>[key.toLowerCase(),String(value)])));
          responseHeaderWaiters.get(event.requestId)?.();
          while(responseHeaders.size>500)responseHeaders.delete(responseHeaders.keys().next().value!);
        });
        session.on('Network.responseReceived',(event:any)=>{
          const details=tlsSecurityDetails(event.response?.securityDetails);
          if(!details)return;
          responseTls.set(event.requestId,details);
          responseTlsWaiters.get(event.requestId)?.();
          while(responseTls.size>500)responseTls.delete(responseTls.keys().next().value!);
        });
        page.on('close',()=>{
          for(const tracked of requests.values())void observer.finish(tracked.token,tracked.event,undefined,'Browser page closed before its response completed.').catch(()=>undefined);
          requests.clear();byNetwork.clear();extraHeaders.clear();responseHeaders.clear();responseTls.clear();
          for(const resolve of responseHeaderWaiters.values())resolve();responseHeaderWaiters.clear();
          for(const resolve of responseTlsWaiters.values())resolve();responseTlsWaiters.clear();
        });
      }
      session.on('Fetch.requestPaused',(event:any)=>{
        void(async()=>{
          if(isCancelled()){await session.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});return;}
          const responseStage=event.responseStatusCode!==undefined||event.responseErrorReason!==undefined;
          if(responseStage){
            const tracked=requests.get(event.requestId);
            if(tracked&&observer){
              requests.delete(event.requestId);if(event.networkId){byNetwork.delete(event.networkId);extraHeaders.delete(event.networkId);}
              let body:Buffer|undefined,error:string|undefined=event.responseErrorReason;
              // Read while Chromium's response is paused, before page code can
              // navigate and discard the body. No request is replayed or fulfilled.
              const headers=Object.fromEntries((event.responseHeaders||[]).map((header:any)=>[header.name.toLowerCase(),String(header.value)]));
              if(!error&&/text\/event-stream/i.test(String(headers['content-type']||'')))error='Streaming response cannot be recorded as a complete finite body.';
              if(!error&&Number(headers['content-length'])>2*1024*1024)error='Response body exceeds the 2 MiB recording limit.';
              if(!error && event.request.method!=='HEAD' && ![204,304].includes(event.responseStatusCode) && !(event.responseStatusCode>=300&&event.responseStatusCode<400)){
                try{const result=await session.send('Fetch.getResponseBody',{requestId:event.requestId});body=Buffer.from(result.body,result.base64Encoded?'base64':'utf8');}
                catch(failure:any){error=`Response body unavailable: ${failure?.message||String(failure)}`;}
              }
              // Chromium's paused response headers can omit Set-Cookie. The
              // actual network ExtraInfo is authoritative and may arrive only
              // once the original response is continued. Keep the body buffer
              // locally, then finish with those headers; page navigation cannot
              // evict this already-read body.
              await session.send('Fetch.continueRequest',{requestId:event.requestId});
              if(event.networkId&&!responseHeaders.has(event.networkId))await new Promise<void>(resolve=>{
                const timer=setTimeout(()=>{responseHeaderWaiters.delete(event.networkId);resolve();},250);
                responseHeaderWaiters.set(event.networkId,()=>{clearTimeout(timer);responseHeaderWaiters.delete(event.networkId);resolve();});
              });
              const extra=event.networkId?responseHeaders.get(event.networkId):undefined;
              if(extra){event.responseHeaders=[...Object.entries({...headers,...extra}).map(([name,value])=>({name,value}))];responseHeaders.delete(event.networkId);}
              if(event.networkId&&!responseTls.has(event.networkId))await new Promise<void>(resolve=>{
                const timer=setTimeout(()=>{responseTlsWaiters.delete(event.networkId);resolve();},250);
                responseTlsWaiters.set(event.networkId,()=>{clearTimeout(timer);responseTlsWaiters.delete(event.networkId);resolve();});
              });
              const tls=responseTls.get(event.networkId);
              if(tls)(event as any).__bstg_tls_security_details=tls;
              if(event.networkId)responseTls.delete(event.networkId);
              await observer.finish(tracked.token,event,body,error);return;
            }
            await session.send('Fetch.continueRequest',{requestId:event.requestId});return;
          }
          if(event.resourceType==='Document')try{assertBrowserNavigationUrl(event.request.url,baseUrl,authenticationOrigins);}
          catch(error:any){
            if(event.frameId===mainFrameId)onBlocked(error.message);
            await session.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});return;
          }
          if(observer&&responseObservationEnabled){
            const continuedHeaders=removeCausalActionHeader(event);
            if(event.networkId&&extraHeaders.has(event.networkId))event.request.headers={...event.request.headers,...extraHeaders.get(event.networkId)};
            if(event.request.hasPostData&&event.request.postData===undefined&&event.networkId){
              try{event.request.postData=(await session.send('Network.getRequestPostData',{requestId:event.networkId})).postData;}
              catch{event.request.bodyUnavailable=true;}
            }
            const token=await observer.start(event);
            if(token){requests.set(event.requestId,{token,event});if(event.networkId)byNetwork.set(event.networkId,event.requestId);}
            await session.send('Fetch.continueRequest',continuedHeaders ? {requestId:event.requestId,headers:continuedHeaders} : {requestId:event.requestId});
            return;
          }
          await session.send('Fetch.continueRequest',{requestId:event.requestId});
        })().catch(()=>{if(!closed&&!page.isClosed()){onBlocked('浏览器跳转校验中断，本次浏览器已关闭。');void context.close().catch(()=>undefined);}});
      });
      await session.send('Fetch.enable',{patterns:patterns()});
    })();guarded.set(page,installing);return installing;
  };
  await context.route('**/*',async(route:any)=>{
    if(isCancelled()){await route.abort('blockedbyclient').catch(()=>undefined);return;}
    const request=route.request();
    if(request.isNavigationRequest()){
      let frame:any;
      try{frame=request.frame();}
      catch{
        onBlocked('当前浏览器不支持弹窗的首次导航或弹窗登录，请使用当前窗口登录。弹窗请求尚未发出。');
        await route.abort('blockedbyclient').catch(()=>undefined);return;
      }
      try{assertBrowserNavigationUrl(request.url(),baseUrl,authenticationOrigins);await guardPage(frame.page());}
      catch(error:any){
        if(frame===frame.page().mainFrame())onBlocked(error.message||'无法建立浏览器跳转边界');
        await route.abort('blockedbyclient').catch(()=>undefined);return;
      }
    }
    if(isCancelled()){await route.abort('blockedbyclient').catch(()=>undefined);return;}
    await route.continue().catch(()=>undefined);
  });
  await guardPage(initialPage);
  return {setResponseObservation:async(enabled:boolean)=>{
    if(enabled&&!observer)throw new Error('This navigation guard has no response observer.');
    if(closed)throw new Error('Browser context is closed.');
    responseObservationEnabled=enabled;
    await Promise.all([...sessions].map(session=>session.send('Fetch.enable',{patterns:patterns()})));
  }};
}
