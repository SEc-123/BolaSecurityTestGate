# BSTG 通用 Android Emulator 严格 E2E 实现

本目录是本次交付的**可执行 BSTG 源代码**。移动端整改的目标是：通过 profile/session/环境变量指定任意已授权的本地 Android Emulator 工作负载，而不是把某个测试 App、包名、Activity、端点、证书或后端写死在 BSTG 产品中。

## 主要实现文件

| 文件 | 作用 |
|---|---|
| `server/src/services/mobile/mobile-target-contract.ts` | 严格真实 E2E 合同；要求显式 APK、app identity、ADB 目标、UI 工件、解密流量和 workflow draft。 |
| `server/src/services/mobile/android-certificate-manager.ts` | 新增。生成/校验受控 mitmproxy CA，计算 SHA-256 与 Android CA hash，只在授权 rootable AVD 上安装并复核系统信任库。 |
| `server/src/services/mobile/mobile-profile-service.ts` | 移除有效样例 target 默认值，解析 strict profile。 |
| `server/src/services/mobile/android-device-manager.ts` | 禁止默认 app identity，安装后校验 package，启动后校验前台 package；新增 ADB reverse、代理回读和 Emulator acceleration preflight。 |
| `server/src/services/mobile/mobile-lab-service.ts` | 在安装、观察、流量导入、草案生成时实施严格失败条件。 |
| `server/src/services/mobile/burp-capture-service.ts` | 不再仅凭 `https://` URL 推定 TLS 已解密。 |
| `server/src/services/mobile/mobile-traffic-importer.ts` | 只接收匹配 package 的显式解密 flow，并记录接收/拒绝计数。 |
| `server/src/agent/tools/mobile-scan-tools.ts` | Agent 移动工具不会把跳过安装、空 flow、缺 UI 工件视为成功。 |
| `scripts/mobile-lab/mitm-jsonl-capture.py` | 将代理实际解密后的 flow 写成 JSONL；目标 package/device 只从环境变量读取。 |
| `scripts/mobile-lab/run-real-android-local-e2e.sh` | 新增的通用实跑入口：经 BSTG API 执行 CA/代理/安装/启动，保留 UI 证据、导入录制、发布 Workflow、执行 Runner、保存 Finding/Gate 工件。 |
| `tests/mobile-lab/assert-real-emulator-e2e.mjs` | 新增的运行后验证入口；只从本轮工件读取目标配置和 ID，不硬编码任何 App。 |
| `docs/mobile-lab/real-target-manifest.md` | 严格 target manifest 字段说明。 |
| `docs/mobile-lab/real-target-acceptance-contract.md` | APK、UI、TLS、Recording、Run、Finding、Gate 的验收标准。 |
| `docs/mobile-lab/run-real-android-local-e2e.md` | 完整环境变量说明与运行方式。 |
| `docs/mobile-lab/current-environment-blocker.md` | 本轮无 KVM 宿主的实际阻断、已验证的 fail-closed 行为和重新验证前提。 |

## 快速使用

先启动 BSTG 服务、受控本地后端和 Android SDK 工具。然后根据你的**已授权本地测试 App**设置变量。必须包含 AVD、APK 路径、显式包名、启动 Activity、代理上游、BSTG Runner 访问的 base URL 和 strict profile ID。

```bash
export BSTG_E2E_AUTHORIZED=true
export BSTG_E2E_AVD_NAME='<your-avd>'
export BSTG_E2E_APK_PATH='/absolute/path/to/authorized-app.apk'
export BSTG_E2E_APP_PACKAGE='your.authorized.app'
export BSTG_E2E_APP_ACTIVITY='.LaunchActivity'
export BSTG_E2E_PROXY_UPSTREAM='http://127.0.0.1:<backend-port>'
export BSTG_E2E_EXECUTION_BASE_URL='http://127.0.0.1:<backend-port>'
export BSTG_E2E_PROFILE_ID='<strict-profile-id>'
export BSTG_E2E_EXPECT_PATH='/api/your-business-action'

bash scripts/mobile-lab/run-real-android-local-e2e.sh
node tests/mobile-lab/assert-real-emulator-e2e.mjs artifacts/real-android-e2e/latest
```

任何 APK/前台包/UI/TLS/录制草案/Runner/Finding/Gate 条件失败，脚本都会返回非零状态并保留诊断工件。`Gate PASS` 的业务含义仍取决于你在 BSTG 中配置的 policy 与风险分值；它不会自动关闭 Finding。

## 本轮客观状态

已实际验证：受控 CA 可以生成并产生可审计摘要；托管 `mitmdump` 能启动、记录 PID 并随 session stop 清理；本地 APK 能构建、`aapt`/`apksigner` 元数据和摘要会写入 session；无 KVM 的 x86 AVD 会快速失败，capture import 会因无设备 CA 信任而返回 400。当前宿主无法再次完整启动 AVD，因此本轮**不宣称**新的 APK→HTTPS→Recording→Finding→Gate 已重跑通过。详见 `docs/mobile-lab/current-environment-blocker.md`。

## 安全边界

该实现只用于明确授权的测试目标。脚本需要显式 `BSTG_E2E_AUTHORIZED=true`，不会配置证书锁定绕过、动态 hook、Frida 或针对外部目标的自动化扫描。独立参考工作负载若随包提供，仅用于本地验证此通用接口，不属于 BSTG 产品默认配置。
