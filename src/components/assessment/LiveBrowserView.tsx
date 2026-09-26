import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '../../lib/api-client';
interface Controller { setSelection(ids: string[] | null): void; setTerminal(ended: boolean): void; dispose(): void; }
/** Owns only the viewer, never the test lifecycle. A remount must not rerun AI actions. */
export function LiveBrowserView({runId, taskIds, ended}: {runId: string; taskIds: string[] | null; ended: boolean}) {
  const host = useRef<HTMLDivElement>(null);const controller = useRef<Controller | null>(null);
  const selection = useRef(taskIds);selection.current=taskIds;
  const terminal = useRef(ended);terminal.current=ended;
  const [error,setError]=useState('');
  useEffect(()=>{
    let cancelled=false;setError('');
    const cssId='bstg-live-viewer-css';
    if(!document.getElementById(cssId)){const css=document.createElement('link');css.id=cssId;css.rel='stylesheet';css.href='/live-browser/viewer.css';document.head.appendChild(css);}
    // Vendored noVNC is served locally. No CDN, iframe to the target, or screenshot URL.
    const moduleUrl='/live-browser/viewer.js';
    void import(/* @vite-ignore */ moduleUrl).then(module=>{
      if(cancelled || !host.current)return;
      controller.current=module.mountLiveViewer(host.current,{apiBase:API_BASE_URL,runId,taskIds:selection.current,terminal:terminal.current});
    }).catch(()=>{if(!cancelled)setError('实时观看组件加载失败。请确认部署包含 live-browser 和 vendor/novnc 静态文件。');});
    return ()=>{cancelled=true;controller.current?.dispose();controller.current=null;};
  },[runId]);
  const selectionKey=JSON.stringify(taskIds);
  useEffect(()=>{controller.current?.setSelection(taskIds);},[selectionKey]);
  useEffect(()=>{controller.current?.setTerminal(ended);},[ended]);
  return <section aria-label="实时观看 AI 测试浏览器"><div ref={host} data-testid="live-browser-mount"/>{error&&<p role="alert" className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{error}</p>}</section>;
}
