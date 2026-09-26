# Web 实时旁观部署与验收

## 本版行为

Web 主观察区使用 noVNC 的真实 RFB 桌面连接。AI 的 `browser.navigate` / `browser.interact` 操作的是同一个 headed Chromium。每个浏览器上下文分配自己的 Xvfb、Xauthority、x11vnc 和 websockify；没有共享宿主桌面，没有对目标页面创建 iframe，也没有以截图轮询充当直播。

截图只供审计及历史证据，放在折叠区。Android 仍是上一版的 Appium 逐帧观察，本次没有升级为手机视频流。接口级检查没有浏览器动作时不伪造点击。

## 1. 系统和安装

运行桌面的 worker 必须是 Linux。使用非 root 的专用用户运行应用，保留 Chromium sandbox。需要 Xvfb、x11vnc、websockify 和对应浏览器依赖。Debian/Ubuntu 可由管理员安装系统软件，例如：

```sh
sudo apt-get update
sudo apt-get install -y xvfb x11vnc xauth x11-utils websockify
npm ci
npm --prefix server ci
(cd server && npx playwright install --with-deps chromium)
npm run typecheck
npm run typecheck:server
npm run build
npm run check:web:live
npm start
```

以上是部署命令，不是本环境已经执行成功的声明。本环境 npm registry DNS 失败、完整项目依赖缺失，完整构建未通过。

Playwright 已从 server 的 devDependencies 移入 dependencies，并同步 lockfile，避免生产省略 devDependencies 后没有浏览器驱动。`public/vendor/novnc` 已附本地模块及许可证，不需要在线 CDN；固定版本 1.5.0，不称为最新版本。升级第三方版本后必须重新执行直播、只读和断线回归。

源代码开发使用 Vite 的 `/api` WebSocket 代理；生产构建会将 public 文件带入 dist。前后端必须同源访问。不要仅把 viewer.js 复制到旧 dist 后继续运行旧后端。

## 2. 默认本机模式

默认 `BSTG_LIVE_ACCESS_MODE=local`。观看接口仅接受实际 loopback socket、loopback Host、匹配 Origin；不接受代理伪装的 X-Forwarded-For 身份。通过本机应用或 SSH 本地端口转发访问；不要把此模式解释为多用户鉴权。

```sh
export BSTG_LIVE_ACCESS_MODE=local
npm run check:web:live
npm start
```

默认 8 个同时活动桌面、每桌面最多 4 个观看连接；尺寸 1366×900。已完成任务会关闭 task-scoped 浏览器，避免长测试耗尽桌面配额；共享 scan/identity 上下文在整轮结束或超时关闭。

| 环境变量 | 默认 | 含义 |
|---|---:|---|
| BSTG_LIVE_MAX_SESSIONS | 8 | 桌面总数上限，范围 1–32 |
| BSTG_LIVE_WIDTH / HEIGHT | 1366 / 900 | 服务器固定桌面尺寸 |
| BSTG_LIVE_IDLE_SECONDS | 900 | 待命桌面空闲超时 |
| BSTG_LIVE_MAX_SECONDS | 7200 | 桌面最长寿命，超时会结束相应浏览器 |
| BSTG_CHROMIUM_EXECUTABLE | Playwright 安装位置 | 管理员指定的实际浏览器 |
| BSTG_XVFB_BIN / X11VNC_BIN / WEBSOCKIFY_BIN | PATH 中同名程序 | 管理员指定程序路径 |

本版会话注册表、票据及 Unix socket 在同一个 worker 内。多副本必须将同一运行的 API 和 WS 路由到所属 worker；本次没有实现分布式桌面调度。系统进程崩溃、SIGKILL 或主机断电不等于正常清理完成；以服务管理器/cgroup 回收其整个进程组，不能依靠持久化数据库自动接回旧画面。

## 3. 远程 HTTPS / WSS 模式

**原项目没有完善的登录/用户/租户权限系统，本次没有把隐藏导航冒充权限控制。远程部署前必须在整个站点与全部 API 前部署鉴权网关，并阻断客户端直接访问后端端口。** 下面是本次观看网关的对接契约，不是开箱即用的完整 SSO 服务。

```sh
BSTG_LIVE_ACCESS_MODE=proxy
BSTG_LIVE_PROXY_IP=127.0.0.1
BSTG_PUBLIC_ORIGIN=https://bstg.example.org
# 由 Secret Manager 注入随机的 >=32 字节共享值，不写入 Git/前端/截图
BSTG_LIVE_PROXY_SECRET=...
```

可信反向代理必须删除所有客户端传入的 `X-BSTG-*`，从经验证的登录会话和运行权限中重新产生：

