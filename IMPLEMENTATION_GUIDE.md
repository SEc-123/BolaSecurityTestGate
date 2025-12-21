# Implementation Guide: Enhanced Security Testing

## Quick Start Implementation Checklist

### ✅ Already Completed
- [x] Database schema extended with all new fields
- [x] TypeScript types updated
- [x] RLS policies configured

### 🔄 In Progress
- [ ] Edge Function: execute-test with all enhancements
- [ ] Edge Function: execute-workflow with all enhancements

### 📋 TODO
- [ ] UI: API Template advanced configuration panel
- [ ] UI: Workflow assertion strategy selector
- [ ] UI: Findings account traceability display
- [ ] Testing: Integration tests for all strategies

## Critical Implementation Files

### 1. Edge Function Utility Library

Location: `supabase/functions/_shared/security-test-utils.ts`

This module should contain:

```typescript
// Account Binding Strategies
export function generateValueCombinations(
  variables: VariableConfig[],
  accounts: Account[],
  checklists: Checklist[],
  securityRules: SecurityRule[],
  strategy: AccountBindingStrategy,
  attackerAccountId?: string
): ValueCombination[]

// Baseline Comparison
export async function executeWithBaseline(
  template: ApiTemplate,
  baselineValues: Record<string, string>,
  mutatedValues: Record<string, string>,
  environment: Environment
): Promise<TestExecution>

export function compareResponses(
  baseline: HttpResponse,
  mutated: HttpResponse,
  config: BaselineComparisonConfig
): ResponseDiff

// Enhanced Replacement
export function applyPathReplacement(
  path: string,
  variable: VariableConfig,
  value: string
): string

export function applyBodyReplacement(
  body: string,
  headers: Record<string, string>,
  variable: VariableConfig,
  value: string
): { body: string; headers: Record<string, string> }

// Body Format Handlers
export function parseFormUrlencoded(body: string): Record<string, string>
export function serializeFormUrlencoded(data: Record<string, string>): string
export function parseMultipart(body: string, boundary: string): MultipartPart[]
export function serializeMultipart(parts: MultipartPart[], boundary: string): string
```

### 2. Updated execute-test Function

Key changes needed:

```typescript
// 1. Load template with new fields
const { data: template } = await supabase
  .from('api_templates')
  .select('*, account_binding_strategy, attacker_account_id, enable_baseline, baseline_config')
  .eq('id', template_id)
  .single();

// 2. Generate combinations based on strategy
const combinations = generateValueCombinations(
  template.variables,
  accounts,
  checklists,
  securityRules,
  template.account_binding_strategy || 'independent',
  template.attacker_account_id
);

// 3. Execute with baseline if enabled
for (const combo of combinations) {
  let execution: TestExecution;

  if (template.enable_baseline) {
    // Determine baseline values
    const baselineValues = template.account_binding_strategy === 'anchor_attacker'
      ? combo.attackerValues  // Attacker's values as baseline
      : combo.values;         // Original template values

    execution = await executeWithBaseline(
      template,
      baselineValues,
      combo.values,
      environment
    );

    // Check if finding should be created
    const isVulnerability = evaluateWithBaseline(execution, template);
    if (isVulnerability) {
      await createFinding(template, execution, combo);
    }
  } else {
    // Original logic - no baseline
    execution = await executeSingle(template, combo.values, environment);
    const isVulnerability = !matchesFailurePatterns(execution.response, template.failure_patterns);
    if (isVulnerability) {
      await createFinding(template, execution, combo);
    }
  }
}

// 4. Create finding with account traceability
async function createFinding(
  template: ApiTemplate,
  execution: TestExecution,
  combo: ValueCombination
) {
  await supabase.from('findings').insert({
    // ... existing fields ...

    // NEW: Account traceability
    account_source_map: combo.accountMap,
    attacker_account_id: combo.attackerId,
    victim_account_ids: combo.victimIds,

    // NEW: Baseline comparison
    baseline_response: execution.baseline?.response,
    mutated_response: execution.mutated.response,
    response_diff: execution.comparison
  });
}
```

