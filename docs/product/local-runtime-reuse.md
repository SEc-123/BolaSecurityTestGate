# 复用本地浏览器与 Android 环境

本项目支持直接使用已有工具。以下命令不拉取镜像、不安装依赖、不下载 Android 系统镜像。环境包中的文件名和说明不代表工具完整，必须实际检查可执行文件、架构与依赖。

## Linux 浏览器容器

需要一个本地 Docker 镜像，包含非 root 用户、Node、可运行的 Chromium。私有 HTTPS CA 还需要 `certutil`。本机已验证移动硬盘中的 `aegicove/runtime-full:v1.7.0-rc.1`，包含 Chromium 151、NSS 工具以及桌面组件。脚本只复用运行时，不启动 Aegicove 控制平面。

项目 `server/node_modules` 中的 Playwright 与 playwright-core 必须已安装。脚本以只读方式挂载这两个纯 JS 包，保证控制端与容器端协议版本一致；不使用镜像内可能不兼容的 Playwright 版本。

```bash
install -d -m 700 "$HOME/.local/state/bstg"
export BSTG_BROWSER_RUNTIME_FILE="$HOME/.local/state/bstg/browser-runtime.json"
BSTG_RUNTIME_IMAGE=aegicove/runtime-full:v1.7.0-rc.1 \
  node scripts/live-browser/local-container-runtime.mjs
```

启动器的普通 stdout/stderr 只报告 worker 就绪和 CA 指纹，绝不输出 Playwright WebSocket capability 或其随机路径。控制器从私有 Docker stdout 管道接收该 capability，并原子写入调用方预先指定的 `BSTG_BROWSER_RUNTIME_FILE`；文件及父目录分别强制为 `0600` 和 `0700`。不要 `cat`、复制、上传或把这个文件纳入测试产物。

现有后端仍使用 `BSTG_BROWSER_WS_ENDPOINT`，但应在同一用户、受控子进程启动时从该私有文件注入，而不是在终端显示地址：

```bash
export BSTG_BROWSER_MODE=headless
BSTG_BROWSER_WS_ENDPOINT="$(node -e 'const fs=require("node:fs"); const p=process.env.BSTG_BROWSER_RUNTIME_FILE; const s=fs.statSync(p); if ((s.mode&0o777)!==0o600) throw Error("runtime capability file must be 0600"); const v=JSON.parse(fs.readFileSync(p,"utf8")).browser_ws_endpoint; const u=new URL(v); if (u.protocol!=="ws:" || u.hostname!=="127.0.0.1" || !/^\d+$/.test(u.port) || !/^[A-Za-z0-9-]+$/.test(u.pathname.slice(1))) throw Error("invalid local runtime capability"); process.stdout.write(v)')" \
  npm start
```

这保留了既有后端环境变量契约，同时将 capability 限于本机控制器、0600 文件和目标子进程环境。运行时文件应由服务管理器或受控启动包装器清理；不要把它用作跨主机配置交换。

Web 发现、页面观察、反射脚本和上传脚本验证均使用该运行时。每个连接有独立浏览器，身份仍在独立 Context 中；关闭一个连接不会终止其他测试。容器仅将服务发布到主机 `127.0.0.1`，使用随机路径，保留 Chromium sandbox。为允许浏览器的 namespace 系统调用，容器使用 `seccomp=unconfined`；它是受信任的本机执行服务，不能发布为公网浏览器 API。

默认浏览器程序为容器中的 `/usr/bin/chromium`；其他镜像可在控制端设置 `BSTG_REMOTE_CHROMIUM_EXECUTABLE`。`BSTG_WORKER_PORT` 可改变本地端口。远程连接当前提供截图展示，不提供本机 noVNC 桌面；noVNC 继续使用已有本地 Linux 部署方式。

如果测试对象是控制端的 loopback 服务，额外设置 `BSTG_BROWSER_EXPOSE_NETWORK='<loopback>'`。只在需要访问这些目标时启用；普通目标无需转发主机网络。

这里的受管 Playwright 容器是 BSTG 当前支持的原生录制运行时。另行审查的 `computer-use-offline` 包不会被这些命令启动或选中，也不会自动成为视觉回退；在完成外部执行器认证桥接、同浏览器采集和 Linux 端验收前，它不能提供业务证据。

## 私有 HTTPS

公有 HTTPS 站点使用运行时正常信任库。私有服务应提供实际签发 CA，不能关闭证书校验。

```bash
BSTG_RUNTIME_IMAGE=aegicove/runtime-full:v1.7.0-rc.1 \
  BSTG_WORKER_CA=/absolute/path/target-ca.pem \
  node scripts/live-browser/local-container-runtime.mjs
```

