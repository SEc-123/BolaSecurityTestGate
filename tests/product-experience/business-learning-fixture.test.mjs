/** Real fixture-server/browser checks. These verify the test target; they are not
 * evidence of model-driven BSTG acceptance. No model/provider is used here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createBusinessLearningFixture} from './business-learning-fixture.mjs';
const require=createRequire(new URL('../../server/package.json',import.meta.url));

async function login(fixture, role='attacker') {
  const response=await fetch(fixture.baseUrl+'/r/k01',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture.credentials[role])});
  assert.equal(response.status,200);
  const state=await response.json();const cookie=response.headers.get('set-cookie').split(';')[0];
  return {state,cookie, async request(resource,body) {
    const response=await fetch(fixture.baseUrl+resource,{method:body?'POST':'GET',headers:{cookie,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify({_g:this.state.csrf,...body})}:{})});
    const data=await response.json();if(data.csrf)this.state.csrf=data.csrf;return {status:response.status,data};
  }};
}

test('real HTTP normal flows use changing tokens, create random objects and persist business results',async t=>{
  const fixture=await createBusinessLearningFixture();t.after(()=>fixture.close());const a=await login(fixture);
  const firstToken=a.state.csrf;
  assert.equal((await a.request('/r/k12',{alias:'中文成员 A'})).data.alias,'中文成员 A');
  assert.notEqual(a.state.csrf,firstToken);
  assert.equal((await a.request('/r/k22',{sku:'x17',quantity:2})).data.total,24);
  const review=await a.request('/r/k23',{});assert.match(review.data.ticket,/^t_/);
  const placed=await a.request('/r/k24',{ticket:review.data.ticket,total:review.data.total});assert.match(placed.data.order_id,/^o_/);
  assert.equal((await a.request('/r/k24',{ticket:review.data.ticket,total:review.data.total})).status,409,'Tickets cannot be reused');
  const note=await a.request('/r/k32',{headline:'Fresh object',content:'Real state'});assert.match(note.data.object_id,/^n_/);
  assert.equal((await a.request('/r/k33?id='+note.data.object_id)).data.owner,a.state.user_id);
  const overview=await a.request('/r/k40');assert.equal(overview.data.alias,'中文成员 A');assert.equal(overview.data.orders.length,1);assert.equal(overview.data.orders[0].total,24);assert.equal(overview.data.notes.length,1);
  const snapshot=fixture.snapshot();assert.equal(snapshot.metrics.invalid_orders,0);assert.equal(snapshot.unresolved_values,0);assert.ok(snapshot.csrf_values.length>=4);
  assert.ok(snapshot.events.every(event=>!/(login|register|profile|cart|order|payment|note|content|upload|download|verify)/i.test(event.path)));
});

test('secure and isolated object fault have observable authorization outcomes',async t=>{
  for(const mode of ['secure','object-boundary']){
    const fixture=await createBusinessLearningFixture({mode});t.after(()=>fixture.close());const a=await login(fixture),b=await login(fixture,'victim');
    const bState=await b.request('/r/k40'),object=bState.data.notes[0];
    assert.equal((await b.request('/r/k33?id='+object.id)).data.owner,b.state.user_id);
    const read=await a.request('/r/k33?id='+object.id);
    assert.equal(read.status,mode==='secure'?403:200);
    const write=await a.request('/r/k34',{id:object.id,content:'Changed by A'});
    assert.equal(write.status,mode==='secure'?403:200);
    const after=await b.request('/r/k33?id='+object.id);
    assert.equal(after.data.content==='Changed by A',mode==='object-boundary');
    assert.equal(fixture.snapshot().metrics.unauthorized_updates,mode==='object-boundary'?1:0);
  }
});

test('secure profile updates reject a missing anti-CSRF token without changing account state',async t=>{
  const fixture=await createBusinessLearningFixture({mode:'secure'});t.after(()=>fixture.close());
  const member=await login(fixture);const before=await member.request('/r/k40');
  const response=await fetch(fixture.baseUrl+'/r/k12',{method:'POST',headers:{cookie:member.cookie,'content-type':'application/json'},
    body:JSON.stringify({alias:'Cross-site change'})});
  assert.equal(response.status,403);assert.equal((await response.json()).applied,false);
  const after=await member.request('/r/k40');
  assert.equal(after.data.alias,before.data.alias);
  assert.equal(fixture.snapshot().metrics.csrf_rejections,1);
  assert.equal(fixture.snapshot().metrics.profile_updates,0);
});

test('quantity fault and misleading success responses are distinguished by actual state',async t=>{
  for(const mode of ['secure','quantity-boundary','misleading-response']){
    const fixture=await createBusinessLearningFixture({mode});t.after(()=>fixture.close());const a=await login(fixture);
    const change=await a.request('/r/k22',{sku:'x17',quantity:-2});
    if(mode==='quantity-boundary'){
      const review=await a.request('/r/k23',{});const placed=await a.request('/r/k24',{ticket:review.data.ticket,total:review.data.total});assert.equal(placed.data.total,-24);
      assert.equal(fixture.snapshot().metrics.invalid_orders,1);
    }else{
      assert.equal(change.status,mode==='secure'?400:200);assert.equal(change.data.applied,false);
      const overview=await a.request('/r/k40');assert.equal(overview.data.cart.length,0);assert.equal(overview.data.orders.length,0);assert.equal(fixture.snapshot().metrics.invalid_orders,0);
    }
  }
});

test('real Chromium operates each normal business through visible controls', {timeout:45000},async t=>{
  const {chromium}=require('playwright');const fixture=await createBusinessLearningFixture({postWriteReadbacks:true});t.after(()=>fixture.close());
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(fixture.baseUrl);await page.getByLabel('Username',{exact:true}).fill(fixture.credentials.attacker.username);await page.getByLabel('Password',{exact:true}).fill(fixture.credentials.attacker.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Workspace',exact:true}).waitFor();
  await page.getByRole('link',{name:'Personal details',exact:true}).click();await page.getByLabel('Display name').fill('Browser member');await page.getByRole('button',{name:'Save details'}).click();await page.locator('#current').filter({hasText:'Browser member'}).waitFor();
  await page.getByRole('link',{name:'Desk supplies',exact:true}).click();await page.getByLabel('Quantity',{exact:true}).fill('2');await page.getByRole('button',{name:'Add item'}).click();await page.locator('#basket-state').filter({hasText:'2 pack(s)'}).waitFor();
  await page.getByRole('button',{name:'Review purchase'}).click();await page.getByRole('button',{name:'Place purchase'}).click();await page.locator('#confirmation').filter({hasText:'Purchase recorded:'}).waitFor();
  await page.getByRole('link',{name:'Notebook',exact:true}).click();await page.getByLabel('Headline',{exact:true}).fill('Browser-created note');await page.getByRole('button',{name:'Create note'}).click();await page.getByRole('link',{name:'Browser-created note',exact:true}).waitFor();
  assert.deepEqual(errors,[]);const snapshot=fixture.snapshot();assert.equal(snapshot.metrics.profile_updates,1);assert.equal(snapshot.metrics.profile_readbacks,1);
  const profileWrite=snapshot.events.findIndex(event=>event.method==='POST'&&event.path==='/r/k12'&&event.state_changed===true);
  assert.ok(snapshot.events.slice(profileWrite+1).some(event=>event.method==='GET'&&event.path==='/r/k40'&&
    event.actor_id===snapshot.events[profileWrite].actor_id),'The browser must read the saved account state after the profile write.');
  assert.equal(snapshot.metrics.orders_created,1);assert.equal(snapshot.metrics.order_readbacks,1);
  assert.equal(snapshot.metrics.cart_readbacks,1);assert.equal(snapshot.metrics.notes_created,1);assert.equal(snapshot.metrics.note_readbacks,1);
  const noteWrite=snapshot.events.findIndex(event=>event.method==='POST'&&event.path==='/r/k32'&&event.state_changed===true);
  const noteId=snapshot.events[noteWrite].response.object_id;
  assert.ok(snapshot.events.slice(noteWrite+1).some(event=>event.method==='GET'&&event.path==='/r/k33'&&event.query.id===noteId&&
    event.actor_id===snapshot.events[noteWrite].actor_id),'The browser must read back the newly created note object.');
});
