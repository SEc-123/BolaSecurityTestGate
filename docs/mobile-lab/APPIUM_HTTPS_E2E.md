# Appium + HTTPS 应用业务测试：运行与验收

本版主链路是 **Appium 操作实际 Android App → UI 断言 + 同步骤 HTTPS 请求/响应断言 → 证据 → 清理 → 应用测试结论**。抓到包或服务端回放成功都不能代替 App 测试通过。

当前交付已经执行源代码回归、Appium 协议替身集成和真实本地 HTTPS/TLS 验证；没有连接 Android、运行真实 Appium/mitmproxy，或构建参考 APK。`validation/appium-https/` 记录本次执行边界。请勿把测试替身日志或旧版验收日志当成你的设备已通过。

## 1. 支持范围与前置条件

支持 Android 原生界面，Appium UiAutomator2，具有完整文本/JSON 请求和响应的 HTTPS API。目标必须为已授权 APK、独占测试设备和授权 API 域名；测试账号、数据应可重复使用且非生产。不同设备必须使用不同代理端口和 UiAutomator2 `systemPort`。

主路径需要 Android SDK 的 adb、aapt、apksigner；Appium Server 和已安装的 UiAutomator2 driver；mitmdump、Python 与 OpenSSL；能够正常构建、启动的 BSTG 服务。Appium/driver/Node/Android 的组合要符合各版本官方要求：UiAutomator2 5 起要求 Appium 3，6 起要求 Android API 26 或以上。可执行 `appium driver doctor uiautomator2` 检查安装环境。本版没有在硬件上验证任何具体版本组合。

Appium 和 BSTG 的**本机控制接口**可以使用 loopback HTTP，例如 `http://127.0.0.1:4723`。这不等于被测业务请求走 HTTP：**App → 代理、代理 → 业务服务两个 TLS 连接都必须存在，且上游证书验证不能关闭。**

`noReset=true` 保留测试 App 数据。本工具不自动回滚业务数据、卸载 App 或移除 CA；手动设备上的 App 可能继续运行。场景必须声明初始状态并使用隔离测试数据。动态启动、由本次会话持有的模拟器才会被停止。

## 2. 原有 App 使用方式

### 2.1 配置 profile

通过 `/api/mobile/profiles` 或 CLI 提交 profile JSON。以下路径和序列号必须替换为真实环境值：

```json
{
  "id": "authorized-appium-https-lab",
  "name": "Authorized Android Appium HTTPS lab",
  "is_enabled": true,
  "runtime_type": "manual",
  "adb_serial": "emulator-5554",
  "appium_server_url": "http://127.0.0.1:4723",
  "proxy_type": "mitmproxy",
  "proxy_host": "127.0.0.1",
  "proxy_port": 18080,
  "certificate_mode": "manual_verified",
  "config_json": {
    "strict_real_e2e": true,
    "managed_proxy": true,
    "mitm_proxy_mode": "regular",
    "capture_allowed_hosts": ["api.example.test"],
    "managed_proxy_confdir": "/absolute/lab/proxy-ca",
    "proxy_ca_certificate_path": "/absolute/lab/proxy-ca/mitmproxy-ca-cert.pem",
    "manual_certificate_verified": true,
    "manual_certificate_evidence": "Owned debug APK trusts exactly this lab CA; record build identity and CA fingerprint here. Runtime trust is still checked by HTTPS assertions.",
    "proxy_use_adb_reverse": true,
    "appium_system_port": 8200,
    "aapt_path": "/absolute/android-sdk/build-tools/35.0.0/aapt",
    "apksigner_path": "/absolute/android-sdk/build-tools/35.0.0/apksigner"
  }
}
```

`manual_verified` 是部署者对调试构建信任配置的声明，**不是实际 HTTPS 成功证据**。App 实际请求必须在代理中完成解密并通过业务断言。证书文件必须对应正在使用的同一个 `managed_proxy_confdir`。对于私有服务端 CA，额外配置 `upstream_ca_certificate_path`，不要开启 `allow_insecure_upstream`。

App 不遵循系统代理、证书绑定、mTLS 或自定义网络栈可能阻断代理。应使用自己控制的调试构建及经确认的代理/信任配置，不能简单关闭证书校验。Android debug-overrides 不等于所有三方证书绑定库都被绕过。系统 CA 方案需要真实有效的信任存储，不能根据文件名或安装声明认定成功。

### 2.2 定义实际业务步骤

