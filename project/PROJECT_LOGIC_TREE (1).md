# 项目文件结构 & 功能逻辑树（生成于 2025-12-21）

## 1) 顶层文件结构（重点）

```text
project/
├── .bolt/ # Bolt/脚手架相关配置（生成器或项目元信息）
│   ├── config.json # Bolt 模板配置（该项目基于 bolt-vite-react-ts）
│   └── prompt # Bolt 生成提示词（约束 UI/组件/风格的默认要求）
├── legacy/ # 历史遗留实现（旧 Supabase Functions 等）
│   ├── supabase-functions/ # 目录
│   └── README.md # legacy 目录说明（旧实现/迁移说明）
├── server/ # 后端源码（Express + DB Provider）
│   ├── src/ # 目录
│   ├── package-lock.json # 后端 npm 锁定依赖版本
│   ├── package.json # 后端依赖与脚本（server 侧）
│   └── tsconfig.json # 后端 TS 编译配置
├── src/ # 前端源码（React）
│   ├── components/ # 目录
│   ├── lib/ # 目录
│   ├── pages/ # 目录
│   ├── types/ # 目录
│   ├── App.tsx # 前端主壳：左侧导航 + 页面路由（基于 state 切页）
│   ├── index.css # 全局样式（Tailwind base/components/utilities）
│   ├── main.tsx # 前端入口：创建 React Root，挂载 App
│   └── vite-env.d.ts # Vite 的 TS 类型声明
├── supabase/ # Supabase 本地开发/迁移脚本
│   └── migrations/ # 目录
├── .env # 环境变量（本地/部署配置；注意不要提交敏感信息）
├── .gitignore # Git 忽略规则
├── ADMIN_API_CONSISTENCY.md # Admin API 设计/一致性说明
├── ENHANCEMENTS_README.md # 增强功能汇总说明
├── eslint.config.js # ESLint 规则配置
├── IMPLEMENTATION_EXAMPLES.ts # 实现示例代码/片段（参考用）
├── IMPLEMENTATION_GUIDE.md # 实现指南（开发者说明）
├── index.html # Vite 前端 HTML 入口（挂载 root）
├── LEARNING_MODE_IMPLEMENTATION.md # Learning Mode 设计与实现说明
├── P0_FIXES_SUMMARY.md # P0 修复汇总（变更记录）
├── package-lock.json # npm 锁定依赖版本
├── package.json # 前端依赖与脚本（dev/build/lint 等）
├── postcss.config.js # PostCSS 配置（Tailwind 编译链）
├── SECURITY_TESTING_ENHANCEMENTS.md # 安全测试增强说明（规则/发现等）
├── SOLUTION_SUMMARY.md # 整体方案总结/架构说明
├── tailwind.config.js # TailwindCSS 配置
├── tsconfig.app.json # 前端 TS 配置（应用侧）
├── tsconfig.json # TS 主配置（路径/编译选项）
├── tsconfig.node.json # Node 侧 TS 配置（Vite/脚本）
└── vite.config.ts # Vite 构建/代理配置
```

## 2) 前端（src）文件结构

