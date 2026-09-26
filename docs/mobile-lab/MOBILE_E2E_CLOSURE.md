> 历史基线文档：本版 Appium + HTTPS 主验收以 `APPIUM_HTTPS_REVIEW_ZH.md` 和 `docs/mobile-lab/APPIUM_HTTPS_E2E.md` 为准；本文件旧回放结果不能作为本版设备验收。

# Android 移动端闭环：运行与验收说明

本次交付聚焦 APK/Android 链路，不包含 iOS 驱动。请先阅读根目录 `MOBILE_E2E_REVIEW_ZH.md` 和 `validation/mobile-closure/result.json`。

## 1. 什么算通过

严格设备验收必须在同一次运行中完成：上传授权 APK → 校验摘要、签名、包名与入口 → 绑定明确设备 → 读取设备真实 API/ABI → 证书/代理准备 → 安装并确认目标包 → 启动并确认前台包 → 非空业务动作及观察断言 → 当前会话 HTTPS 响应 → 导入录制 → 生成草稿 → 发布普通回放工作流 → 原生执行并持久化 → Gate 持久化 → 清理自有资源。

三个概念不能混用：

* `simulated`：离线协议模拟，不是设备测试。
* `session_bound_device_capture`：设备会话和域名范围绑定的抓包证据。包名来自操作者提供的隔离范围，不是内核 UID 级来源证明。
* `real_device_api_chain_verified`：严格脚本跑完、证据核对通过后的脚本结论。依赖可信服务端、可信实验室设备及人工正确限定授权范围，不是不可伪造的硬件远程证明。

普通采集回放的 PASS 只证明该次采集/发布/执行满足所声明的断言，**不等于被测 App 没有漏洞**。进一步的越权/业务逻辑安全判断仍须建立攻击者、受害者、对象、变异请求和安全断言。

## 2. 部署前置条件

服务端使用本项目锁定的依赖，先安装再构建，不可继续运行旧 `server/dist`。交付源码包有意不包含 `node_modules`、旧 `dist`、历史实机结果、APK、数据库及 CA 私钥。

```bash
npm ci --ignore-scripts
npm --prefix server ci
npm run check:mobile:release
```

`check:mobile:release` 按顺序执行前端/后端完整类型检查、构建、生产依赖模式的移动回归及静态契约检查；任意失败退出非零，不会切换到测试适配器。

需要独立准备：Android SDK 的 `adb`、`aapt`、`apksigner`，可用的授权设备或可启动的 AVD，`mitmdump`，OpenSSL；使用 `fill` 或中文等非 ASCII 输入还需启动安装了 UiAutomator2 驱动的 Appium。把这些可执行文件放在 PATH，或在 profile 中给出对应绝对路径。Appium 服务端的 Node 运行要求应遵循所安装版本的官方文档，不能由本项目的 Node 测试版本推导。

```bash
adb devices -l
# 明确选择设备后核对，不要省略 -s
adb -s YOUR_SERIAL shell getprop ro.build.version.sdk
adb -s YOUR_SERIAL shell getprop ro.product.cpu.abilist

# 在完成构建后启动 BSTG。不要将实验室控制 API 暴露到不可信公网。
HOST=127.0.0.1 PORT=3101 npm start
```

本次没有重做项目的多租户认证/授权体系。具有实验室配置权限的人可以指定本机工具和文件路径，因此这些 API 必须放在受保护的管理员环境中。抓包、截图、录制请求、扫描配置仍可能含测试凭证与业务数据；输入日志局部脱敏不等于所有存储都匿名化。

## 3. 准备 profile 和真实业务步骤

复制并编辑 `examples/authorized-avd.profile.example.json` 或 `examples/authorized-device.profile.example.json`，不要直接用示例域名和资源 ID 验收。

