> 历史基线文档：本版 Appium + HTTPS 主验收以 `APPIUM_HTTPS_REVIEW_ZH.md` 和 `docs/mobile-lab/APPIUM_HTTPS_E2E.md` 为准；本文件旧回放结果不能作为本版设备验收。

# BolaSecurityTestGate 移动端闭环审查与整改交付

日期：2026-09-18（Asia/Singapore）
审查基线：用户上传的 `BolaSecurityTestGate-live-acceptance-final.zip`
范围：Android/APK 采集入口、UI/Agent 调用、设备/代理/证据生命周期、录制导入、普通回放发布、原生执行和 Gate。

## 一、结论先说清楚

这次交付包含实际修改后的源码、可应用差异补丁、新增回归测试、严格设备验收脚本、运行说明和本次测试记录，不是仅给方案。

原项目已有移动端接口和多个“闭环”脚本，但存在真正影响使用的前后端断点，也存在把模拟数据、旧流量、空流程或者普通成功响应当成验收/漏洞结果的问题。因此原包名称中的 final/live acceptance 不能代替对当前代码版本的验证。

本次实际验证：147 项 Node 回归全部通过、8 项 Python 抓包插件逻辑测试全部通过、原有两项静态契约检查通过、23 个修改过的 TypeScript 文件语法检查无错误。Node 回归使用明确标记的测试适配器，通过 Node 内置 SQLite 执行生产 schema/repository SQL，其中录制→发布→原生执行→Gate 测试确实访问了本地 HTTP 服务。

**尚未完成：真实 Android/AVD 成功验收、真实 mitmproxy TLS 抓包、完整前后端生产构建、浏览器点击端到端、生产 better-sqlite3 原生模块和 PostgreSQL 验证。** 当前环境没有 adb/emulator/aapt/apksigner/mitmdump，npm 依赖获取也受到网络限制。完整类型检查未通过的直接原因记录为缺少 uuid/express 类型依赖；不能将语法检查或 SQLite 适配器通过写成完整构建通过。

## 二、项目实际是什么

BSTG 的核心不是单纯的 App 自动点击器，而是将 HTTP 请求转成可重复的安全测试资产：请求/录制 → API 模板或工作流 → 变量、账号、提取器与断言 → 原生执行 → Findings → Gate。

代码结构体现出三条相互衔接但不能混淆的链路：

1. 产品链路：`src/pages/AIScans.tsx` 创建任务，`api-client.ts` 调用 API，后端保存扫描配置，Agent 编排执行，product-state/证据面板向用户展示状态。
2. 移动采集链路：`routes/mobile.ts` → `services/mobile` → ADB/Appium/mitmproxy → `mobile_sessions`、`mobile_actions` 与抓包证据。
3. 安全复测链路：`mobile-traffic-importer.ts` → recording events/drafts → `recording-service.ts` 发布 → `workflow-runner.ts` 执行 → `gate-runner.ts` 持久化门禁结论。

移动端真正的价值是把受控 App 业务操作产生的请求接入既有安全复测能力，而不是“看到一个截图”或者“出现三个接口”。因此本次把主要精力放在这三条链路的连接处。没有把本次范围外的所有安全检测类型、所有前端页面或整个项目生产部署冒充为已全面验证。

## 三、具体发现和修复