```json
[
  {
    "action": "fill",
    "target": {"resource_id": "username"},
    "value": "test-alice",
    "expect": {"resource_id": "com.example.app:id/username", "text": "test-alice"}
  },
  {
    "action": "tap",
    "target": {"resource_id": "login"},
    "expect": {"resource_id": "com.example.app:id/dashboard"},
    "timeout_ms": 15000,
    "expect_network": [
      {
        "id": "login",
        "method": "POST",
        "url": "https://api.example.test/login",
        "request": {"json": [{"pointer": "/username", "equals": "test-alice"}]},
        "response": {
          "status": 200,
          "json": [{"pointer": "/token", "exists": true}, {"pointer": "/user/id", "equals": "alice"}]
        }
      }
    ]
  }
]
```

这是字段示例，不是任意 App 都能直接运行的脚本；真实登录还需配置密码、验证码或其他必要步骤。`expect` 必须使用当前 App 的真实控件或页面状态。输入值和网络断言配置可包含测试凭据，应保护步骤文件。

支持动作：tap/click、input/type/fill（fill 先清空）、swipe、back、wait。严格模式下所有实际 UI 动作均通过 Appium；不会在 Appium 失败时改走 ADB 点击。ADB 仍负责安装、设备检查和系统代理等基础设施工作。选择器支持 resource_id/resourceId、content_desc/contentDesc/accessibility_id、text，可组合；默认精确匹配，文本可用 match=contains；多元素匹配会失败。严格模式禁止易漂移的 UI-tree index；输入必须用元素选择器。

每个非 wait 步骤必须有 UI expect；至少一个业务动作必须有非空 `expect_network`。UI-only 调试不能成为 Appium HTTPS 验收。UI-only 步骤仍被记录，但不会据此宣称其业务网络路径已经覆盖。

网络断言采用**完整且精确的 HTTPS URL、方法、步骤时间窗口**，可匹配请求 headers/json/body_contains；响应必须声明 status（单值或数组），可声明 headers/json/body_contains。JSON 使用 RFC 6901 Pointer，如 `/user/id`、`/items/0/id`、`/a~1b`，不是 JSONPath。`exists:false` 能检测字段缺失；它不代表“零个请求”。min_count 默认为 1，max_count 可限制重复请求；设置 max_count 时会观察整个超时窗口。当前不支持“预期 0 个请求”的网络断言。

同一 URL/方法在窗口内出现与声明请求体或响应不一致的请求会失败，不会悄悄忽略后选择一条成功记录。动态 URL、令牌或随机对象值需要由场景准备代码明确生成，本版不实现任意变量提取/替换语言。

`timeout_ms` 是操作后的 UI/网络轮询窗口，Appium 建会话、命令和元素等待还有各自的有界超时；它不是所有设备命令的统一硬墙时间。只重试观察/查找，不重试登录、点击等可能有业务副作用的操作。

### 2.3 运行完整测试

先完成依赖安装、构建并启动 BSTG 服务和 Appium。Appium、代理和 BSTG 控制面应位于可信隔离网络，默认只监听本机，不能作为公共无认证服务暴露。

```bash
npm ci --ignore-scripts
npm --prefix server ci
npm run build
# 在单独终端按项目部署说明启动 BSTG；另一个终端启动 Appium。
# 例如：appium --address 127.0.0.1 --port 4723 --base-path /

export BSTG_E2E_AUTHORIZED=true
export BSTG_E2E_BSTG_API_URL=http://127.0.0.1:3101
export BSTG_E2E_PROFILE_JSON_FILE=/absolute/lab/profile.json
export BSTG_E2E_FLOW_JSON_FILE=/absolute/lab/steps.json
export BSTG_E2E_APK_PATH=/absolute/lab/authorized-debug.apk
export BSTG_E2E_APK_SOURCE=owned-authorized-test-build
export BSTG_E2E_ARTIFACT_DIR=/absolute/lab/new-run-evidence
npm run test:mobile:appium:https
```

产物目录必须新建或为空。可使用 `BSTG_E2E_API_TOKEN` 接入已配置的 API 认证；设置 `BSTG_E2E_IMPORT_CAPTURE=false` 可关闭测试后的录制/草稿生成，**不会关闭 UI 或 HTTPS 断言**。无需 `BSTG_E2E_EXECUTION_BASE_URL`：那是旧服务端回放路径的参数，不是 App 测试目的。

