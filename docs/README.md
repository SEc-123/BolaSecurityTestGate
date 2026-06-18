# Bola Security Test Gate - 完整项目文档

## 📚 文档导航

本文档库提供了 Bola Security Test Gate 的完整使用说明、配置指南和 API 参考。

### 文档结构

```
docs/
├── README.md                           # 本文件 - 文档导航
├── QUICK_START.md                      # 5分钟快速上手
├── modules/                            # 功能模块详细文档
│   ├── 01-environments.md             # 环境管理模块
│   ├── 02-accounts.md                 # 账户管理模块
│   ├── 03-api-templates.md            # API 模板模块
│   └── 04-checklists.md               # 检查清单模块
├── configuration/                      # 配置文档
│   ├── database.md                    # 数据库配置
│   └── environment-variables.md       # 环境变量配置
└── api/                               # API 参考文档
    └── rest-api.md                    # REST API 完整参考
```

---

## 🎯 项目概述

**Bola Security Test Gate** 是一个面向 **API 安全测试** 的可视化控制台，核心围绕两件事展开：

- 用 **API Template** 表达真实 HTTP 请求
- 用 **Test Run** 对这些模板做正式执行、追踪与结果复查

典型使用方式是：

1. 粘贴或录制一条真实请求
2. 将请求整理成 API Template
3. 把关键字段配置成变量
4. 将变量绑定到账户字段、Checklist 或 Security Rule
5. 选择目标环境发起 Test Run
6. 查看 Findings、证据和治理结果

这使它特别适合以下 API 安全场景：

- 对象级授权校验（BOLA / IDOR）
- 多账户访问控制测试
- 参数替换与篡改测试
- payload 注入与异常响应比对
- 高风险接口的重复回归验证

## 🚀 快速开始

### 1. 基本概念

#### **Environment (环境)**
定义测试目标的基础 URL 和配置

#### **Account (账户)**
测试用的身份凭证，支持多种认证方式

#### **API Template (API 模板)**
定义单个 API 请求的模板，支持变量替换

#### **Checklist (检查清单)**
管理测试数据和参数值列表

#### **Test Run（测试运行）**
项目中用于执行和追踪 API 模板测试的运行记录。通常会保存本次运行选择了哪些模板、目标环境、绑定了哪些账户，以及运行过程中的进度、发现和错误信息。

---

## 📋 功能模块文档

### 基础设施模块

| 模块 | 文档 | 说明 |
|------|------|------|
| 环境管理 | [01-environments.md](modules/01-environments.md) | 管理测试目标环境和基础配置 |
| 账户管理 | [02-accounts.md](modules/02-accounts.md) | 管理测试用户身份和凭证 |

### 测试定义模块

| 模块 | 文档 | 说明 |
|------|------|------|
| API 模板 | [03-api-templates.md](modules/03-api-templates.md) | 定义可重用的 API 请求模板 |
| 检查清单 | [04-checklists.md](modules/04-checklists.md) | 管理变量替换值列表 |

### 配置参考

| 配置 | 文档 | 说明 |
|------|------|------|
| 数据库 | [configuration/database.md](configuration/database.md) | SQLite、PostgreSQL 配置 |
| 环境变量 | [configuration/environment-variables.md](configuration/environment-variables.md) | 前端和后端环境变量配置 |

### API 参考

| API | 文档 | 说明 |
|-----|------|------|
| REST API | [api/rest-api.md](api/rest-api.md) | 完整的 HTTP API 接口文档 |

---

## 📝 文档版本

- **文档版本**: 1.0.0
- **最后更新**: 2026-01-13

---

**开始使用**: 阅读 [5分钟快速上手](QUICK_START.md) 快速入门！
