# 本次交付入口

- 功能和差距分析：`docs/business-experience/REQUIREMENTS.md`
- 生产部署、App 场景和验收：`docs/business-experience/RUNBOOK.md`
- 实际验证和未通过项：`docs/business-experience/VALIDATION.md`
- 变更清单与补丁检查：本目录 JSON 文件
- 测试日志及界面组件截图：`validation/business-experience/`

补丁基线是 `BolaSecurityTestGate-appium-https-closure.zip`。普通用户通过业务测试界面操作，不接触内部 JSON。完整包未包含已构建前端/后端，需要执行生产依赖安装、类型检查和构建。不要将受控渲染截图视为真机证据。