```text
src/
├── components/ # 目录
│   ├── ui/ # 目录
│   │   ├── Form.tsx # UI 基础组件：表单封装
│   │   ├── Modal.tsx # UI 基础组件：弹窗
│   │   └── Table.tsx # UI 基础组件：表格
│   ├── Layout.tsx # 通用布局：侧边栏/顶部栏/内容区容器
│   ├── LearningResultsModal.tsx # Learning 结果弹窗展示（建议字段/规则等）
│   ├── StepAssertionsEditor.tsx # 步骤断言编辑器（step assertions 配置/校验）
│   ├── SuppressionRulesManager.tsx # Finding 抑制规则管理（忽略/降噪）
│   └── VariablePoolManager.tsx # 变量池管理组件（workflow 变量/作用域/取值）
├── lib/ # 目录
│   ├── api-client.ts # API Client + 各资源 service：页面调用的主要入口
│   └── api-service.ts # service 聚合导出/封装（便于引用）
├── pages/ # 目录
│   ├── Accounts.tsx # 测试账户管理：账户 CRUD、关联环境/变量
│   ├── ApiTemplates.tsx # API 模板管理：请求模板、参数、headers、变量占位符
│   ├── Checklists.tsx # 检查清单：测试点/检查项管理
│   ├── CIGatePolicies.tsx # CI Gate 策略：policy 规则编辑、运行 gate
│   ├── Dashboard.tsx # Dashboard 页面：统计概览/趋势卡片
│   ├── DictionaryManager.tsx # 字段字典管理：字段规则/映射/学习结果落库
│   ├── Environments.tsx # 环境管理：环境列表、基础配置
│   ├── Findings.tsx # Findings：发现列表、详情、状态流转、关联 run
│   ├── FindingsGovernance.tsx # 治理：抑制/丢弃/基线/保留策略等
│   ├── SecurityRules.tsx # 安全规则：规则库（匹配/严重性/处理动作）
│   ├── TemplateVariableManager.tsx # 模板变量管理：批量更新/搜索/作用域
│   ├── TestRuns.tsx # 测试运行：发起 run、查看结果/日志、回放
│   └── Workflows.tsx # 工作流：步骤编排、提取器、断言、执行入口
├── types/ # 目录
│   └── index.ts # 前端公共类型定义
├── App.tsx # 前端主壳：左侧导航 + 页面路由（基于 state 切页）
├── index.css # 全局样式（Tailwind base/components/utilities）
├── main.tsx # 前端入口：创建 React Root，挂载 App
└── vite-env.d.ts # Vite 的 TS 类型声明
```

## 3) 后端（server）文件结构

```text
server/
├── src/ # 目录
│   ├── db/ # 目录
│   │   ├── db-manager.ts # DB 管理器：选择 provider、连接/切换 profile、初始化
│   │   ├── postgres-provider.ts # Postgres Provider：生产/远程 DB 实现
│   │   ├── schema.ts # 数据库 schema（表结构、字段、关系）
│   │   └── sqlite-provider.ts # SQLite Provider：本地/轻量存储实现
│   ├── routes/ # 目录
│   │   ├── admin.ts # 管理类 API：DB profiles、迁移、导入导出等
│   │   ├── api.ts # 核心 API：CRUD/资源接口（模板、检查项、规则、发现等）
│   │   ├── crud.ts # 通用 CRUD Router 工厂（减少重复代码）
│   │   ├── dashboard.ts # Dashboard 汇总接口（统计/趋势/概览数据）
│   │   ├── learning.ts # Learning Mode API：字典/学习/映射/变量推荐等
│   │   └── run.ts # 执行类 API：运行测试/工作流/gate（触发 runner）
│   ├── services/ # 目录
│   │   ├── baseline-normalize.ts # Baseline 归一化：将响应归一后用于稳定比较
│   │   ├── baseline-utils.ts # Baseline 工具：基线配置/比较策略（用于 diff/回归）
│   │   ├── drop-filter.ts # Drop 过滤：finding drop rules（丢弃/降噪策略）
│   │   ├── execution-utils.ts # 执行工具：请求/响应清洗、header 处理、通用执行辅助
│   │   ├── field-dictionary.ts # 字段字典：规则定义、字段匹配/归一、学习输入输出模型
│   │   ├── gate-runner.ts # CI Gate 执行：按 gate policy 评估 runs/findings
│   │   ├── learning-engine.ts # 学习引擎：从历史 runs/findings 推断字段/规则/映射建议
│   │   ├── rate-limiter.ts # 治理/限流：读取 governance settings，控制执行频率
│   │   ├── retention-cleaner.ts # 数据保留清理：按 retention policy 清理历史 runs/findings
│   │   ├── suppression.ts # 抑制逻辑：finding suppression 规则匹配与应用
│   │   ├── template-runner.ts # 模板执行器：按模板发请求、收集结果、生成 findings
│   │   ├── variable-pool.ts # 变量池：变量解析、作用域合并、模板变量/工作流变量处理
│   │   ├── variable-validation.ts # 变量校验：按账户/环境约束检查变量合法性
│   │   └── workflow-runner.ts # 工作流执行器：串行/并行步骤、变量注入、断言/提取器
│   ├── types/ # 目录
│   │   └── index.ts # 后端公共类型（DB Provider、DTO、规则结构等）
│   └── index.ts # 后端入口：Express 初始化、路由挂载、清理任务调度
├── package-lock.json # 后端 npm 锁定依赖版本
├── package.json # 后端依赖与脚本（server 侧）
└── tsconfig.json # 后端 TS 编译配置
```

