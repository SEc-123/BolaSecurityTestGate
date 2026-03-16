# B0 Audit Report: Findings Schema & Data Completeness

## Database Schema Analysis

### Current findings Table Structure

**SQLite version (lines 233-269)**:
- `baseline_response TEXT`
- `mutated_response TEXT`

**PostgreSQL version (lines 577+)**:
- `baseline_response JSONB`
- `mutated_response JSONB`

## Current Data Structure in baseline_response/mutated_response

### Test Run Findings (template-runner.ts:432-433)

**Current Structure** (truncateResponseForStorage output):
```json
{
  "status": 200,
  "headers": {"content-type": "application/json"},
  "body": "..."
}
```

**❌ Missing Fields**:
- ❌ `request.method`
- ❌ `request.url`
- ❌ `request.headers`
- ❌ `request.body`

### Workflow Findings (workflow-runner.ts:832-835)

**Current Structure**:
```json
{
  "steps": [
    {
      "status": 200,
      "headers": {"content-type": "application/json"},
      "body": "..."
    }
  ]
}
```

**Good News**: stepExecutions object HAS complete request info:
- `url`, `method`, `headers`, `body`, `response`

**❌ Problem**: Only `response` is stored (line 833, 835):
```javascript
steps: baselineStepExecutions.map(s => truncateResponseForStorage(s.response, 10000))
```

**❌ Missing Fields** (available but not stored):
- ❌ `step.url` → should be `request.url`
- ❌ `step.method` → should be `request.method`
- ❌ `step.headers` → should be `request.headers`
- ❌ `step.body` → should be `request.body`

## Mapping Table: DB Fields → AIAnalysisInput

| AIAnalysisInput Field | Current DB Field | Status | Fix Required |
|----------------------|------------------|--------|--------------|
| `meta.run_id` | `test_run_id` / `security_run_id` | ✅ Exists | None |
| `meta.finding_id` | `id` | ✅ Exists | None |
| `meta.source_type` | `source_type` | ✅ Exists | None |
| `meta.template_name` | `template_name` | ✅ Exists | None |
| `meta.workflow_id` | `workflow_id` | ✅ Exists | None |
| `baseline.request.method` | N/A | ❌ Missing | **B1** |
| `baseline.request.url` | N/A | ❌ Missing | **B1** |
| `baseline.request.headers` | N/A | ❌ Missing | **B1** |
| `baseline.request.body` | N/A | ❌ Missing | **B1** |
| `baseline.response.status` | `baseline_response.status` | ✅ Exists | None |
| `baseline.response.headers` | `baseline_response.headers` | ✅ Exists | None |
| `baseline.response.body` | `baseline_response.body` | ✅ Exists | None |
| `finding.request.method` | N/A | ❌ Missing | **B1** |
| `finding.request.url` | N/A | ❌ Missing | **B1** |
| `finding.request.headers` | N/A | ❌ Missing | **B1** |
| `finding.request.body` | N/A | ❌ Missing | **B1** |
| `finding.response.status` | `mutated_response.status` | ✅ Exists | None |
| `finding.response.headers` | `mutated_response.headers` | ✅ Exists | None |
| `finding.response.body` | `mutated_response.body` | ✅ Exists | None |
| `workflow_steps[].baseline.request.*` | N/A | ❌ Unknown | **B2** audit needed |
| `workflow_steps[].baseline.response.*` | N/A | ❌ Unknown | **B2** audit needed |
| `workflow_steps[].finding.request.*` | N/A | ❌ Unknown | **B2** audit needed |
| `workflow_steps[].finding.response.*` | N/A | ❌ Unknown | **B2** audit needed |

## Conclusion

### Test Run Findings
**Status**: ❌ **Incomplete** - Only response data stored, request data missing

**Required Changes**:
1. Modify `truncateResponseForStorage()` in `baseline-utils.ts` to accept request+response
2. Update `template-runner.ts` to capture and store complete request data
3. Change storage format from `{status, headers, body}` to `{request: {...}, response: {...}}`

### Workflow Findings
**Status**: ⏳ **Pending Audit** - Need to check workflow-runner.ts

**Next Step**: Audit workflow-runner.ts for steps structure
