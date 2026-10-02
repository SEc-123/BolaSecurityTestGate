import test from "node:test";
import assert from "node:assert/strict";
import { createAgentToolRegistry } from "../../server/src/agent/index.ts";
import { AgentToolRegistry } from "../../server/src/agent/tool-registry.ts";
import { buildAutonomousAgentContext } from "../../server/src/agent/context-builder.ts";
import {
  buildModelContextScope,
  modelContextStageForTask,
  modelDecisionScopeError,
  projectContextForModel,
  selectModelVisibleTools,
} from "../../server/src/agent/model-context-profile.ts";
import { sanitizeForAIModel } from "../../server/src/agent/model-context-sanitizer.ts";
import { AIScanRepository } from "../../server/src/services/ai-scan/repository.ts";
import {
  newBusinessFlow,
  saveBusinessFlow,
} from "../../server/src/services/ai-scan/agent-business-contract.ts";
import { database } from "../mobile-closure/fixtures.mjs";

const registry = createAgentToolRegistry();
const tools = registry.list();
const task = (intent) => ({
  id: `task-${intent}`,
  task_type: "autonomous_agent_task",
  execution_plan: { intent },
});
const names = (stage) =>
  selectModelVisibleTools(tools, stage).map((tool) => tool.name);

test("normal-business stages receive only their persisted capability surface", () => {
  assert.equal(
    modelContextStageForTask(task("inventory_bstg_capabilities")),
    "capability_inventory",
  );
  assert.equal(
    modelContextStageForTask(task("discover_target")),
    "normal_discovery",
  );
  assert.equal(
    modelContextStageForTask(task("plan_business_flows")),
    "normal_business_planning",
  );
  assert.equal(
    modelContextStageForTask(task("learn_business_flow")),
    "normal_business_learning",
  );
  assert.equal(
    modelContextStageForTask(task("review_business_flows")),
    "normal_business_review",
  );
  assert.equal(
    modelContextStageForTask(task("model_business_experiment")),
    "security_experiment",
  );

  assert.deepEqual(names("capability_inventory"), [
    "bstg.capabilities.inventory",
  ]);
  assert.deepEqual(
    buildModelContextScope({
      task: task("inventory_bstg_capabilities"),
      scanConfig: { authorization_acknowledged: true },
      tools,
    }).allowed_actions,
    ["tool_call", "complete_task"],
    "inventory availability must come from its persisted native tool rather than a free-form model block",
  );
  const discovery = names("normal_discovery");
  assert.ok(
    discovery.includes("browser.navigate") &&
      discovery.includes("browser.discover_target"),
  );
  for (const hidden of [
    "bstg.generic_vuln.run_test",
    "bstg.payload.plan",
    "bstg.test_plan.create",
    "vuln.generate_candidates",
  ])
    assert.ok(
      !discovery.includes(hidden),
      `${hidden} must not enter normal discovery`,
    );

  const planning = names("normal_business_planning");
  assert.ok(
    planning.includes("bstg.business.coverage.save") &&
      planning.includes("bstg.business.flow.define"),
  );
  for (const hidden of [
    "bstg.generic_vuln.run_test",
    "bstg.test_plan.execute",
    "bstg.payload.plan",
  ])
    assert.ok(
      !planning.includes(hidden),
      `${hidden} must not enter normal planning`,
    );

  const learning = names("normal_business_learning");
  assert.ok(
    learning.includes("bstg.business.capture.start") &&
      learning.includes("bstg.identity.apply_login") &&
      learning.includes("bstg.business.workflow.validate") &&
      learning.includes("bstg.business.workflow.repair") &&
      learning.includes("bstg.business.workflow.revise") &&
      learning.includes("bstg.business.flow.block"),
  );
  const businessPrepare = tools.find(
    (tool) => tool.name === "bstg.business.workflow.prepare",
  );
  const nativePrepare = tools.find(
    (tool) => tool.name === "bstg.workflow.prepare",
  );
  assert.ok(
    businessPrepare?.input_schema.required.includes("event_ids"),
    "Normal model workflow compilation requires explicit inspected event IDs.",
  );
  assert.ok(
    nativePrepare?.input_schema.required.includes("event_ids"),
    "The native-asset compatibility route cannot bypass explicit event selection.",
  );
  for (const hidden of [
    "bstg.generic_vuln.run_test",
    "bstg.test_plan.create",
    "vuln.generate_candidates",
  ])
    assert.ok(
      !learning.includes(hidden),
      `${hidden} must not enter normal learning`,
    );
  const review = names("normal_business_review");
  assert.ok(
    review.includes("bstg.business.flow.inspect"),
    "review can inspect persisted normal-flow evidence",
  );
  assert.ok(
    !review.includes("bstg.business.workflow.inspect"),
    "review never receives a task-owned workflow tool it cannot legally invoke",
  );
  assert.ok(
    !names("security_experiment").includes("bstg.identity.apply_login"),
    "prepared browser login remains a normal-learning capability only",
  );

  const experiment = names("security_experiment");
  assert.ok(
    experiment.includes("bstg.test_plan.create") &&
      experiment.includes("bstg.test_plan.assess"),
  );
  assert.ok(
    !experiment.includes("bstg.generic_vuln.run_test"),
    "business experiment must not receive unrelated generic runner",
  );
});

