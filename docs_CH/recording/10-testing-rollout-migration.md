# 录制域 Doc10: 测试、灰度上线与迁移

## 1. 目标

本文件对应 `10_测试、上线与迁移.docx`，覆盖三类交付：

- 测试分层与验收入口
- 灰度上线开关与回滚约束
- 数据迁移脚本与迁移后回归

录制域的最终验收命令统一为：

```powershell
npm run smoke:recording:doc10
```

该命令会串行执行：

1. `server npm run build`
2. `server npm run typecheck`
3. `npm run typecheck`
4. `npm run build`
5. `node scripts/recording-unit-check.mjs`
6. `tests/recording/smoke-tests/tmp_recording_doc03_smoke.ps1`
7. `tests/recording/smoke-tests/tmp_recording_doc05_smoke.ps1`
8. `tests/recording/smoke-tests/tmp_recording_doc06_smoke.ps1`
9. `tests/recording/smoke-tests/tmp_recording_doc07_smoke.ps1`
10. `tests/recording/smoke-tests/tmp_recording_doc08_smoke.ps1`
11. `tests/recording/smoke-tests/tmp_recording_doc09_smoke.ps1`
12. `tests/recording/smoke-tests/tmp_recording_doc10_smoke.ps1` 自身的 rollout / migration / performance 验证

如果只想快速验证 Doc10 本轮新增闭环，可执行：

```powershell
npm run smoke:recording:doc10:focus
```

该模式会跳过 Doc03/05/06/07/08/09 的历史专项，只保留：

- build / typecheck
- unit check
- rollout gating
- 100 事件性能
- DB profile 迁移与迁移后回归

执行结果会落到：

```text
tests/recording/smoke-tests/tmp_recording_doc10_result.json
```

## 2. 测试分层

### 2.1 Unit

入口：

```powershell
npm run check:recording:unit
```

脚本：

```text
scripts/recording-unit-check.mjs
```

覆盖点：

- `normalizeRecordingFieldTargets` 的 alias / from_sources 去重
- `prepareRecordingArtifacts` 的密码脱敏、字段命中、runtime context 提取
- `generateWorkflowDraftArtifacts` 的 polling 过滤、连续排序、`workflow_context` 注入
- `generateApiDraftArtifacts` 的 sequence 排序、`request.path` / `request.body` 字段候选生成

### 2.2 Integration

现有专项脚本：

- `tmp_recording_doc03_smoke.ps1`
- `tmp_recording_doc05_smoke.ps1`
- `tmp_recording_doc06_smoke.ps1`
- `tmp_recording_doc07_smoke.ps1`
- `tmp_recording_doc08_smoke.ps1`
- `tmp_recording_doc09_smoke.ps1`

这些脚本已经覆盖：

- 插件入口到后端录制 API
- 录制生成 workflow / api drafts
- 字段抽取与账户联动
- 资产转正与追溯
- 安全、审计、死信和恢复

### 2.3 End-to-End

`tmp_recording_doc10_smoke.ps1` 会补上 Doc10 自己的三段闭环：

- rollout phase 切换与前后端开关约束
- 100 事件录制性能验证
- 跨 DB profile 迁移与迁移后 `accounts / workflows / test_runs` 回归

## 3. 验收矩阵

| 验收包 | 对应脚本 | 关键验证 |
| --- | --- | --- |
| A. 工作流录制 | `tmp_recording_doc05_smoke.ps1` | 登录 -> 列表 -> 详情 -> 提交，live token / orderId 注入 |
| B. 接口录制 | `tmp_recording_doc06_smoke.ps1` | 3 个独立接口转为 preconfigured drafts |
| C. 字段抽取联动 | `tmp_recording_doc07_smoke.ps1` | token / cookie / userId 写回 account 并可执行消费 |
| D. 转正与追溯 | `tmp_recording_doc08_smoke.ps1` | workflow / template / formal test run 带 source tracing |
| E. 异常恢复 | `tmp_recording_doc09_smoke.ps1` | 死信重放、权限控制、敏感信息脱敏 |
| F. 测试上线迁移 | `tmp_recording_doc10_smoke.ps1` | rollout gating、100 事件性能、跨库迁移、迁移后回归 |

## 4. 灰度上线

后端与前端共用同一套 rollout 配置。

配置接口：

```text
GET /api/recordings/config
GET /api/recordings/health
```

实现：

