# 录制域 Doc10: 交接、运维与培训

## 1. 交接清单

### 后端

- 迁移脚本：`scripts/recording-db-migrate.ps1`
- 录制统一 smoke：`tests/recording/smoke-tests/tmp_recording_doc10_smoke.ps1`
- unit 校验：`scripts/recording-unit-check.mjs`
- rollout 配置：`server/src/services/recording-rollout.ts`
- 审计 / 死信 / 运维聚合：
  - `server/src/services/recording-observability.ts`
  - `server/src/services/recording-telemetry.ts`
  - `server/src/routes/recordings.ts`

### 前端

- 灰度入口控制：
  - `src/App.tsx`
  - `src/pages/Recordings.tsx`
  - `src/pages/RecordingDetail.tsx`
  - `src/pages/PreconfiguredRuns.tsx`
- 录制详情与 draft 编辑：
  - `src/components/recordings/WorkflowDraftEditorModal.tsx`
  - `src/components/recordings/TestRunDraftEditorModal.tsx`

### 插件

- 插件入口：`burp-recorder-plugin/src/main/java/com/bstg/burp/recorder/BstgExtension.java`
- API 客户端：`burp-recorder-plugin/src/main/java/com/bstg/burp/recorder/BstgApiClient.java`
- 本地待发队列：`burp-recorder-plugin/src/main/java/com/bstg/burp/recorder/PendingQueueStore.java`
- 本地设置：`burp-recorder-plugin/src/main/java/com/bstg/burp/recorder/SettingsStore.java`

### 测试

- 专项脚本：`tests/recording/smoke-tests/tmp_recording_doc03_smoke.ps1` 到 `tests/recording/smoke-tests/tmp_recording_doc10_smoke.ps1`
- mock 服务：`tests/recording/smoke-tests/tmp_recording_doc05_mock_server.js` 到 `tests/recording/smoke-tests/tmp_recording_doc09_mock_server.js`
- 结果文件：`tests/recording/smoke-tests/tmp_recording_doc08_result.json`、`tests/recording/smoke-tests/tmp_recording_doc09_result.json`、`tests/recording/smoke-tests/tmp_recording_doc10_result.json`

## 2. API 与运维接口

### 录制配置

- `GET /api/recordings/config`
- `GET /api/recordings/health`

### 录制主链路

- `POST /api/recordings/sessions`
- `POST /api/recordings/sessions/:id/events/batch`
- `POST /api/recordings/sessions/:id/finish`
- `POST /api/recordings/sessions/:id/regenerate`
- `GET /api/recordings/sessions/:id`
- `GET /api/recordings/sessions/:id/events`
- `GET /api/recordings/sessions/:id/candidates`

### 转正链路

- `PUT /api/recordings/workflow-drafts/:id`
- `POST /api/recordings/workflow-drafts/:id/publish`
- `PUT /api/recordings/test-run-drafts/:id`
- `POST /api/recordings/test-run-drafts/:id/template`
- `POST /api/recordings/test-run-drafts/:id/publish`
- `POST /api/recordings/test-run-drafts/:id/test-run`
- `GET /api/recordings/publish-logs`

### 账户联动

- `GET /api/recordings/sessions/:id/account-preview`
- `POST /api/recordings/sessions/:id/apply-account`

### 运维与恢复

- `GET /api/recordings/ops/summary`
- `GET /api/recordings/ops/audit-logs`
- `GET /api/recordings/ops/dead-letters`
- `POST /api/recordings/ops/dead-letters/:id/retry`
- `POST /api/recordings/ops/dead-letters/:id/discard`

### DB Profile

- `GET /admin/db/status`
- `GET /admin/db/profiles`
- `POST /admin/db/profiles`
- `POST /admin/db/migrate`
- `POST /admin/db/switch`
- `POST /admin/db/export`
- `POST /admin/db/import`

## 3. 指标与审计

指标来源：

```text
server/src/services/recording-telemetry.ts
```

当前内置指标：

- `recording_sessions_created_total`
- `recording_events_ingested_total`
- `recording_event_deduplicated_total`
- `recording_batches_failed_total`
- `promotion_success_total`
- `draft_generation_duration_ms_total`
- `draft_generation_duration_ms_last`
- `draft_generation_duration_ms_avg`
- `draft_generation_duration_ms_max`
- `draft_generation_runs_total`

审计来源：

```text
server/src/services/recording-observability.ts
```

重要审计动作：

- `recording_session_created`
- `recording_session_finished`
- `recording_generation_failed`
- `recording_batch_failed`
- `recording_promotion_success`
- `recording_account_overwrite`
- `recording_dead_letter_retried`
- `recording_dead_letter_retry_failed`
- `recording_dead_letter_discarded`

## 4. 告警建议

建议最少配置以下告警：

1. `recording_batches_failed_total` 连续增长
2. `pending_dead_letters > 0` 持续 10 分钟
3. `draft_generation_duration_ms_last` 明显超过日常均值
4. `recording_generation_failed` 审计动作在 15 分钟内超过阈值
5. `publish` / `promote` 被 `403` 拒绝的次数异常升高

推荐巡检查询：

- 最近 20 条审计：
  `GET /api/recordings/ops/audit-logs?limit=20`
- 最近 pending dead letters：
  `GET /api/recordings/ops/dead-letters?status=pending`
- 全局录制摘要：
  `GET /api/recordings/ops/summary`

## 5. 插件安装与配置

插件设置持久化字段：

- `serverUrl`
- `apiKey`
- `mode`
- `name`
- `environmentId`
- `accountId`
- `role`
- `targetFields`
- `queueCapacity`
- `batchSize`

来源：

```text
burp-recorder-plugin/src/main/java/com/bstg/burp/recorder/SettingsStore.java
```

推荐默认值：

- `serverUrl`: `http://127.0.0.1:3001`
- `mode`: `workflow`
- `queueCapacity`: `500`
- `batchSize`: `10`

插件错误处理约定：

- HTTP `401`: API Key 错误，插件应停止发送并提示鉴权失败
- HTTP `403`: rollout phase 或 admin privilege 不允许
- HTTP `413`: batch 超过 ingress 限制
- 网络异常：进入本地 pending queue，待网络恢复后重放
- 服务端 ingest 失败：后端落 dead letter，前端运维页可重放

## 6. 培训建议

面向测试 / 研发的最小培训闭环：

1. 配置 Burp 插件 `serverUrl + apiKey`
2. 选择 `workflow` 或 `api` 模式
3. 录制一次登录或独立接口调用
4. 在 Recording Center 查看 session 详情
5. 编辑并发布 draft
6. 在 Workflows / Preconfigured Runs / Test Runs 中复用正式资产
7. 在 Recordings Ops 页面查看审计与 dead letters

推荐培训顺序：

1. 先讲 `workflow_only` 阶段如何用
2. 再讲 `api_publish` 阶段如何从 draft 转正
3. 最后讲 `ops summary / audit logs / dead letters`