test("normal-stage model projection withholds broader assessment inputs while retaining business evidence", () => {
  const originalGoal =
    "OPERATOR_BROADER_OBJECTIVE: investigate all security weaknesses";
  const visible = selectModelVisibleTools(tools, "normal_business_planning");
  const scope = buildModelContextScope({
    task: task("plan_business_flows"),
    scanConfig: {
      authorization_acknowledged: true,
      account_mode: "manual",
      accounts: { tester: { password: "PRIVATE" } },
    },
    tools,
  });
  const context = {
    scan: {
      id: "scan",
      base_url: "http://127.0.0.1:9999",
      status: "running",
      current_phase: "normal",
      user_prompt: originalGoal,
      scan_config: {
        authorization_acknowledged: true,
        account_mode: "manual",
        accounts: { tester: { password: "PRIVATE" } },
        max_pages: 12,
        business_learning: {
          normal_objectives: [
            "Update the signed-in profile display name",
            "Create a private note and verify its saved state",
          ],
        },
      },
    },
    task: {
      ...task("plan_business_flows"),
      title: "Plan observed normal flows",
      agent_goal: "Original broad task text",
      decision_budget: { remaining: 5 },
    },
    selected_vuln_types: ["bola_idor", "xss"],
    available_tools: visible,
    relevant_endpoints: [
      { id: "endpoint-1", path: "/profile", method: "POST" },
    ],
    endpoint_inventory_summary: { total: 1 },
    feature_tree: [{ id: "profile", name: "Profile" }],
    vulnerability_candidates: [{ id: "candidate", title: "Candidate" }],
    task_artifacts: [{ id: "business-evidence", type: "browser_state" }],
    task_tool_invocations: [],
    global_recent_artifacts: [{ id: "risk-artifact" }],
    shared_resources: [{ id: "payload-resource" }],
    shared_resource_summary: { total: 1 },
    relevant_memories: [{ id: "risk-memory" }],
    memory_summary: { total: 1 },
    browser_context_summary: {
      active: 1,
      contexts: [{ identity_key: "tester" }],
    },
    planner_state: {},
    recent_tasks: [
      { id: "task-plan_business_flows", title: "Plan observed normal flows" },
      { id: "risk-task", title: "Risk task" },
    ],
    operating_rules: ["broad rule"],
    business_flows: [{ id: "flow", name: "Profile save" }],
  };
  const projected = projectContextForModel(context, scope);
  const wire = JSON.stringify(projected);
  assert.equal(projected.model_scope.stage, "normal_business_planning");
  assert.equal(projected.model_scope.authorization, "acknowledged");
  assert.deepEqual(
    projected.model_scope.allowed_actions,
    ["tool_call", "complete_task"],
    "planning may not end through a free-form block/fail/wait/child-task declaration",
  );
  assert.deepEqual(projected.selected_vuln_types, []);
  assert.deepEqual(projected.vulnerability_candidates, []);
  assert.deepEqual(projected.global_recent_artifacts, []);
  assert.deepEqual(projected.shared_resources, []);
  assert.deepEqual(projected.relevant_memories, []);
  assert.ok(
    projected.recent_tasks.every(
      (item) => item.id === "task-plan_business_flows",
    ),
  );
  assert.ok(!wire.includes(originalGoal));
  assert.ok(!wire.includes("PRIVATE"));
  assert.ok(
    wire.includes("Profile save"),
    "current normal-flow evidence remains available",
  );
  assert.ok(
    !projected.available_tools.some(
      (tool) => tool.name === "bstg.generic_vuln.run_test",
    ),
  );
  assert.ok(
    projected.operating_rules.some(
      (rule) =>
        rule.includes("role is an executable identity key") &&
        rule.includes("display label"),
    ),
    "normal-business model context must distinguish canonical identity keys from display labels",
  );
  assert.ok(
    projected.operating_rules.some(
      (rule) => rule.includes("assertion_paths") && rule.includes("bare body"),
    ),
    "normal-business model context must explain the executable assertion-path contract before native validation",
  );
  assert.deepEqual(
    projected.scan.scan_config.normal_business_objectives,
    [
      "Update the signed-in profile display name",
      "Create a private note and verify its saved state",
    ],
    "explicit normal outcomes remain available without exposing the broader security goal",
  );
  assert.ok(
    projected.operating_rules.some(
      (rule) =>
        rule.includes("normal_business_objectives") &&
        rule.includes("coverage requirement"),
    ),
    "the model must be told that declared normal outcomes cannot be silently skipped",
  );
  assert.ok(
    projected.operating_rules.some(
      (rule) =>
        rule.includes('JSON action "tool_call"') &&
        rule.includes("coverage.save"),
    ),
    "planning context must explain that JSON tool_call is its executable dispatch protocol",
  );
  assert.deepEqual(
    projected.scan.scan_config.available_execution_identities,
    [{ identity_key: "tester", prepared: true, session_available: true }],
    "normal-stage model context carries only safe executable identity facts",
  );
  assert.equal(
    JSON.stringify(projected.scan.scan_config).includes("PRIVATE"),
    false,
    "identity roster never carries credential material",
  );
  assert.equal(
    context.scan.user_prompt,
    originalGoal,
    "projection cannot mutate canonical context",
  );
  assert.deepEqual(context.selected_vuln_types, ["bola_idor", "xss"]);
});

test("normal business planning rejects free-form terminal actions while retaining its executable tools", () => {
  const scope = buildModelContextScope({
    task: task("plan_business_flows"),
    scanConfig: { authorization_acknowledged: true },
    tools,
  });
  assert.ok(
    scope.allowed_tool_names.includes("bstg.business.coverage.inspect"),
  );
  assert.ok(scope.allowed_tool_names.includes("bstg.business.coverage.save"));
  assert.ok(scope.allowed_tool_names.includes("bstg.business.flow.define"));
  assert.deepEqual(scope.allowed_actions, ["tool_call", "complete_task"]);
  for (const action of [
    "block_task",
    "fail_task",
    "wait_for_user_selection",
    "create_child_tasks",
  ]) {
    assert.match(
      modelDecisionScopeError({ action }, scope),
      /JSON tool_call protocol/i,
      `${action} must be a recoverable planning-protocol rejection`,
    );
  }
  assert.equal(
    modelDecisionScopeError(
      { action: "tool_call", tool_name: "bstg.business.coverage.inspect" },
      scope,
    ),
    undefined,
  );
});

