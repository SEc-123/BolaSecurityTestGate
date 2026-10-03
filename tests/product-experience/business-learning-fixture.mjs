#!/usr/bin/env node
/** Disposable real HTTP business site. The model receives the site and credentials,
 * never this route table, fault mode, known experiments, or the assertion oracle. */
import http from 'node:http';
import https from 'node:https';
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const BUSINESS_FIXTURE_MODES = ['secure', 'object-boundary', 'quantity-boundary', 'misleading-response'];
const opaque = prefix => prefix + randomBytes(9).toString('hex');
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(String(value)).digest('hex');

/**
 * A caller may provide a controlled certificate/key pair. The fixture does
 * not create or trust one itself: a strict acceptance must provision the same
 * CA to Chromium and the native replay transport before this target starts.
 * The optional form keeps focused HTTP unit fixtures lightweight while the
 * real Agent acceptance exercises its HTTPS path.
 */
export async function createBusinessLearningFixture({mode = 'secure', host = '127.0.0.1', port = 0, tls: tlsOptions} = {}) {
  if (!BUSINESS_FIXTURE_MODES.includes(mode)) throw new Error('Unknown business fixture mode');
  const secureTransport = Boolean(tlsOptions?.key && tlsOptions?.cert);
  if (tlsOptions && !secureTransport) throw new Error('TLS business fixture requires both key and certificate.');
  const scheme = secureTransport ? 'https' : 'http';
  const credentials = {
    attacker: {username: 'member-a', password: 'A-' + randomBytes(12).toString('hex')},
    victim: {username: 'member-b', password: 'B-' + randomBytes(12).toString('hex')},
  };
  const users = new Map([
    ['member-a', {id: opaque('u_'), username: 'member-a', password: credentials.attacker.password, alias: 'Member A', cart: [], orders: [], notes: []}],
    ['member-b', {id: opaque('u_'), username: 'member-b', password: credentials.victim.password, alias: 'Member B', cart: [], orders: [], notes: []}],
  ]);
  const notes = new Map();
  const victim = users.get('member-b');
  const victimObject = {id: opaque('n_'), owner: victim.id, headline: 'Private B draft', content: opaque('private-'), revision: 1};
  notes.set(victimObject.id, victimObject); victim.notes.push(victimObject.id);
  const sessions = new Map();
  const tickets = new Map();
  const events = [];
  const metrics = {logins: 0, profile_updates: 0, cart_additions: 0, tickets_created: 0, orders_created: 0, normal_orders: 0, notes_created: 0,
    object_reads: 0, object_updates: 0, rejected: 0, unauthorized_reads: 0, unauthorized_updates: 0, invalid_orders: 0};
  let sequence = 0;

  const sendJSON = (res, status, data) => {
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    res.end(JSON.stringify(data));
  };
  const nav = '<nav><a href="/">Home</a> · <a href="/r/k11">Personal details</a> · <a href="/r/k21">Desk supplies</a> · <a href="/r/k31">Notebook</a> · <a href="/r/k40">Account overview</a></nav>';
  const html = (res, title, body, status = 200) => {
    res.writeHead(status, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title><style>body{max-width:860px;margin:3rem auto;padding:0 1rem;font:18px system-ui}nav{padding:1rem 0}label{display:block;margin:1rem 0}input,textarea,button{font:inherit;padding:.4rem}pre{white-space:pre-wrap}</style></head><body>${nav}<h1>${escape(title)}</h1>${body}</body></html>`);
  };
  const publicUser = user => ({user_id: user.id, username: user.username, alias: user.alias, cart: clone(user.cart), orders: clone(user.orders),
    notes: user.notes.map(id => clone(notes.get(id)))});
  const csrfField = session => `<input type="hidden" name="_g" value="${escape(session.csrf)}">`;
  const actorFor = req => {
    const sid = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('sid='))?.slice(4);
    const session = sessions.get(sid);
    return session ? {sid, session, user: users.get(session.username)} : null;
  };
  const record = (req, data, actor, result) => events.push({sequence: ++sequence, at: new Date().toISOString(), method: req.method,
    path: new URL(req.url, 'http://fixture.local').pathname, query: Object.fromEntries(new URL(req.url, 'http://fixture.local').searchParams),
    actor_id: actor?.user.id || null, request: {...data, ...(data.password ? {password: '[redacted]'} : {})}, ...result});
  const reject = (req, res, data, actor, reason, status = 400) => {
    metrics.rejected++;
    const misleading = mode === 'misleading-response';
    record(req, data, actor, {status: misleading ? 200 : status, outcome: 'rejected', reason, state_changed: false});
    sendJSON(res, misleading ? 200 : status, misleading
      ? {success: true, message: 'accepted verified paid admin', applied: false, reason, ...(actor ? {user_id: actor.user.id, csrf: actor.session.csrf} : {})}
      : {success: false, applied: false, error: reason, ...(actor ? {csrf: actor.session.csrf} : {})});
  };
  const rotate = actor => {actor.session.csrf = opaque('g_');};
  const complete = (req, res, data, actor, result) => {
    rotate(actor);
    record(req, data, actor, {status: 200, outcome: 'applied', state_changed: true, response: result});
    sendJSON(res, 200, {success: true, applied: true, ...result, user_id: actor.user.id, csrf: actor.session.csrf});
  };
  const scriptForm = (formId, after) => `<script>document.getElementById(${JSON.stringify(formId)}).addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const response=await fetch(form.action,{method:'POST',body:new URLSearchParams(new FormData(form))});const result=await response.json();document.getElementById('result').textContent=JSON.stringify(result,null,2);if(result.csrf){document.querySelectorAll('input[name="_g"]').forEach(input=>input.value=result.csrf);}if(result.success&&result.applied!==false){${after}}});</script>`;
  const resultPanel = '<pre id="result" role="status" aria-live="polite"></pre>';

  const requestHandler = async (req, res) => {
    try {
      const url = new URL(req.url, `${scheme}://fixture.local`);
      const actor = actorFor(req);
      let data = {};
      if (req.method === 'POST') {
        const chunks = []; let length = 0;
        for await (const chunk of req) {length += chunk.length; if (length > 65536) throw new Error('Request too large'); chunks.push(chunk);}
        const raw = Buffer.concat(chunks).toString('utf8');
        data = String(req.headers['content-type'] || '').includes('application/json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
      }
      if (url.pathname === '/favicon.ico') {res.writeHead(204);res.end();return;}
      if (url.pathname === '/' && req.method === 'GET') {
        record(req, {}, actor, {status: 200, outcome: 'observed', state_changed: false});
        if (actor) {html(res, 'Workspace', `<p>Signed in as ${escape(actor.user.username)} (${escape(actor.user.alias)}).</p><p>Use the sections above to maintain your details, purchase desk supplies, and create private notes.</p>`);return;}
        html(res, 'Workspace access', '<form id="entry" method="POST" action="/r/k01"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>'+resultPanel+scriptForm('entry', 'location.href="/";')); return;
      }
      if (url.pathname === '/r/k01' && req.method === 'POST') {
        const user = users.get(data.username);
        if (!user || data.password !== user.password) {reject(req, res, data, null, 'Credentials rejected', 401);return;}
        const sid = opaque('s_');const session = {username: user.username, csrf: opaque('g_')};sessions.set(sid, session);metrics.logins++;
        res.setHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
        record(req, data, {user, session}, {status: 200, outcome: 'authenticated', state_changed: true, response: {user_id: user.id}});
        sendJSON(res, 200, {success: true, applied: true, user_id: user.id, username: user.username, csrf: session.csrf});return;
      }
      if (!actor) {
        if (req.method === 'GET' && ['/r/k11', '/r/k21', '/r/k31'].includes(url.pathname)) {html(res, 'Sign in required', '<p>Please <a href="/">sign in</a> to use this section.', 401);record(req, {}, null, {status:401,outcome:'rejected',state_changed:false});return;}
        reject(req, res, data, null, 'Authentication required', 401);return;
      }
      if (req.method === 'POST' && data._g !== actor.session.csrf) {reject(req, res, data, actor, 'Form token is not current', 403);return;}
      if (url.pathname === '/r/k11' && req.method === 'GET') {
        record(req, {}, actor, {status:200,outcome:'observed',state_changed:false});
        html(res, 'Personal details', `<p>Current display name: <strong id="current">${escape(actor.user.alias)}</strong></p><form id="details" method="POST" action="/r/k12">${csrfField(actor.session)}<label>Display name<input name="alias" value="${escape(actor.user.alias)}" required maxlength="80"></label><button type="submit">Save details</button></form>${resultPanel}${scriptForm('details', 'document.getElementById("current").textContent=result.alias;')}`);return;
      }
      if (url.pathname === '/r/k12' && req.method === 'POST') {
        const alias = String(data.alias || '').trim();
        if (!alias || alias.length > 80) {reject(req, res, data, actor, 'A display name of 1 to 80 characters is required');return;}
        actor.user.alias = alias;metrics.profile_updates++;complete(req, res, data, actor, {alias});return;
      }
      if (url.pathname === '/r/k21' && req.method === 'GET') {
        record(req, {}, actor, {status:200,outcome:'observed',state_changed:false});
        html(res, 'Desk supplies', `<p>Notebook pack — 12 credits each. Available balance: 500 credits.</p><form id="basket" method="POST" action="/r/k22">${csrfField(actor.session)}<input name="sku" type="hidden" value="x17"><label>Quantity<input name="quantity" type="number" value="1" min="1" max="5" required></label><button type="submit">Add item</button></form><p id="basket-state">${actor.user.cart.length ? `${actor.user.cart[0].quantity} pack(s) in basket.` : 'Basket is empty.'}</p><form id="review" method="POST" action="/r/k23">${csrfField(actor.session)}<button type="submit">Review purchase</button></form><section id="confirmation"></section>${resultPanel}${scriptForm('basket', 'document.getElementById("basket-state").textContent=result.quantity+" pack(s) in basket.";')}${scriptForm('review', 'document.getElementById("confirmation").innerHTML=`<h2>Confirm purchase</h2><p>Total: ${result.total} credits.</p><form id="finish" method="POST" action="/r/k24"><input type="hidden" name="_g" value="${result.csrf}"><input type="hidden" name="ticket" value="${result.ticket}"><input type="hidden" name="total" value="${result.total}"><button type="submit">Place purchase</button></form>`;document.getElementById("finish").addEventListener("submit",async e=>{e.preventDefault();const f=e.currentTarget;const response=await fetch(f.action,{method:"POST",body:new URLSearchParams(new FormData(f))});const next=await response.json();document.getElementById("result").textContent=JSON.stringify(next,null,2);if(next.csrf){document.querySelectorAll("input[name=_g]").forEach(i=>i.value=next.csrf);}if(next.success&&next.applied!==false){document.getElementById("confirmation").textContent="Purchase recorded: "+next.order_id;}});')}`);return;
      }
      if (url.pathname === '/r/k22' && req.method === 'POST') {
        const quantity = Number(data.quantity);
        if (data.sku !== 'x17' || !Number.isInteger(quantity) || (mode !== 'quantity-boundary' && (quantity < 1 || quantity > 5))) {reject(req, res, data, actor, 'Quantity must be an integer between one and five');return;}
        actor.user.cart = [{sku:'x17',quantity,unit_price:12}];metrics.cart_additions++;complete(req, res, data, actor, {quantity,total:quantity*12});return;
      }
      if (url.pathname === '/r/k23' && req.method === 'POST') {
        if (!actor.user.cart.length) {reject(req, res, data, actor, 'Add an item before reviewing');return;}
        const ticket = opaque('t_');const total = actor.user.cart.reduce((sum,item)=>sum+item.quantity*item.unit_price,0);
        tickets.set(ticket, {user_id:actor.user.id,cart:clone(actor.user.cart),total,consumed:false});metrics.tickets_created++;
        complete(req, res, data, actor, {ticket,total});return;
      }
      if (url.pathname === '/r/k24' && req.method === 'POST') {
        const ticket = tickets.get(data.ticket);
        if (!ticket || ticket.user_id !== actor.user.id || ticket.consumed) {reject(req, res, data, actor, 'A fresh purchase review is required', 409);return;}
        if (Number(data.total) !== ticket.total) {reject(req, res, data, actor, 'Total must match reviewed items');return;}
        const order = {id:opaque('o_'),owner:actor.user.id,items:clone(ticket.cart),total:ticket.total,status:'recorded'};
        ticket.consumed = true;actor.user.orders.push(order);actor.user.cart = [];metrics.orders_created++;
        if (order.items.some(item=>item.quantity<1||item.quantity>5)||order.total<=0) metrics.invalid_orders++;else metrics.normal_orders++;
        complete(req, res, data, actor, {order_id:order.id,total:order.total,status:order.status});return;
      }
      if (url.pathname === '/r/k31' && req.method === 'GET') {
        record(req, {}, actor, {status:200,outcome:'observed',state_changed:false});
        html(res, 'Private notebook', `<p>Notes belong to their creator.</p><form id="draft" method="POST" action="/r/k32">${csrfField(actor.session)}<label>Headline<input name="headline" value="My draft" required></label><label>Note text<textarea name="content" required>A disposable note for this assessment.</textarea></label><button type="submit">Create note</button></form><div id="note-links">${actor.user.notes.map(id=>`<a href="/r/k33?id=${escape(id)}">${escape(notes.get(id).headline)}</a>`).join('<br>')}</div>${resultPanel}${scriptForm('draft', 'const link=document.createElement("a");link.href="/r/k33?id="+encodeURIComponent(result.object_id);link.textContent=result.headline;document.getElementById("note-links").append(link);')}`);return;
      }
      if (url.pathname === '/r/k32' && req.method === 'POST') {
        const headline=String(data.headline||'').trim(),content=String(data.content||'').trim();
        if (!headline||!content||headline.length>100||content.length>2000) {reject(req,res,data,actor,'A headline and note text are required');return;}
        const note={id:opaque('n_'),owner:actor.user.id,headline,content,revision:1};notes.set(note.id,note);actor.user.notes.push(note.id);metrics.notes_created++;
        complete(req,res,data,actor,{object_id:note.id,headline});return;
      }
      if (url.pathname === '/r/k33' && req.method === 'GET') {
        const note=notes.get(url.searchParams.get('id'));
        if (!note) {reject(req,res,{},actor,'Note not found',404);return;}
        if (note.owner!==actor.user.id&&mode!=='object-boundary') {reject(req,res,{},actor,'This note belongs to another member',403);return;}
        metrics.object_reads++;if(note.owner!==actor.user.id)metrics.unauthorized_reads++;
        record(req,{},actor,{status:200,outcome:'observed',state_changed:false,object_id:note.id,object_owner:note.owner});
        sendJSON(res,200,{success:true,...clone(note),csrf:actor.session.csrf});return;
      }
      if (url.pathname === '/r/k34' && req.method === 'POST') {
        const note=notes.get(data.id);
        if(!note){reject(req,res,data,actor,'Note not found',404);return;}
        if(note.owner!==actor.user.id&&mode!=='object-boundary'){reject(req,res,data,actor,'This note belongs to another member',403);return;}
        if(!String(data.content||'').trim()){reject(req,res,data,actor,'Note text is required');return;}
        if(note.owner!==actor.user.id)metrics.unauthorized_updates++;
        note.content=String(data.content);note.revision++;metrics.object_updates++;complete(req,res,data,actor,{object_id:note.id,revision:note.revision});return;
      }
      if (url.pathname === '/r/k40' && req.method === 'GET') {
        record(req,{},actor,{status:200,outcome:'observed',state_changed:false});
        sendJSON(res,200,{success:true,...publicUser(actor.user),csrf:actor.session.csrf});return;
      }
      reject(req,res,data,actor,'Unknown resource',404);
    } catch (error) {
      if(!res.headersSent)sendJSON(res,400,{success:false,applied:false,error:error.message});else res.end();
    }
  };
  const server = secureTransport
    ? https.createServer(tlsOptions, requestHandler)
    : http.createServer(requestHandler);
  server.listen(port, host);await once(server,'listening');
  return {
    baseUrl: `${scheme}://${host}:${server.address().port}`, credentials: clone(credentials), mode, transport: scheme,
    identities: Object.fromEntries([...users].map(([key,user])=>[key,{user_id:user.id,...(key==='member-b'?{object_id:victimObject.id}:{})}])),
    events, snapshot: () => ({mode,transport:scheme,metrics:clone(metrics),users:[...users.values()].map(publicUser),events:clone(events),
      request_count:events.length,unresolved_values:events.filter(event=>JSON.stringify(event.request).includes('{{')).length,
      csrf_values:[...new Set(events.flatMap(event=>event.request._g?[digest(event.request._g)]:[]))]}),
    close: () => new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture=await createBusinessLearningFixture({mode:process.env.BSTG_BUSINESS_FIXTURE_MODE||'secure',port:Number(process.env.BSTG_BUSINESS_FIXTURE_PORT||0)});
  console.log(JSON.stringify({base_url:fixture.baseUrl,credentials:fixture.credentials,identities:fixture.identities},null,2));
  const shutdown=async()=>{await fixture.close();process.exit(0);};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
