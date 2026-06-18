# Value Mode: raw_request 同步更新修复完成

## 完成时间
2025-12-27

## 修复目标 ✅

实现 Template Variable Manager 的 Value Mode 批量改值时：
1. ✅ `variable.original_value = newValue`（执行器真实发包已生效）
2. ✅ `api_templates.raw_request` 的 JSON body 真正被同步改掉
3. ✅ `api_templates.parsed_structure` 重新生成并与 raw_request 一致
4. ✅ 前端 Preview 显示 raw_request_updated 标志和 warnings

## 后端实现（server/src/routes/api.ts）

### 1. JSONPath 规范化函数（490-498 行）

```typescript
function normalizeJsonPath(jsonPath: string): string {
  let p = (jsonPath || "").trim();
  p = p.replace(/^\$\./, "");      // $.a.b -> a.b
  p = p.replace(/^body\./, "");    // body.a.b -> a.b
  p = p.replace(/^content\./, ""); // content.a.b -> a.b
  return p;
}
```

**功能**：兼容 `$. / body. / content.` 等常见 JSONPath 前缀

### 2. 深度值设置函数（500-547 行）

```typescript
function setDeepValue(obj: any, path: string, value: any): boolean
```

**功能**：
- 支持嵌套对象路径（`a.b.c`）
- 支持数组索引（`a[0]` 或 `a.0.b`）
- 安全处理不存在的路径（返回 false 而不是抛出异常）

### 3. raw_request JSON body 更新函数（549-593 行）

```typescript
function updateRawRequestJsonBody(
  rawRequest: string,
  jsonPath: string,
  newValue: any
): { updated: boolean; rawRequest: string }
```

**功能**：
- 拆分 raw_request 为 header + body
- 解析 JSON body
- 使用候选路径策略（`content.xxx` 和 `xxx` 两种尝试）
- 更新 JSON 值
- 重新序列化并处理 Content-Length header
- 返回更新结果和新的 raw_request

### 4. bulk-update 端点集成（595-767 行）

**核心逻辑**：

```typescript
// 为每个 match 创建 update 记录，包含 raw_request_updated 标志
const matchUpdates: any[] = [];
matchUpdates.push({
  template_id, template_name, variable_name, variable_type,
  json_path, before, after,
  raw_request_updated: undefined  // 初始为 undefined
});

// 处理 default_value 更新
if (patch.default_value !== undefined) {
  for (const match of matches) {
    if (match.variable_type === 'body' && match.json_path) {
      const res = updateRawRequestJsonBody(...);

      if (res.updated) {
        // 成功：更新 raw_request 并标记
        matchUpdates[i].raw_request_updated = true;

        // 重新解析 parsed_structure
        template.parsed_structure = parseRawRequest(res.rawRequest);
      } else {
        // 失败：标记并添加 warning
        matchUpdates[i].raw_request_updated = false;
        warnings.push({ message: 'JSON path not found' });
      }
    }
  }
}
```

**特性**：
- 支持 dry_run 模式（预览时也会计算 raw_request_updated）
- 每个变量独立标记是否同步成功
- 失败不阻断整体更新，但会记录 warnings
- 同时更新 raw_request 和 parsed_structure 保持一致

## 前端实现（src/pages/TemplateVariableManager.tsx）

### 1. UpdatePreview 接口增强（12-20 行）

```typescript
interface UpdatePreview {
  template_id: string;
  template_name: string;
  variable_name: string;
  json_path: string;
  before: Record<string, any>;
  after: Record<string, any>;
  raw_request_updated?: boolean;  // 新增
}
```

### 2. Warnings 显示增强（595-615 行）

```typescript
{previewWarnings.length > 0 && (
  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
    <h4 className="font-medium text-amber-800 mb-2">
      Warnings ({previewWarnings.length})
    </h4>
    <ul className="text-sm text-amber-700 space-y-1">
      {previewWarnings.map((warning, index) => (
        <li key={index} className="flex items-start gap-2">
          <span className="text-amber-600">⚠</span>
          <span>
            {warning.template_name && <span className="font-medium">{warning.template_name}: </span>}
            {warning.variable_name && <span>{warning.variable_name} - </span>}
            {warning.message || warning.reason || 'Unknown issue'}
          </span>
        </li>
      ))}
    </ul>
  </div>
)}
```

**支持格式**：
- 通用 `message` 字段（新格式）
- 兼容旧的 `reason` 字段
- 显示 template_name 和 variable_name（如果存在）

### 3. Preview 表格增强（631-708 行）

**新增功能**：

1. **显示 Value 变化**（Value Mode 场景）
   ```typescript
   // Before 列
   {item.before.default_value !== undefined && (
     <div>Value: <code>{String(item.before.default_value)}</code></div>
   )}

   // After 列
   {item.after.default_value !== undefined && (
     <div>Value: <code className="text-green-600">{String(item.after.default_value)}</code></div>
   )}
   ```