test("a model proposal outside its stage is rejected before any handler can run", async (t) => {
  const db = await database();
  t.after(() => db.disconnect());
  const calls = [];
  const local = new AgentToolRegistry();
  local.register({
    name: "hidden.tool",
    description: "must remain unavailable",
    input_schema: {},
    handler: async () => {
      calls.push("called");
      return { ok: true };
    },
  });
  const scope = buildModelContextScope({
    task: task("discover_target"),
    scanConfig: { authorization_acknowledged: true },
    tools,
  });
  assert.match(
    modelDecisionScopeError(
      { action: "tool_call", tool_name: "hidden.tool" },
      scope,
    ),
    /outside the persisted model context stage/,
  );
  assert.match(
    modelDecisionScopeError({ action: "create_child_tasks" }, scope),
    /not permitted/,
  );
  assert.equal(
    modelDecisionScopeError(
      { action: "tool_call", tool_name: "browser.navigate" },
      scope,
    ),
    undefined,
  );
  const repo = { createToolInvocation: async (record) => calls.push(record) };
  await assert.rejects(
    local.call(
      "hidden.tool",
      {},
      {
        db,
        repo,
        scanRunId: "scan",
        taskId: "task",
        allowed_tool_names: scope.allowed_tool_names,
      },
    ),
    /not available in the current task stage/,
  );
  assert.deepEqual(calls, [
    {
      scan_run_id: "scan",
      task_id: "task",
      tool_name: "hidden.tool",
      input_json: {},
      output_json: {},
      status: "failed",
      error_message:
        "Tool hidden.tool is not available in the current task stage.",
      started_at: calls[0].started_at,
      completed_at: calls[0].completed_at,
    },
  ]);
});

test("business capture dispatch persists strict opaque candidate references without captured values", async (t) => {
  const db = await database();
  t.after(() => db.disconnect());
  const persisted = [];
  const local = new AgentToolRegistry();
  local.register({
    name: "bstg.business.capture.inspect",
    description: "test strict capture projection",
    input_schema: {},
    handler: async () => ({
      ok: true,
      data: {
        recording_session_id: "recording-strict",
        objective_operation: {
          operation_id: "operation:0123456789abcdef01234567",
          side_effect_class: "create",
          operation_candidate_event_ids: ["event-operation"],
        },
        objective_completion: {
          completion_candidate_event_ids: ["event-completion"],
        },
        events: [
          {
            event_id: "event-operation",
            response: { body: "PRIVATE_CAPTURE_VALUE" },
          },
        ],
      },
    }),
  });
  await local.call(
    "bstg.business.capture.inspect",
    { recording_session_id: "recording-strict" },
    {
      db,
      repo: { createToolInvocation: async (record) => persisted.push(record) },
      scanRunId: "scan",
      taskId: "task",
    },
  );
  assert.equal(persisted.length, 1);
  assert.deepEqual(
    persisted[0].output_json.objective_operation
      .operation_candidate_event_ids,
    ["event-operation"],
  );
  assert.deepEqual(
    persisted[0].output_json.objective_completion
      .completion_candidate_event_ids,
    ["event-completion"],
  );
  assert.equal(
    JSON.stringify(persisted[0].output_json).includes("PRIVATE_CAPTURE_VALUE"),
    false,
    "candidate graph references survive the audit projection, while capture scalars do not",
  );
});

test("normal business learning rejects bare model blocks and exposes only the evidenced Flow blocker route", () => {
  const scope = buildModelContextScope({
    task: task("learn_business_flow"),
    scanConfig: { authorization_acknowledged: true },
    tools,
  });
  assert.ok(scope.allowed_tool_names.includes("bstg.business.flow.block"));
  assert.ok(scope.allowed_tool_names.includes("bstg.business.workflow.repair"));
  assert.ok(scope.allowed_tool_names.includes("bstg.business.workflow.revise"));
  assert.ok(!scope.allowed_actions.includes("block_task"));
  assert.ok(!scope.allowed_actions.includes("fail_task"));
  assert.ok(!scope.allowed_actions.includes("wait_for_user_selection"));
  assert.ok(!scope.allowed_actions.includes("create_child_tasks"));
  assert.match(
    modelDecisionScopeError({ action: "block_task" }, scope),
    /cannot end with block_task/i,
  );
  assert.match(
    modelDecisionScopeError({ action: "fail_task" }, scope),
    /cannot end with fail_task/i,
  );
  assert.equal(
    modelDecisionScopeError(
      { action: "tool_call", tool_name: "bstg.business.flow.block" },
      scope,
    ),
    undefined,
  );
  assert.equal(
    modelDecisionScopeError(
      { action: "tool_call", tool_name: "bstg.business.workflow.repair" },
      scope,
    ),
    undefined,
  );
  assert.equal(
    modelDecisionScopeError(
      { action: "tool_call", tool_name: "bstg.business.workflow.revise" },
      scope,
    ),
    undefined,
  );
});

