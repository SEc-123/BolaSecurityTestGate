# Bola Security Test Gate - 5-Minute Quick Start

## 🚀 Welcome

Welcome to Bola Security Test Gate! This guide will help you complete your first test in 5 minutes.

---

## 📋 Prerequisites

- ✅ Frontend and backend services are running
- ✅ Frontend: http://localhost:5173
- ✅ Backend: http://localhost:3001
- ✅ Database automatically initialized (default SQLite)

---

## 🎯 Step 1: Create a Test Environment

### Steps

1. Open browser and visit: http://localhost:5173
2. Click **"Environments"** in the left menu
3. Click **"Create Environment"** button
4. Fill in the form:

```
Name: Development
Base URL: http://localhost:3000
Description: Local development environment testing
```

5. Click **"Save"**

---

## 👤 Step 2: Create a Test Account

### Steps

1. Click **"Accounts"** in the left menu
2. Click **"Create Account"** button
3. Fill in account information (Basic Auth example):

```
Name: Test User
Username: testuser
Password: testpass123
Description: Regular test user account
```

4. Click **"Save"**

---

## 📝 Step 3: Create an API Template

### Steps

1. Click **"API Templates"** in the left menu
2. Click **"Create Template"** button
3. Fill in basic information:

```
Name: Get User List
Group: User Management
Description: Get list of all users
```

4. Fill in raw HTTP request:

```http
GET /api/users HTTP/1.1
Host: api.example.com
Content-Type: application/json
```

5. Configure failure pattern: Select HTTP Status, operator not_equals, value 200
6. Click **"Save"**

---

## ▶️ Step 4: Run a Template Test

### Steps

1. Click **"Test Runs"** in the left menu
2. Click **"New Test Run"**
3. Select:
   - Template: "Get User List"
   - Environment: "Development"
   - Accounts: "Test User"
4. Click **"Run"** to start execution
5. View execution progress and results

---

## 🔍 Step 5: View Findings

### Steps

1. Click **"Findings"** in the left menu
2. View list of issues discovered during testing
3. Click on any Finding to view detailed request/response information

---

## 📚 Complete Documentation

Need more detailed information? Check the complete documentation:

- [Documentation Home](README.md)
- [Environment Management](modules/01-environments.md)
- [Account Management](modules/02-accounts.md)
- [API Templates](modules/03-api-templates.md)
- [REST API](api/rest-api.md)

---

## ✅ Completion Checklist

- [ ] Created test environment
- [ ] Created test account
- [ ] Created API template
- [ ] Successfully ran test
- [ ] Viewed test findings

---

**Congratulations on completing the quick start!** 🎉
