# 本版入口：实时浏览器旁观，而不是截图刷新

基线：BolaSecurityTestGate-business-test-experience.zip。

阅读顺序：
1. `docs/live-browser/REVIEW_ZH.md`：本轮变化、实际验证及未验证项。
2. `docs/live-browser/USER_PAGES_ZH.md`：用户能进入的全部已挂载页面、操作与布局。
3. `docs/live-browser/RUNBOOK.md`：Linux 依赖、同源 WS、只读和远程鉴权对接、真实验收。

Web 主观察区已用 noVNC；截图只保留为折叠证据。Android 仍保持上一版 Appium 逐帧观察。

先在新目录安装、编译并执行 `npm run check:web:live`；再启动并运行 `npm run test:web:live` 完成授权部署验收。不能用旧 dist、历史日志或本地 fixture 的成功取代目标环境发布验收。

本轮结果在 `validation/live-browser/`，此前目录内保留的报告属于历史轮次，不是本轮新增通过数量。