test("normal business learning keeps current executable evidence while bounding historical recorder context", () => {
  const learningTask = {
    ...task("learn_business_flow"),
    id: "learning-task",
    execution_plan: { intent: "learn_business_flow", flow_id: "current-flow" },
  };
  const scope = buildModelContextScope({
    task: learningTask,
    scanConfig: { authorization_acknowledged: true },
    tools,
  });
  const historicalSnapshot = "x".repeat(24000);
  const taskToolInvocations = Array.from({ length: 32 }, (_, index) => ({
    id: `invocation-${index}`,
    tool_name:
      index === 30
        ? "bstg.business.workflow.inspect"
        : index === 31
          ? "bstg.business.workflow.validate"
          : index === 1
            ? "bstg.business.capture.inspect"
            : index === 0
              ? "bstg.business.capture.start"
              : "browser.interact",
    status: "completed",
    input_json: {
      recording_session_id: "recording-current",
      historicalSnapshot,
    },
    output_summary: "normal business observation " + historicalSnapshot,
    output_json:
      index === 1
        ? {
            recording_session_id: "recording-current",
            status: "recording",
            event_count: 2,
            objective_operation: {
              operation_id: "operation:0123456789abcdef01234567",
              side_effect_class: "create",
              operation_candidate_event_ids: [],
            },
            events: [
              {
                event_id: "opaque-event",
                semantic_body_path_available: false,
                response_body: "PRIVATE_CAPTURE_VALUE",
              },
            ],
            historicalSnapshot,
          }
        : index === 30
          ? {
              workflow_id: "workflow-current",
              test_run_id: "run-current",
              assertion_paths: ["status", "body.saved", "body.owner"],
              controls: [
                {
                  selector: 'button[data-testid="save-profile"]',
                  label: "Save profile",
                },
              ],
              historicalSnapshot,
            }
          : index === 31
            ? {
                flow_id: "current-flow",
                workflow_id: "workflow-current",
                test_run_id: "run-current",
                verified: false,
                objective_completion_assertion_requirements: [
                  {
                    source_step_order: 3,
                    required_response_path: "body.order_id",
                    allowed_assertion_purposes: ["goal", "state"],
                  },
                ],
                execution: {
                  success: false,
                  has_execution_error: true,
                  errors_count: 1,
                  execution_failures: [
                    {
                      step_order: 3,
                      status: 409,
                      error_kind: "non_success_response",
                    },
                  ],
                  diagnostic: "PRIVATE_NATIVE_DIAGNOSTIC",
                },
                historicalSnapshot,
              }
            : {
                recording_session_id: "recording-current",
                context_key: "identity:tester",
                historicalSnapshot,
              },
  }));
  const context = {
    scan: {
      id: "scan",
      base_url: "https://authorized.example.test",
      status: "running",
      current_phase: "normal",
      user_prompt: "normal stage",
      scan_config: { authorization_acknowledged: true },
    },
    task: learningTask,
    selected_vuln_types: [],
    available_tools: selectModelVisibleTools(tools, "normal_business_learning"),
    relevant_endpoints: [],
    endpoint_inventory_summary: { total: 0 },
    feature_tree: [],
    vulnerability_candidates: [],
    task_artifacts: [
      {
        id: "decision-artifact",
        type: "agent_decision",
        content_json: { historicalSnapshot },
      },
      {
        id: "validation-artifact",
        type: "business_workflow_validation",
        content_json: {
          flow_id: "current-flow",
          workflow_id: "workflow-current",
          test_run_id: "run-current",
          assertions_verified: false,
          execution: {
            success: false,
            has_execution_error: true,
            errors_count: 1,
            execution_failures: [
              {
                step_order: 3,
                status: 409,
                error_kind: "non_success_response",
              },
            ],
            diagnostic: "PRIVATE_NATIVE_DIAGNOSTIC",
          },
          trace: {
            records: [
              {
                step_order: 3,
                status: 409,
                diagnostic: "PRIVATE_NATIVE_DIAGNOSTIC",
                response_body: "PRIVATE_NATIVE_VALUE",
              },
            ],
          },
          historicalSnapshot,
        },
      },
      {
        id: "trace-artifact",
        type: "business_native_trace",
        content_json: {
          flow_id: "current-flow",
          workflow_id: "workflow-current",
          test_run_id: "run-current",
          historicalSnapshot,
        },
      },
      {
        id: "revision-artifact",
        type: "business_workflow_revision",
        content_json: {
          flow_id: "current-flow",
          previous_workflow_id: "workflow-older",
          previous_test_run_id: "run-older",
          workflow_id: "workflow-current",
          effective_event_ids: ["event-1", "event-2"],
          selection_origin: "model_explicit_observed_event_ids",
          historicalSnapshot,
        },
      },
    ],
    task_tool_invocations: taskToolInvocations,
    global_recent_artifacts: [],
    shared_resources: [],
    shared_resource_summary: { total: 0 },
    relevant_memories: [],
    memory_summary: { total: 0 },
    browser_context_summary: {
      active: 1,
      contexts: [{ identity_key: "tester" }],
    },
    planner_state: {},
    recent_tasks: [{ id: "learning-task", title: "Current normal flow" }],
    operating_rules: ["normal rule"],
    business_flows: [
      {
        id: "current-flow",
        name: "Save profile",
        goal: "The supplied identity sees the saved profile",
        role: "tester",
        status: "learning",
        workflow_id: "workflow-current",
        normal_run_id: "run-current",
        steps: [{ id: "step-1", description: "Save profile" }],
        assertions: [{ id: "assertion-1", description: "Saved state" }],
      },
      {
        id: "unrelated-flow",
        name: "Unrelated",
        goal: "Unrelated goal",
        status: "learning",
      },
    ],
  };
  const projected = projectContextForModel(context, scope);
  const wire = JSON.stringify(projected);
  assert.ok(
    wire.length < 70000,
    `normal-learning provider envelope unexpectedly grew to ${wire.length} characters`,
  );
  assert.ok(
    projected.task_tool_invocations.length < 20,
    "the provider receives recent turns plus lifecycle transitions, not every historical snapshot",
  );
  assert.equal(
    projected.lifecycle_tool_invocations.length,
    32,
    "the server-side lifecycle guard retains the complete bounded task history",
  );
  const captureInspection = projected.task_tool_invocations.find(
    (item) => item.tool_name === "bstg.business.capture.inspect",
  );
  assert.equal(
    captureInspection?.output_json.event_count,
    2,
    "the latest active capture inventory survives a long interaction history",
  );
  assert.deepEqual(
    captureInspection?.output_json.objective_operation
      ?.operation_candidate_event_ids,
    [],
  );
  assert.equal(
    JSON.stringify(captureInspection).includes("PRIVATE_CAPTURE_VALUE"),
    false,
    "retained capture inspection remains value-free",
  );
  const inspection = projected.task_tool_invocations.find(
    (item) => item.tool_name === "bstg.business.workflow.inspect",
  );
  assert.equal(inspection.output_json.workflow_id, "workflow-current");
  assert.deepEqual(inspection.output_json.assertion_paths, [
    "status",
    "body.saved",
    "body.owner",
  ]);
  assert.equal(
    inspection.output_json.controls[0].selector,
    'button[data-testid="save-profile"]',
    "the current observed selector remains usable",
  );
  const validationInvocation = projected.task_tool_invocations.find(
    (item) => item.tool_name === "bstg.business.workflow.validate",
  );
  assert.deepEqual(
    validationInvocation?.output_json.execution.execution_failures,
    [{ step_order: 3, status: 409, error_kind: "non_success_response" }],
    "The provider receives value-free native step failure facts needed for a model-selected Workflow revision.",
  );
  assert.deepEqual(
    validationInvocation?.output_json
      .objective_completion_assertion_requirements,
    [
      {
        source_step_order: 3,
        required_response_path: "body.order_id",
        allowed_assertion_purposes: ["goal", "state"],
      },
    ],
    "the model receives the exact value-free final-outcome correction contract rather than a generic rejection",
  );
  const validationArtifact = projected.task_artifacts.find(
    (artifact) => artifact.id === "validation-artifact",
  );
  assert.deepEqual(
    validationArtifact?.content_json.execution.execution_failures,
    [{ step_order: 3, status: 409, error_kind: "non_success_response" }],
  );
  assert.equal(
    JSON.stringify(validationArtifact).includes("PRIVATE_NATIVE_DIAGNOSTIC"),
    false,
  );
  assert.equal(
    JSON.stringify(validationArtifact).includes("PRIVATE_NATIVE_VALUE"),
    false,
  );
  assert.equal(
    validationArtifact?.content_json.trace,
    "[Private evidence retained in the originating record]",
  );
  assert.deepEqual(
    projected.business_flows.map((flow) => flow.id),
    ["current-flow"],
    "a normal learner sees only its current Flow",
  );
  assert.equal(
    projected.task_artifacts.some(
      (artifact) => artifact.id === "decision-artifact",
    ),
    false,
    "duplicated planner artifacts do not consume the normal-learning transport budget",
  );
  assert.equal(
    projected.task_artifacts[0].content_json.workflow_id,
    "workflow-current",
    "current native validation provenance remains available",
  );
  const revision = projected.task_artifacts.find(
    (artifact) => artifact.id === "revision-artifact",
  );
  assert.deepEqual(
    revision?.content_json.effective_event_ids,
    ["event-1", "event-2"],
    "model-visible lifecycle context retains opaque event references for an explicit revision, never raw recording payloads",
  );
});

