/** EXPLICIT CONTRACT DOUBLE. Not a Chromium or website acceptance result. */
import {EventEmitter} from 'node:events';
export const calls=[];export let launchOptions;export let routing;
class Locator {constructor(selector){this.selector=selector;}first(){return this;}async waitFor(){calls.push(['wait',this.selector]);}async count(){return this.selector==='ambiguous'?2:1;}async click(){calls.push(['click',this.selector]);}async fill(value){calls.push(['fill',this.selector,value]);}async selectOption(value){calls.push(['select',value]);}async press(value){calls.push(['press',value]);}async innerText(){return 'Successful business outcome';}}
class Page extends EventEmitter {
 current='https://authorized.example/';mouse={wheel:async(x,y)=>calls.push(['scroll',x,y])};closed=false;
 async bringToFront(){calls.push(['front']);}async goto(url,options){this.current=url;calls.push(['goto',url,options]);}url(){return this.current;}isClosed(){return this.closed;}
 async title(){return 'Contract fixture';}locator(s){return new Locator(s);}async screenshot(){calls.push(['screenshot-evidence']);return Buffer.from('TEST-DOUBLE-NOT-AN-IMAGE');}
 async evaluate(){return {title:'Contract fixture',url:this.current,visible_text:'Successful business outcome',controls:[]};}
 async close(){this.closed=true;this.emit('close');}
}
class Context extends EventEmitter {page=new Page();async newPage(){return this.page;}pages(){return this.page.closed?[]:[this.page];}async route(_,callback){routing=callback;}async storageState(){return {cookies:[],origins:[]};}async close(){await this.page.close();}}
class Browser extends EventEmitter {async newContext(){this.context=new Context();return this.context;}async close(){if(this.closed)return;this.closed=true;this.emit('disconnected');}}
export const chromium={launch:async options=>{launchOptions=options;return new Browser();}};