### 3. Updated execute-workflow Function

Key changes:

```typescript
// 1. Load workflow with new fields
const { data: workflow } = await supabase
  .from('workflows')
  .select(`
    *,
    assertion_strategy,
    critical_step_orders,
    enable_baseline,
    baseline_config
  `)
  .eq('id', workflow_id)
  .single();

// 2. Execute workflow with strategy-aware evaluation
for (const combo of combinations) {
  const stepExecutions: StepExecution[] = [];

  // Execute baseline workflow if enabled
  if (workflow.enable_baseline) {
    const baselineSteps = await executeWorkflowSteps(
      workflow.steps,
      combo.attackerValues,
      environment
    );

    // Verify baseline succeeds
    if (!evaluateWorkflowSuccess(baselineSteps, workflow.assertion_strategy)) {
      continue; // Skip this combination if baseline fails
    }
  }

  // Execute mutated workflow
  for (const step of workflow.steps) {
    const execution = await executeStep(
      step,
      combo.values,
      environment
    );
    stepExecutions.push(execution);
  }

  // Evaluate using assertion strategy
  const isVulnerability = evaluateWorkflowExecution(
    workflow,
    stepExecutions
  );

  if (isVulnerability) {
    await createWorkflowFinding(workflow, stepExecutions, combo);
  }
}

function evaluateWorkflowExecution(
  workflow: Workflow,
  steps: StepExecution[]
): boolean {
  switch (workflow.assertion_strategy || 'any_step_pass') {
    case 'any_step_pass':
      return steps.some(s => !s.matchedFailurePattern);

    case 'all_steps_pass':
      return steps.every(s => !s.matchedFailurePattern);

    case 'last_step_pass':
      return !steps[steps.length - 1].matchedFailurePattern;

    case 'specific_steps':
      return steps
        .filter(s => workflow.critical_step_orders?.includes(s.step_order))
        .every(s => !s.matchedFailurePattern);
  }
}
```

## Implementation Priority Order

### Phase 1: Core Engine (Do This First)

**Priority 1A: Account Binding Strategies** ⭐⭐⭐
- Most critical for accurate IDOR testing
- Implement all 3 strategies: independent, per_account, anchor_attacker
- File: Update `execute-test` function
- Estimated effort: 4-6 hours

**Priority 1B: Enhanced Path Replacement** ⭐⭐⭐
- Required for real-world REST APIs
- Implement segment_index and regex modes
- File: Utility function `applyPathReplacement`
- Estimated effort: 2-3 hours

**Priority 1C: Form Body Support** ⭐⭐⭐
- Required for login/upload endpoints
- Implement form-urlencoded and multipart
- File: Utility functions for body handling
- Estimated effort: 3-4 hours

### Phase 2: Enhanced Detection (Do This Second)

**Priority 2A: Baseline Comparison** ⭐⭐
- Significantly improves accuracy
- Reduces false positives
- File: Update both execute functions
- Estimated effort: 4-5 hours

**Priority 2B: Workflow Assertion Strategies** ⭐⭐
- Critical for multi-step flows
- Implement all 4 strategies
- File: Update `execute-workflow` function
- Estimated effort: 2-3 hours

### Phase 3: Observability (Do This Third)

**Priority 3A: Account Traceability** ⭐
- Improves debugging and investigation
- Add to findings creation
- File: Both execute functions
- Estimated effort: 1-2 hours

**Priority 3B: UI Updates** ⭐
- Configuration panels for new options
- Findings display enhancements
- Files: Multiple UI components
- Estimated effort: 6-8 hours

## Testing Strategy

### Unit Tests

Create `supabase/functions/_shared/__tests__/`:

```typescript
// test-account-binding.test.ts
describe('Account Binding Strategies', () => {
  test('independent: generates cartesian product', () => {
    const combos = generateValueCombinations(
      [{ name: 'sessionId', data_source: 'account_field', account_field_name: 'session' }],
      [{ id: 'a', fields: { session: 'sess_a' }}, { id: 'b', fields: { session: 'sess_b' }}],
      [],
      [],
      'independent'
    );
    expect(combos).toHaveLength(2);
  });

  test('per_account: binds variables to same account', () => {
    const combos = generateValueCombinations(
      [
        { name: 'sessionId', data_source: 'account_field', account_field_name: 'session' },
        { name: 'userId', data_source: 'account_field', account_field_name: 'userId' }
      ],
      [
        { id: 'a', fields: { session: 'sess_a', userId: 'user_a' }},
        { id: 'b', fields: { session: 'sess_b', userId: 'user_b' }}
      ],
      [],
      [],
      'per_account'
    );
    expect(combos).toHaveLength(2);
    expect(combos[0].accountMap).toEqual({ sessionId: 'a', userId: 'a' });
    expect(combos[1].accountMap).toEqual({ sessionId: 'b', userId: 'b' });
  });

  test('anchor_attacker: fixes attacker vars, varies victim vars', () => {
    // Test implementation...
  });
});

// test-path-replacement.test.ts
describe('Path Replacement Modes', () => {
  test('placeholder mode', () => {
    const result = applyPathReplacement(
      '/user/{userId}/profile',
      { name: 'userId', path_replacement_mode: 'placeholder' },
      '123'
    );
    expect(result).toBe('/user/123/profile');
  });

  test('segment_index mode', () => {
    const result = applyPathReplacement(
      '/user/999/profile',
      { name: 'userId', path_replacement_mode: 'segment_index', path_segment_index: 2 },
      '123'
    );
    expect(result).toBe('/user/123/profile');
  });

  test('regex mode', () => {
    const result = applyPathReplacement(
      '/user/999/profile',
      { name: 'userId', path_replacement_mode: 'regex', path_regex_pattern: '\\d+' },
      '123'
    );
    expect(result).toBe('/user/123/profile');
  });
});
```

### Integration Tests

Create test scenarios:

```typescript
// integration-tests/idor-anchor-strategy.test.ts
describe('IDOR Testing with Anchor Strategy', () => {
  test('detects cross-account access with fixed attacker', async () => {
    // Setup: Create 3 test accounts
    const attacker = await createTestAccount({ username: 'attacker' });
    const victim1 = await createTestAccount({ username: 'victim1' });
    const victim2 = await createTestAccount({ username: 'victim2' });

    // Setup: Create API template with anchor strategy
    const template = await createApiTemplate({
      raw_request: `GET /user/{userId}/profile
Authorization: Bearer {token}`,
      variables: [
        { name: 'token', data_source: 'account_field', account_field_name: 'authToken', is_attacker_field: true },
        { name: 'userId', data_source: 'account_field', account_field_name: 'userId', is_attacker_field: false }
      ],
      account_binding_strategy: 'anchor_attacker',
      attacker_account_id: attacker.id,
      failure_patterns: [
        { type: 'http_status', operator: 'equals', value: '403' }
      ]
    });

    // Execute test
    const testRun = await executeTest({
      template_ids: [template.id],
      account_ids: [attacker.id, victim1.id, victim2.id],
      environment_id: testEnv.id
    });

    // Verify: Should generate 2 findings (attacker accessing victim1 and victim2)
    const findings = await getFindings(testRun.id);
    expect(findings).toHaveLength(2);
    expect(findings[0].attacker_account_id).toBe(attacker.id);
    expect(findings[0].victim_account_ids).toContain(victim1.id);
    expect(findings[1].victim_account_ids).toContain(victim2.id);
  });
});
```

## Common Pitfalls & Solutions

### Pitfall 1: Forgetting to handle missing attacker_account_id
```typescript
// BAD
const attacker = accounts.find(a => a.id === template.attacker_account_id);
const attackerSession = attacker.fields.session; // May crash if not found

// GOOD
if (template.account_binding_strategy === 'anchor_attacker' && !template.attacker_account_id) {
  throw new Error('anchor_attacker strategy requires attacker_account_id');
}
const attacker = accounts.find(a => a.id === template.attacker_account_id);
if (!attacker) {
  throw new Error(`Attacker account ${template.attacker_account_id} not found`);
}
```

