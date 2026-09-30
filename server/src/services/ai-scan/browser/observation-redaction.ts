import {createHash} from 'node:crypto';

export interface BrowserObservationSecrets {fields:Set<string>;values:Set<string>}
const secretName=/password|passwd|^pwd$|secret|authorization|cookie|token|csrf|ticket|otp|passcode|session(?:[_-]?id)?|verification[_-]?code|^sid$|^_g$/i;
export const sensitiveBrowserField=(name:string,fields:ReadonlySet<string>):boolean=>secretName.test(name)||fields.has(name.toLowerCase());

export function rememberBrowserSecret(state:BrowserObservationSecrets,value:unknown):void {
  if(typeof value==='string'&&value){state.values.add(value);while(state.values.size>1000)state.values.delete(state.values.values().next().value!);}
  else if(Array.isArray(value))value.forEach(item=>rememberBrowserSecret(state,item));
  else if(value&&typeof value==='object')Object.values(value).forEach(item=>rememberBrowserSecret(state,item));
}

/** Private, context-scoped observations only; the collection is never returned
 * in a browser tool result. Learn aliases by value as well as field name. */
export function rememberBrowserStructure(state:BrowserObservationSecrets,value:unknown,key=''):void {
  if(sensitiveBrowserField(key,state.fields)){
    rememberBrowserSecret(state,value);
    if(typeof value==='string'&&/authorization|cookie/i.test(key)){
      if(/^Bearer\s+/i.test(value))rememberBrowserSecret(state,value.replace(/^Bearer\s+/i,''));
      for(const part of value.split(';')){const i=part.indexOf('=');if(i>=0)rememberBrowserSecret(state,part.slice(i+1).trim());}
    }
    return;
  }
  if(Array.isArray(value))value.forEach(item=>rememberBrowserStructure(state,item));
  else if(value&&typeof value==='object')for(const [name,item]of Object.entries(value))rememberBrowserStructure(state,item,name);
}

export function rememberBrowserBody(state:BrowserObservationSecrets,text:string|undefined,contentType?:string):void {
  if(!text)return;
  try{rememberBrowserStructure(state,JSON.parse(text));}catch{
    if(contentType?.includes('application/x-www-form-urlencoded'))for(const [key,value]of new URLSearchParams(text))rememberBrowserStructure(state,value,key);
  }
}

export function redactBrowserObservation<T>(state:BrowserObservationSecrets,value:T,key=''):T {
  if(sensitiveBrowserField(key,state.fields))return {redacted:true,sha256:createHash('sha256').update(typeof value==='object'?JSON.stringify(value):String(value)).digest('hex')} as T;
  if(Array.isArray(value))return value.map(item=>redactBrowserObservation(state,item)) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,redactBrowserObservation(state,item,name)])) as T;
  if(typeof value!=='string')return value;
  let safe:string=value;
  // A page may render its response JSON inside a pre or ordinary body text.
  // Preserve structure when it is JSON and redact dynamic custom aliases.
  try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object')return JSON.stringify(redactBrowserObservation(state,parsed)) as T;}catch{}
  for(const secret of [...state.values].sort((a,b)=>b.length-a.length))if(secret.length>=4){
    safe=safe.split(secret).join('[REDACTED]');
    const encoded=encodeURIComponent(secret);if(encoded!==secret)safe=safe.split(encoded).join('[REDACTED]');
  }
  // Protect named secrets in rendered snippets even without network capture.
  safe=safe.replace(/(["']?(?:[\w.-]*(?:password|passwd|secret|token|csrf|ticket|passcode|session|otp)[\w.-]*|_g)["']?\s*[:=]\s*)(["'])([^"'\r\n]*)\2/gi,'$1$2[REDACTED]$2');
  safe=safe.replace(/https?:\/\/[^\s"'<>]+/g,candidate=>{
    try{const url=new URL(candidate);for(const [name]of url.searchParams)if(sensitiveBrowserField(name,state.fields))url.searchParams.set(name,'[REDACTED]');return url.toString();}catch{return candidate;}
  });
  return safe as T;
}
