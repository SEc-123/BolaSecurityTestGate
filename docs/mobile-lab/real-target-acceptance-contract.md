# 通用 Android 真实闭环验收契约

该契约用于验证 BSTG 的 Android 运行面是否可服务于不同的**明确授权** App。参考 App 只是一轮兼容性样本；包名、启动页、代理、证书模式、目标后端、业务步骤和预期 UI 均从独立 target manifest/profile 读取，不得进入 BSTG 默认值或 Agent 提示词。

| 阶段 | 不可替代的实际证据 | 失败语义 |
|---|---|---|
| 设备 | ADB `device` 状态、serial、Android 版本 | 不执行后续步骤 |
| 应用 | APK SHA-256、安装命令输出、已安装包与前台包匹配 | 标记 session `failed` |
| UI | 每步动作记录、操作后截图、UIAutomator 树、`expect` 断言 | 中断 flow |
| HTTPS | 隔离捕获窗口内的 JSONL、显式 `tls_decrypted: true`、响应码、profile 目标包声明 | 拒绝导入 |
| BSTG 资产 | `recording_session_id`、events、workflow draft、endpoint 发现 | 闭环失败 |
| 执行与 Gate | 原生 runner 产物、Finding 原始证据、Gate JSON/exit code | 不发布成功结论 |

严格 profile 默认启用该契约。只有显式标为 `offline_simulator` 的开发 fixture 可使用宽松行为，且不会被记录为真实闭环通过。