test("canonical strict capture evidence retains opaque operation and completion candidate IDs", async (t) => {
  const db = await database();
  t.after(() => db.disconnect());
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({
    base_url: "https://authorized.example.test",
    scan_config: { authorization_acknowledged: true },
  });
  const learningTask = await repo.createTask({
    scan_run_id: run.id,
    title: "Retain strict capture candidates",
    task_type: "learn_business_flow",
    execution_plan: { intent: "learn_business_flow", flow_id: "pending" },
  });
  const flow = newBusinessFlow(
    {
      name: "Create one record",
      goal: "A normal create operation has captured semantic evidence.",
      role: "anonymous",
    },
    learningTask.id,
  );
  flow.status = "learning";
  flow.recording_session_id = "recording-strict-candidates";
  flow.objective_operation = {
    operation_id: "operation:0123456789abcdef01234567",
    side_effect_class: "create",
  };
  flow.objective_completion = {
    required_response_paths: ["body.record_id"],
  };
  await saveBusinessFlow(repo, run.id, learningTask.id, flow);
  await repo.updateTask(learningTask.id, {
    execution_plan: { intent: "learn_business_flow", flow_id: flow.id },
  });
  await repo.createToolInvocation({
    scan_run_id: run.id,
    task_id: learningTask.id,
    tool_name: "bstg.business.capture.inspect",
    status: "completed",
    output_json: {
      recording_session_id: flow.recording_session_id,
      status: "recording",
      event_count: 2,
      objective_operation: {
        operation_id: flow.objective_operation.operation_id,
        side_effect_class: "create",
        operation_candidate_event_ids: ["event-operation"],
      },
      objective_completion: {
        completion_candidate_event_ids: ["event-completion"],
      },
      events: [
        {
          event_id: "event-operation",
          action_id: "action-operation",
          semantic_body_path_available: true,
          response_body: "PRIVATE_CAPTURE_VALUE",
        },
        {
          event_id: "event-completion",
          action_id: "action-completion",
          semantic_body_path_available: true,
          response_body: "PRIVATE_COMPLETION_VALUE",
        },
      ],
    },
  });
  const currentTask = await repo.getTask(learningTask.id);
  const scope = buildModelContextScope({
    task: currentTask,
    scanConfig: run.scan_config,
    tools,
  });
  const canonical = await buildAutonomousAgentContext({
    repo,
    scanRunId: run.id,
    task: currentTask,
    tools: selectModelVisibleTools(tools, scope.stage),
  });
  const projected = projectContextForModel(canonical, scope);
  const inspect = (invocations) =>
    invocations.find(
      (invocation) =>
        invocation.tool_name === "bstg.business.capture.inspect" &&
        invocation.status === "completed",
    );
  for (const evidence of [
    inspect(canonical.task_tool_invocations),
    inspect(projected.lifecycle_tool_invocations),
    inspect(projected.task_tool_invocations),
  ]) {
    assert.deepEqual(
      evidence?.output_json?.objective_operation?.operation_candidate_event_ids,
      ["event-operation"],
    );
    assert.deepEqual(
      evidence?.output_json?.objective_completion?.completion_candidate_event_ids,
      ["event-completion"],
    );
  }
  const wire = JSON.stringify(projected);
  assert.equal(wire.includes("PRIVATE_CAPTURE_VALUE"), false);
  assert.equal(wire.includes("PRIVATE_COMPLETION_VALUE"), false);
});