`npm run test:mobile:real` 和旧 `run-real-android-e2e.mjs` 都委托此入口。只有显式命名的 `test:mobile:replay:legacy` 保留旧回放功能，不属于新的应用验收。

`npm run check:mobile:release` 现在依次要求生产依赖下的类型检查、构建、Node 测试、静态契约、Python 插件回归，以及最后的**实际授权设备验收**。未配置设备验收参数不会被视为通过。请在配置好的隔离测试环境使用，而非生产业务环境。

## 3. 服务端统一入口与结果

```text
POST /api/mobile/sessions/:id/test
body: {"authorized":true,"steps":[...],"import_capture":true}

GET  /api/mobile/sessions/:id/test-report
GET  /api/mobile/sessions/:id/actions/:actionId/evidence/screen
GET  /api/mobile/sessions/:id/actions/:actionId/evidence/ui
GET  /api/mobile/sessions/:id/actions/:actionId/evidence/network
GET  /api/mobile/sessions/:id/actions/:actionId/evidence/appium
```

统一入口服务端拥有 prepare → install → Appium launch → flow → 可选 capture import → finally cleanup。会话生命周期 reservation 阻止交互动作插入测试中间。普通客户端 HTTP 断连不负责取消这个 finally；服务端进程被强杀或主机断电仍需恢复处理。

同一次运行的 UUID 关联每个步骤、Appium session、设备、APK、抓包会话及断言。插件在 requestheaders 时冻结步骤归属，因此上一操作的迟到响应不能借用下一步身份。只有当前运行中通过断言的 HTTPS 流可进入严格录制导入。

每步保存 screen.png、ui.json、network.json、appium.json 与 SHA-256。网络证据保留完整解码文本、原始编码字节的 Base64、重复头字段和 TLS 元信息；不把 HTTP URL 改写成 HTTPS。响应未完成、流式正文不可用、超限或非文本正文均不会伪装为完整证据。

应用测试报告不借用 native HTTP replay 的 Gate。最终 PASS 必须满足：全部声明步骤成功；网络断言成功；Appium/设备/页面与抓包身份一致；证据存在且摘要有效；当前会话已经停止并完成清理。执行成功而清理未完成时，`execution_passed` 可为 true，`acceptance_complete` 仍为 false。

CLI 保存 report.json、appium-test-report.json、junit.xml、每步证据和下载摘要校验结果；退出码 0 才表示当次验收通过。应用原本应拒绝的请求返回预期 401、且 UI 状态也正确，可以是测试 PASS；这不是绕过成功。

## 4. 原生参考 App 与真实 HTTPS 后端

`examples/appium-https/` 附有 Java 原生 App 源码、SDK 构建脚本、HTTPS 后端和场景生成器。不是 WebView 演示、不是伪造抓包接口。参考 App 显式使用实验室代理并保留默认 TLS/主机名校验。其主流程为：错误密码登录 → 正确密码登录 → 读取当前用户 → 退出 → 再次读取被拒绝。

**这份参考 APK 尚未在本交付环境构建或运行。** 后端源码已通过真实 TLS 套接字和证书验证测试。

示例 Linux/macOS 环境准备如下（`timeout` 在部分系统需另行提供；没有该命令可手动启动 mitmdump，生成 CA 后停止）：

```bash
export LAB="$HOME/bstg-authorized-lab"
mkdir -p "$LAB/proxy-ca"
# 安装好 mitmdump 后，仅初始化 CA。退出码 124 表示 timeout 正常停止。
timeout 3s mitmdump --set confdir="$LAB/proxy-ca" --listen-host 127.0.0.1 --listen-port 0 || test "$?" -eq 124

test -f "$LAB/proxy-ca/mitmproxy-ca-cert.pem"
export BSTG_LAB_CERT_DIR="$LAB/upstream-tls"
export BSTG_LAB_CERT_HOST=127.0.0.1
bash examples/appium-https/create-upstream-cert.sh

export ANDROID_SDK_ROOT=/absolute/android-sdk
export BSTG_LAB_BASE_URL=https://127.0.0.1:9443
export BSTG_LAB_PROXY_CA="$LAB/proxy-ca/mitmproxy-ca-cert.pem"
export BSTG_LAB_PROXY_PORT=18080
export BSTG_LAB_BUILD_DIR="$LAB/native-build"
bash examples/appium-https/build-native-apk.sh
```

