# Android 真实目标 Manifest 与闭环验收

BSTG 的 Android 功能不再把固定包名、预装 App、模拟器数据或 HTTPS URL 当作真实成功。每一个真实目标都应创建独立 Mobile Lab Profile；同一套服务与 Agent 工具只读取 profile 与 scan 配置，不把任何应用标识写入产品代码。

```json
{
  "name": "Authorized Android target",
  "runtime_type": "local_avd",
  "adb_serial": "emulator-5554",
  "proxy_type": "mitmproxy",
  "proxy_host": "127.0.0.1",
  "proxy_port": 8443,
  "certificate_mode": "preinstalled_system_ca",
  "config_json": {
    "strict_real_e2e": true,
    "require_apk_install": true,
    "require_apk_attestation": true,
    "require_proxy_certificate": true,
    "require_explicit_app_identity": true,
    "require_explicit_tls_evidence": true,
    "require_capture_app_identity": true,
    "require_flow_steps": true,
    "require_flow_assertions": true,
    "minimum_decrypted_flows": 1,
    "minimum_workflow_drafts": 1,
    "aapt_path": "/absolute/path/to/aapt",
    "apksigner_path": "/absolute/path/to/apksigner",
    "app_package": "org.example.authorized",
    "app_activity": ".MainActivity",
    "managed_proxy": true,
    "mitmdump_path": "mitmdump",
    "mitm_reverse_upstream": "http://127.0.0.1:3100",
    "managed_proxy_confdir": "/absolute/private/path/bstg-mitmproxy-ca",
    "certificate_provisioning": "managed_mitmproxy",
    "allow_system_ca_install": true,
    "proxy_use_adb_reverse": true,
    "burp_flow_export_path": "/absolute/private/path/capture.jsonl",
    "allow_software_emulation": false
  }
}
```

`POST /api/mobile/apps/import` 或 `POST /api/mobile/sessions` 接受**本地 APK 文件**，不依赖 Google Play。严格 session 必须保存 `apk_source`、文件 SHA-256、`apksigner` 签名摘要、`aapt` 解析出的 package/launchable activity；在安装前 BSTG 会再次核验它们，任何漂移都阻断安装。

当 `managed_proxy=true` 与 `certificate_provisioning=managed_mitmproxy` 时，BSTG 生成（或复用）私有 `mitmproxy` CA，记录证书路径、SHA-256 与 Android 旧 subject hash。只有已明确授权的、可 `adb root`/`adb remount` 的**本地 AVD**可设置 `allow_system_ca_install=true`；BSTG 才会安装 CA 到系统信任库并以文件存在性复核。普通设备、证书锁定 App 或非 root 环境不会被绕过，而是直接阻断。若 App 提供合法测试构建的网络安全配置，请使用 `manual_verified` 并保存人工信任证据。

本地代理地址默认会使用 `adb reverse` 后的 `127.0.0.1:<port>`，随后 BSTG 写入并回读 Android `http_proxy`。无 KVM 环境下，默认会运行 Emulator 加速预检并快速阻断；仅在已证实可启动的 ARM 软件模拟 AVD 中可显式设置 `allow_software_emulation=true`，随后仍必须由 ADB 的真实 `device` 状态证明启动成功。

真实验收必须在**同一次 session**中留存下列工件：设备序列号、APK 来源/摘要/签名/包验证、受管理 CA 的生成与设备信任证据、托管代理 PID 与 Android 代理回读、前台包名、截图与 UIAutomator 树、每个 flow 步骤的期望 UI 断言、带 `tls_decrypted: true` 和匹配 `app_package` 的 HTTPS 响应流量、`recording_session_id`、生成的 workflow draft、原生 test run、Finding 原始证据以及 Gate JSON。任一项缺失，严格 profile 必须失败，而不是继续生成“成功”状态。