test("normal-learning retains an old strict capture receipt locally and projects only its current transition", async (t) => {
  const db = await database();
  t.after(() => db.disconnect());
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({
    base_url: "https://authorized.example.test",
    scan_config: { authorization_acknowledged: true },
  });
  const learningTask = await repo.createTask({
    scan_run_id: run.id,
    title: "Long normal-learning lifecycle",
    task_type: "learn_business_flow",
    execution_plan: { intent: "learn_business_flow", flow_id: "long-flow" },
  });
  await repo.createToolInvocation({
    scan_run_id: run.id,
    task_id: learningTask.id,
    tool_name: "bstg.business.capture.start",
    status: "completed",
    output_json: {
      recording_session_id: "recording-long",
      capture_status: "recording",
    },
  });
  await repo.createToolInvocation({
    scan_run_id: run.id,
    task_id: learningTask.id,
    tool_name: "bstg.business.capture.inspect",
    status: "completed",
    output_json: {
      recording_session_id: "recording-long",
      status: "recording",
      event_count: 2,
      objective_operation: {
        operation_id: "operation:0123456789abcdef01234567",
        side_effect_class: "create",
        operation_candidate_event_ids: ["event-operation"],
      },
      events: [
        {
          event_id: "event-operation",
          response: { body: "PRIVATE_CAPTURE_VALUE" },
        },
      ],
    },
  });
  for (let index = 0; index < 65; index += 1) {
    await repo.createToolInvocation({
      scan_run_id: run.id,
      task_id: learningTask.id,
      tool_name: "browser.interact",
      status: "completed",
      input_json: { operation: { action: "observe" } },
      output_json: { ok: true },
    });
  }
  const currentTask = await repo.getTask(learningTask.id);
  const scope = buildModelContextScope({
    task: currentTask,
    scanConfig: run.scan_config,
    tools,
  });
  const canonical = await buildAutonomousAgentContext({
    repo,
    scanRunId: run.id,
    task: currentTask,
    tools: selectModelVisibleTools(tools, scope.stage),
  });
  assert.equal(canonical.task_tool_invocations.length, 64);
  assert.equal(
    canonical.task_tool_invocations.some(
      (invocation) =>
        invocation.tool_name === "bstg.business.capture.inspect",
    ),
    false,
    "the transport-sized task window no longer contains the old strict receipt",
  );
  assert.equal(
    canonical.lifecycle_tool_invocations.length,
    67,
    "local guards retain the full safely compacted task lifecycle",
  );
  assert.equal(
    Object.keys(canonical).includes("lifecycle_tool_invocations"),
    false,
    "the full lifecycle is non-enumerable before model projection",
  );
  const projected = projectContextForModel(canonical, scope);
  const strictInspection = projected.task_tool_invocations.find(
    (invocation) =>
      invocation.tool_name === "bstg.business.capture.inspect",
  );
  assert.deepEqual(
    strictInspection?.output_json?.objective_operation
      ?.operation_candidate_event_ids,
    ["event-operation"],
    "the provider receives the newest strict inspection even after more than 64 later UI turns",
  );
  assert.equal(
    JSON.stringify(projected).includes("PRIVATE_CAPTURE_VALUE"),
    false,
  );
  assert.equal(
    JSON.stringify(projected).includes("lifecycle_tool_invocations"),
    false,
    "the complete local history never enters the provider envelope",
  );
});