2. **raw_request_updated 状态标识**
   ```typescript
   {hasValueChange && isBodyVariable && (
     <div className="mt-1">
       {item.raw_request_updated === false ? (
         <span className="bg-amber-100 text-amber-800">
           ⚠ raw_request not synced
         </span>
       ) : item.raw_request_updated === true ? (
         <span className="bg-green-100 text-green-800">
           ✓ raw_request synced
         </span>
       ) : null}
     </div>
   )}
   ```

**显示逻辑**：
- 仅对 body 类型变量且有 json_path 的显示状态标识
- 绿色 ✓ 表示 raw_request 已同步
- 黄色 ⚠ 表示 raw_request 未同步（但 original_value 仍会生效）

## 测试场景

### 场景 1：成功同步
- **输入**：`json_path = "content.user.id"`，`default_value = "12345"`
- **期望**：
  - ✅ `variable.original_value = "12345"`
  - ✅ `raw_request` body 中 `{"content":{"user":{"id":"12345"}}}`
  - ✅ `parsed_structure` 重新生成
  - ✅ 前端显示绿色 "✓ raw_request synced"

### 场景 2：路径不匹配
- **输入**：`json_path = "content.nonexistent"`，`default_value = "test"`
- **期望**：
  - ✅ `variable.original_value = "test"`（执行器仍会用新值）
  - ⚠ `raw_request` 未改变
  - ⚠ warning: "JSON path not found: content.nonexistent"
  - ✅ 前端显示黄色 "⚠ raw_request not synced"

### 场景 3：非 JSON body
- **输入**：`variable_type = "header"`，`default_value = "Bearer xxx"`
- **期望**：
  - ✅ `variable.original_value = "Bearer xxx"`
  - ✅ 不尝试更新 raw_request（header 更新在 Phase 2）
  - ✅ 前端不显示 raw_request 状态标识

### 场景 4：多个变量批量更新
- **输入**：3 个变量（2 个成功，1 个失败）
- **期望**：
  - ✅ 3 个变量的 `original_value` 都更新
  - ✅ 2 个成功的显示绿色标识
  - ⚠ 1 个失败的显示黄色标识 + warning
  - ✅ `raw_request` 包含 2 个成功的改动

## 候选路径策略

为了兼容不同的 JSONPath 格式，使用双重尝试：

```typescript
const norm = normalizeJsonPath(jsonPath); // 去掉 $. / body. / content.

if (norm.startsWith("content.")) {
  candidates = [norm, norm.replace(/^content\./, "")];
  // 例如：["content.user.id", "user.id"]
} else {
  candidates = [norm, "content." + norm];
  // 例如：["user.id", "content.user.id"]
}
```

**为什么需要两种候选**：
- 变量可能定义为 `content.user.id`（指向 `json.content.user.id`）
- 但 raw_request body 可能是 `{"user":{"id":"..."}}`（根对象不是 content）
- 或反过来：变量定义为 `user.id`，但 body 是 `{"content":{"user":{"id":"..."}}}`

## 数据一致性保证

1. **原子性**：`variables`、`raw_request`、`parsed_structure` 在同一个 `update()` 调用中更新
2. **失败隔离**：单个变量的 raw_request 同步失败不影响其他变量
3. **执行优先**：即使 raw_request 未同步，`original_value` 仍会更新，执行器发包时会用新值
4. **可追溯**：warnings 记录所有失败的同步尝试

## 构建验证

```bash
# 前端构建
✓ vite build (7.27s)
  dist/assets/index-DHLkTJnU.js   487.70 kB

# 后端构建
✓ tsc (无错误)
```

## Phase 2 扩展建议

当前实现仅覆盖 **body JSON** 类型变量。未来可扩展：

1. **Header 变量**：更新 `raw_request` 的 header 行
2. **Query 变量**：更新请求行的 query string
3. **Path 变量**：替换请求行的路径部分

函数已经预留了扩展点：
```typescript
if (match.variable_type === 'body' && ...) {
  // 当前实现
} else if (match.variable_type === 'header' && ...) {
  // Phase 2 扩展
}
```

## 总结

✅ **核心目标全部完成**：
1. Value Mode 批量改值时同步更新 raw_request
2. 前端显示同步状态和 warnings
3. 数据一致性保证（original_value + raw_request + parsed_structure）
4. 兼容多种 JSONPath 格式
5. 失败不阻断，提供清晰的 warnings

✅ **代码质量**：
- 函数职责单一，易于测试
- 候选路径策略提高容错性
- dry_run 模式支持完整预览
- 构建通过，无类型错误

🎯 **用户体验提升**：
- 一眼看到哪些变量同步成功/失败
- warnings 提供详细的失败原因
- Value Mode 显示完整的 before/after 对比
- 黄色/绿色标识清晰直观
