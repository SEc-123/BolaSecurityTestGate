# noVNC 实时浏览器整改与验证报告

## 结论与基线

基线为 `BolaSecurityTestGate-business-test-experience.zip`。旧版 Web 主观察区使用采样截图 `<img>`，不等于用户旁观 AI 操作同一个浏览器桌面。本版将 Web 主观察路径替换为 noVNC，保留业务清单、完成删除线和确认问题；静态截图只在用户展开证据区后才加载。

实现链路：AI 工具 → 持久化浏览器上下文 → 独立 headed Chromium/Xvfb → 服务器只读 x11vnc → 私有 Unix websockify → 逐运行鉴权的 HTTP/WS 网关 → 同源 noVNC canvas。

本版不是给原截图更换名字、提高截图刷新率，也不是把被测网站放进 iframe。前端每 2 秒读取的是会话元数据；屏幕像素来自持续 RFB 连接。noVNC 本身使用帧缓冲增量协议，不承诺固定视频帧率或零延迟。

## 一、实际修改

1. 浏览器不再使用跨任务共享的 headless 进程。各上下文拥有独立桌面及浏览器，真正的页面、弹窗、滚动和输入均处于该桌面内。
2. 新增 `browser.interact` 的点击、输入、选择、按键、滚动、页面断言和观察；返回页面观察但不返回表单值、Cookie 或凭证。动作成功不直接等于业务安全测试通过。
3. `browser.navigate` 工具强制真实浏览器路径，缺少桌面/Playwright 时失败，不以 HTTP 抓取替代。单独的 HTTP 发现和安全检查仍可运行，但不会伪装 UI 操作。
4. 声明范围以外的主动文档导航、重定向和弹窗目标在 route 中阻断；被动 CDN 资源继续允许。task-scoped 上下文绑定所属任务，另一个任务不能凭自定义 context_key 重用。
5. 完成任务及时关闭其专有桌面，scan/identity 共享上下文在整轮结束或超时关闭。关闭单个运行不能关闭其他运行的浏览器。观看断开/刷新不触发重复业务动作。
6. 默认只允许本机观看。远程模式要求可信鉴权代理明确授予运行权限，再申请绑定身份、Origin、运行、桌面的 30 秒一次性票据。内部 VNC 及 websockify 只监听私有 Unix socket。
7. 服务端 `-viewonly` 拒绝观看者键鼠输入；前端 viewOnly、禁止剪贴板输入、只在本地缩放。页面重连、暂停/恢复观看、全屏、选择同业务浏览器都不改变测试结果状态。
8. Web 主观察区使用新组件；截图证据折叠、按需加载并明确标注非直播。未找到对应任务的浏览器，不用其他任务窗口补位。静态历史图不是视频回放。
9. Vite 启用 WS 代理，生产 HTTP server 安装同一个网关 Upgrade 处理器；Playwright 移入服务端生产依赖并同步 lockfile；noVNC 本地附带版本和许可证，不依赖 CDN。
10. 更新真实部署验收脚本，Web 必须出现原生 WebSocket、实际 noVNC canvas 更新、刷新恢复和业务状态完成，不再靠两张截图通过。

本次差异共 92 个文件：32 个自有代码/测试/文档变更，60 个随包保存的 noVNC 源码、许可证和来源校验文件。不能把第三方文件数量算作自研修改量。

## 二、本轮实际验证

| 项目 | 本轮结果 | 证据边界 |
|---|---:|---|
| 权限、Origin、代理身份、票据隔离/过期/重放/配额 | 26/26 | Node 单元测试，非 UI E2E |
| 浏览器运行时和工具动作契约 | 22/22 | 生产 runtime + 真实桌面生命周期；Playwright 使用明示 double |
| 桌面/网关真实链路 | 20/20 | 真 Xvfb、x11vnc、websockify、Chromium、HTTP、WS、RFB；页面为授权本地 setContent fixture |
| 实际 noVNC 前端组件 | 10/10 | 实际生产组件、实际 noVNC 解码/Canvas、实际 RFB；浏览器 HTTP/WS/location 是明示桥接 |
| 原业务体验 Node 回归 | 93/93 | SQLite/相关依赖采用原有明示测试适配器 |
| 原移动端 Node 回归 | 197/197 | 使用原有明示设备及依赖适配器，不是真机验收 |
| 原 Python 抓包插件回归 | 18/18 | 插件单元测试，不是真机代理 TLS 抓包 |
| 新增网关核心语义类型检查 | 3 个模块通过 | access-policy / desktop-runtime / gateway，使用已安装 Node 类型 |
| 修改的自有 TS/JS 文件语法检查 | 24 个文件，0 语法错误 | 不等同于全量类型/生产构建 |
| 原移动及产品静态契约 | 2 项通过 | 静态约束，不是真实运行验收 |

实际 Agent 工具注册表另已加载验证：27 个注册工具中包含 `browser.interact`，`browser.navigate` 不再暴露 HTTP 降级选项（采用明示依赖适配器）。

真实桌面链测试中，Playwright 在真正的 Chromium 页面填写授权账号并点击按钮，接收端通过实际 RFB 更新看到输入值和结果区变化。另一个恶意观看客户端发送键盘及鼠标事件，服务器未让它改变输入或再次触发按钮；这不是仅检查前端 viewOnly 参数。