AVD 示例仅适合专用、获授权、可 root/remount 的本地测试镜像。它明确开启 `allow_system_ca_install`，会修改该实验室镜像的系统 CA；不是对个人手机的默认操作。实际 Android API ≥ 34 时，不接受“复制到 /system 就算完成信任”的推断，应预配置正确镜像或使用有文档证明的测试构建。服务端现在读取实际设备 API/ABI 后再选择检查方式。

物理设备/调试构建示例默认 `manual_certificate_verified=false`，因此会被阻断。只有在完成该测试构建的 CA 信任配置并记录验证依据后，才填写 `manual_certificate_verified=true` 和具体的 `manual_certificate_evidence`。后续仍必须观察到目标 HTTPS 响应，人工勾选不能替代抓包证据。不提供证书固定绕过、第三方 App 重打包或任意真机自动提权。

`capture_allowed_hosts` 使用精确主机名数组，不写协议、路径或通配符。专用设备不要同时运行其他会访问这些域名的 App。默认代理监听回环地址，通过自有 ADB reverse 映射连接设备；已有映射会阻止接管。

业务步骤文件必须是 JSON 数组。`business-flow.example.json` 只是格式模板，要替换成当前 App 真正存在的控件和下一屏结果。严格模式下每个非等待步骤都需要 `expect`。支持 tap/click、input/type、fill、swipe、back、wait；input/type 追加文本，fill 使用 Appium 先清空再输入。

```json
[
  {
    "action": "tap",
    "target": { "resourceId": "com.yourcompany.authorizedapp:id/open_orders" },
    "expect": {
      "package": "com.yourcompany.authorizedapp",
      "resourceId": "com.yourcompany.authorizedapp:id/orders_list"
    },
    "timeout_ms": 15000
  }
]
```

优先使用唯一资源 ID，文本默认精确匹配；多个条件是 AND。断言可以明确设置 `match:"contains"` 或 `absent:true`，后者应配合具体节点选择条件。不要只写空对象、`min_ui_nodes:0` 或纯 wait 来伪装业务覆盖。动作失败/断言超时默认停止后续步骤，不自动重复点击付款等有副作用的操作。

## 4. 通过网页使用

在评估页选择 Android，选已启用的环境，上传授权 APK，填写业务流程和断言，确认授权后启动。上传成功只表示文件已接收；签名、包名、入口未识别时不能作为严格可测 APK。切换 profile 后需要重新上传和确认授权；上传过程中禁止切换环境或重复提交文件。

环境通过 `POST /api/mobile/profiles` 配置。页面目前提供环境选择和业务步骤 JSON 编辑，并不是完整的设备管理台或所见即所得步骤录制器。代码已经连接 UI → 持久化 scan_config → Agent 工具；本次环境没有运行完整浏览器交互测试。

## 5. 通过严格脚本验收

脚本使用产品 API，不接受 `BSTG_E2E_TRIGGER_ADB_SHELL` 这类绕开 `/flow` 的快捷触发。所有路径都是运行脚本机器上的路径；上传后的 APK 路径由服务端返回。脚本上传模式限制 64 MiB，较大 APK 可通过受控服务端路径使用产品 API，但不属于这个上传驱动的验收入口。

```bash
export BSTG_E2E_AUTHORIZED=true
export BSTG_E2E_BSTG_API_URL=http://127.0.0.1:3101
export BSTG_E2E_PROFILE_JSON_FILE=/absolute/path/to/authorized-profile.json
export BSTG_E2E_FLOW_JSON_FILE=/absolute/path/to/business-flow.json
export BSTG_E2E_APK_PATH=/absolute/path/to/your-authorized-test.apk
export BSTG_E2E_APK_SOURCE='Internal authorized test build; release/build identifier'
export BSTG_E2E_EXECUTION_BASE_URL=https://api.your-authorized-app.example

npm run test:mobile:real
```