## 4) 数据库（schema & migrations）

### 4.1 schema.ts 中的表

- accounts
- api_templates
- app_settings
- checklists
- cicd_gate_policies
- db_profiles
- environments
- field_dictionary
- finding_drop_rules
- finding_suppression_rules
- findings
- governance_settings
- security_rules
- security_runs
- test_runs
- workflow_extractors
- workflow_mappings
- workflow_steps
- workflow_variable_configs
- workflow_variables
- workflows

### 4.2 supabase migrations

```text
supabase/
└── migrations/ # 目录
    ├── 20251218074427_add_checklist_tables_v2.sql # 数据库迁移：新增 checklist 相关表（v2 版本）
    ├── 20251218082341_simplify_checklist_design.sql # 数据库迁移：简化 checklist 表设计/字段
    ├── 20251218090942_redesign_security_rules_v3.sql # 数据库迁移：重构 security rules 结构（v3）
    ├── 20251218102558_fix_rls_and_add_ownership.sql # 数据库迁移：修复 RLS 并补充 ownership（多租户归属）
    ├── 20251218104407_add_workflow_tables.sql # 数据库迁移：新增 workflow 相关表（workflow/steps 等）
    ├── 20251219023313_enhance_security_testing_capabilities.sql # 数据库迁移：增强安全测试能力（字段/索引/策略扩展）
    ├── 20251219060850_add_workflow_extractors_and_session_jar.sql # 数据库迁移：新增 workflow extractors 与 session jar（会话/提取）
    ├── 20251219063907_add_workflow_context_data_source.sql # 数据库迁移：新增 workflow context data source（上下文数据源）
    ├── 20251219064938_add_findings_source_type_and_suppression.sql # 数据库迁移：为 findings 增加 source_type 与 suppression 支持
    ├── 20251219100240_initial_schema.sql # 数据库迁移：初始化基础 schema
    ├── 20251219102214_update_gate_policy_rules_structure.sql # 数据库迁移：更新 CI gate policy 规则结构
    ├── 20251219154520_add_execution_error_tracking_v2.sql # 数据库迁移：增加执行错误追踪（v2）
    ├── 20251219154537_add_findings_baseline_columns.sql # 数据库迁移：为 findings 增加 baseline 对比字段
    ├── 20251219180224_add_step_assertions_and_baseline_config.sql # 数据库迁移：新增 step assertions 与 baseline 配置
    ├── 20251220085224_add_variable_validation_and_account_scope.sql # 数据库迁移：新增变量校验与 account scope（账户作用域）
    └── 20251220193940_create_complete_schema_with_learning.sql # 数据库迁移：创建完整 schema，并加入 learning 模块相关表
```

## 5) 功能逻辑树（从页面 -> API -> 后端 -> DB）

### Dashboard（dashboard）

- 前端入口：`src/pages/Dashboard.tsx`（由 `src/App.tsx` 的 `currentPage='dashboard'` 渲染）

- 前端调用的 Service：
  - `dashboardService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/dashboard/summary`（dashboardService.summary）

- 后端对应：
  - 路由：`server/src/routes/dashboard.ts`（挂载到 `/api/dashboard`）
  - 数据来源：通过当前激活的 DB provider 读统计摘要（`/summary`）

- 主要表：
  - `test_runs`
  - `findings`
  - `workflows`
  - `security_runs`



### Environments（environments）