| 问题 | 对真实使用的影响 | 本次修改 |
|---|---|---|
| 前端写死环境、流程只有等待、APK 源/摘要/签名没有完整进入任务 | 用户上传后看似进入流程，执行端仍拿不到必要信息 | 可选真实 profile、显式设备与域名、业务步骤及断言编辑、授权确认；统一配置构造器传递 APK 证明字段 |
| Agent 读取不存在的 context.scan | 持久化 scan_config 存在但工具拿不到 APK 和 flow_steps | 通过 repository.getRun(scanRunId) 读取权威任务配置；会话必须属于当前 scan |
| 模型可以提前宣告移动发现完成 | 安装/执行/导入尚未发生也可能结束 | 移动采集阶段固定有序编排，完成点从 import 后移到 stop；退出路径补充清理 |
| 严格要求可通过单个布尔字段规避 | 标称 real E2E 实际降级为模拟/弱验证 | 严格模式强制必要条件，离线模式显式标记；验收脚本拒绝模拟和非严格配置 |
| 空流程、纯 wait、空 expect 和无效断言可形成成功 | 没有实际业务覆盖但上游显示完成 | 全流程先验证、1–200 步、严格模式要求真实动作与可观察断言；单动作入口同样拒绝无断言严格操作 |
| 动作后的观察失败被吞掉，异常动作未留记录 | 点击失败/设备断开仍可能 completed | 驱动错误、截图/UI/包名错误及断言失败写入 failed 动作；HTTP 422；只重试观察，不重复业务副作用 |
| serial、Appium session、选择器存在混用/歧义 | 操作错误设备、错误控件、输入不能可靠清空 | 会话绑定设备；Appium 缓存以服务/serial/session/package 隔离；明确 udid/noReset；唯一 AND 选择；fill 清空与 Unicode 输入 |
| ADB spawn 不等于远端 shell 安全转义 | 输入引号、元字符或非 ASCII 时行为错误甚至被远端 shell 解释 | 每个远端 token 单独转义，拒绝 NUL、无效坐标和有损输入；Unicode/fill 使用 Appium |
| 证书只验证文件名/错误指纹，API 版本只信配置 | CA 看似安装成功，App 仍不能实际信任 | X.509 DER 摘要核对实际内容；读取真实 API/ABI；Android 14+ 不以 /system 副本证明有效 trust store；实际 HTTPS 仍必需 |
| health 更新覆盖进程信息，多个会话共用设备/端口 | 失去清理依据、错误复用资源或残留代理 | 合并运行状态、冻结会话执行 profile、数据库资源租约、进程内操作锁、仅管理自有进程/映射 |
| 捕获文件按 profile 复用且来源约束弱 | 上一次流量/其他设备/其他包混入本次结果 | 独立 capture nonce 和文件；设备、包、时间、精确域名、实际 HTTPS 完整响应联合过滤；不接受调用方提交对象充当严格证据 |
| 重复导入、异常顺序、草稿最小值未保证 | 同一请求变成多份资产，部分失败重试重复建记录 | 稳定排序与去重、pending import 恢复、摘要复用、防止不同快照混接、草稿数要求 |
| 采集文件持续增长，验收缺少稳定证据 | 导入时和核对时看到不同内容，难以追溯 | 保存 accepted.json 不变快照及 SHA-256；新增 capture-evidence API；读取时核对摘要 |
| 普通成功回放被当成 Workflow vulnerability | 移动端跑通反而制造假漏洞和错误 Gate | Android 录制发布普通回放标记 capture_replay_only，建立响应状态断言；成功不产漏洞，失败产生执行错误并阻断 Gate |
| 旧实机脚本直接 ADB 触发、检查未生成的文件或假 finding | 脚本通过不能证明产品 API 路径可用 | 统一 Node API 驱动入口；全图关联 ID、24 份证据及哈希、失败退出和 finally stop；普通回放明确要求无假 finding |

主要文件集中于 `server/src/services/mobile/`、`server/src/routes/mobile.ts`、`server/src/agent/`、`src/pages/AIScans.tsx`、`src/lib/mobile-scan-config.ts`、录制发布和工作流执行器。详细差异见 `DELIVERY/mobile-e2e-closure.patch`。

## 四、成功条件现在如何闭环

正常路径为：

```text
网页/严格脚本配置
  → 持久化 APK 来源、摘要、签名、设备、流程
  → 会话 manifest 前置检查
  → 独占设备/端口，读取真实设备 API/ABI
  → 证书核对、启动自有代理、保存并设置设备代理
  → 安装目标 APK，验证包存在
  → 启动目标，确认前台身份
  → 声明动作 → 新观察 → 断言 → 持久化动作结果
  → 当前会话范围内的完整 HTTPS 响应
  → 稳定快照 → 录制/草稿 → 正常回放工作流
  → 原生 HTTP 执行和持久化 Test Run
  → 持久化 Gate
  → 恢复代理、关闭自有会话/进程、释放租约
```

任何必要环节失败都不能获得严格验收成功。flow 的失败状态会覆盖先前的成功标记；非法或空的新流程不会继续借用旧的 flow_run.ok。原始截图和业务请求仍属于敏感证据，需要访问控制和生命周期治理，不能因为对动作输入做了脱敏就放心公开。

采集阶段的 Agent 被固定为确定性顺序，是为了阻止模型绕过必要步骤；这并不声称已经实现“无需配置就自动理解任意 App 全部业务”。当前稳定入口要求用户提供实际业务动作/断言。

## 五、最关键的运行结果

新增 Node 套件共 147 项，覆盖契约、服务/SQL、驱动与 UI 配置、验收器及 CLI。总数来自 Node 最终 TAP 输出，不代表 147 条真实设备用例，也不代表代码覆盖率为 100%。

其中确实执行的数据库/HTTP 用例完成：

```text
当前会话流量夹具
 → 实际生产数据库 schema/repository SQL
 → 实际 recording events 与 workflow draft
 → 实际发布普通回放 workflow
 → 实际向本地 HTTP 服务发请求
 → 测试记录 completed、0 个伪漏洞
 → Gate PASS 并能从数据库读回

将同一目标的响应从 200 改为 409
 → 响应断言失败
 → 原生执行错误
 → Gate BLOCK
 → 仍不创建虚构的漏洞 finding
```

测试夹具明确标记为非设备证据。验收器的正向测试是合成协议夹具，只证明校验代码逻辑；负向覆盖模拟环境、空流程、错误设备、旧 nonce、旧时间、篡改文件、错误发布来源、假漏洞和清理失败。不会把合成夹具打包成一份“真实 Android 成功报告”。

