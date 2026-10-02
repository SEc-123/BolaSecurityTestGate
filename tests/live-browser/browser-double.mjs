/** EXPLICIT CONTRACT DOUBLE. Not a Chromium or website acceptance result. */
import {EventEmitter} from 'node:events';
export const calls=[];export let launchOptions;export let routing;
class CDPSession extends EventEmitter {
 async send(method,params){
  calls.push(['cdp',method,params]);
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main-frame'}}};
  return {};
 }
}
class Locator {constructor(selector){this.selector=selector;}first(){return this;}and(){return this;}async waitFor(){calls.push(['wait',this.selector]);}async count(){return this.selector==='ambiguous'?2:1;}async isVisible(){return true;}async isEnabled(){return true;}async click(){calls.push(['click',this.selector]);}async fill(value){calls.push(['fill',this.selector,value]);}async selectOption(value){calls.push(['select',value]);}async press(value){calls.push(['press',value]);}async evaluate(){return false;}async innerText(){return 'Successful business outcome';}}
class Page extends EventEmitter {
 current='about:blank';mouse={wheel:async(x,y)=>calls.push(['scroll',x,y])};keyboard={press:async key=>calls.push(['key',key])};closed=false;
 async bringToFront(){calls.push(['front']);}async goto(url,options){this.current=url;calls.push(['goto',url,options]);}url(){return this.current;}isClosed(){return this.closed;}
 async waitForLoadState(){calls.push(['wait-for-load']);}async title(){return 'Contract fixture';}locator(s){return new Locator(s);}async screenshot(){calls.push(['screenshot-evidence']);return Buffer.from('TEST-DOUBLE-NOT-AN-IMAGE');}
 async evaluate(_fn,...args){if(args.length)return [];return {title:'Contract fixture',url:this.current,visible_text:'Successful business outcome',controls:[]};}
 async close(){this.closed=true;this.emit('close');}
}
class Context extends EventEmitter {page=new Page();async newPage(){return this.page;}pages(){return this.page.closed?[]:[this.page];}async route(_,callback){routing=callback;}async addInitScript(script){calls.push(['init-script',script]);}async newCDPSession(){return new CDPSession();}async storageState(){return {cookies:[],origins:[]};}async close(){await this.page.close();this.emit('close');}}
class Browser extends EventEmitter {async newContext(){this.context=new Context();return this.context;}async close(){if(this.closed)return;this.closed=true;this.emit('disconnected');}}
export const chromium={launch:async options=>{launchOptions=options;return new Browser();}};
