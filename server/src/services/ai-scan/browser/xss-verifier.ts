import { chromium } from 'playwright';
import { assertUrlInTargetScope } from '../target-scope.js';
import { replayHeaders } from '../captured-request.js';
import type { HttpRequestSpec } from '../http-executor.js';

/** Verify reflected GET/HTML XSS by navigating the actual target in a fresh browser.
 * JSON reflection and HTML rendered through setContent are not browser execution proof. */
export async function verifyReflectedXss(request:HttpRequestSpec,marker:string):Promise<{verified:boolean;reason:string;screenshot_base64?:string}>{
  if(request.method.toUpperCase()!=='GET')return {verified:false,reason:'non_get_requires_declared_browser_scenario'};
  const browser=await chromium.launch({headless:true,chromiumSandbox:process.env.BSTG_BROWSER_ALLOW_NO_SANDBOX!=='1',...(process.env.BSTG_CHROMIUM_EXECUTABLE?{executablePath:process.env.BSTG_CHROMIUM_EXECUTABLE}:{})});
  try {
    const context=await browser.newContext();
    const headers=replayHeaders(request.headers||{});
    const cookieHeader=headers.cookie;delete headers.cookie;
    const cookies={...Object.fromEntries((cookieHeader||'').split(';').filter(x=>x.includes('=')).map(x=>{const at=x.indexOf('=');return [x.slice(0,at).trim(),x.slice(at+1).trim()];})),...request.cookies};
    await context.addCookies(Object.entries(cookies).map(([name,value])=>({name,value,url:new URL(request.url).origin})));
    await context.route('**/*',async route=>{
      const outgoing=route.request();
      try {assertUrlInTargetScope(outgoing.url(),request.url);}catch {await route.abort();return;}
      // Credentials never travel to third-party resources or redirects.
      await route.continue({headers:{...outgoing.headers(),...headers}});
    });
    const page=await context.newPage();let verified=false;
    page.on('dialog',async dialog=>{if(dialog.message()===marker)verified=true;await dialog.dismiss().catch(()=>undefined);});
    const response=await page.goto(request.url,{waitUntil:'domcontentloaded',timeout:20000});
    await page.waitForLoadState('networkidle',{timeout:2000}).catch(()=>undefined);
    if(!response?.headers()['content-type']?.includes('text/html'))return {verified:false,reason:'response_is_not_html'};
    const screenshot=verified?await page.screenshot({type:'png'}).catch(()=>null):null;
    return {verified,reason:verified?'unique_dialog_observed_in_target_browser':'no_unique_browser_execution_observed',screenshot_base64:screenshot?.toString('base64')};
  } catch(error){return {verified:false,reason:error instanceof Error?error.message:String(error)};}
  finally {await browser.close();}
}