- 前端入口：`src/pages/Environments.tsx`（由 `src/App.tsx` 的 `currentPage='environments'` 渲染）

- 相关组件：
  - `components/ui/Form`
  - `components/ui/Modal`
  - `components/ui/Table`

- 前端调用的 Service：
  - `environmentsService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/environments`（environmentsService.list）

  - `PUT /api/environments/${id}`（environmentsService.update）

- 后端对应：
  - 路由：`server/src/routes/api.ts` -> `createCrudRouter(...)`（挂载到 `/api/environments`）
  - CRUD 实现：`server/src/routes/crud.ts`（通用 list/get/create/update/delete）
  - DB：`server/src/db/*-provider.ts` 的 `create/findAll/update/delete`

- 主要表：
  - `environments`



### Test Accounts（accounts）

- 前端入口：`src/pages/Accounts.tsx`（由 `src/App.tsx` 的 `currentPage='accounts'` 渲染）

- 相关组件：
  - `components/ui/Form`
  - `components/ui/Modal`
  - `components/ui/Table`

- 前端调用的 Service：
  - `accountsService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/accounts`（accountsService.list）

  - `PUT /api/accounts/${id}`（accountsService.update）

- 后端对应：
  - 挂载：`/api/accounts`（CRUD router）

- 主要表：
  - `accounts`



### API Templates（templates）

- 前端入口：`src/pages/ApiTemplates.tsx`（由 `src/App.tsx` 的 `currentPage='templates'` 渲染）

- 相关组件：
  - `components/ui/Form`
  - `components/ui/Modal`
  - `components/ui/Table`

