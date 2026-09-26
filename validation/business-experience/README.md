# 本轮证据

仅此目录是本次修订的运行记录。

- product-node：93 项新增业务体验测试。
- mobile-regression：197 项既有移动测试。
- capture-addon：18 项实际插件逻辑测试。
- browser-component：14 项受控离线 Chromium 组件交互，明确使用 React19 与请求/事件等替身；不是真机。
- core-typecheck：6 个核心模块的语义检查，不包含完整 React/Express 构建。
- syntax：28 个修改源文件的语法检查，不是完整类型检查。
- build-full/typecheck-full/typecheck-server-full：完整生产检查失败日志，不能按通过处理。
- clean-*：交付目录内真实复跑，数量不重复累计。
- ui-*.png：带标记的界面渲染测试截图，不是真实 App 的运行证据。
- summary.json：汇总、明确区分通过、失败及未运行。

SSE 单元/集成覆盖真实 Node HTTP 套接字及原有HTTPS套件使用真实本地 TLS。没有 Android设备+Appium+mitmproxy+已部署 React18 前端的联合验收。
