import type { AIDiscoveredEndpoint } from './types.js';
import type { HttpRequestSpec } from './http-executor.js';
import type { AIScanRepository } from './repository.js';

/** A missing baseline is a coverage prerequisite, not an execution failure. */
export class CaptureRequiredError extends Error {
  readonly code = 'capture_required';

  constructor() {
    super('当前接口没有已捕获的真实请求，无法建立测试基线。请先触发对应页面功能或导入实际流量，再新建重试。');
    this.name = 'CaptureRequiredError';
  }
}

export interface CapturedRequest {
  method: string; url: string; headers: Record<string,string>; body: string | null;
  response_status?: number; captured_at: string; source: 'browser' | 'android';
}
export function replayHeaders(headers:Record<string,any>):Record<string,string> {
  return Object.fromEntries(Object.entries(headers).filter(([k,v])=>v!=null && !/^(host|content-length|connection|transfer-encoding|accept-encoding|upgrade|proxy-.*|sec-.*)$/i.test(k) && !/[\r\n]/.test(k+String(v))).map(([k,v])=>[k.toLowerCase(),String(v)]));
}
export async function hydrateRequests(repo:AIScanRepository,endpoints:AIDiscoveredEndpoint[]):Promise<AIDiscoveredEndpoint[]> {
  return Promise.all(endpoints.map(async endpoint=>({...endpoint,captured_request:await repo.getCapturedRequest(endpoint.scan_run_id,endpoint.id)||endpoint.captured_request})));
}
export function capturedParameters(endpoint:AIDiscoveredEndpoint):Record<string,any> {
  const request=endpoint.captured_request;
  if(!request)return {};
  const url=new URL(request.url);
  const params:Record<string,any> = Object.fromEntries(url.searchParams);
  url.pathname.split('/').forEach((segment,index)=>{
    if(/^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{24})$/i.test(segment))params[`$path.${index}`]=decodeURIComponent(segment);
  });
  if(request.body){
    const contentType=request.headers['content-type']||'';
    try {
      if(contentType.includes('json')) {
        const body=JSON.parse(request.body);
        const visit=(value:any,parts:string[],depth:number)=>{
          if(Object.keys(params).length>=100||depth>8)return;
          if(value===null||['string','number','boolean'].includes(typeof value)){
            const key=parts.length===1&&!Object.hasOwn(params,parts[0])?parts[0]:`$body.${parts.join('.')}`;
            if(parts.length)params[key]=value;
          }else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value))if(!key.includes('.')&&!['__proto__','prototype','constructor'].includes(key))visit(item,[...parts,key],depth+1);
        };
        visit(body,[],0);
      }else if(contentType.includes('application/x-www-form-urlencoded')) for(const [key,value] of new URLSearchParams(request.body))params[Object.hasOwn(params,key)?`$body.${key}`:key]=value;
    }catch { /* Unparseable/binary bodies are retained verbatim, never guessed. */ }
  }
  return params;
}
export function capturedSpec(endpoint:AIDiscoveredEndpoint,params:Record<string,any>={},headers:Record<string,string>={}):HttpRequestSpec {
  const captured=endpoint.captured_request;
  if(!captured)throw new Error('缺少真实请求样本。');
  const url=new URL(captured.url), original=replayHeaders(captured.headers), overrides=replayHeaders(headers);
  // An explicit identity replaces the captured identity as a whole; mixing an
  // attacker's Cookie with a victim's captured Authorization invalidates the test.
  if(Object.hasOwn(overrides,'authorization')||Object.hasOwn(overrides,'cookie')){delete original.authorization;delete original.cookie;}
  const merged={...original,...overrides};
  let body:HttpRequestSpec['body']=captured.body, body_type:HttpRequestSpec['body_type']=body?'raw':'none';
  const observed=capturedParameters(endpoint);
  const remaining=Object.fromEntries(Object.entries(params).filter(([key,value])=>!Object.hasOwn(observed,key)||String(observed[key])!==String(value)));
  const segments=url.pathname.split('/');
  for(const key of Object.keys(remaining))if(/^\$path\.\d+$/.test(key)){
    const index=Number(key.slice(6));
    if(!segments[index])throw new Error('Path parameter does not exist in captured request.');
    segments[index]=encodeURIComponent(String(remaining[key]));delete remaining[key];
  }
  url.pathname=segments.join('/');
  for(const key of Object.keys(remaining)) if(url.searchParams.has(key)){url.searchParams.set(key,String(remaining[key]));delete remaining[key];}
  if(Object.keys(remaining).length && body && (merged['content-type']||'').includes('json')) {
    try {const parsed=JSON.parse(String(body));if(parsed && typeof parsed==='object'){
      for(const key of Object.keys(remaining)){
        const parts=key.startsWith('$body.')?key.slice(6).split('.'):[key];
        if(parts.some(p=>['__proto__','prototype','constructor'].includes(p)))continue;
        let parent=parsed;
        for(const part of parts.slice(0,-1)){if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,part)){parent=null;break;}parent=parent[part];}
        const leaf=parts[parts.length-1];
        if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,leaf))continue;
        const value=remaining[key],old=parent[leaf];
        parent[leaf]=typeof old==='number'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value))?Number(value):typeof old==='boolean'&&['true','false'].includes(String(value))?String(value)==='true':value;
        delete remaining[key];
      }
      body=parsed;body_type='json';
    }}catch{}
  }else if(Object.keys(remaining).length && body && (merged['content-type']||'').includes('application/x-www-form-urlencoded')){
    const parsed=new URLSearchParams(String(body));for(const key of Object.keys(remaining)){const field=key.startsWith('$body.')?key.slice(6):key;if(parsed.has(field)){parsed.set(field,String(remaining[key]));delete remaining[key];}}body=parsed;body_type='form';
  }
  if(Object.keys(remaining).length) throw new Error(`待测试字段没有出现在真实请求中：${Object.keys(remaining).join(', ')}`);
  return {method:captured.method,url:url.toString(),headers:merged,body,body_type};
}
export function capturedRaw(endpoint:AIDiscoveredEndpoint,params:Record<string,any>={},headers:Record<string,string>={}):string {
  const spec=capturedSpec(endpoint,params,headers),url=new URL(spec.url);
  const body=spec.body instanceof URLSearchParams?spec.body.toString():typeof spec.body==='object'&&spec.body?JSON.stringify(spec.body):String(spec.body||'');
  return [`${spec.method} ${url.pathname}${url.search} HTTP/1.1`,`Host: ${url.host}`,...Object.entries(spec.headers||{}).map(([k,v])=>`${k}: ${v}`),'',body].join('\r\n');
}

export function parameterLocation(endpoint:AIDiscoveredEndpoint,name:string):string {
  if(name.startsWith('$body.'))return `body.${name.slice(6)}`;
  if(/^\$path\.\d+$/.test(name))return `path.__bstg_segment_${Number(name.slice(6))}`;
  return new URL(endpoint.captured_request?.url || endpoint.url!).searchParams.has(name) || endpoint.method==='GET' ? `query.${name}` : `body.${name}`;
}
export function parameterBodyType(endpoint:AIDiscoveredEndpoint):string|undefined {
  if(endpoint.method==='GET')return undefined;
  return endpoint.captured_request?.headers['content-type']?.includes('application/x-www-form-urlencoded')?'form_urlencoded':'json';
}
