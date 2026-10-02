# 外部 Desktop Executor 最小契约

`desktop-executor.ts` 是 BSTG 的可选外部桌面执行器适配边界。它不替代现有 Playwright、录制器、Workflow 或 Test Run，也不会因为环境变量存在就自动把外部桌面当作业务证据来源。

业务证据链只能取得 `BusinessEvidenceDesktopExecutor`。取得它必须同时完成以下条件：

1. 所有四个 HTTP 调用都携带本次会话的 Bearer Token：`GET /health`、`GET /state`、`GET /screenshot.png`、`POST /action`。
2. `health` 在已认证响应中声明 Bearer 为必需、并且唯一允许的操作就是上述四项。
3. `state` 在已认证响应中声明 `bstg.desktop-executor.bridge.v1`：独占 browser instance、CDP WebSocket、当前 target ID，以及活动的 `cdp_fetch` network capture ID；capture target 必须与 browser target 相同。
4. 调用方提供服务端 CDP/Fetch attester。它必须实际连接该 CDP target，并在已有的 BSTG 网络录制/边界控制已经附着到同一 target 后，返回匹配的 browser ID、target ID 和 capture ID。只有这样适配器才会返回可执行的 evidence lease。
5. 每次 visual action 的响应都要返回同一 bridge state。browser、target 或 capture ID 改变时，lease 立即失效，不能把后续截图、操作或 HTTP 成功当成原业务证据。
6. 每个 action 都在执行前和执行后检查 state 的 target scope；执行后还会重新读取已认证 state，而不信任 action 响应本身。任何 action、state、截图、health、bridge 或 attestation 检查失败都会永久关闭该 lease，必须重新取得并 attestation 新 lease。

这里的 attester 是一个有意明确的服务端信任边界，不是模型参数，也不能由桌面 API 自我声明替代。现有持久浏览器运行时的 `installNavigationGuard` 已在本地上下文中安装 CDP `Network`/`Fetch` 观察；真正接入外部 runner 时，应复用该录制器，在它已附着的精确 target 上实现 attester。不得用第二个浏览器、仅 URL 相同的页面，或只依赖 noVNC 画面来证明同一性。

## 私有配置

仅支持 `BSTG_DESKTOP_EXECUTOR_CONFIG_FILE` 指向的**绝对路径** JSON 文件。Unix 上文件必须是 `0600`；Bearer Token 不接受通过普通环境变量、URL、查询串或日志传递。

```json
{
  "version": 1,
  "endpoint": "http://127.0.0.1:8765",
  "bearer_token": "private-per-run-token",
  "request_timeout_ms": 10000
}
```

默认只允许 `127.0.0.1` 或 `::1`。要使用远端运行器，配置必须显式加上 `"allow_remote": true`，并且 endpoint 必须是 HTTPS。endpoint 只能是 origin，不能包含用户名、密码、路径、查询或 fragment。

远端 bridge 的 CDP endpoint 必须在同一主机名上并使用 `wss:`；本地 loopback bridge 才可使用 `ws:`。每次 state 也必须仍在本轮声明的 target origin 内，视觉 `open` 只能打开该 origin 的 URL。

远端 API 的已认证 `health` 最小响应如下：

```json
{
  "ok": true,
  "authentication": { "required": true, "scheme": "bearer" },
  "allowed_endpoints": ["health", "state", "screenshot", "action"],
  "bridge_schema": "bstg.desktop-executor.bridge.v1"
}
```

已认证 `state` 除了 URL、标题和屏幕尺寸外，必须提供如下 bridge。标识符应为每个独占运行实例生成，不能复用其他 assessment 的值。

```json
{
  "url": "https://target.example.test/account",
  "title": "Account",
  "screen": [1280, 800],
  "bridge": {
    "schema": "bstg.desktop-executor.bridge.v1",
    "browser_instance_id": "browser-run-opaque-id",
    "cdp_ws_endpoint": "wss://runner.example.test/cdp/opaque-id",
    "target_id": "chromium-target-id",
    "ownership": "exclusive",
    "network_capture": {
      "mode": "cdp_fetch",
      "active": true,
      "capture_id": "capture-opaque-id",
      "target_id": "chromium-target-id"
    }
  }
}
```

`POST /action` 只接受有限的桌面输入：受屏幕尺寸约束的鼠标点、受限按键/热键、有限文本、滚动、等待，以及同一授权 target scope 内的 `open`。它不能执行 shell、任意进程、任意文件读写或跨 scope 打开网页。`/action` 的成功响应必须包含 `{ "ok": true, "state": ... }`，并且 state bridge 必须保持不变。

单键只限页面编辑与导航键。组合键采用精确白名单：`Ctrl+A/C/V/X/Z/Y`、`Ctrl+Shift+Z`，以及 `Shift+Tab/Enter` 和带 `Shift` 的方向、Home/End、PageUp/PageDown 选择键。不会接受 `Alt`、Command/Super、`Ctrl+Tab`、`Alt+Tab`、`Ctrl+Alt+Delete`、DevTools 等可能切换标签、应用或触发系统行为的组合；文本写入应优先使用 `insert_text`。

## 当前提供包的处理

`/Users/a0000/Downloads/computer-use-offline-linux-x86_64` 是一个有价值的 Linux x86_64 虚拟桌面与 PyAutoGUI/截图运行包，但当前不能作为 BSTG 业务证据运行器：

- `app/main.py:260-269` 允许未认证的 `/health`，也不声明 Bearer 认证或严格 endpoint allowlist。
- `app/main.py:108-111` 的 `/state` 只包含 URL、标题、屏幕、鼠标和 viewport；没有 CDP endpoint、target ID 或 network capture bridge。
- 它的 Playwright 和桌面输入在同一 Python 进程中是有用的执行能力，但没有向 BSTG 暴露可验证的同浏览器 CDP/请求捕获桥。

因此适配器会在 `/health` 的认证契约检查处失败；即使未来补上 health 声明，也会在 state bridge 检查处拒绝。不要绕过这些检查来把截图、点击或 HTTP 200 伪装成业务状态证明。

## 交付范围与后续接入

本次只交付严格适配契约、输入校验和本地单元测试。它没有启动 Linux rootfs、没有管理 runner 进程、没有把 token 写入数据库，也没有改变业务生命周期、实验编译或能力地图。真正产品化前仍需：

1. 为外部 runner 增加上述已认证 bridge state，并保证每 assessment 独占 Chromium/target。
2. 在持久浏览器录制器将 `Network`/`Fetch` observer 附着到该精确 target 后，提供真实 attester。
3. 连接同一 browser 的 live viewer、请求捕获和 visual fallback；selector/DOM 成功时仍优先使用现有 Playwright，视觉坐标动作后必须再做原生语义验证。
4. 在 x86_64 Linux 上运行 runner 的自检、桥接、崩溃回收和断线/取消验收。当前 macOS 上的 contract test 不构成该 Linux 验收。
