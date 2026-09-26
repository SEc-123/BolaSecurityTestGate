# 复用本地浏览器与 Android 环境

本项目支持直接使用已有工具。以下命令不拉取镜像、不安装依赖、不下载 Android 系统镜像。环境包中的文件名和说明不代表工具完整，必须实际检查可执行文件、架构与依赖。

## Linux 浏览器容器

需要一个本地 Docker 镜像，包含非 root 用户、Node、可运行的 Chromium。私有 HTTPS CA 还需要 `certutil`。本机已验证移动硬盘中的 `aegicove/runtime-full:v1.7.0-rc.1`，包含 Chromium 151、NSS 工具以及桌面组件。脚本只复用运行时，不启动 Aegicove 控制平面。

项目 `server/node_modules` 中的 Playwright 与 playwright-core 必须已安装。脚本以只读方式挂载这两个纯 JS 包，保证控制端与容器端协议版本一致；不使用镜像内可能不兼容的 Playwright 版本。

```bash
BSTG_RUNTIME_IMAGE=aegicove/runtime-full:v1.7.0-rc.1 \
  node scripts/live-browser/local-container-runtime.mjs
```

脚本输出 `BSTG_BROWSER_WS_ENDPOINT=ws://127.0.0.1:19446/...`。将该完整值配置到 BSTG 后端，再启动后端：

```bash
export BSTG_BROWSER_MODE=headless
export BSTG_BROWSER_WS_ENDPOINT='使用上一步输出的完整地址'
npm start
```

Web 发现、页面观察、反射脚本和上传脚本验证均使用该运行时。每个连接有独立浏览器，身份仍在独立 Context 中；关闭一个连接不会终止其他测试。容器仅将服务发布到主机 `127.0.0.1`，使用随机路径，保留 Chromium sandbox。为允许浏览器的 namespace 系统调用，容器使用 `seccomp=unconfined`；它是受信任的本机执行服务，不能发布为公网浏览器 API。

默认浏览器程序为容器中的 `/usr/bin/chromium`；其他镜像可在控制端设置 `BSTG_REMOTE_CHROMIUM_EXECUTABLE`。`BSTG_WORKER_PORT` 可改变本地端口。远程连接当前提供截图展示，不提供本机 noVNC 桌面；noVNC 继续使用已有本地 Linux 部署方式。

如果测试对象是控制端的 loopback 服务，额外设置 `BSTG_BROWSER_EXPOSE_NETWORK='<loopback>'`。只在需要访问这些目标时启用；普通目标无需转发主机网络。

## 私有 HTTPS

公有 HTTPS 站点使用运行时正常信任库。私有服务应提供实际签发 CA，不能关闭证书校验。

```bash
BSTG_RUNTIME_IMAGE=aegicove/runtime-full:v1.7.0-rc.1 \
  BSTG_WORKER_CA=/absolute/path/target-ca.pem \
  node scripts/live-browser/local-container-runtime.mjs
```

CA 仅导入本次容器的 NSS 信任库，不更改主机系统信任。后端原生 HTTP 回放也需要在进程启动前设置 `NODE_EXTRA_CA_CERTS=/absolute/path/target-ca.pem`。Android 代理若访问该私有服务，profile 的 `upstream_ca_certificate_path` 也应指向同一 CA。这三个位置分别服务于浏览器、原生请求和抓包代理，不能只配置其中一个。

Android App 信任的是抓包代理的 CA，和服务端 CA 不同。专用可 root AVD 可以在明确开启 `allow_system_ca_install` 后安装系统 CA；Android 14+ 应预配置有效的 Conscrypt 信任环境。普通设备和证书固定应用需要获授权的测试构建/实验室配置，不能把未解密流量视为完成检测。

## 现有 Android 工具

复用已安装 SDK、JDK、Appium UiAutomator2 和 mitmproxy。将其路径配置到环境或 profile：

- `ANDROID_HOME`、`JAVA_HOME`：实际 SDK/JDK 根目录。
- `BSTG_MITMDUMP_PATH`：实际 `mitmdump` 可执行文件。
- `BSTG_MOBILE_ADB_PATH`、`BSTG_MOBILE_AAPT_PATH`、`BSTG_MOBILE_APKSIGNER_PATH`：需要覆盖自动定位时设置。
- `BSTG_MOBILE_APPIUM_URL`：已启动的 Appium 服务地址。
- 页面“配置 Android 测试设备”：实际 serial、Appium 地址、设备可访问的代理地址和端口。