Python 8 项检查真实抓包插件代码的 response 处理逻辑，但 HTTPFlow/TLS 属性是测试夹具，不是启动 mitmproxy 后得到的网络结果。

| 验证层 | 本次状态 |
|---|---|
| Node 契约、服务、驱动测试夹具、UI 配置、验收器 | 147/147 通过 |
| Python 抓包插件逻辑 | 8/8 通过 |
| 生产 schema/repository SQL + 本地 HTTP 原生回放/Gate | 已执行正反两条路径；SQLite 使用 node:sqlite 适配器 |
| 原有两个静态契约脚本 | 通过；不代表运行链路通过 |
| 修改 TypeScript 语法 | 23 文件、0 语法错误；不是完整类型检查 |
| 完整生产依赖类型检查/构建 | 未通过验证；环境缺依赖，类型检查日志保留 |
| 原有完整 offline API/Agent E2E | 已对齐新清理语义，未在此环境运行 |
| 浏览器交互、真实 Appium/Android、真实 HTTPS 捕获 | 未运行 |

原始日志位于 `validation/mobile-closure/`。安装失败与类型检查受阻不写成 skip 后假装 release 通过；发布环境应运行 `npm run check:mobile:release` 并进一步运行严格设备脚本。

## 六、仍需明确的限制与风险

**设备与网络来源证明。** 代理可证明受控会话收到并解密了对应主机的响应，但目前包名来自专用设备和域名隔离约束，不是 Android UID 级流量归属。因此不能让多 App 共用实验设备后仍宣称单包精准取证。

**生产打包。** 此容器无法安装完整依赖并编译运行 Express/React，原生 SQLite 模块、打包产物和浏览器流程仍须在部署环境验收。只交付源码而不夹带旧 dist，防止“看上去更新、实际上运行旧代码”。

**并发和故障。** 不同会话的设备/端口资源占用由数据库唯一键保护；同一 session 的操作排他是进程内实现。单后端 worker 是当前部署约束。断电、SIGKILL、服务器重启后不保证自动清理；未知 PID 不会被擅自终止，保留租约等待管理员核对。没有实现任意外部进程树的完全回收。

**测试副作用。** 安装、清数据/重装（仅显式授权配置）、CA 配置以及业务 API 回放可能改变实验环境。脚本会执行工作流和 Gate，因此请求可能重复，不可用于未隔离的生产支付/删除/转账等业务。stop 不负责恢复业务数据库、不卸载 App、不移除系统 CA。

**覆盖范围。** 当前端到端针对 Android HTTP 文本 API 业务，不包含 iOS、任意 App 自探索、证书固定绕过、复杂二进制/流式协议全面覆盖。此次没有升级整个产品的认证/多租户权限系统。完整深度安全检测仍需要正确账号、对象、攻击变异和安全判定，不能用采集回放的成功冒充漏洞检测能力。

## 七、交付目录和应用方式

建议在新目录解压完整源码包，安装依赖并构建，不要覆盖后继续复用历史构建产物。根目录结构仍是正常项目，新增：

```text
MOBILE_E2E_REVIEW_ZH.md                   本报告
DELIVERY/mobile-e2e-closure.patch         基于上传源码的差异，不含私钥/旧证据内容
DELIVERY/BASELINE_AND_PACKAGING.json      基线摘要和打包排除说明
validation/mobile-closure/               本次测试结果与受限项
scripts/run-mobile-closure-tests.mjs     明确区分生产依赖/测试适配器
scripts/verify-mobile-release.mjs        生产发布检查入口
scripts/mobile-lab/run-real-android-e2e.mjs
                                         严格 API 驱动设备验收
tests/mobile-closure/                    新增回归
docs/mobile-lab/MOBILE_E2E_CLOSURE.md      配置、运行、证据、故障恢复说明
```

使用差异补丁时，先在原上传源码副本执行 `git apply --check DELIVERY/mobile-e2e-closure.patch`，再应用并重新构建。补丁不携带历史私钥/数据库的删除内容；完整源码包已排除它们。在旧目录应用补丁的人仍需自行隔离旧运行数据/证书，不能把旧目录的历史验收报告当作新版本结果。

根目录 npm 新入口：`test:mobile:closure`、`test:mobile:closure:adapters`、`check:mobile:release`、`test:mobile:real`。详细变量和示例见运行说明。

## 八、代码验收标准

交付后本版本的生产放行条件是：实际依赖安装和完整构建通过；在授权专用设备上用实际 APK/业务流程执行严格脚本；检查当次独立目录的证据链、原生执行和 Gate 记录；确认 stop 完成且没有残留自有资源。未经这些步骤，本报告只证明已列明的源码修复和本次回归结果，不作真实设备已验收的承诺。
