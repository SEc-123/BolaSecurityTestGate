"""Offline browser component acceptance. No network/browser policy changes.
React19, icon/history/event/fetch adapters are explicit; NOT a deployed app/Android E2E.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import base64,json,os
root=Path(__file__).resolve().parents[3]
assets=Path(os.environ.get('BSTG_UI_ARTIFACT_DIR',root/'validation/business-experience/ui-assets'))
out=root/'validation/business-experience'
states=json.loads((assets/'states.json').read_text())
checks=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('BSTG_CHROMIUM','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':1080},locale='zh-CN')
    page.set_default_timeout(6000)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    # Render a visibly marked test page. This is not a device screenshot.
    page.set_content('<html lang="zh"><body style="background:#f2f5f9;font:18px sans-serif;padding:50px"><h3>界面验收样例 · 非真实 App</h3><main style="background:white;border:1px solid #ddd;border-radius:12px;padding:40px;max-width:450px"><h1>账号中心</h1><p>隔离测试页面</p><p>登录已提交</p><p>此图仅用于验证画面与测试项关联。</p></main></body></html>')
    image=page.screenshot()
    page.set_content('<!doctype html><html lang="zh"><head><meta charset="UTF-8"></head><body><div style="background:#fff5d6;text-align:center;padding:6px;font:12px sans-serif">受控界面验收 · 非真机测试 · 显式 React 19 与事件适配器</div><div id="root"></div></body></html>')
    page.add_style_tag(content=(assets/'visual-fixture.css').read_text())
    page.evaluate('data=>{window.__fixtureStates=data;window.__fixtureCurrent={"run-a":data.initial,"run-b":data.app};}',states)
    page.evaluate('image=>window.__fixtureImage=image','data:image/png;base64,'+base64.b64encode(image).decode())
    page.add_script_tag(content=r'''
      const store=new Map([['bstg_business_run','run-a'],['bstg.language','zh']]);
      Object.defineProperty(window,'localStorage',{value:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)}});
      // about:blank has no navigation/storage origin. These are explicit UI fixture adapters.
      history.replaceState=()=>{};history.pushState=()=>{};
      window.__requests=[];window.__sources=[];
      window.__publish=state=>{window.__fixtureCurrent[state.run.id]=state;for(const s of __sources)if(!s.closed&&s.id===state.run.id)s.listeners.assessment?.({data:JSON.stringify(state)});};
      window.EventSource=class{
        constructor(url){this.id=/ai-scans\/([^/]+)/.exec(url)?.[1];this.listeners={};this.closed=false;__sources.push(this);queueMicrotask(()=>{if(this.closed)return;this.onopen?.();this.listeners.assessment?.({data:JSON.stringify(__fixtureCurrent[this.id])});});}
        addEventListener(type,fn){this.listeners[type]=fn;}close(){this.closed=true;}
      };
      window.fetch=async(url,options={})=>{const path=String(url);__requests.push(path);let data;
        if(path.endsWith('/product-runs'))data=Object.values(__fixtureCurrent).map(s=>s.run);
        else if(path.endsWith('/product-state')){const id=/ai-scans\/([^/]+)/.exec(path)[1];data=__fixtureCurrent[id];}
        else if(path==='/api/mobile/business-profiles')data=[{id:'device',name:'授权测试设备',device_label:'已配置设备',enabled:true,simulated:false,scenarios:[]}];
        else return new Response(JSON.stringify({data:null,error:'Unexpected fixture request'}),{status:400,headers:{'content-type':'application/json'}});
        return new Response(JSON.stringify({data,error:null}),{status:200,headers:{'content-type':'application/json'}});
      };
    ''')
    page.add_script_tag(content=(assets/'react19-fixture.js').read_text())
    page.add_script_tag(content=(assets/'production-ui-offline.js').read_text())
    expect(page.get_by_test_id('business-test')).to_have_count(35)
    checks.append('Renders all 35 business tests, no truncation')
    assert not errors,errors
    # Source data is produced by the actual server projection.
    page.evaluate('__publish(__fixtureStates.running)')
    row=page.locator('[data-test-id="test:candidate-0"]')
    expect(row).to_have_attribute('data-status','running');expect(row).to_have_attribute('data-checked','false')
    expect(page.get_by_test_id('assessment-frame')).to_be_visible()
    checks.append('Running test and corresponding frame are rendered from events')
    assert '模拟画面' in page.get_by_test_id('live-surface').inner_text()
    checks.append('Simulated frame cannot look like live device evidence')
    page.evaluate('__publish(__fixtureStates.confirmed)')
    expect(row).to_have_attribute('data-checked','true')
    expect(row.locator('.line-through')).to_have_count(1)
    expect(page.get_by_test_id('confirmed-issues').locator('article')).to_have_count(1)
    expect(page.get_by_test_id('assessment-frame')).to_have_count(0)
    checks.append('Confirmed issue persists when its completed test is crossed out')
    checks.append('Next running test does not inherit a previous test screenshot')
    row.click();expect(page.get_by_test_id('assessment-frame')).to_be_visible()
    checks.append('Selecting completed case shows its associated historical frame')
    page.evaluate('__publish(__fixtureStates.mixed)')
    expect(page.locator('[data-test-id="test:candidate-1"]')).to_have_attribute('data-checked','false')
    expect(page.locator('[data-test-id="test:candidate-2"]')).to_have_attribute('data-status','skipped')
    expect(page.locator('[data-test-id="test:candidate-3"]')).to_have_attribute('data-status','review')
    checks.append('Failure, skipped and insufficient evidence remain unstruck')
    page.get_by_label('筛选测试项').select_option('issues');expect(page.get_by_test_id('business-test')).to_have_count(1)
    page.get_by_label('筛选测试项').select_option('all');page.get_by_label('搜索业务或测试项').fill('忘记密码');expect(page.get_by_test_id('business-test')).to_have_count(1)
    page.get_by_label('搜索业务或测试项').fill('');expect(page.get_by_test_id('business-test')).to_have_count(35)
    checks.append('Issue filter and business search keep correct counts')
    page.screenshot(path=str(out/'ui-web-business-checklist.png'),full_page=True)
    page.get_by_label('选择测试记录').select_option('run-b')
    expect(page.get_by_test_id('business-test')).to_have_count(4)
    page.evaluate('__publish(__fixtureStates.ended)');page.wait_for_timeout(100)
    expect(page.get_by_test_id('business-test')).to_have_count(4)
    assert page.evaluate('__sources.filter(s=>!s.closed&&s.id==="run-a").length')==0
    checks.append('Run switch closes old subscription and ignores late old-run updates')
    page.screenshot(path=str(out/'ui-app-business-checklist.png'),full_page=True)
    page.evaluate('__unmountApp()');assert page.evaluate('__sources.filter(s=>!s.closed).length')==0
    page.evaluate('__mountApp()');expect(page.get_by_test_id('business-test')).to_have_count(4)
    checks.append('Unmount/remount restores saved run and creates a new subscription')
    # Trigger an SSE error; component switches to HTTP polling and then recovers.
    page.evaluate('__sources.filter(s=>!s.closed).forEach(s=>s.onerror?.())')
    expect(page.get_by_test_id('assessment-connection')).to_contain_text('定时更新')
    page.evaluate('__publish(__fixtureStates.app)');expect(page.get_by_test_id('assessment-connection')).to_contain_text('已连接')
    checks.append('Broken event channel falls back to snapshots and recovers')
    page.get_by_role('button',name='新建测试',exact=True).click()
    page.get_by_role('button',name='Android App',exact=True).click()
    expect(page.get_by_role('group',name='要执行的 App 业务测试')).to_be_visible()
    assert page.locator('textarea').count()==1
    expect(page.get_by_role('button',name='开始测试',exact=True)).to_be_disabled()
    assert page.get_by_role('textbox',name='测试目标').is_visible()
    checks.append('App setup uses business selection, no raw step JSON, and requires authorization')
    page.get_by_role('button',name='收起新建',exact=True).click()
    page.set_viewport_size({'width':390,'height':900});page.wait_for_timeout(150)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2')
    page.screenshot(path=str(out/'ui-narrow-390.png'),full_page=True)
    checks.append('390px viewport has no horizontal page overflow')
    page.set_viewport_size({'width':1440,'height':1080});page.get_by_role('button',name='Expand navigation').click() if page.get_by_role('button',name='Expand navigation').count() else None
    # Chinese UI labels can be translated in Layout; use content substring when opening navigation.
    nav=page.locator('nav button');nav.nth(1).click();page.wait_for_timeout(250)
    expect(page.get_by_role('heading',name='测试发现的问题',exact=True)).to_be_visible()
    assert 'workflow' not in page.locator('body').inner_text().lower()
    nav.nth(2).click();expect(page.get_by_role('heading',name='业务测试报告',exact=True)).to_be_visible()
    assert not any('/findings' in r or r.endswith('/api/ai-scans') or '/tools' in r for r in page.evaluate('__requests'))
    checks.append('Findings and reports use only per-run product data, no raw engine endpoints')
    assert not errors,errors
    report={'mode':'offline browser component regression with explicit React19, memory event/fetch/history/icon adapters; not production build/device E2E','checks':checks,'passed':len(checks),'page_errors':errors,'react_version':page.evaluate('__fixtureReact.version'),'requests':page.evaluate('__requests')}
    (out/'browser-component-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps(report,ensure_ascii=False,indent=2));browser.close()
