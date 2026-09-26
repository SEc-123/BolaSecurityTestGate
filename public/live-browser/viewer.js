/** Production noVNC viewer. RFB pixels arrive over the live gateway WebSocket.
 * The 2s poll below discovers session metadata ONLY; it never requests screenshots.
 */
import RFB from '../vendor/novnc/core/rfb.js';
export function mountLiveViewer(root, options) {
  const origin = new URL(options.apiBase || location.origin, location.origin).origin;
  if (origin !== location.origin) {
    root.textContent = '实时观看需要同源网关。请通过应用服务器或已配置 WebSocket 的反向代理访问。';
    return {setSelection(){},setTerminal(){},dispose(){root.replaceChildren();}};
  }
  const base = `${origin}/api/ai-scans/${encodeURIComponent(options.runId)}/live-browser`;
  let closed=false, terminal=Boolean(options.terminal), paused=false, busy=false, epoch=0;
  let selectedTasks=options.taskIds || null, manual='', current='', rfb=null, channel=null;
  let retryAt=0, failures=0, lastMetadata=0, connected=false, sessions=[];
  const abort=new AbortController();
  root.classList.add('bstg-live-viewer'); root.dataset.testid='live-browser-viewer';
  // Literal template only. Untrusted labels and IDs are assigned with textContent/value.
  root.innerHTML=`<div class="live-toolbar"><span class="live-status" role="status" data-testid="live-browser-status">正在寻找测试浏览器…</span><div class="live-controls"><select aria-label="选择正在测试的浏览器"><option value="">跟随当前业务</option></select><button type="button" data-action="reconnect">重连观看</button><button type="button" data-action="pause">暂停观看</button><button type="button" data-action="fullscreen">全屏</button></div></div><div class="live-stage"><div class="live-canvas" data-testid="novnc-canvas-host"></div><div class="live-empty">等待本轮真正启动浏览器。接口检查不会产生页面操作。</div></div><div class="live-footer">只读旁观 AI 正在操作的同一个浏览器。观看断开不影响测试执行。</div>`;
  const status=root.querySelector('.live-status'), host=root.querySelector('.live-canvas');
  const empty=root.querySelector('.live-empty'), select=root.querySelector('select');
  const pauseButton=root.querySelector('[data-action="pause"]');
  function label(text, state='waiting') {status.textContent=text;root.dataset.state=state;options.onState?.(state);}
  function clearConnection(message) {
    epoch++; connected=false;current='';
    const old=rfb;rfb=null;old?.disconnect();channel?.close();channel=null;
    host.replaceChildren();empty.hidden=false;empty.textContent=message;
  }
  function endMessage() { return terminal?'本轮测试已结束。直播连接已关闭；截图证据不是直播回放。':paused?'已暂停观看，AI 测试仍继续执行。':'此业务当前没有活动浏览器。接口检查不会伪造页面操作。'; }
  async function request(path, method='GET') {
    const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',signal:abort.signal,
      ...(method==='POST'?{headers:{'Content-Type':'application/json'},body:'{}'}:{})});
    if(!response.ok) {const e=new Error('viewer request failed');e.status=response.status;throw e;}
    const value=await response.json();if(value.error || !value.data)throw new Error('invalid response');return value.data;
  }
  function eligible() {return selectedTasks?.length?sessions.filter(s=>selectedTasks.includes(s.task_id)):sessions;}
  function desired() {
    const list=eligible();
    if(manual)return list.find(s=>s.id===manual);
    return list.find(s=>s.state==='working') || list.find(s=>s.id===current) || list[0];
  }
  function rebuildOptions() {
    const list=eligible();select.replaceChildren(new Option('跟随当前业务',''));
    for(let i=0;i<list.length;i++)select.add(new Option(`测试浏览器 ${i+1} · ${list[i].state==='working'?'操作中':'等待下一步'}`,list[i].id));
    if(!list.some(s=>s.id===manual))manual='';select.value=manual;
    select.hidden=list.length<2;
  }
  async function connect(session) {
    clearConnection('正在连接真实测试浏览器…');label('正在连接直播…','connecting');
    const mine=epoch;current=session.id;
    try {
      const ticket=await request(`${base}/${encodeURIComponent(session.id)}/ticket`,'POST');
      if(closed || paused || terminal || epoch!==mine)return;
      const target=new URL(ticket.socket_path,origin);
      if(target.origin!==origin || !target.pathname.startsWith(new URL(base).pathname+'/'))throw new Error('invalid viewer endpoint');
      target.protocol=target.protocol==='https:'?'wss:':'ws:';
      channel=new WebSocket(target.toString(),['binary']);
      rfb=new RFB(host,channel,{shared:true});
      rfb.viewOnly=true;rfb.scaleViewport=true;rfb.resizeSession=false;rfb.focusOnClick=false;
      rfb.qualityLevel=7;rfb.compressionLevel=2;
      rfb.addEventListener('connect',()=>{
        if(closed || epoch!==mine)return;
        connected=true;failures=0;empty.hidden=true;
        label('实时观看 · AI 操作中，用户只读','connected');
      });
      rfb.addEventListener('disconnect',()=>{
        if(closed || epoch!==mine)return;
        failures++;retryAt=Date.now()+Math.min(10000,500*2**Math.min(failures,5));
        clearConnection('观看连接已断开，正在重新授权连接。测试本身不会被重启。');label('观看已断开，正在重连','reconnecting');
      });
      rfb.addEventListener('securityfailure',()=>{
        if(closed || epoch!==mine)return;clearConnection('观看握手失败，请检查桌面服务。');label('观看连接失败','error');retryAt=Date.now()+10000;
      });
    } catch(error) {
      if(closed || epoch!==mine)return;
      clearConnection(error.status===403?'没有当前测试的观看权限。':'无法连接测试浏览器，请检查服务或重试。');
      label(error.status===403?'观看未获授权':'连接失败，等待重试','error');retryAt=Date.now()+5000;
    }
  }
  async function tick() {
    if(closed || busy)return;
    if(terminal || paused) {if(current)clearConnection(endMessage());label(terminal?'测试已结束':'已暂停观看',terminal?'ended':'paused');empty.textContent=endMessage();return;}
    busy=true;
    try {
      const metadata=await request(base);if(closed)return;
      if(terminal || paused)return;
      sessions=(metadata.sessions || []).filter(s=>s.run_id===options.runId && s.transport==='novnc' && s.read_only===true);
      lastMetadata=Date.now();rebuildOptions();
      const session=desired();
      if(!session) {clearConnection(endMessage());label('等待当前业务的真实浏览器','waiting');return;}
      if(current && current!==session.id)clearConnection('正在切换本轮测试浏览器…');
      if(!current && Date.now()>=retryAt)await connect(session);
      else if(connected)label(session.state==='working'?'实时观看 · AI 操作中，用户只读':'实时观看 · 浏览器待命，未伪造操作','connected');
    } catch(error) {
      if(closed || error.name==='AbortError')return;
      if(error.status===403 || Date.now()-lastMetadata>8000)clearConnection('无法确认当前观看权限或会话状态，已断开画面。');
      label(error.status===403?'观看未获授权':'观看状态离线，正在重试','offline');
    } finally {busy=false;}
  }
  const onChange=()=>{manual=select.value;retryAt=0;clearConnection('正在切换浏览器…');void tick();};select.addEventListener('change',onChange);
  const onClick=event=>{
    const action=event.target.closest('button')?.dataset.action;
    if(action==='reconnect'){retryAt=0;clearConnection('重新连接观看，不会重启测试。');void tick();}
    if(action==='pause'){paused=!paused;pauseButton.textContent=paused?'恢复观看':'暂停观看';clearConnection(endMessage());void tick();}
    if(action==='fullscreen'){
      const result=document.fullscreenElement?document.exitFullscreen():root.requestFullscreen?.();
      result?.catch(()=>label('浏览器不允许全屏；仍可在面板中观看','connected'));
    }
  };root.addEventListener('click',onClick);
  const timer=setInterval(()=>void tick(),2000);void tick();
  return {
    setSelection(taskIds){const next=taskIds?.length?taskIds:null;if(JSON.stringify(next)===JSON.stringify(selectedTasks))return;selectedTasks=next;manual='';retryAt=0;clearConnection('正在跟随所选业务…');void tick();},
    setTerminal(value){terminal=Boolean(value);if(terminal)clearConnection(endMessage());void tick();},
    dispose(){closed=true;clearInterval(timer);abort.abort();clearConnection('');root.removeEventListener('click',onClick);select.removeEventListener('change',onChange);root.replaceChildren();},
  };
}