参考 App 对 127.0.0.1 业务地址使用**显式代理**：设备连接 adb reverse 后的本地代理端口，再由宿主机代理连接宿主机 HTTPS 后端。因此这里的业务 loopback 指向代理宿主机，并非要求设备自身运行后端。其他 App 不能自动套用这一假设，必须确认其真实代理行为与地址可达性。

在单独终端运行后端：

```bash
export BSTG_LAB_TLS_KEY="$LAB/upstream-tls/upstream-key.pem"
export BSTG_LAB_TLS_CERT="$LAB/upstream-tls/upstream-cert.pem"
export BSTG_LAB_PASSWORD='choose-an-isolated-test-password'
node examples/appium-https/https-backend.mjs
```

在执行终端设置同一个测试密码，再生成设备配置与步骤：

```bash
export BSTG_LAB_PASSWORD='choose-an-isolated-test-password'
export BSTG_LAB_PROXY_CONFDIR="$LAB/proxy-ca"
export BSTG_LAB_UPSTREAM_CA="$LAB/upstream-tls/upstream-cert.pem"
export BSTG_E2E_DEVICE_ID=emulator-5554
export BSTG_LAB_CONFIG_DIR="$LAB/config"
node examples/appium-https/configure-lab.mjs

export BSTG_E2E_AUTHORIZED=true
export BSTG_E2E_PROFILE_JSON_FILE="$LAB/config/profile.json"
export BSTG_E2E_FLOW_JSON_FILE="$LAB/config/steps.json"
export BSTG_E2E_APK_PATH="$LAB/native-build/bstg-https-lab.apk"
export BSTG_E2E_APK_SOURCE=owned-reference-debug-build
export BSTG_E2E_ARTIFACT_DIR="$LAB/first-device-run"
npm run test:mobile:appium:https
```

只给 App 拷贝公开的 CA 证书，禁止把 CA 私钥放入 APK、Git、报告或公共产物。参考构建生成的 debug-only.p12 也是私钥，不应分发。本包不包含预置私钥或“已通过”的真机证据。

## 5. 失败与边界

| 现象 | 处理原则 |
| --- | --- |
| Appium 找不到元素或返回多个元素 | 修正当前 App 的稳定选择器；不回退 ADB 坐标瞎点。 |
| UI 成功但无当前步骤 HTTPS 流 | BLOCK；检查缓存命中、App 代理行为、TLS 信任、域名与步骤预期。 |
| client_tls_handshake_failed | 可能是信任配置或 pinning；不是 pinning 已被确诊，查看授权调试构建。 |
| upstream_tls_handshake_failed | 修复后端证书/主机名/CA；不能开启 ssl_insecure。 |
| 401/403 与预期不符 | BLOCK，不能只选择另一条 200 忽略它。 |
| evidence integrity failed | BLOCK，不接受修改后的旧证据。 |
| cleanup failed / MOBILE_RESOURCE_BUSY | 保留所有权，检查失败会话；不能夺用或删除其他任务的代理/设备资源。 |

当前调度要求一个 BSTG 后端 worker；内存中的 Appium 会话与操作 reservation 不是分布式协调。设备/代理/UiAutomator2 端口另有数据库租约，进程崩溃后故意不自动夺用。恢复时应先确认进程和设备的真实所有权。

Appium 服务、代理与数据库处于可信实验室边界。本版关联的是独占设备、前台 App、授权域名、步骤时间和明确请求断言，不是内核 UID 抓包或硬件远程证明。前台包名不能单独证明所有流量属于该 App，务必隔离后台应用并使用足够具体的请求断言。

不声明支持任意第三方 App 的证书绑定绕过、mTLS 自动配置、HTTP/3/QUIC、WebSocket/gRPC 二进制断言、WebView DOM 上下文切换或 iOS。文本/JSON 请求、响应分别限 2 MiB，单捕获文件读取上限 32 MiB；超限失败，不截断后冒充完整。完整响应/截图可能含测试个人信息或令牌，证据文件默认 0600，目录 0700，但现有目录/备份/日志的权限仍由部署者负责。

## 6. 官方依据（核对日期：2026-09-18）

Appium UiAutomator2 的 W3C 命令、udid、systemPort 与版本要求：
https://github.com/appium/appium-uiautomator2-driver

Android 应用级信任与 debug-overrides：
https://developer.android.com/privacy-and-security/security-config

mitmproxy CA 信任及证书绑定边界：
https://docs.mitmproxy.org/stable/concepts/certificates/