可选：`BSTG_E2E_DEVICE_ID` 覆盖 profile serial；`BSTG_E2E_API_TOKEN` 作为 Bearer 头；`BSTG_E2E_EXPECT_GATE` 默认 PASS；`BSTG_E2E_ARTIFACT_DIR` 指向新的空目录。已有证据目录不能重复使用。请勿在工单、版本库或共享终端历史中暴露真实凭证。

**这会执行实际业务动作，并且原生工作流执行与 Gate 会再次回放请求。** 使用专用测试账号、可清理/可重复的测试数据，禁止直接指向生产支付、转账、删除等不可重复业务。重复执行带来的对象创建不由这个验收脚本自动回滚。

成功后，脚本在本次独立目录写出至少 24 个证据文件和 `report.json`，包含摘要清单、会话/录制/草稿/工作流/执行/Gate 的关联 ID。失败也会留下失败报告；创建过会话的正常异常路径会尝试 stop。检查：

```bash
node tests/mobile-lab/assert-real-emulator-e2e.mjs /absolute/path/to/run-artifacts
```

校验器检查流量摘要、当前会话标识/设备/包名/时间/域名、真实步骤数与持久化动作 ID、截图一致性、发布来源、非空原生执行、Gate 记录与清理结果。不能只凭一个 `ok:true` 或目录里有 PNG 就认定通过。

## 6. 开发回归：明确区分证据等级

```bash
# 已安装生产依赖时，使用实际 better-sqlite3 等模块
npm run test:mobile:closure

# 离线开发模式：显式 node:sqlite 适配器，不会伪装为原生部署测试
npm run test:mobile:closure:adapters

# Python 逻辑回归，HTTPFlow 是测试夹具，不是真实代理 TLS
python tests/mobile-closure/capture_addon_test.py

# 完整离线模拟器+产品 API 测试，需要依赖和构建齐全；不是真机
npm run test:mobile-lab:offline-e2e
```

标准模式不会悄悄启用适配器。测试用适配器位于 tests 下，生产启动入口不加载它们。此次交付只实际运行了显式适配器回归、Python 夹具测试和静态检查，未运行最后一条完整离线 API/Agent 测试或真机脚本成功分支。

## 7. 清理、恢复和部署边界

正常 stop 恢复测试前的 Android 全局代理，只移除本会话拥有的 reverse 映射，关闭自有 Appium 会话，停止本进程启动并跟踪的代理/模拟器进程，最后释放数据库资源租约。外部启动的模拟器和服务不会被停止。系统 CA、安装的 App、业务数据不会自动删除，应在专用可还原镜像中运行并按组织流程重置。

设备租约使用数据库唯一键防止不同会话占用同一设备/端口；同一会话操作锁仍是进程内锁。**本交付以单后端 worker 控制移动设备为部署约束，不声称支持跨进程分布式移动调度。** 崩溃后进程所有权无法确认时保留租约并拒绝按不可靠 PID 杀进程。由管理员先核对实际设备代理、reverse、进程、会话状态，完成清理后再处理该 session 的租约；不要盲目批量删租约。

进程停止只针对直接拥有的进程对象，不保证任意 shell 包装器创建的全部子孙进程一起退出。profile 中使用工具的直接可执行入口。SIGKILL、主机断电、强制结束容器等不可能由进程内 finally 保证清理。

实时抓包最多读取 32 MiB；插件拒绝超过 2 MiB 的单个请求或响应体，不把截断内容当成完整可回放证据。当前输入/录制主要针对 HTTP 文本 API，不声称覆盖 gRPC、QUIC、WebSocket、二进制上传的完整语义。

## 8. 参考依据

以下为实现核对时查阅的官方资料，查阅日期为 2026-09-18；它们不是本项目测试通过的证据。

- Android Network Security Configuration：`https://developer.android.com/privacy-and-security/security-config`
- Appium Session Capabilities：`https://appium.io/docs/en/latest/guides/caps/`
- mitmproxy Event Hooks：`https://docs.mitmproxy.org/stable/api/events.html`