- `X-BSTG-User`：已验证身份；
- `X-BSTG-Run-Ids`：明确允许观看的运行 ID 列表，不接受 `*`；
- `X-BSTG-Proxy-Secret`：代理与后端之间的密钥。

每次状态读取、票据申请和 WebSocket Upgrade 都验证这些信息。仅伪造 user 或知道 session ID 不足以连接。`BSTG_LIVE_PROXY_IP` 匹配真实 socket 地址，可能需要明确填写 `::ffff:127.0.0.1`，不能填写转发头中的地址。

nginx 必须开启 `proxy_http_version 1.1`，转发 `Upgrade` 与 `Connection`，关闭该路由缓冲，适当延长读取超时。HTTP 页面不应混用 ws 到另一个主机；HTTPS 页面通过同源 wss。观看 URL 内有一次性短期票据，访问日志不得记录查询字符串或代理密钥。

观看票据 30 秒有效、只使用一次、绑定用户/Origin/运行/桌面；已建立连接最长 5 分钟后重新鉴权。权限撤销不是毫秒级推送，最多受这个重新鉴权窗口约束。观看页丢失身份或断线不会自动重新执行测试。

## 4. 操作含义

- “重连观看”只重新连 RFB，不重跑 AI 测试。
- “暂停观看”只关闭观看连接，AI 继续操作；它不是“暂停测试”。
- “全屏”只在本地缩放画面，不改变被测桌面的尺寸。
- “跟随当前测试”按业务项的任务 ID 选择本轮会话；不会用另一项的浏览器填充空白。
- 同一业务有多个活动浏览器时可选择；选择不同业务先切换测试清单。
- 结束/过期/无活动浏览器明确显示状态，不继续播放旧截图。

服务器使用 x11vnc `-viewonly` 禁止键盘和鼠标输入，前端也关闭输入和剪贴板。内部 VNC/websockify 仅用私有目录中的 Unix socket，没有开放给外部的 VNC TCP 端口。Xauthority 与目录分别采用 0600 / 0700。

**原始实时桌面不是自动打码画面。** 密码输入框的原生隐藏不代表业务数据都已脱敏；响应、账号、个人资料等可能被看见。只使用授权隔离测试账号与数据，观看权限应等同于直接看该测试会话的权限。静态审计截图的 mask 不会作用于 VNC 实时像素。

## 5. 验证命令和真实发布门槛

```sh
npm run test:web:viewer:policy       # 权限/票据单元测试
npm run test:web:viewer:contracts    # 明示 Playwright double；不是网站验收
npm run test:web:viewer:stack        # 真 Xvfb/VNC/WS/Chromium；本地受控 fixture
npm run test:product:experience:adapters
npm run test:mobile:closure:adapters
```

受控 fixture 的桌面链测试不得被当成目标网站安全结论。本交付还提供浏览器组件桥接测试 `tests/live-browser/viewer-stack.mjs`；其 HTTP/WS 浏览器端用了明示测试桥，RFB 字节和像素是真实的，但不代替原生浏览器网络 E2E。

完整发布需在已经启动的授权测试期间执行，不接受历史记录、模拟帧或自动跳过：

```sh
export BSTG_UX_AUTHORIZED=true
export BSTG_UX_FRONTEND_URL=http://127.0.0.1:3001
export BSTG_UX_API_URL=http://127.0.0.1:3001
export BSTG_UX_RUN_ID=<正在运行的授权测试ID>
export BSTG_UX_TIMEOUT_MS=180000
# 远程鉴权环境可提供 Playwright storage state 文件；不要入库或随证据公开
# export BSTG_UX_STORAGE_STATE=/private/auth-state.json
npm run test:web:live
```

该检查观察原生 WebSocket、实际 noVNC canvas 变化、浏览器刷新后的连接恢复、业务状态推进、最终删除线和保留的问题数量。它不会自行创建漏洞、偷偷放开浏览器策略或关闭 HTTPS 校验。运行窗口内没有浏览器操作时应验收失败/不满足条件，而不是用纯 HTTP 检查冒充 UI 验收。

## 6. 本轮已知限制

没有完成全量依赖安装和完整生产编译；没有真实外部网站/完整 Express+React 原生网络部署验收。执行环境 Chromium 返回 `ERR_BLOCKED_BY_ADMINISTRATOR`，没有修改其策略。没有真实 Android 设备联合验收。本次主要覆盖 Web 直播，Android 原链路未改为直播。

本轮为了在受控本地 fixture 中启动 Chromium，显式使用 `BSTG_BROWSER_ALLOW_NO_SANDBOX=1`；这是隔离测试的降级，不是生产安全验收通过。部署预检会将该开关视为发布阻断项。