模拟器启动后先核对指定 serial 的 `get-state` 和 `sys.boot_completed`。系统 CA 安装仅用于专用实验 AVD；自动重挂载需要重启时，按 [AOSP 的 AVD 流程](https://android.googlesource.com/device/generic/car/+/refs/heads/main/tools/remount.sh) 准备 AVB，并校验重启、写入及证书摘要。失败会传到任务页面，不会自动清空设备或无限重启。

上传 APK 后可直接自动探索界面并采集目标请求。已有业务场景可选；场景的页面断言、HTTPS 请求/响应断言和依赖由服务端保存，前端选择时按安装包身份绑定。实时观察画面只用于展示，不能代替这些断言。

## 本次实际验证边界

当前见 [0.6.5 验收与未完成项](0.6.5-closure-audit.md)，历史执行器验收见 [0.6.2 审计](0.6.2-closure-audit.md)。受控目标的真实 HTTPS 验收与测试替身回归分别记录；接口返回成功、Appium 命令返回成功、模型判为漏洞均不能单独构成确认漏洞的证据。

## 复跑受控验收

源码包含实际 Android Activity、APK 离线构建脚本和前端操作验收。没有预置录制画面，验收会新建 SQLite 数据目录、启动受控 HTTPS 服务，从真实页面创建测试，最后导出截图、报告、状态和日志到 `artifacts/`。

完整 Web / Android 验收现在必须设置 `BSTG_ACCEPTANCE_AI_PROVIDER_FILE=/absolute/path/private-provider.json`，文件提供真实 `base_url`、`api_key`、`model`，可选 `provider_type`。凭据文件置于源码之外且仅本人可读。对于独立本地 Codex 桥接（当前固定 Luna / xhigh），设置 `BSTG_AI_TIMEOUT_MS=600000`、`BSTG_AI_MIN_TIMEOUT_MS=600000`、`BSTG_AI_REASONING_EFFORT=xhigh`。没有真实模型决策或上游明确拒绝时验收失败，不回退后宣称通过。

1. 使用已有 OpenSSL 生成本地测试证书：`python3 tests/fixtures/prepare-local-tls.py --output artifacts/runtime-0.6.2/tls`。已存在的证书不会被覆盖。
2. 按前述方式启动浏览器 worker，传入该 `ca.pem`。后端设置完整 `BSTG_BROWSER_WS_ENDPOINT`，本地靶场另设 `BSTG_BROWSER_EXPOSE_NETWORK='<loopback>'`。
3. `npm run build` 后运行 `BSTG_WEB_TLS_DIR="$PWD/artifacts/runtime-0.6.2/tls" node tests/product-experience/web-workflow-acceptance.mjs`。加 `BSTG_WEB_ALL_CATEGORIES=1` 可验证 13 类真实请求、条件不足及待复核状态，不把响应中的成功文字当作漏洞。
4. `NODE_EXTRA_CA_CERTS="$PWD/artifacts/runtime-0.6.2/tls/ca.pem" node tests/product-experience/browser-tls-acceptance.mjs` 验证 CA/主机名拒绝和浏览器隔离；使用同一 worker 与 `BSTG_WEB_TLS_DIR` 或默认 runtime 目录中的 TLS 文件。
5. 用已有 SDK 构建 APK：`python3 tests/fixtures/android-app/build.py --sdk "$ANDROID_HOME" --java-home "$JAVA_HOME" --base-url https://localhost:19443 --output artifacts/runtime-0.6.2/fixture-app`。不依赖 Gradle 下载。
6. Android 验收使用专用 `emulator-5566`、API 30 可 root AVD、`http://127.0.0.1:14723` Appium UiAutomator2 和 runtime 目录中的 `android-sdk`、`mitmproxy-venv/bin/mitmdump`。本机 harness 的 JDK 默认为 Android Studio JBR；其他机器需按实际环境调整。`node tests/product-experience/android-workflow-acceptance.mjs` 验证自动探索；加 `BSTG_ANDROID_SCENARIO=1` 验证两步业务；加 `BSTG_ANDROID_BAD_UPSTREAM_TLS=1` 验证真实证书拒绝及从界面重试恢复。
7. `node tests/product-experience/settings-ui-acceptance.mjs` 验证模型配置界面，模型端是明确的协议测试服务。

Android harness 使用 19443/19444/19445 端口，设备实验不得同时运行多个。它会实际安装专用 APK、配置本地 AVD 的代理 CA；只在专用实验设备运行。正常结束由产品清理代理和 Appium 会话，harness 关闭其服务，保留设备及证据供核对。测试目录中的私钥、APK 签名密钥、数据库和设备记录均被 Git 忽略，也不进入发布包。

日常使用不需要运行验收靶场：启动 BSTG 后输入授权 Web URL，或选择已配置的 Android 设备、上传 APK、核对其业务服务地址。自动发现和证书/身份前提的限制见审计中的覆盖边界。

## 已有工具的一次启动

`python3 scripts/local-lab/start.py --config /absolute/path/local-lab.json` 会复用已启动的专用 AVD/Appium/浏览器 worker，缺少进程时只启动本地已安装工具；不会下载任何包。后端只监听 loopback，首次创建专用设备配置，不覆盖已修改配置。Ctrl+C 只关闭本启动器创建的进程。

配置文件示例（路径按本机替换）：

```json
{
  "runtime_directory": "/absolute/path/runtime-0.6.2",
  "state_directory": "/absolute/path/local-lab",
  "node_path": "/absolute/path/node",
  "java_home": "/absolute/path/jdk",
  "adb_serial": "emulator-5566",
  "avd_name": "bstg-acceptance-api30-v2",
  "android_api_level": 30,
  "allow_system_ca_install": true,
  "browser_image": "aegicove/runtime-full:v1.7.0-rc.1",
  "port": 19440,
  "ai_timeout_ms": 600000,
  "ai_reasoning_effort": "xhigh"
}
```

runtime 目录结构与上述验收目录一致：android-sdk、avds、appium、appium-home、mitmproxy-venv。可选 `target_ca` 指定私有目标的 CA；可选 `browser_ws_endpoint` 复用已启动的本机 worker（其信任库须已配置）。默认 Appium/worker/代理端口为 14723/19446/19445，可通过对应 `appium_port`、`worker_port`、`proxy_port` 覆盖。启动器使用独立 state/data，不替换项目原有数据库。

统一登录可在账号区填写独立 HTTPS 来源。只有登录允许跨到该来源，漏洞测试仍限于目标网站。当前不支持弹窗首次导航；使用当前窗口登录。`npm run test:product:web:sso` 验证实际浏览器范围；`npm run test:product:provider-denial` 验证模型拒绝的真实界面闭环，后者明确使用拒绝测试服务。
