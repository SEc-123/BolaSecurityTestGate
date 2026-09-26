# Appium + HTTPS 应用测试整改报告

日期：2026-09-18。整改基线为上一轮交付 `BolaSecurityTestGate-mobile-e2e-closure.zip`，不是绕过该基线重新修改最初 ZIP。

基线 ZIP SHA-256：`192d8534d8ae34789fb66b7ef28193defcbbe24c9bd8ac4a3c40112f5fe8db05`。

## 一、结论及验收边界

本次把移动端主路径从“操作/采集后做 HTTP 回放”调整为 **Appium 原生 UI 操作 + 同步骤完整 HTTPS 请求/响应业务断言 + 独立应用测试报告 + 服务端 finally 清理**。源码、测试、统一 API、Agent 产物、前端结果展示和设备 CLI 已同时修改。

已实际执行：197 项 Node 回归（含 50 项新增 Appium/HTTPS 相关测试）、18 项 Python 抓包插件单元测试、真实本地 HTTPS 业务与证书校验、3 个独立新增核心模块的语义类型检查、15 个修改/新增 TypeScript 文件的语法检查，以及两项原有静态契约检查。

**未执行**：实际 Android/UiAutomator2 驱动运行、实际 mitmproxy 的 App TLS 截获、参考 APK 构建、完整 Express/浏览器端到端、完整生产依赖构建与 PostgreSQL 验收。环境没有 adb/Appium/mitmdump/SDK/KVM；npm registry DNS 失败、pip 无可安装 mitmproxy 分发；生产发布检查因 React/Express 等依赖不可用被阻断。日志如实保留，未把这些项目算作通过。

因此，交付证明的是实现和可在当前环境执行的回归，不是“用户的 App 已在真机上通过”。最终放行必须由配置好的授权设备执行主入口，取得同次运行的 PASS 和证据。

## 二、基线断点与改造

| 断点 | 原始风险 | 本次落实 |
| --- | --- | --- |
| 驱动混合 | 严格路径的点击、滑动、返回和观察主要走 ADB；仅部分输入使用 Appium | 新建 NativeAppiumClient，严格 UI 路径统一 W3C Appium；ADB 只保留基础设施角色；失败无 ADB UI 回退 |
| 设备身份 | Appium session 成功不等于选中了声明设备 | 验证服务端返回的 udid、Android、UiAutomator2；按设备+移动会话隔离缓存，设置并租约管理 systemPort |
| 页面层次 | 仅解析 `<node>` 标签会漏掉 Appium 的 `android.widget.*` XML | 解析原生类名标签；严格验证截图、UI、前台包名；选择器唯一且可见 |
| 点击成功被当作测试成功 | UI 操作与业务响应无声明式联合判断 | 每个非等待步骤有 UI expect，至少一个业务动作有 expect_network；UI、请求身份、响应同时成立 |
| HTTPS 被弱化 | 原证据存在把 reverse HTTP URL 改成 HTTPS 的路径 | 删除 URL 改写；要求客户端 TLS + 上游 TLS + 上游验证 + 完整正文；严格代理禁止 HTTP 上游降级 |
| 代理全局配置漂移 | 已有 confdir 配置可能影响模式或证书校验 | 启动命令明确 regular/reverse，明确 ssl_insecure=false，私有 CA 用独立信任文件 |
| 跨步骤错配 | 延迟响应可能被算入后面的操作 | requestheaders 冻结服务端生成的 run/step 身份；响应保留原始归属，结合 capture/设备/包名/时间/方法/URL 匹配 |
| 有包无业务证明 | 后台请求或其他步骤能充当结果 | 精确请求/响应断言；只导入当前 Appium 测试实际通过断言的 flow IDs |
| 故障丢失 | 握手失败无完整响应，可能被“无流量”掩盖 | TLS 客户端/服务端、请求错误、流式/超限/解码失败独立诊断；缺证据仍 BLOCK |
| 清理依赖客户端 | 浏览器断开可能留下半次测试 | 新 POST /sessions/:id/test 服务端拥有完整生命周期，finally 清理；reservation 防止操作插入；故障保留租约 |
| 报告混淆 | 服务端回放 Gate 被当成 App 测试结果 | 独立 getMobileTestReport；只有设备/UI/HTTPS/证据完整性/清理全部满足才 acceptance_complete=true |
| Agent/前端遗漏 | 结果没有与实际测试和清理同步 | Agent 输出测试/最终报告产物；严格验收 BLOCK 会使发现任务失败；前端显示步骤、网络断言、清理和失败原因 |
| 验收入口不统一 | 旧 real 命令仍可把回放当主验收 | 主入口与旧 real wrapper 都委托 Appium HTTPS runner；旧回放显式标记 legacy；release 最后强制实际设备验收 |

## 三、新的端到端流程

```text
上传已授权 APK → 摘要/签名/包名核对 → 创建新移动会话
  → 服务端取得测试生命周期所有权
  → ADB 设备及代理准备 + Appium 健康检查 + CA 配置
  → 安装目标 APK → Appium 建会话并核对返回的设备身份 → 启动前台 App
  → 对每一个步骤：
       冻结 run/step/capture 范围 → Appium 操作（只执行一次）
       → Appium 观察与 UI 断言
       → 代理采集完整 HTTPS 请求/响应 → 请求/响应业务断言
       → 截图/UI/网络/Appium 命令元数据 → 摘要与动作记录
  → 可选：仅导入本次成功断言的 HTTPS 流，生成录制/工作流草稿
  → finally：清理步骤上下文、还原代理、关闭 Appium session、停止自有进程
  → 独立应用测试报告：PASS 或 BLOCK
```

