import {assertBrowserNavigationUrl} from './authentication-scope.js';
import {scanAbortSignal} from '../run-control.js';

/** Playwright routing does not revisit each HTTP redirect. Chromium Fetch checks
 * every document request in an initialized page before network dispatch. A new
 * popup's initial request precedes its public Page/Frame, so reject that request
 * explicitly instead of pretending its redirect chain can already be guarded. */
export async function installNavigationGuard(
  context:any,initialPage:any,baseUrl:string,authenticationOrigins:string[],
  onBlocked:(message:string)=>void,
  currentSignal?:()=>AbortSignal|undefined,
):Promise<void>{
  const signal=scanAbortSignal();
  const isCancelled=()=>Boolean(signal?.aborted || currentSignal?.()?.aborted);
  const cancelled=()=>{void context.close().catch(()=>undefined);};
  signal?.addEventListener('abort',cancelled,{once:true});
  const guarded=new WeakMap<object,Promise<void>>();
  let closed=false;
  context.on('close',()=>{closed=true;signal?.removeEventListener('abort',cancelled);});
  const guardPage=(page:any):Promise<void>=>{
    const existing=guarded.get(page);if(existing)return existing;
    const installing=(async()=>{
      const session=await context.newCDPSession(page);
      const {frameTree}=await session.send('Page.getFrameTree');
      const mainFrameId=frameTree.frame.id;
      session.on('Fetch.requestPaused',(event:any)=>{
        void(async()=>{
          if(isCancelled()){await session.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});return;}
          try{assertBrowserNavigationUrl(event.request.url,baseUrl,authenticationOrigins);}
          catch(error:any){
            if(event.frameId===mainFrameId)onBlocked(error.message);
            await session.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});return;
          }
          await session.send('Fetch.continueRequest',{requestId:event.requestId});
        })().catch(()=>{if(!closed&&!page.isClosed()){onBlocked('浏览器跳转校验中断，本次浏览器已关闭。');void context.close().catch(()=>undefined);}});
      });
      await session.send('Fetch.enable',{patterns:[{urlPattern:'*',resourceType:'Document',requestStage:'Request'}]});
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
}
