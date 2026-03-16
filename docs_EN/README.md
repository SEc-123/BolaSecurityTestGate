# Bola Security Test Gate - Complete Documentation

## 📚 Documentation Navigation

This documentation provides complete usage instructions, configuration guides, and API references for Bola Security Test Gate.

### Documentation Structure

```
docs/
├── README.md                           # This file - Documentation navigation
├── QUICK_START.md                      # 5-minute quick start guide
├── modules/                            # Feature module documentation
│   ├── 01-environments.md             # Environments module
│   ├── 02-accounts.md                 # Accounts module
│   ├── 03-api-templates.md            # API Templates module
│   └── 04-checklists.md               # Checklists module
├── configuration/                      # Configuration documentation
│   ├── database.md                    # Database configuration
│   └── environment-variables.md       # Environment variables
└── api/                               # API reference documentation
    └── rest-api.md                    # Complete REST API reference
```

---

## 🎯 Project Overview

**Bola Security Test Gate** is a powerful Web/API security testing platform with a visual console for:

- 🔐 Security test automation
- 🔄 Complex workflow orchestration
- 📊 Test result governance
- 🚪 CI/CD quality gates
- 🤖 AI-driven security analysis
- 🔍 Vulnerability discovery and management

### Core Features

| Feature Category | Capabilities |
|-----------------|--------------|
| **Test Infrastructure** | Environment management, Account management, Variable pools |
| **Test Definition** | API templates, Security rules, Workflows, Checklists |
| **Execution Engine** | Template execution, Workflow orchestration, Parallel execution |
| **Result Management** | Finding records, Evidence preservation, Suppression rules, Rate limiting |
| **Quality Gates** | CI/CD policies, Threshold rules, Weighted scoring |
| **Governance** | Data retention policies, Automatic cleanup, Archiving |
| **AI Analysis** | Smart finding classification, Pattern recognition, Report generation |
| **Debug Tools** | Request tracing, Response inspection, Raw HTTP export |

---

## 🚀 Getting Started

### Core Concepts

#### **Environment**
Defines the base URL and configuration for test targets. Each environment represents an independent test target (e.g., dev, test, production).

#### **Account**
Test credentials and authentication information. Supports username/password, API keys, Bearer tokens, and more.

#### **API Template**
Defines a single API request template with URL, method, headers, body, and supports variable substitution and failure pattern detection.

#### **Workflow**
Multi-step test scenario orchestration with data passing, assertions, and conditional execution between steps.

#### **Security Rule**
Predefined security test payloads for SQL injection, XSS, command injection, and other attack testing.

#### **Finding**
Security issues or vulnerabilities discovered during testing, including complete request/response evidence.

#### **CI/CD Gate Policy**
Defines quality standards and thresholds for automated decision-making in CI/CD pipelines.

---

## 📖 Typical Usage Flow

```
1. Configure Infrastructure
   ↓
   Create Environments
   Create Accounts

2. Define Tests
   ↓
   Create API Templates
   or
   Create Workflows

3. Add Security Checks
   ↓
   Configure Security Rules
   Set up failure pattern detection

4. Execute Tests
   ↓
   Run templates/workflows
   Monitor progress in real-time

5. Manage Results
   ↓
   Review Findings
   Set suppression rules
   Configure retention policies

6. CI/CD Integration
   ↓
   Create Gate Policies
   Integrate into CI/CD pipeline
```

---

## 📋 Module Documentation Index

### Infrastructure Modules

| Module | Documentation | Description |
|--------|--------------|-------------|
| Environments | [01-environments.md](modules/01-environments.md) | Manage test target environments and base configuration |
| Accounts | [02-accounts.md](modules/02-accounts.md) | Manage test user identities and credentials |

### Test Definition Modules

| Module | Documentation | Description |
|--------|--------------|-------------|
| API Templates | [03-api-templates.md](modules/03-api-templates.md) | Define reusable API request templates |
| Checklists | [04-checklists.md](modules/04-checklists.md) | Manage variable substitution value lists |

### Configuration Reference

| Module | Documentation | Description |
|--------|--------------|-------------|
| Database | [configuration/database.md](configuration/database.md) | SQLite, PostgreSQL, Supabase configuration |
| Environment Variables | [configuration/environment-variables.md](configuration/environment-variables.md) | Frontend and backend environment variables |

### API Reference

| API | Documentation | Description |
|-----|--------------|-------------|
| REST API | [api/rest-api.md](api/rest-api.md) | Complete HTTP API interface documentation |

---

## 🆘 Getting Help

### Troubleshooting

1. Check the "Common Questions" section in each module's documentation
2. Refer to [REST API Documentation](api/rest-api.md) to verify API call formats
3. Check [Database Configuration](configuration/database.md) to ensure connection is working

---

## 📝 Documentation Version

- **Documentation Version**: 1.0.0
- **Project Version**: 0.0.0
- **Last Updated**: 2026-01-13

---

**Get Started**: Read the [5-Minute Quick Start](QUICK_START.md) to get up and running quickly!