Appium 和 BSTG loopback 控制面的 HTTP 不是被测业务 HTTP。业务 TLS 必须同时覆盖 App 到代理、代理到实际服务两个连接；本版没有把“URL 是 https”当作已解密。

## 四、实际测试证据

| 执行项 | 本次结果 | 正确解读 |
| --- | --- | --- |
| Node 回归 | 197/197 通过 | 包括旧回归；数据库使用显式 node:sqlite 适配器；Appium 与采集写入使用明确的协议替身 |
| Python 插件逻辑 | 18/18 通过 | 执行真实插件代码，但 mitmproxy HTTPFlow 对象是替身，不是实际代理运行 |
| 本地 HTTPS 服务 | 通过 | 实际 TLS 套接字，真实证书验证，错误密码/正确密码/鉴权/退出撤销；未知 CA、错误主机名、明文均失败 |
| 联合集成 | 通过 | 真实 HTTPS 后端 + Appium 协议替身 + 源服务 + 实际 SQLite SQL + 证据文件；不是设备 UI 实测 |
| 失败路径 | 通过 | 无捕获、错误状态、错误页面、Appium source 失败、错误 UDID、不完整证据、篡改、清理未完成等均阻断 |
| 聚焦语义类型检查 | 3 个核心新模块通过 | 使用已有 Node 类型定义；不能替代整个项目的生产依赖编译 |
| 修改源文件语法 | 15 个 TS/TSX，0 错误 | 不代表整个前端构建通过 |
| 原有静态契约 | 2 项通过 | 静态契约非设备结果 |
| 完整 release | 阻断 | 缺少依赖；没有继续伪装构建、浏览器或实际设备成功 |

验证日志目录：`validation/appium-https/`。关键文件：`node-tests.log`、`python-tests.log`、`focused-typecheck.log`、`source-syntax.log`、`environment.json`、`production-release-check.log`。首次失败日志属于整改过程，不是最终成功计数。

新增集成正向场景包含错误密码登录、正确密码登录、读取用户、退出、退出后访问被拒绝。这里预期 401 是测试成功条件，而不是漏洞利用成功。真实 Appium 验收在设备上执行相同原理的场景，但本环境没有完成那一步。

## 五、关键文件

| 文件 | 作用 |
| --- | --- |
| server/src/services/mobile/appium-client.ts | 独立严格 W3C 客户端、设备身份、命令错误、会话生命周期 |
| server/src/services/mobile/android-device-manager.ts | 把实际原生 UI 动作/观察接入 Appium，支持 Appium XML |
| server/src/services/mobile/mobile-network-assertions.ts | 精确 HTTPS 请求/响应与 JSON Pointer 断言 |
| server/src/services/mobile/mobile-test-evidence.ts | 原子步骤上下文、受限证据文件、摘要检查 |
| server/src/services/mobile/mobile-lab-service.ts | 逐步执行、统一服务端测试、独立报告、严格导入与清理 |
| server/src/services/mobile/mobile-runtime-state.ts | 会话冻结配置、操作锁、测试 reservation、资源租约 |
| scripts/mobile-lab/mitm-jsonl-capture.py | 完整 TLS 双连接、完整消息、重复头/字节、错误诊断、步骤归属 |
| server/src/routes/mobile.ts | 完整测试、报告及固定证据类型下载 API |
| server/src/agent/agent-runtime.ts / agent/tools/mobile-scan-tools.ts | Agent 调用与最终清理/报告产物一致 |
| src/lib/mobile-scan-config.ts / src/pages/AIScans.tsx | 前端预检和真实测试状态展示 |
| scripts/mobile-lab/run-appium-https-e2e.mjs | 统一 API 驱动设备验收、证据下载校验、JUnit 与退出码 |
| examples/appium-https/ | 原生 Java 参考 App、无 trust-all 的 HTTPS 服务与构建配置脚本 |

## 六、部署与仍存在的明确边界

完整操作见 `docs/mobile-lab/APPIUM_HTTPS_E2E.md`。在新目录部署完整源码，不要误用旧 dist。单独补丁相对上述基线，不是最初 live-acceptance ZIP；请使用完整源码或正确基线应用补丁。

当前实现要求单 BSTG 后端 worker 和可信、独占实验室；没有分布式 Appium 会话恢复、硬件身份远程证明、内核 UID 流量归属、任意 App 自动探索或自动生成所有安全用例。WebView DOM、iOS、HTTP/3、二进制/gRPC/WebSocket断言、mTLS 自动配置以及通用 pinning 绕过均不作可用性承诺。文本消息限额与权限、进程崩溃后的所有权核对、数据回滚责任都在运行文档中明确。

本次增加的原生参考 App 是可供按 SDK 构建的源码，不是已编译、已真机验证的 APK。完整发布检查、真机操作和真正 mitmproxy 截获仍需在部署实验室通过后才能放行；没有将这段缺失验证隐藏成“已完成验收”。
