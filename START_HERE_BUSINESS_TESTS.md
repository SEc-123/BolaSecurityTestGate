# 业务清单 + 实际测试过程：本轮修订入口

当前修订以普通用户的业务测试体验为入口：Web 与 Android 共用业务清单、正在执行的测试画面、完成删除线、保留的确认问题和一致的报告。底层执行机制由原引擎使用，默认页面不展示原始内部数据。

请依次阅读：

1. `docs/business-experience/REQUIREMENTS.md`：原问题、实际修改和功能边界。
2. `docs/business-experience/RUNBOOK.md`：依赖、生产构建、App 场景准备及验收操作。
3. `docs/business-experience/VALIDATION.md`：本轮实际测试和未验证项。

`delivery/business-experience/` 包含增量补丁及干净基线核验；`validation/business-experience/` 仅包含本轮运行记录。旧版根目录的移动端报告用于历史背景，不取代本轮验证结论。

**生产构建、真实部署和真机 Appium+HTTPS 联合验收尚未在本环境通过。** 带“受控界面验收/非真机”的截图不是设备证据。不要直接沿用旧 dist。
