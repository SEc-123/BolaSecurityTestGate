# 5 分钟快速上手

## 🚀 前置条件

- 已启动前端: http://localhost:5173
- 已启动后端: http://localhost:3001

---

## 步骤 1：创建环境

1. 打开 http://localhost:5173
2. 点击 "Environments"
3. 点击 "Create"
4. 填写：
   - 名称: `开发环境`
   - Base URL: `http://localhost:3000`
5. 保存

---

## 步骤 2：创建账户

1. 点击 "Accounts"
2. 点击 "Create"
3. 填写：
   - 名称: `测试用户`
   - 用户名: `testuser`
   - 密码: `testpass123`
4. 保存

---

## 步骤 3：创建 API 模板

1. 点击 "API Templates"
2. 点击 "Create"
3. 填写原始请求：
```http
GET /api/users HTTP/1.1
Host: api.example.com
Content-Type: application/json
```
4. 保存

---

## 步骤 4：运行模板测试

1. 点击 "Test Runs"
2. 点击 "New Test Run"
3. 选择模板、环境、账户
4. 点击 "Start Test"

---

## 步骤 5：查看结果

1. 点击 "Findings"
2. 查看测试发现

---

**完成！** 查看 [完整文档](README.md) 了解更多功能。