test("normal-learning model projection retains opaque retry proof mappings without captured values", () => {
  const learningTask = {
    ...task("learn_business_flow"),
    id: "retry-learning-task",
    execution_plan: {
      intent: "learn_business_flow",
      flow_id: "retry-flow",
      coverage_retry: {
        targets: [
          {
            key: "operation:target-a",
            target_type: "operation",
            target_id: "target-a",
          },
          {
            key: "feature:target-b",
            target_type: "feature",
            target_id: "target-b",
          },
        ],
      },
    },
  };
  const scope = buildModelContextScope({
    task: learningTask,
    scanConfig: { authorization_acknowledged: true },
    tools,
  });
  const context = {
    scan: {
      id: "retry-scan",
      base_url: "https://authorized.example.test",
      status: "running",
      current_phase: "normal",
      user_prompt: "normal stage",
      scan_config: { authorization_acknowledged: true },
    },
    task: learningTask,
    selected_vuln_types: [],
    available_tools: selectModelVisibleTools(tools, "normal_business_learning"),
    relevant_endpoints: [],
    endpoint_inventory_summary: { total: 0 },
    feature_tree: [],
    vulnerability_candidates: [],
    task_artifacts: [],
    task_tool_invocations: [
      {
        id: "retry-capture-inspect",
        tool_name: "bstg.business.capture.inspect",
        status: "completed",
        input_json: { recording_session_id: "retry-recording" },
        output_json: {
          recording_session_id: "retry-recording",
          status: "recording",
          retry_target_event_candidates: [
            {
              target_type: "operation",
              target_id: "target-a",
              event_ids: ["event-a"],
            },
            {
              target_type: "feature",
              target_id: "target-b",
              event_ids: ["event-b"],
            },
          ],
        },
      },
      {
        id: "retry-workflow-inspect",
        tool_name: "bstg.business.workflow.inspect",
        status: "completed",
        input_json: { workflow_id: "retry-workflow" },
        output_json: {
          flow_id: "retry-flow",
          workflow_id: "retry-workflow",
          recording_session_id: "retry-recording",
          steps: [
            {
              step_id: "step-a",
              step_order: 3,
              assertion_paths: [{ path: "body.state", semantic: true }],
            },
          ],
          retry_target_assertion_requirements: [
            {
              target_type: "operation",
              target_id: "target-a",
              source_step_orders: [3],
              semantic_body_assertion_required: true,
            },
            {
              target_type: "feature",
              target_id: "target-b",
              source_step_orders: [5, 7],
              semantic_body_assertion_required: true,
            },
          ],
        },
      },
      {
        id: "semantic-selection",
        tool_name: "bstg.business.workflow.prepare",
        status: "failed",
        input_json: {
          recording_session_id: "retry-recording",
          event_ids: ["context-event"],
        },
        output_json: {
          status: "semantic_body_candidate_required",
          retryable: true,
          candidate_event_ids: ["semantic-event"],
          candidate_event_count: 1,
        },
      },
    ],
    global_recent_artifacts: [],
    shared_resources: [],
    shared_resource_summary: { total: 0 },
    relevant_memories: [],
    memory_summary: { total: 0 },
    browser_context_summary: {
      active: 1,
      contexts: [{ identity_key: "anonymous" }],
    },
    planner_state: {},
    recent_tasks: [{ id: "retry-learning-task", title: "Retry flow" }],
    operating_rules: [],
    business_flows: [
      {
        id: "retry-flow",
        name: "Retry normal flow",
        goal: "Each scheduled target is proven",
        role: "anonymous",
        status: "learning",
      },
    ],
  };
  const projected = sanitizeForAIModel(projectContextForModel(context, scope));
  const capture = projected.task_tool_invocations.find(
    (item) => item.tool_name === "bstg.business.capture.inspect",
  );
  const workflow = projected.task_tool_invocations.find(
    (item) => item.tool_name === "bstg.business.workflow.inspect",
  );
  const semanticSelection = projected.task_tool_invocations.find(
    (item) => item.tool_name === "bstg.business.workflow.prepare",
  );
  assert.deepEqual(
    capture?.output_json.retry_target_event_candidates,
    [
      {
        target_type: "operation",
        target_id: "target-a",
        event_ids: ["event-a"],
      },
      { target_type: "feature", target_id: "target-b", event_ids: ["event-b"] },
    ],
    "capture inspection keeps only opaque target/event references for model-selected Workflow assembly",
  );
  assert.deepEqual(
    workflow?.output_json.retry_target_assertion_requirements,
    [
      {
        target_type: "operation",
        target_id: "target-a",
        source_step_orders: [3],
        semantic_body_assertion_required: true,
      },
      {
        target_type: "feature",
        target_id: "target-b",
        source_step_orders: [5, 7],
        semantic_body_assertion_required: true,
      },
    ],
    "workflow inspection keeps the target-to-source-step proof contract needed for model-selected assertions",
  );
  assert.deepEqual(
    semanticSelection?.output_json,
    {
      status: "semantic_body_candidate_required",
      retryable: true,
      candidate_event_ids: ["semantic-event"],
      candidate_event_count: 1,
    },
    "semantic-selection correction retains only opaque candidate IDs and counts so the next model turn can choose a corrected subset",
  );
});

test("strict operation matcher stays private while the model receives only its opaque effect contract", () => {
  const operation = {
    operation_id: "operation:0123456789abcdef01234567",
    method: "POST",
    route_shape: "/private/write-target",
    side_effect_class: "create",
  };
  const scopedTask = {
    ...task("plan_business_flows"),
    execution_plan: {
      intent: "plan_business_flows",
      strict_normal_objectives: true,
      normal_objective_manifest: [
        {
          id: "objective:0123456789abcdef01234567",
          label: "Create private record",
          operation,
        },
      ],
    },
  };
  const scope = buildModelContextScope({
    task: scopedTask,
    scanConfig: { authorization_acknowledged: true },
    tools,
  });
  const context = {
    scan: {
      id: "scan",
      base_url: "https://example.test",
      status: "running",
      scan_config: { authorization_acknowledged: true },
      user_prompt: "bounded",
    },
    task: scopedTask,
    selected_vuln_types: [],
    available_tools: selectModelVisibleTools(tools, "normal_business_planning"),
    relevant_endpoints: [],
    endpoint_inventory_summary: {},
    feature_tree: [],
    vulnerability_candidates: [],
    task_artifacts: [],
    task_tool_invocations: [],
    global_recent_artifacts: [],
    shared_resources: [],
    shared_resource_summary: {},
    relevant_memories: [],
    memory_summary: {},
    browser_context_summary: { contexts: [] },
    planner_state: {},
    recent_tasks: [],
    operating_rules: [],
    business_flows: [],
  };
  const wire = JSON.stringify(projectContextForModel(context, scope));
  assert.match(wire, /operation:[a-f0-9]{24}/);
  assert.ok(wire.includes("create"));
  for (const privateValue of [
    operation.route_shape,
    "private-payload-value",
    "#private-selector",
  ])
    assert.equal(wire.includes(privateValue), false);
});

