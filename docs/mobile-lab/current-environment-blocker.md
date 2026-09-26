# 当前本地运行环境阻断记录

本文件记录本次代码复审后的**实际执行事实**，不是兼容性承诺。

| 检查项 | 实测结果 | BSTG 当前行为 |
|---|---|---|
| x86 Android 23 AVD 启动 | Android Emulator 37.1.11 明确报错：`x86 emulation currently requires hardware acceleration`；宿主不存在 `/dev/kvm`。 | `startEmulatorIfConfigured()` 在 AVD 加速预检中快速返回失败，不再返回短暂 PID 后等待超时。 |
| ARM Android 21 AVD 启动 | 同一 Emulator 报错：`CPU Architecture 'arm' is not supported by the QEMU2 emulator`。 | 仅允许 profile 显式设置 `allow_software_emulation=true` 时跳过 KVM 预检；仍必须由 ADB `device` 状态证明实际启动。 |
| 托管代理 CA | `mitmdump` 在 profile 私有 confdir 实际生成 `mitmproxy-ca-cert.pem`，BSTG 记录 SHA-256 与 Android subject hash。 | 严格 profile 在设备不可达时把 CA 安装标记为未验证并阻断。 |
| 托管代理 | BSTG 在未占用端口可启动 `mitmdump` 并记录 PID；停止 session 会终止该 PID。 | 代理自身启动不等于 HTTPS 已解密；没有可信设备、证书安装与目标绑定流量时，capture import 仍失败。 |

因此，在当前宿主中，完整 APK→CA 安装→代理→HTTPS 的重新实跑受 **无 KVM 且当前 Emulator 不支持 ARM AVD** 阻断。代码已将该条件 fail-closed，不把旧 JSONL、已生成 CA、代理 PID、离线模拟或理论步骤当作端到端成功。