实际 noVNC 测试还验证了重连申请新票据、观看暂停不停止浏览器、选择不同业务不显示旧桌面、窄屏不横向溢出、结束后清空 live canvas、观看组件没有请求截图地址。

`validation/live-browser/real-stack/*.png` 是从真实 RFB 数据保存的验证证据；`viewer-stack/*.png` 是实际 noVNC 组件渲染截图。它们不是产品直播的实现方式，也不是客户网站漏洞证据。

## 三、未通过/未完成，不能省略

完整前端和服务端类型检查、生产构建没有通过：缺少项目依赖与声明，构建报告 `vite: not found`。聚焦检查 persistent-browser-runtime 还受缺少 uuid 声明阻断。运行源码测试时使用了已安装 TypeScript，不能据此声称 npm ci/生产编译成功。

真实 native navigation probe 已执行并返回 `ERR_BLOCKED_BY_ADMINISTRATOR`，本地 HTTP 服务收到 0 个请求；没有修改受管理 Chromium 的策略。因此受控页面使用 setContent，不能声称正常网址导航、整站 React18+Express、原生浏览器网络或真实外部站点的端到端验收已经通过。

组件测试的浏览器 HTTP/WS 通过明示桥接到真实网关；这验证解码、生命周期和画面，不是把浏览器自身的原生网络连通性算作已验收。本轮 Chromium 对受控 fixture 显式关闭 sandbox；发布预检会拒绝这一降级，生产应使用非 root 和正常 sandbox。

没有 Android 真机验收，Android 仍为 Appium 逐帧观察。没有实现整个系统的登录/租户/RBAC、录像回放、任意网站自动完整业务覆盖。当前页面也没有测试暂停/终止按钮。

## 四、必须理解的产品边界

实时展示只能呈现真正发生的 UI 行为。原生接口安全测试可能只发请求，这时不能安排假的鼠标动画。模型可以使用新增 UI 工具完成需要的页面交互，但不是所有漏洞测试都变成页面点击。

原始桌面流可能包含敏感业务数据；静态截图 mask 不会自动屏蔽 VNC。只使用授权测试数据，远程观看必须有与该运行相匹配的权限。默认本机模式是单操作者使用方式，不是多用户平台安全承诺。

桌面、票据为 worker 本地内存资源，当前没有分布式调度；并发使用要保持运行和观看的 worker 亲和。正常结束会回收进程；SIGKILL/主机故障不等于正常 cleanup，需使用系统服务管理器回收进程组。浏览器 sandbox 和租户隔离不是一回事。

## 五、用户页面与后续验收

用户可达页面、真实操作和布局详见 `USER_PAGES_ZH.md`。三个入口仍是业务测试、发现问题、测试报告，没有恢复内部工具页面。

部署后执行 `npm run check:web:live`；在真实授权测试运行期间执行 `npm run test:web:live`。缺少依赖、没有浏览器动作、只有静态历史图、无法看到原生 RFB 连接、未完成业务验证均不能通过发布验收。

## 六、技术资料

- noVNC 官方 API（RFB/WebSocket、viewOnly、scaleViewport、连接生命周期）：https://novnc.com/noVNC/docs/API.html
- noVNC 上游源代码与固定版本来源：https://github.com/novnc/noVNC/tree/v1.5.0
- websockify 官方实现：https://github.com/novnc/websockify
- Playwright 官方 Docker/非 root/sandbox 说明：https://playwright.dev/docs/docker

上游网站用于核对协议和部署方式；本报告中的代码实现及测试结果依据交付源码和本次运行日志，不借用上游能力声称本项目已全部验收。

## 附：本版源码定位

行号只对应本交付版本。

| 文件 | 可核对的位置 |
|---|---|
| `src/App.tsx` | L14 `const PAGE_PATHS`；L46 `const navItems`；L70 `const renderPage` |
| `src/components/Layout.tsx` | L25 `export function Layout`；L89 `w-[264px]`；L126 `bstg-topbar` |
| `src/pages/AIScans.tsx` | L8 `const CHECKS`；L156 `const canResume`；L168 `aria-label="新建业务测试"` |
| `src/components/assessment/AssessmentWorkspace.tsx` | L39 `export function AssessmentWorkspace`；L75 `lg:grid-cols`；L98 `<LiveBrowserView` |
| `src/components/assessment/AssessmentResults.tsx` | L10 `export function AssessmentResults`；L25 `mode==='report'` |
| `server/src/services/ai-scan/browser/persistent-browser-runtime.ts` | L42 `async function chromiumBrowser`；L205 `export async function navigatePersistentBrowser`；L386 `export async function closeTaskBrowserContexts`；L404 `export async function interactPersistentBrowser` |
| `server/src/services/live-browser/desktop-runtime.ts` | L68 `export async function openDesktop`；L129 `-unixsock` |
| `server/src/services/live-browser/gateway.ts` | L16 `async handleHttp`；L43 `upgrade(req` |
| `server/src/services/live-browser/access-policy.ts` | L18 `export function authorizeViewer`；L51 `export class ViewerTickets` |
| `server/src/agent/tools/ai-scan-tools.ts` | L203 `name: 'browser.navigate'`；L227 `name: 'browser.interact'` |
| `server/src/agent/agent-runtime.ts` | L505 `closeTaskBrowserContexts(this.repo` |
| `public/live-browser/viewer.js` | L5 `export function mountLiveViewer`；L47 `async function connect`；L79 `async function tick` |