- 前端调用的 Service：
  - `apiTemplatesService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）
  - `templateVariableService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/api-templates${params}`（apiTemplatesService.list）

  - `GET /api/api-templates/${id}`（apiTemplatesService.getById）

  - `POST /api/api-templates`（apiTemplatesService.create）

  - `POST /api/template-variables/bulk-update`（templateVariableService.bulkUpdate）

- 额外/特殊 API：
  - `POST /api/template-variables/search`
  - `POST /api/template-variables/bulk-update`

- 后端对应：
  - `/api/api-templates`：CRUD + `baseline-normalize.ts` 做 baseline_config 归一化（beforeCreate/beforeUpdate hook）
  - `template-variables`：`server/src/routes/api.ts` 里的自定义 endpoints（非 CRUD）

- 主要表：
  - `api_templates`
  - `workflow_variables`
  - `workflow_mappings`



### Checklists（checklists）

- 前端入口：`src/pages/Checklists.tsx`（由 `src/App.tsx` 的 `currentPage='checklists'` 渲染）

- 相关组件：
  - `components/ui/Form`
  - `components/ui/Modal`
  - `components/ui/Table`

- 前端调用的 Service：
  - `checklistsService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/checklists`（checklistsService.list）

  - `GET /api/checklists/${id}`（checklistsService.getById）

- 后端对应：
  - 挂载：`/api/checklists`（CRUD router）

- 主要表：
  - `checklists`



### Security Rules（rules）

- 前端入口：`src/pages/SecurityRules.tsx`（由 `src/App.tsx` 的 `currentPage='rules'` 渲染）

- 相关组件：
  - `components/ui/Form`
  - `components/ui/Modal`
  - `components/ui/Table`

- 前端调用的 Service：
  - `securityRulesService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/security-rules`（securityRulesService.list）

  - `GET /api/security-rules/${id}`（securityRulesService.getById）

- 后端对应：
  - 挂载：`/api/security-rules`（CRUD router）

- 主要表：
  - `security_rules`



### Workflows（workflows）

- 前端入口：`src/pages/Workflows.tsx`（由 `src/App.tsx` 的 `currentPage='workflows'` 渲染）

- 相关组件：
  - `components/LearningResultsModal`
  - `components/StepAssertionsEditor`
  - `components/VariablePoolManager`
  - `components/ui/Form`
  - `components/ui/Modal`
  - `components/ui/Table`

- 前端调用的 Service：
  - `workflowsService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/workflows`（workflowsService.list）

  - `GET /api/workflows/${id}`（workflowsService.getById）

  - `GET /api/workflows/${id}/full`（workflowsService.getWithDetails）

  - `PUT /api/workflows/${workflowId}/steps`（workflowsService.setSteps）

  - `PUT /api/workflows/${workflowId}/variable-configs`（workflowsService.setVariableConfigs）

  - `GET /api/workflows/${workflowId}/extractors`（workflowsService.getExtractors）

  - `PUT /api/workflow-steps/${stepId}/assertions`（workflowsService.updateStepAssertions）

- 额外/特殊 API：
  - `GET /api/workflows/:id/full`
  - `GET/PUT /api/workflows/:id/steps`
  - `GET/PUT /api/workflows/:id/variable-configs`
  - `GET/PUT /api/workflows/:id/extractors`
  - `PUT /api/workflow-steps/:id/assertions`
  - `POST /api/workflows/:id/learn（学习）`
  - `GET/POST/PUT/DELETE /api/workflows/:id/variables（变量池）`
  - `GET/POST/PUT/DELETE /api/workflows/:id/mappings（映射）`
  - `POST /api/workflows/:id/mappings/apply（应用映射）`
  - `POST /api/workflows/:id/steps/import-from-template`

- 后端对应：
  - 路由：`server/src/routes/api.ts`（workflow 的详情/steps/variable-configs/extractors/assertions）
  - 学习相关：`server/src/routes/learning.ts`（同样挂到 `/api` 下）
  - 执行核心：`server/src/services/workflow-runner.ts`（执行 workflow -> 调用 template-runner，写 test_runs/findings）

- 主要表：
  - `workflows`
  - `workflow_steps`
  - `workflow_variable_configs`
  - `workflow_extractors`
  - `workflow_variables`
  - `workflow_mappings`



### Field Dictionary（dictionary）

- 前端入口：`src/pages/DictionaryManager.tsx`（由 `src/App.tsx` 的 `currentPage='dictionary'` 渲染）

- 前端调用的 Service：
  - `dictionaryService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/dictionary?${params}`（dictionaryService.list）

  - `POST /api/dictionary`（dictionaryService.create）

  - `PUT /api/dictionary/${id}`（dictionaryService.update）

- 额外/特殊 API：
  - `GET/POST /api/dictionary`
  - `PUT/DELETE /api/dictionary/:id`

- 后端对应：
  - 路由：`server/src/routes/learning.ts`
  - 实现：`server/src/services/field-dictionary.ts`（对 `field_dictionary` 表的读写/匹配）

- 主要表：
  - `field_dictionary`



### Test Runs（runs）

- 前端入口：`src/pages/TestRuns.tsx`（由 `src/App.tsx` 的 `currentPage='runs'` 渲染）

- 前端调用的 Service：
  - `testRunsService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）
  - `executionService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）
  - `securityRunsService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/test-runs`（testRunsService.list）

  - `GET /api/test-runs/${id}`（testRunsService.getById）

  - `POST /api/run/template`（executionService.executeTemplate）

  - `POST /api/run/workflow`（executionService.executeWorkflow）

  - `GET /api/security-runs`（securityRunsService.list）

  - `GET /api/security-runs/${id}`（securityRunsService.getById）

- 额外/特殊 API：
  - `POST /api/run/template`
  - `POST /api/run/workflow`
  - `POST /api/run/gate`

- 后端对应：
  - 执行路由：`server/src/routes/run.ts`（挂到 `/api/run`）
  - 模板执行：`server/src/services/template-runner.ts`
  - 工作流执行：`server/src/services/workflow-runner.ts`
  - Gate 执行：`server/src/services/gate-runner.ts`

- 主要表：
  - `test_runs`
  - `security_runs`
  - `findings`



### Findings（findings）

- 前端入口：`src/pages/Findings.tsx`（由 `src/App.tsx` 的 `currentPage='findings'` 渲染）

- 相关组件：
  - `components/SuppressionRulesManager`
  - `components/ui/Form`
  - `components/ui/Modal`
  - `components/ui/Table`

- 前端调用的 Service：
  - `findingsService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）
  - `suppressionRulesService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）
  - `testRunsService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/findings${params}`（findingsService.list）

  - `GET /api/findings/${id}`（findingsService.getById）

  - `POST /api/findings`（findingsService.create）

  - `GET /api/suppression-rules`（suppressionRulesService.list）

  - `PUT /api/suppression-rules/${id}`（suppressionRulesService.update）

  - `GET /api/test-runs`（testRunsService.list）

  - `GET /api/test-runs/${id}`（testRunsService.getById）

- 后端对应：
  - 挂载：`/api/findings`（CRUD router，支持查询参数筛选）
  - 抑制规则：`/api/suppression-rules`（CRUD） + `server/src/services/suppression.ts`（匹配逻辑）

- 主要表：
  - `findings`
  - `finding_suppression_rules`



### Governance（governance）

- 前端入口：`src/pages/FindingsGovernance.tsx`（由 `src/App.tsx` 的 `currentPage='governance'` 渲染）

- 前端调用的 Service：
  - `governanceService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）
  - `dropRulesService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/governance/settings`（governanceService.getSettings）

  - `POST /api/governance/cleanup`（governanceService.runCleanup）

  - `GET /api/drop-rules`（dropRulesService.list）

  - `PUT /api/drop-rules/${id}`（dropRulesService.update）

  - `POST /api/drop-rules/preview`（dropRulesService.preview）