### Pitfall 2: Not handling baseline failure gracefully
```typescript
// BAD
const baseline = await executeRequest(baselineReq);
// Continues even if baseline fails

// GOOD
const baseline = await executeRequest(baselineReq);
if (matchesFailurePatterns(baseline.response, template.failure_patterns)) {
  console.warn('Baseline request failed, skipping mutation test');
  continue; // Skip this combination
}
```

### Pitfall 3: Comparing entire response body as string
```typescript
// BAD - byte-level comparison includes timestamps, request IDs
const isDifferent = baseline.body !== mutated.body;

// GOOD - structured comparison with field filtering
const isDifferent = hasSignificantDiff(
  baseline.body,
  mutated.body,
  config.rules.ignore_fields,
  config.rules.critical_fields
);
```

## Performance Optimization

### Recommendation 1: Use per_account or anchor_attacker by default
```
Independent strategy with 10 accounts, 3 variables:
  10 × 10 × 10 = 1,000 combinations

Per-account strategy with 10 accounts, 3 variables:
  10 combinations (one per account)

Anchor strategy with 1 attacker + 9 victims, 3 variables:
  9 combinations (fixed attacker, 9 victims)

Reduction: 99% fewer requests!
```

### Recommendation 2: Limit baseline comparison to critical templates
```typescript
// Only enable baseline for high-value IDOR tests
const template = {
  name: 'Get User Profile',
  enable_baseline: true,  // Enable for IDOR tests

  // Disable for informational endpoints
  // enable_baseline: false (default)
};
```

### Recommendation 3: Use request pooling for workflows
```typescript
// Execute baseline workflow ONCE per attacker
// Then reuse baseline results for all victim combinations
const baselineCache = new Map<string, WorkflowExecution>();

for (const combo of combinations) {
  const cacheKey = JSON.stringify(combo.attackerValues);
  let baseline = baselineCache.get(cacheKey);

  if (!baseline) {
    baseline = await executeWorkflow(workflow, combo.attackerValues);
    baselineCache.set(cacheKey, baseline);
  }

  // Now execute mutated workflow with victim values
  const mutated = await executeWorkflow(workflow, combo.values);

  // Compare...
}
```

## Rollout Strategy

### Week 1: Core Features
- Deploy database migration ✅ (already done)
- Implement account binding strategies in execute-test
- Basic UI for selecting binding strategy

### Week 2: Enhanced Replacement
- Implement path replacement modes
- Implement form body support
- Add configuration UI for these features

### Week 3: Baseline & Assertions
- Implement baseline comparison
- Implement workflow assertion strategies
- Add comparison visualization in findings

### Week 4: Polish & Testing
- Account traceability UI
- Integration tests
- Performance testing
- Documentation

## Support & Troubleshooting

### Enable Debug Logging

In Edge Functions, add:

```typescript
const DEBUG = Deno.env.get('DEBUG') === 'true';

function debugLog(message: string, data?: any) {
  if (DEBUG) {
    console.log(`[DEBUG] ${message}`, data || '');
  }
}

// Usage
debugLog('Generated combinations', { count: combinations.length, strategy });
debugLog('Baseline response', baseline.response);
```

### Monitoring Key Metrics

Track these in production:

1. **Combination Count**: Monitor explosive growth
   - Alert if > 1000 combinations for single test

2. **Baseline Success Rate**: Track if baselines are failing
   - If < 80%, investigate test environment issues

3. **Finding False Positive Rate**: After triage
   - Target < 20% false positives

4. **Test Execution Time**: Monitor performance
   - Alert if > 5 minutes for single template test

## Conclusion

Follow this guide sequentially. Start with Phase 1 (Core Engine) as it provides the most value. Phase 2 and 3 can be implemented incrementally based on user feedback.

All changes are backward compatible - existing tests will continue to work with default settings.
