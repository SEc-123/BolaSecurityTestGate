# BSTG 本轮闭环验收待办

- [x] 读取并遵循自动化、持久化计算、内置模型和 WebDev 相关技能说明，确认中转部署边界
- [x] 盘点移动端 session、代理、CA、捕获、Recording、Workflow、Finding、Gate 的现有 API 与事件记录
- [x] 定义受控 Agent 中转的事件模型、脱敏规则、请求关联 ID 和失败状态
- [x] 在后端接入 Agent 调用事件发布与实时订阅接口，不暴露密钥和完整敏感载荷
- [x] 在测试前端接入实时事件流，展示 Agent 调用、工具/服务阶段、请求响应摘要、Finding、Gate 和阻断原因
- [x] 启动真实 x86 Android AVD，执行 APK attestation、安装、CA 信任、代理配置和 HTTPS 解密验证（APK、CA、代理通过；本轮 HTTPS 解密因 AVD 掉线阻断）
- [ ] 触发真实非轮询业务流，导入捕获并通过原生 Runner 生成 Finding 与 Gate 结果（本轮新 session 因无 decrypted HTTPS flow 未执行）
- [x] 证明前端看到的调用事件来自后端真实执行，而不是静态或模拟数据
- [x] 验证设备掉线、CA 未信任、代理端口冲突和 Agent 错误时前后端都 fail-closed
- [x] 运行构建/验证脚本，整理真实工件、日志、源码和验收说明
