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

**Bola Security Test Gate** is a visual console for **API security testing**. The product revolves around two primary objects:

- **API Templates** for modeling real HTTP requests
- **Test Runs** for executing those templates and reviewing the results

A typical BSTG workflow looks like this:

1. capture or paste a real HTTP request
2. turn it into an API Template
3. mark important request fields as variables
4. bind variables to account fields, checklists, or security-rule payloads
5. launch a Test Run against a target environment
6. review findings, evidence, and governance outcomes

This makes BSTG especially useful for API security scenarios such as:

- BOLA / IDOR checks
- multi-account authorization testing
- parameter tampering
- payload replay against high-risk endpoints
- regression testing for previously identified weak points

### Core Features

| Feature Category | Capabilities |
|-----------------|--------------|
| **Test Infrastructure** | Environment management, account management, variable sources |
| **Test Definition** | API templates, checklists, security rules |
| **Execution** | Template-based test runs, live progress tracking, findings generation |
| **Advanced Scenarios** | Workflows, recording-derived presets, draft promotion |
| **Result Management** | Finding records, evidence preservation, suppression rules, rate limiting |
| **Quality Gates** | CI/CD policies, threshold rules, weighted scoring |
| **Governance** | Data retention policies, automatic cleanup, archiving |
| **AI Analysis** | Smart finding classification, pattern recognition, report generation |
| **Debug Tools** | Request tracing, response inspection, raw HTTP export |

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

#### **Test Run**
The execution record used to run and track API template tests. It usually stores which templates were selected, which environment was targeted, which accounts were bound, and the resulting progress, findings, and errors.

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
   Launch a Test Run for one or more API templates
   Monitor runner-updated progress in real-time

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
| Database | [configuration/database.md](configuration/database.md) | SQLite and PostgreSQL configuration |
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