test("successful prepared login removes pre-login opaque references from the next model context", () => {
  const learningTask = {
    ...task("learn_business_flow"),
    id: "post-login-learning-task",
    execution_plan: {
      intent: "learn_business_flow",
      flow_id: "post-login-flow",
    },
  };
  const scope = buildModelContextScope({
    task: learningTask,
    scanConfig: { authorization_acknowledged: true },
    tools,
  });
  const context = {
    scan: {
      id: "post-login-scan",
      base_url: "https://authorized.example.test",
      status: "running",
      current_phase: "normal",
      scan_config: { authorization_acknowledged: true },
    },
    task: learningTask,
    selected_vuln_types: [],
    available_tools: selectModelVisibleTools(tools, "normal_business_learning"),
    relevant_endpoints: [],
    endpoint_inventory_summary: { total: 0 },
    feature_tree: [],
    vulnerability_candidates: [],
    task_artifacts: [],
    task_tool_invocations: [
      {
        tool_name: "browser.navigate",
        status: "completed",
        input_json: { url: "https://private-login.example/" },
        output_json: {
          observation: {
            controls: [
              {
                control_ref: "control_ref_pre_login_private",
                label: "Private login label",
              },
            ],
          },
        },
      },
      {
        tool_name: "browser.interact",
        status: "completed",
        input_json: {
          operation: {
            action: "click",
            control_ref: "control_ref_post_login_intermediate",
          },
        },
        output_json: {
          observation: {
            controls: [
              {
                control_ref: "control_ref_pre_login_private",
                label: "Private login label",
              },
            ],
          },
        },
      },
      {
        tool_name: "bstg.identity.apply_login",
        status: "completed",
        output_json: {
          authenticated: true,
          recording_session_id: "recording-post-login",
        },
      },
      {
        tool_name: "browser.interact",
        status: "completed",
        input_json: { operation: { action: "observe" } },
        output_json: {
          observation: {
            controls: [
              {
                control_ref: "control_ref_post_login_initial",
                navigation_target: "profile",
              },
            ],
          },
        },
      },
      {
        tool_name: "browser.interact",
        status: "completed",
        input_json: {
          operation: {
            action: "click",
            control_ref: "control_ref_post_login_initial",
          },
        },
        output_json: {
          observation: {
            controls: [
              {
                control_ref: "control_ref_post_login_intermediate",
                navigation_target: "profile",
              },
            ],
          },
        },
      },
      {
        tool_name: "browser.interact",
        status: "completed",
        input_json: { operation: { action: "observe" } },
        output_json: {
          observation: {
            controls: [
              {
                control_ref: "control_ref_post_login_current",
                navigation_target: "profile",
              },
            ],
          },
        },
      },
    ],
    global_recent_artifacts: [],
    shared_resources: [],
    shared_resource_summary: { total: 0 },
    relevant_memories: [],
    memory_summary: { total: 0 },
    browser_context_summary: {
      active: 1,
      contexts: [{ identity_key: "tester" }],
    },
    planner_state: {},
    recent_tasks: [
      { id: "post-login-learning-task", title: "Post login flow" },
    ],
    operating_rules: [],
    business_flows: [
      {
        id: "post-login-flow",
        name: "Post login flow",
        goal: "Observe the authenticated page",
        role: "tester",
        status: "learning",
      },
    ],
  };
  const projected = projectContextForModel(context, scope);
  const wire = JSON.stringify(projected);
  assert.equal(
    wire.includes("control_ref_pre_login_private"),
    false,
    "a successful login invalidates pre-login opaque references in model transport",
  );
  assert.equal(wire.includes("Private login label"), false);
  assert.equal(
    wire.includes("control_ref_post_login_initial"),
    false,
    "an older authenticated observation cannot compete with the current control set",
  );
  assert.equal(
    wire.includes("control_ref_post_login_intermediate"),
    false,
    "intermediate browser observations lose their opaque references before provider transport",
  );
  assert.equal(
    wire.includes("control_ref_post_login_current"),
    true,
    "the fresh authenticated observation remains usable",
  );
  const currentObservationInvocation = projected.task_tool_invocations.findLast(
    (invocation) =>
      invocation.tool_name === "browser.interact" &&
      invocation.output_json?.observation?.controls?.some(
        (control) => control.control_ref === "control_ref_post_login_current",
      ),
  );
  assert.equal(
    Object.hasOwn(currentObservationInvocation?.input_json?.operation || {}, "control_ref"),
    false,
    "the input handle that produced the current page is stale and cannot compete with its current output controls",
  );
  const historicalClick = projected.task_tool_invocations.find(
    (invocation) =>
      invocation.tool_name === "browser.interact" &&
      invocation.input_json?.operation?.action === "click",
  );
  assert.equal(
    Object.hasOwn(historicalClick?.input_json?.operation || {}, "control_ref"),
    false,
    "history keeps the browser action class without retaining its stale opaque reference",
  );
  assert.ok(
    projected.operating_rules.some((rule) =>
      rule.includes("prior opaque browser references are invalid"),
    ),
  );
});