- 额外/特殊 API：
  - `POST /api/drop-rules/preview`
  - `POST /api/governance/cleanup`

- 后端对应：
  - 治理设置：`server/src/services/rate-limiter.ts`（读取/更新 `governance_settings`）
  - 清理任务：`server/src/services/retention-cleaner.ts`（按设置做保留/清理）
  - Drop rules：`server/src/services/drop-filter.ts`（匹配/预览）

- 主要表：
  - `governance_settings`
  - `finding_drop_rules`



### CI Gate（cigate）

- 前端入口：`src/pages/CIGatePolicies.tsx`（由 `src/App.tsx` 的 `currentPage='cigate'` 渲染）

- 前端调用的 Service：
  - `gatePoliciesService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）
  - `securityRunsService`（定义在 `src/lib/api-client.ts`，聚合导出在 `src/lib/api-service.ts`）

- 主要 API：

  - `GET /api/gate-policies`（gatePoliciesService.list）

  - `GET /api/gate-policies/${id}`（gatePoliciesService.getById）

  - `GET /api/security-runs`（securityRunsService.list）

  - `GET /api/security-runs/${id}`（securityRunsService.getById）

- 后端对应：
  - 策略：`/api/gate-policies`（CRUD）
  - 执行：`POST /api/run/gate` -> `gate-runner.ts`（生成 security_runs，引用 test_runs）

- 主要表：
  - `cicd_gate_policies`
  - `security_runs`
  - `test_runs`



## 6) 一条“从功能定位到代码”的通用路径（建议你这样查）

1. 先从左侧菜单找到页面：`src/App.tsx` 里 `navItems` 的 `id` 对应 `currentPage`。

2. 进入对应的 `src/pages/*.tsx`，搜索你关心的按钮/事件处理函数。

3. 看它调用了哪个 Service：一般来自 `src/lib/api-service.ts`（实际实现都在 `src/lib/api-client.ts`）。

4. 记下它请求的 API 路径（例如 `/api/workflows/...`），再去后端：

   - `server/src/index.ts` 看该路径挂到哪个 router（`/api`、`/api/run`、`/admin`）。

   - 对应路由文件：`server/src/routes/api.ts` / `run.ts` / `learning.ts` / `admin.ts`。

5. 路由里通常会调用 `server/src/services/*.ts` 或通用 `createCrudRouter`，再往下就是 DB provider：`server/src/db/*-provider.ts`。

6. 最后对照 `server/src/db/schema.ts` 的表名定位数据存在哪。