```text
server/src/services/recording-rollout.ts
src/App.tsx
src/pages/Recordings.tsx
src/pages/RecordingDetail.tsx
src/pages/PreconfiguredRuns.tsx
```

### 4.1 Phase 定义

| Phase | 录制中心 | Workflow 录制 | API 录制 | Publish / Promote | 说明 |
| --- | --- | --- | --- | --- | --- |
| `hidden` | 关闭 | 关闭 | 关闭 | 关闭 | 只部署后端和前端代码，不开放入口 |
| `internal_plugin` | 开启 | 开启 | 关闭 | 关闭 | 内测插件录制，建议叠加账号白名单 |
| `workflow_only` | 开启 | 开启 | 关闭 | 关闭 | 只放工作流录制 |
| `api_publish` | 开启 | 开启 | 开启 | 开启 | API 录制和转正灰度 |
| `formal` | 开启 | 开启 | 开启 | 开启 | 全量开放 |

### 4.2 环境变量

| 变量 | 作用 |
| --- | --- |
| `RECORDING_ROLLOUT_PHASE` | 主 phase，支持 `hidden/internal_plugin/workflow_only/api_publish/formal` |
| `BSTG_RECORDING_ROLLOUT_PHASE` | 备用主 phase 名称 |
| `RECORDING_CENTER_VISIBLE` | 强制覆盖录制中心显隐 |
| `RECORDING_WORKFLOW_MODE_ENABLED` | 强制覆盖 workflow 录制开关 |
| `RECORDING_API_MODE_ENABLED` | 强制覆盖 api 录制开关 |
| `RECORDING_PUBLISH_ENABLED` | 强制覆盖 draft publish / promote 开关 |
| `RECORDING_ALLOWED_ACCOUNT_IDS` | 逗号分隔的灰度账号白名单 |
| `BSTG_RECORDING_ALLOWED_ACCOUNT_IDS` | 备用白名单变量名 |

### 4.3 推荐灰度步骤

1. `hidden`
   目标：只部署代码，不暴露入口。
2. `internal_plugin`
   目标：只给少量内测账号打开 workflow 录制。
3. `workflow_only`
   目标：验证录制中心、详情审阅、workflow draft 编辑。
4. `api_publish`
   目标：开放 API draft、template 创建、preset / formal test run 转正。
5. `formal`
   目标：全量上线，并开启审计、死信、告警巡检。

回滚方式：

- 最快回滚：把 `RECORDING_ROLLOUT_PHASE` 切回 `hidden`
- 保守回滚：保留录制中心可见，但把 `RECORDING_PUBLISH_ENABLED=false`

## 5. 迁移

统一迁移脚本：

```powershell
npm run migrate:recording -- -BaseUrl http://127.0.0.1:3001 -TargetProfileId <profile-id> -MigrateTarget -SwitchToTarget
```

脚本文件：

```text
scripts/recording-db-migrate.ps1
```

脚本动作：

1. 读取当前 active profile
2. 从当前 active profile 执行 `/admin/db/export`
3. 可选执行 `/admin/db/migrate`
4. 把导出数据导入 `target_profile_id`
5. 可选切换到目标 profile
6. 输出 JSON 结果和逐表计数

### 5.1 迁移保真策略

本轮已把 `server/src/db/db-manager.ts` 的导入策略升级为保留原始 `id / created_at / updated_at` 的 upsert 导入，不再使用 `repo.create()` 重新生成 ID。

这意味着以下关联在迁移后保持不变：

- `workflow -> workflow_steps`
- `recording_session -> events / field hits / drafts`
- `test_run -> findings`
- `draft_publish_logs -> source draft / target asset`

### 5.2 迁移后检查

最低检查项：

```text
GET /admin/db/status
GET /api/accounts/:id
GET /api/workflows/:id
GET /api/workflows/:id/steps
GET /api/test-runs/:id
```

`tmp_recording_doc10_smoke.ps1` 已内置这些检查，并验证迁移后 ID 不变。

## 6. 100 事件性能验收

Doc10 的性能要求不是压测平台，而是“100 事件录制不出现明显阻塞”。

当前做法：

- 单次 batch 仍然遵守 ingest guard 的 `max_batch_size = 50`
- 通过 `2 x 50` 批次录入 100 条事件
- 验证：
  - ingest 成功
  - finish 成功
  - 生成 `100` 条 API drafts
  - session 状态为 `completed`

脚本会记录：

- `ingest_duration_ms`
- `finish_duration_ms`

输出位置：

```text
tmp_recording_doc10_result.json
```
