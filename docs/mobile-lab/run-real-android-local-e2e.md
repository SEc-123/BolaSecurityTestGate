# 真实 Android Emulator 本地端到端运行入口

`scripts/mobile-lab/run-real-android-local-e2e.sh` 是 BSTG 的**配置驱动**严格本地验收入口。它不包含任何目标 App 的包名、Activity、APK、业务端点、用户名、密码或远程地址；这些值必须由执行者以环境变量或 profile JSON 显式传入。脚本只应用于明确授权的本地隔离实验室。

## 前置条件

运行主机需要 Android SDK 的 `emulator`、`adb`，可运行的指定 AVD，`mitmdump`、`curl`，已经启动的 BSTG API 以及明确授权的目标后端。目标 App 必须在其受控测试构建中信任实验室 CA；本脚本**不**安装规避证书锁定的 hook、Frida、动态注入或绕过逻辑。

调用前必须设置 `BSTG_E2E_AUTHORIZED=true`。该显式开关是执行者对目标已授权的确认；脚本不会把本地 harness 的功能用于自动发现或攻击外部目标。

| 环境变量 | 是否必填 | 含义 |
|---|---:|---|
| `BSTG_E2E_AVD_NAME` | 是 | 要启动或复用的 AVD 名称。 |
| `BSTG_E2E_APK_PATH` | 是 | 要实际安装的 APK 绝对路径。 |
| `BSTG_E2E_APP_PACKAGE` | 是 | 显式 Android package。 |
| `BSTG_E2E_APP_ACTIVITY` | 是 | 显式启动 Activity。 |
| `BSTG_E2E_PROXY_UPSTREAM` | 是 | 受控后端的代理上游，例如 `http://127.0.0.1:3100`。 |
| `BSTG_E2E_EXECUTION_BASE_URL` | 是 | BSTG 原生 Runner 访问的受控后端 base URL。 |
| `BSTG_E2E_PROFILE_ID` | 是 | 预置的 strict real E2E mobile profile。 |
| `BSTG_E2E_PROFILE_JSON_FILE` | 否 | profile upsert JSON 文件；提供时在本轮开始前上传。 |
| `BSTG_E2E_TRIGGER_ADB_SHELL` | 否 | APK 启动后需要的受控 UI/业务触发 ADB shell 命令。 |
| `BSTG_E2E_EXPECT_PATH` | 否 | 必须出现在捕获中的非轮询业务路径。 |
| `BSTG_E2E_ARTIFACT_DIR` | 否 | 本轮运行工件输出目录。 |
| `BSTG_E2E_USE_RUNNING_EMULATOR` | 否 | 设为 `true` 时复用已启动的 AVD。 |

## 运行方式

以下仅说明变量的结构；示例中的值必须替换为执行者的**授权本地**目标配置。若 App 不会在启动后自动发起业务请求，使用 `BSTG_E2E_TRIGGER_ADB_SHELL` 传入受控 UI 动作。

```bash
export BSTG_E2E_AUTHORIZED=true
export BSTG_E2E_AVD_NAME='<configured-avd>'
export BSTG_E2E_APK_PATH='/absolute/path/to/authorized-app.apk'
export BSTG_E2E_APP_PACKAGE='your.authorized.app'
export BSTG_E2E_APP_ACTIVITY='.LaunchActivity'
export BSTG_E2E_PROXY_UPSTREAM='http://127.0.0.1:<backend-port>'
export BSTG_E2E_EXECUTION_BASE_URL='http://127.0.0.1:<backend-port>'
export BSTG_E2E_PROFILE_ID='<strict-profile-id>'
export BSTG_E2E_EXPECT_PATH='/api/your-business-action'

bash scripts/mobile-lab/run-real-android-local-e2e.sh
```

脚本会保存安装/启动/前台包、截图、UIAutomator、mitmproxy、解密 JSONL、mobile session、capture import、recording detail、published workflow、native workflow run、Gate run 和 execution index。任何 APK 缺失、前台包不匹配、截图/UI 树缺失、没有显式 `tls_decrypted=true`、捕获不是声明 package/device、没有 workflow draft、Workflow Runner 失败或 Gate 没有 `security_run_id` 都会终止运行。

## 现有实跑工件的独立复核

已归档工件可通过下列命令作一致性验证。该命令验证 APK/捕获哈希、目标绑定、录制、资产、原生 test run、Finding 报文和 Gate/security run 的关系；它不会重新触发网络请求。

```bash
node tests/mobile-lab/assert-real-emulator-e2e.mjs \
  artifacts/real-android-e2e/latest
```
