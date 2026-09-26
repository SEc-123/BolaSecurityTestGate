import { useState } from 'react';
import { apiRequest } from '../../lib/api-client';

export function MobileSetup({onSaved}:{onSaved:()=>void}) {
  const [serial,setSerial]=useState(''),[url,setUrl]=useState('http://127.0.0.1:4723');
  const [host,setHost]=useState('10.0.2.2'),[port,setPort]=useState('8080');
  const [installCa,setInstallCa]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const save=async()=>{
    if(!serial.trim()){setMessage('请输入设备序列号。');return;}
    setBusy(true);setMessage('');
    try{await apiRequest('/api/mobile/setup',{method:'POST',body:JSON.stringify({serial:serial.trim(),appium_url:url.trim(),proxy_host:host.trim(),proxy_port:Number(port),install_ca:installCa})});setMessage('设备环境已保存，可以上传 APK。');onSaved();}
    catch(e){setMessage(e instanceof Error?e.message:'保存失败。');}finally{setBusy(false);}
  };
  return <details className="rounded-lg border bg-slate-50 p-3"><summary className="cursor-pointer text-sm font-medium">配置 Android 测试设备</summary>
    <p className="my-2 text-xs leading-5 text-slate-600">服务所在电脑需安装 Android SDK、Java、Appium UiAutomator2 和 mitmproxy。设备可使用模拟器或授权真机，Appium 必须能连接到同一设备。</p>
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-xs">设备序列号<input aria-label="设备序列号" value={serial} onChange={e=>setSerial(e.target.value)} placeholder="emulator-5554" className="mt-1 w-full rounded border p-2"/></label>
      <label className="text-xs">Appium 服务地址<input value={url} onChange={e=>setUrl(e.target.value)} className="mt-1 w-full rounded border p-2"/></label>
      <label className="text-xs">设备访问代理的地址<input value={host} onChange={e=>setHost(e.target.value)} className="mt-1 w-full rounded border p-2"/></label>
      <label className="text-xs">代理端口<input type="number" value={port} onChange={e=>setPort(e.target.value)} className="mt-1 w-full rounded border p-2"/></label>
    </div>
    <label className="my-3 flex items-start gap-2 text-xs"><input type="checkbox" checked={installCa} onChange={e=>setInstallCa(e.target.checked)}/>允许在可 root 的专用测试模拟器中安装测试代理证书；否则设备需已信任该证书。证书锁定会作为阻断原因报告。</label>
    <button type="button" disabled={busy} onClick={()=>void save()} className="rounded bg-blue-700 px-3 py-2 text-sm text-white disabled:opacity-50">{busy?'保存中…':'保存设备环境'}</button>
    {message&&<p role="status" className="mt-2 text-xs text-amber-800">{message}</p>}
  </details>;
}
