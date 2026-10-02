# Android 执行环境与 HTTPS 证据契约

Android 不是 Web 浏览器的替代视图。BSTG 的 Android 执行面由真实的 ADB 设备、Appium UiAutomator2、受控代理、代理 CA、逐步 UI 观察和原生录制导入组成。离线模拟器只用于开发回归，产物会标记为 `simulated`，不能作为设备测试或 HTTPS 解密的证据。

## 一次真实 Android 执行必须具备的事实

1. `adb get-state` 返回 `device`，并且保存的 serial、实际设备能力和会话一致。
2. APK 已通过 SHA-256、签名、包名和启动 Activity 校验，随后由 ADB 安装；前台包由 Appium/设备观察确认。
3. 每个 UI 动作通过 Appium UiAutomator2 执行，保存截图、UIAutomator 层级、Appium trace 和步骤 ID。单独 ADB 成功不能满足 App 测试。
4. 代理 CA 已在该设备上安装并复核。每条可导入流量必须是同一次 capture session、同一设备、同一 App 包、同一 Appium run/步骤、允许主机范围内的 `https:` 请求，并带有 `tls_decrypted: true`、完整请求/响应和已验证的上游 TLS。
5. 导入生成 `recording_events`、原生 Template/Workflow 草案和新的 Test Run；发现或报告只能引用这些持久化证据。

## HTTPS 不能降级

自动探索只是选择有限的非破坏性 UI 操作，不能把真实设备的目标改为 HTTP。非模拟 profile 的 `capture_origin` 必须是 HTTPS，`capture_http_only` 会在准备前被拒绝，且不会跳过代理 CA。`mitmproxy` 捕获插件同样只在显式 offline fixture 中允许 HTTP。

这避免了“看到 UI”或“有代理进程”被误当成已解密 HTTPS。没有满足上述链路时，Agent 可以记录环境阻断和清理资源，但不能导入 API 证据、生成确认问题或声称 App 测试完成。

## Agent 与执行器的分工

Android Agent 已注册 `mobile.lab.prepare`、安装、启动、观察、动作、流程、探索、capture import 和停止工具。发现阶段的设备生命周期是确定性的：它不能由模型跳过安装、Appium 验证、HTTPS 断言、capture 导入或清理。导入后的 Template、Workflow、Test Run 和证据继续进入 BSTG 原生资产/测试工具，供后续模型选择安全实验及解释结果。

当前 `computer-use-offline-linux-x86_64` 包不含 ADB、Android Emulator、Appium、mitmproxy 或 Android CA 管理；它只能作为 Linux x86_64 上独立的 Chromium/X11 桌面视觉输入备选，不能替代 Android 执行环境，也不能为 Android HTTPS 取证。

## 本轮工作机检查

以下只描述本轮当前工作机可用性，不能覆盖或否定其他版本在独立受控 AVD 上保存的历史验收记录。

本轮检查中当前 macOS 工作机能定位 Android SDK 的 `adb` 二进制，但 ADB daemon 未能成为可用设备连接，且没有已连接 Emulator/设备。因此这里已验证的是 fail-closed 合同和焦点回归，不是 APK 到 HTTPS 再到 Finding 的真机成功结果。要进行真实验收，需要接入一个明确授权的设备或 AVD、可用 Android SDK 平台工具、Appium UiAutomator2、受控 mitmproxy 和可验证 CA 信任，然后运行 [真实本地 E2E 指南](run-real-android-local-e2e.md)。
