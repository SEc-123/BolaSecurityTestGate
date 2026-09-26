import type { Browser, LaunchOptions } from 'playwright';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

/** A connection is private to its caller; contexts must still be isolated per run/identity.
 * Remote workers supply the browser and its trust store, never a shared logged-in page.
 * TLS verification stays enabled in both local and remote contexts. */
export async function launchAssessmentBrowser(options: LaunchOptions): Promise<Browser> {
  const playwright = await dynamicImport(process.env.BSTG_PLAYWRIGHT_MODULE || 'playwright').catch(() => null);
  if (!playwright?.chromium) throw new Error('缺少 Playwright 浏览器运行时，请配置已安装的服务依赖。');
  const endpoint = process.env.BSTG_BROWSER_WS_ENDPOINT?.trim();
  if (endpoint) {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error('浏览器运行时地址必须为有效的 ws:// 或 wss:// 地址。'); }
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('浏览器运行时地址必须使用 ws:// 或 wss://。');
    if (options.headless === false) throw new Error('远程浏览器连接暂不提供本机桌面控制，请使用 headless 模式或本机 noVNC 运行时。');
    return playwright.chromium.connect(endpoint, {
      timeout: 30000,
      // run-server creates one owned browser per connection, supports explicit
      // network forwarding, and closes it when this connection terminates.
      headers:{'x-playwright-browser':'chromium','x-playwright-launch-options':JSON.stringify({
        ...options,executablePath:process.env.BSTG_REMOTE_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      })},
      ...(process.env.BSTG_BROWSER_EXPOSE_NETWORK ? { exposeNetwork: process.env.BSTG_BROWSER_EXPOSE_NETWORK } : {}),
    });
  }
  return playwright.chromium.launch(options);
}