CA 仅导入本次容器的 NSS 信任库，不更改主机系统信任。后端将同一个绝对路径设为 `BSTG_TARGET_CA_FILE=/absolute/path/target-ca.pem`；原生 HTTP/Test Run/Workflow 重放会在每个请求上以严格证书和主机名校验加载它，而不是依赖只在 Node 启动时读取一次的 `NODE_EXTRA_CA_CERTS`。worker 会输出 `BSTG_BROWSER_TRUSTED_CA_SHA256`；后端必须同时设置该摘要和按上述受控方式从 runtime 文件注入的 endpoint，否则私有 HTTPS 浏览器会失败关闭。Android 代理若访问该私有服务，profile 的 `upstream_ca_certificate_path` 也应指向同一 CA。详见 [HTTPS 业务录制与原生重放契约](https-business-capture-contract.md)。

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

Android 业务学习是显式启用且独立于 Web 的路径，不会进入 Playwright、Web capture 或 `normal_then_model_experiment`。它要求同一 Mobile Lab 会话内的 Appium 动作、已解密 HTTPS 导入、capture-replay Workflow 和成功的原生 Test Run 一起成立；Android 就绪只允许进入既有通用执行器的前置检查，缺少不可变 endpoint scope 映射会在执行前停止。浏览器/桌面视觉回退、模拟录制或单独的 Appium 成功都不构成替代证据。

## 本次实际验证边界

当前见 [0.6.5 验收与未完成项](0.6.5-closure-audit.md)，历史执行器验收见 [0.6.2 审计](0.6.2-closure-audit.md)。受控目标的真实 HTTPS 验收与测试替身回归分别记录；接口返回成功、Appium 命令返回成功、模型判为漏洞均不能单独构成确认漏洞的证据。

## 复跑受控验收

源码包含实际 Android Activity、APK 离线构建脚本和前端操作验收。没有预置录制画面，验收会新建 SQLite 数据目录、启动受控 HTTPS 服务，从真实页面创建测试，最后导出截图、报告、状态和日志到 `artifacts/`。

完整 Web / Android 验收现在必须设置 `BSTG_ACCEPTANCE_AI_PROVIDER_FILE=/absolute/path/private-provider.json`，文件提供真实 `base_url`、`api_key`、`model`，可选 `provider_type`。凭据文件置于源码之外且仅本人可读。对于独立本地 Codex 桥接，当前验收固定使用 `gpt-5.6-terra / xhigh`，并设置 `BSTG_AI_TIMEOUT_MS=600000`、`BSTG_AI_MIN_TIMEOUT_MS=600000`、`BSTG_AI_REASONING_EFFORT=xhigh`。没有真实模型决策或上游明确拒绝时验收失败，不回退后宣称通过。

可重试的模型传输失败只会重试尚未产生工具调用的决策，并在有界次数耗尽后以安全的阻塞状态结束本次运行；不会重放动作、Workflow 或 Test Run，也不会在日志或报告中保留上游回复正文。

1. 使用已有 OpenSSL 生成本地测试证书：`python3 tests/fixtures/prepare-local-tls.py --output artifacts/runtime-0.6.2/tls`。已存在的证书不会被覆盖。
2. 按前述方式设置私有 `BSTG_BROWSER_RUNTIME_FILE`，再以 `BSTG_TARGET_CA_FILE="$PWD/artifacts/runtime-0.6.2/tls/ca.pem"` 启动浏览器 worker；将它输出的 `BSTG_BROWSER_TRUSTED_CA_SHA256` 配置到后端，并只在受控子进程内从 runtime 文件注入 endpoint。本地靶场另设 `BSTG_BROWSER_EXPOSE_NETWORK='<loopback>'`。
3. `npm run build` 后运行 `BSTG_WEB_TLS_DIR="$PWD/artifacts/runtime-0.6.2/tls" node tests/product-experience/web-workflow-acceptance.mjs`。加 `BSTG_WEB_ALL_CATEGORIES=1` 可验证 13 类真实请求、条件不足及待复核状态，不把响应中的成功文字当作漏洞。
4. 设置 `BSTG_TARGET_CA_FILE="$PWD/artifacts/runtime-0.6.2/tls/ca.pem"`、worker CA 摘要，并在受控测试子进程中从 runtime 文件注入 endpoint 后运行 `node tests/product-experience/browser-tls-acceptance.mjs`，验证 CA/主机名拒绝和浏览器隔离；再运行 `node --import ./tests/mobile-closure/register.mjs tests/product-experience/https-business-capture-acceptance.mjs`，验证真实 Chromium 的持久化业务录制及原生 Workflow 重放。
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
