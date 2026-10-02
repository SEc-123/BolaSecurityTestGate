import type { AIScanTask } from "../services/ai-scan/types.js";
import type { AgentToolSpec } from "./tool-types.js";
import type { AutonomousAgentContext } from "./context-builder.js";
import { configuredIdentityAccounts } from "../services/ai-scan/identity-material.js";
import { sanitizeModelString } from "./model-context-sanitizer.js";
import { compactModelEvidence } from "./model-evidence-context.js";
import {
  BUSINESS_LEARNING_INTENT,
  BUSINESS_PLAN_INTENT,
  BUSINESS_REVIEW_INTENT,
  BUSINESS_EXPERIMENT_INTENT,
} from "./business-task-lifecycle.js";
import { normalObjectiveManifestForTask } from "./normal-business-objectives.js";

/**
 * A model decision should see only the capabilities needed for its current
 * persisted stage. This keeps normal-business learning independent from later
 * risk work, makes the model's authority auditable, and avoids asking a model
 * to reason over an entire product's executor catalogue on every turn.
 */
export type ModelContextStage =
  | "capability_inventory"
  | "normal_discovery"
  | "normal_business_planning"
  | "normal_business_learning"
  | "normal_business_review"
  | "security_modeling"
  | "security_experiment"
  | "generic";

export interface ModelContextScope {
  stage: ModelContextStage;
  purpose: string;
  authorization: "acknowledged" | "not_recorded";
  allowed_tool_names: string[];
  allowed_actions: string[];
  broader_assessment_context_withheld: boolean;
}

const NORMAL_STAGES = new Set<ModelContextStage>([
  "capability_inventory",
  "normal_discovery",
  "normal_business_planning",
  "normal_business_learning",
  "normal_business_review",
]);

const TOOL_NAMES: Record<Exclude<ModelContextStage, "generic">, string[]> = {
  capability_inventory: ["bstg.capabilities.inventory"],
  normal_discovery: [
    "agent.memory.query",
    "agent.memory.remember",
    "browser.discover_target",
    "browser.interact",
    "browser.navigate",
    "bstg.identity.bootstrap_accounts",
  ],
  normal_business_planning: [
    "agent.memory.query",
    "agent.memory.remember",
    "browser.interact",
    "browser.navigate",
    "bstg.business.coverage.inspect",
    "bstg.business.coverage.save",
    "bstg.business.flow.define",
    "bstg.business.flow.inspect",
  ],
  normal_business_learning: [
    "agent.memory.query",
    "agent.memory.remember",
    "browser.interact",
    "browser.navigate",
    "bstg.identity.apply_login",
    "bstg.assets.search",
    "bstg.business.capture.inspect",
    "bstg.business.capture.start",
    "bstg.business.capture.stop",
    "bstg.business.flow.block",
    "bstg.business.flow.inspect",
    "bstg.business.workflow.inspect",
    "bstg.business.workflow.prepare",
    "bstg.business.workflow.repair",
    "bstg.business.workflow.revise",
    "bstg.business.workflow.validate",
  ],
  normal_business_review: [
    "agent.memory.query",
    "agent.memory.remember",
    "bstg.assets.search",
    "bstg.business.flow.inspect",
  ],
  security_modeling: [
    "agent.memory.query",
    "agent.memory.remember",
    "agent.shared_context.prepare",
    "feature.extract_tree",
    "task.expand_selected_vulnerabilities",
    "vuln.generate_candidates",
  ],
  security_experiment: [
    "agent.memory.query",
    "agent.memory.remember",
    "bstg.assets.search",
    "bstg.business.flow.inspect",
    "bstg.business.object_handles.inspect",
    "bstg.test_plan.assess",
    "bstg.test_plan.compile",
    "bstg.test_plan.create",
    "bstg.test_plan.execute",
    "bstg.test_plan.inspect",
    "bstg.workflow.inspect",
  ],
};

function intentOf(
  task: Pick<AIScanTask, "task_type" | "vuln_type" | "execution_plan">,
): string {
  return String(task.execution_plan?.intent || "");
}

export function modelContextStageForTask(
  task: Pick<AIScanTask, "task_type" | "vuln_type" | "execution_plan">,
): ModelContextStage {
  const intent = intentOf(task);
  if (intent === "inventory_bstg_capabilities") return "capability_inventory";
  if (intent === "discover_target") return "normal_discovery";
  if (intent === BUSINESS_PLAN_INTENT) return "normal_business_planning";
  if (intent === BUSINESS_LEARNING_INTENT) return "normal_business_learning";
  if (intent === BUSINESS_REVIEW_INTENT) return "normal_business_review";
  if (
    intent === BUSINESS_EXPERIMENT_INTENT ||
    task.task_type === "model_business_experiment"
  )
    return "security_experiment";
  if (
    intent === "model_features_and_candidates" ||
    intent === "expand_selected_vulnerabilities"
  )
    return "security_modeling";
  return "generic";
}

function purposeForStage(stage: ModelContextStage): string {
  switch (stage) {
    case "capability_inventory":
      return "Inspect the persisted native capability inventory and choose the next bounded inventory action.";
    case "normal_discovery":
      return "Discover and observe normal product paths on the declared target before making any later-stage assessment.";
    case "normal_business_planning":
      return "Define complete, observable normal business flows and save a coverage decision for every discovered operation.";
    case "normal_business_learning":
      return "Execute, record, compile, and semantically verify one normal business flow using the supplied test identity.";
    case "normal_business_review":
      return "Review persisted normal-flow evidence and state any remaining normal-flow gaps precisely.";
    case "security_modeling":
      return "Model discovered functionality and prepare the bounded, evidence-backed next stage for the operator-selected assessment.";
    case "security_experiment":
      return "Use the verified normal-flow evidence to prepare, run, inspect, and assess one bounded native experiment.";
    default:
      return "Choose the next bounded action from the current task evidence.";
  }
}

function allowedActions(stage: ModelContextStage): string[] {
  if (stage === "capability_inventory") {
    // The inventory is a single persisted native observation. A model cannot
    // substitute a free-form availability claim for that fact.
    return ["tool_call", "complete_task"];
  }
  if (stage === "normal_discovery") {
    return ["tool_call", "complete_task", "fail_task", "block_task"];
  }
  // Planning is a model-owned persistence loop, not a place for a free-form
  // terminal statement.  A target that cannot be exercised is still a
  // coverage decision (deferred/blocked, with observed reason) saved through
  // bstg.business.coverage.save.  Restricting the terminal surface here makes
  // an accidental "tools are unavailable" response recoverable without
  // synthesising a business Flow on the model's behalf.
  if (stage === "normal_business_planning") {
    return ["tool_call", "complete_task"];
  }
  // A normal business flow is a learning loop. Its only valid terminal state
  // comes from server-verified native evidence, or an evidence-backed
  // bstg.business.flow.block. A free-form model block or failure would turn
  // an adaptation opportunity into an unreviewable terminal.
  if (stage === "normal_business_learning") {
    return ["tool_call", "complete_task"];
  }
  return [
    "tool_call",
    "complete_task",
    "fail_task",
    "block_task",
    "wait_for_user_selection",
    "create_child_tasks",
  ];
}

export function selectModelVisibleTools(
  tools: AgentToolSpec[],
  stage: ModelContextStage,
): AgentToolSpec[] {
  if (stage === "generic") return tools;
  const allowed = new Set(TOOL_NAMES[stage]);
  return tools.filter((tool) => allowed.has(tool.name));
}

export function buildModelContextScope(input: {
  task: Pick<AIScanTask, "task_type" | "vuln_type" | "execution_plan">;
  scanConfig?: Record<string, any>;
  tools: AgentToolSpec[];
}): ModelContextScope {
  // Mobile acquisition owns a separate deterministic lifecycle whose tools
  // are selected before a provider decision. Keep its established surface
  // intact until the mobile runtime receives its own stage policy.
  const mobile = [
    input.scanConfig?.surface,
    input.scanConfig?.surface_type,
    input.scanConfig?.mobile?.platform,
    input.scanConfig?.android?.platform,
  ].includes("android");
  const stage = mobile ? "generic" : modelContextStageForTask(input.task);
  const visible = selectModelVisibleTools(input.tools, stage);
  return {
    stage,
    purpose: purposeForStage(stage),
    authorization:
      input.scanConfig?.authorization_acknowledged === true
        ? "acknowledged"
        : "not_recorded",
    allowed_tool_names: visible.map((tool) => tool.name),
    allowed_actions: allowedActions(stage),
    broader_assessment_context_withheld: NORMAL_STAGES.has(stage),
  };
}

function normalStageOperatingRules(
  scope: ModelContextScope,
  normalBusinessObjectives: string[],
  objectiveManifest: Array<{
    id: string;
    label: string;
    completion?: { required_response_paths: string[] };
    requires_prepared_identity?: boolean;
  }> = [],
): string[] {
  const authorization =
    scope.authorization === "acknowledged"
      ? "The operator has recorded authorization for the declared target and supplied test identities."
      : "No authorization declaration is present in this model context; do not broaden the current bounded task.";
  return [
    authorization,
    `Current stage: ${scope.purpose}`,
    "Use only the listed stage capabilities. Treat an omitted capability as unavailable for this decision.",
    "Stay on the declared target and supplied test identities. Do not make assumptions from a later stage of the assessment.",
    ...(normalBusinessObjectives.length
      ? [
          "scan.scan_config.normal_business_objectives is a bounded list of required normal outcomes for this stage. Treat every listed outcome as a declarative coverage requirement: observe the reachable UI and define, execute, and verify evidence for it. Defer an outcome only when current persisted evidence proves it unavailable or blocked; do not silently omit it because another flow was easier to observe.",
        ]
      : []),
    ...(objectiveManifest.length
      ? [
          "task.execution_plan.normal_objective_manifest is immutable server-owned planning input. For bstg.business.flow.define, select one exact objective_id from that manifest; BSTG, not the model, supplies the resulting Flow name, goal, completion contract, and identity prerequisite. For an objective with requires_prepared_identity=true, choose one exact identity_key from scan.scan_config.available_execution_identities where prepared=true; anonymous is not allowed, and the server rechecks that the scan-bound prepared identity is executable. Define exactly one Flow for every manifest objective before saving coverage.",
        ]
      : []),
    ...(scope.stage === "normal_business_planning"
      ? [
          'Normal-business planning is an executable model-decision stage. Return JSON action "tool_call" with one name from context.available_tools; BSTG invokes that tool after this decision, so no separate function-call channel is missing. First obtain the current coverage inventory after any needed page observation. Then choose the business goals, exact executable identities, prerequisites, and flow-to-target associations yourself with bstg.business.flow.define, and save every inventory target exactly once with bstg.business.coverage.save. Do not emit block_task, fail_task, wait_for_user_selection, or create_child_tasks here. Complete only after a successful coverage.save response; unresolved targets belong in that coverage record with an observed deferred/blocked reason.',
        ]
      : []),
    'For bstg.business.flow.define, role is an executable identity key: use exactly "anonymous" or a literal active/supplied key from safe context. A server-sealed requires_prepared_identity objective must use a listed prepared identity and never anonymous. Never use an account name, display label, or whitespace-normalized alias.',
    "A completed normal business flow requires persisted browser actions, native execution, and semantic assertions. A successful response alone is not verification.",
    'Before bstg.business.workflow.validate, inspect the Workflow and use only its per-step assertion_paths. An assertion path is exactly status, headers.<observed-header>, or body.<observed-json-field>; bare body, HTML, and text are invalid. At least one goal, identity, or state assertion must use an observed body field. If a normal expected value is private and stable, choose right.type "captured_baseline" with equals: BSTG compares the fresh response to the same private captured field without revealing it. When a server-sealed final-outcome path is an opaque fresh identifier rather than a stable value, do not invent or copy its literal; use an observed-safe shape assertion such as regex ".+" for a nonempty string together with the required final-action provenance.',
    "When evidence is insufficient, record the specific gap or choose another listed observation/verification action. Do not fabricate a result.",
    ...(scope.stage === "normal_business_learning"
      ? [
          'Do not emit block_task for a normal business learning flow. Stop only after capture inspection shows at least one event with semantic_body_path_available=true. If the current Flow has objective_operation, it is a server-sealed state-changing operation contract: keep the capture active until objective_operation.operation_candidate_event_ids is nonempty, include one such event in workflow.prepare, and add a goal/state body assertion on its exact source step. The opaque operation ID/class describes required business effect; BSTG keeps its method and route matcher private and never chooses a UI action or event. If the current Flow has objective_completion.required_response_paths, it is a server-sealed final-outcome contract: keep the capture active until its completion_candidate_event_ids is nonempty, include one such event in workflow.prepare, and put goal/state semantic assertions for every listed path on that completion step. During normal_capture_objective_completion_required, the server may return only operation ID/effect class, response-field shapes, and candidate counts. If any required operation or final-outcome count is zero, choose a browser.navigate or browser.interact action yourself that can produce the missing business effect; do not stop, prepare, or repeatedly inspect the unchanged capture. After that browser action completes, call capture.inspect once to refresh the safe inventory. When that current inspection has semantic evidence plus every declared operation/final-outcome candidate, BSTG may seal the active capture to prevent a duplicate state-changing request; this lifecycle step never chooses a UI control, capture event, mapping, or assertion. If a validation response has objective_completion_assertion_requirements, inspect that same Workflow first. Then, for every listed {source_step_order, required_response_path}, add a goal or state semantic assertion for that exact path on that exact source step before retrying; a baseline assertion for another path does not satisfy it. For a fresh opaque identifier use regex ".+" rather than inventing or copying its value. A review, prerequisite, or HTTP success that lacks that outcome cannot complete the objective. After bstg.business.capture.stop, first call bstg.business.capture.inspect for that stopped recording. Then choose a nonempty ordered set of exact returned event_id values and call bstg.business.workflow.prepare with event_ids. This is the model-owned initial workflow decision: native code rejects omission and never substitutes every captured event. Select only a causally complete normal transaction—its prerequisites, intended operation, and verification state—and do not retain a repeated one-time state-changing request after its successful occurrence unless you judge it required. If a server-persisted hard blocker is present, call bstg.business.flow.block with the current flow_id, that blocker artifact ID, and a concrete reason. If validation rejected assertion shape, inspect the same workflow and retry with exact observed paths. For a first native execution error, call bstg.business.workflow.repair for that current workflow_id and test_run_id, inspect the repaired workflow, then choose fresh mappings/assertions and revalidate. If the current task reports that the repaired path still has a repeated execution error, use execution.execution_failures (only step order, response status, and fixed error kind), inspect the stopped capture/current workflow, and choose bstg.business.workflow.revise yourself with the exact observed event_ids, current workflow_id/test_run_id, and a rationale. The server never selects or silently drops events; preserve every currently bound observed coverage target and validate the new Workflow afresh. A separately planned target that this stopped recording never reached stays in the coverage record and becomes a fresh retry only after native validation. Do not re-record merely to bypass an execution-learning recovery.',
          'Capture lifecycle handles are server-bound: bstg.business.capture.stop and bstg.business.capture.inspect take no recording_session_id, and bstg.business.workflow.prepare takes only the model-selected event_ids plus an optional name. Never supply or choose a recording-session reference. You retain every business decision: browser action, event subset, assertion, mapping, and ambiguity resolution.',
          'capture.inspect exposes an event_id only when that event is action-bound to the current task and eligible for native Workflow replay; never select a background/static/poll row. If transaction_prerequisite_event_candidates is present, it groups replayable opaque IDs by observed add/review/confirm browser intent. When selecting the final transaction event, choose at least one opaque ID from every listed prerequisite group that precedes it. This is a replayability contract over the action sequence you already chose, not an automatic event selection.',
          "After a capture is stopped, do not call browser.navigate, browser.interact, bstg.identity.apply_login, or bstg.business.capture.start. Those operations would create unrecorded browser state. Unless the server explicitly announces capture_required completion recovery, proceed through stopped-capture inspection and a model-selected Workflow preparation.",
          "When task.execution_plan.coverage_retry is present, it is a server-created fresh-task retry: the prior native workflow is retained as sealed audit proof but did not exercise the listed target references. Start the new task-scoped capture, use current observed controls to reach every listed target, and keep it active until capture.inspect lists at least one candidate event for every scheduled target; if a target is still absent, choose a browser action yourself before inspecting again. Then validate a new Workflow/Test Run. capture.inspect returns retry_target_event_candidates: whenever a scheduled target has returned candidate event_ids, explicitly select at least one for that target in workflow.prepare. After workflow.inspect, every scheduled target also needs a goal/identity/state body assertion on one of its exact coverage_bindings source_step_order values; a semantic assertion on a different replayed step does not prove that target. The native layer seals only successful target bindings into its cumulative proof ledger and requires this retry task itself to prove every listed target; a prior successful run cannot complete this retry.",
          'While a capture is active, browser.navigate and browser.interact automatically use its exact bound context if you omit it. After a successful bstg.identity.apply_login, prior opaque browser references are invalid: call browser.interact with action "observe" once before capture.inspect or any authenticated UI action, then use only references from that new observation. After the initial navigation, choose a visible UI action or observation from the current page yourself. When an observation exposes controls[].control_ref or assertion_targets[].assertion_ref, reuse that exact candidate for the corresponding action or state assertion. Use the finite control semantics to guide, never prove, an objective: if a direct matching navigation target is present, prefer profile/settings for update, cart for add, notes for create, and cart/checkout for transaction. Transaction controls can distinguish finite add, review, confirm, and checkout stages without exposing labels. If planner_state.normal_capture_inspection_recovery lists objective_required_control_intents, choose an exact current control with one of those intent values, or prepare an observed field in the same form; do not substitute unrelated navigation or another click. If its objective_eligible_current_control_counts reports a positive count for a required intent, that candidate is available in the current observation: return browser.interact with one exact matching current controls[].control_ref before another capture lifecycle tool. If its transaction_prerequisite_proposal_class is present, correct that closed category using only the narrowed current observation: missing_control_ref or unknown_control_ref requires a current control reference; ineligible_control requires an eligible current candidate; required_control_not_clicked requires click on a matching required control; unrelated_control or preparation_wrong_form requires the matching control or a same-form preparation field; preparation_action_incompatible requires an action compatible with that field; wrong_tool requires browser.interact. These facts never select a reference, field value, event, mapping, or assertion. When the top-level current_normal_browser_requirement is present, it is the immediate one-turn contract and its narrowed current observation is the only live selection surface. In that transaction lease, controls expose candidate_index and bstg.transaction.interact requires operation.candidate_index: choose one current candidate number yourself, and BSTG resolves it to the private current browser reference only for dispatch. These server-derived facts do not select a control, field value, event, mapping, or assertion. If planner_state.normal_capture_inspection_recovery lists last_unsuccessful_action_class, do not repeat that class while a different compatible observed control exists. A fill/select is form preparation: complete the necessary observed form controls, then choose an observed submit/continue action before inspecting traffic; the capture still records every request and only a later semantic event proves success. After a selector pre-action rejection, do not construct a new selector from text, labels, or DOM guesses: select an exact current observed candidate, or observe again when no candidate fits. An observe, scroll, or selectorless key only refreshes candidates; it does not end the correction until a selector-based action or assertion succeeds with one current candidate. Do not call bstg.business.capture.inspect repeatedly without an intervening browser navigation or interaction; stop the capture once you have enough observed request/response evidence.',
          'A top-level current_normal_browser_requirement overrides generic browser-reference guidance for that immediate one-turn lease. Use only its listed bstg.transaction.* tool. For bstg.transaction.trigger, choose operation.intent from its enum yourself; when that intent has exactly one eligible current control, omit candidate_index and BSTG resolves the unique capability. When it has multiple candidates, choose one current candidate_index yourself. Use bstg.transaction.prepare only to prepare a compatible same-form field. Never return browser.interact, control_ref, assertion_ref, selector, observe, assert, or a capture lifecycle tool in this lease. These rules leave the semantic business intent and any ambiguity resolution to the model; they never choose an intent, field value, event, mapping, or assertion locally.',
        ]
      : []),
    "Private captures, credentials, and raw values remain server-side. Refer to persisted IDs and inspection tools instead of requesting raw values.",
  ];
}

function hasPreparedIdentityMaterial(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value))
    return value.some((item) => hasPreparedIdentityMaterial(item, depth + 1));
  if (typeof value === "object")
    return Object.values(value as Record<string, unknown>).some((item) =>
      hasPreparedIdentityMaterial(item, depth + 1),
    );
  return false;
}

/**
 * The full operator prompt can legitimately contain later security scope and
 * must stay out of normal-business model stages.  A small, explicitly
 * configured set of normal outcomes gives the model the business intent it
 * needs without reopening that broader context.  These are declarative
 * coverage labels, never executable instructions or credential material.
 */
function configuredNormalBusinessObjectives(
  config: Record<string, any>,
): string[] {
  const configured =
    config?.business_learning?.normal_objectives ??
    config?.normal_business_objectives;
  if (!Array.isArray(configured)) return [];
  const objectives = new Set<string>();
  for (const item of configured) {
    const source =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && !Array.isArray(item)
          ? item.label
          : undefined;
    if (typeof source !== "string") continue;
    const objective = sanitizeModelString(source)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 360);
    if (objective) objectives.add(objective);
    if (objectives.size >= 12) break;
  }
  return [...objectives];
}

function normalStageScanConfig(
  config: Record<string, any>,
  browserSummary?: Record<string, any>,
): Record<string, any> {
  const output: Record<string, any> = {};
  for (const key of [
    "surface",
    "surface_type",
    "account_mode",
    "enable_account_auto_execution",
    "max_pages",
    "timeout_ms",
    "request_evidence_required",
    "authorization_acknowledged",
  ]) {
    if (config[key] !== undefined) output[key] = config[key];
  }
  const active = new Set<string>(
    (browserSummary?.contexts || [])
      .filter(
        (item: any) =>
          item && typeof item.identity_key === "string" && item.identity_key,
      )
      .map((item: any) => String(item.identity_key)),
  );
  const identities = new Map<
    string,
    { identity_key: string; prepared: boolean; session_available: boolean }
  >();
  for (const [identity_key, material] of Object.entries(
    configuredIdentityAccounts(config),
  )) {
    if (!identity_key || identity_key !== identity_key.trim()) continue;
    identities.set(identity_key, {
      identity_key,
      prepared: hasPreparedIdentityMaterial(material),
      session_available: active.has(identity_key),
    });
  }
  for (const identity_key of active) {
    if (!identities.has(identity_key))
      identities.set(identity_key, {
        identity_key,
        prepared: false,
        session_available: true,
      });
  }
  output.available_execution_identities = [...identities.values()].sort(
    (left, right) => left.identity_key.localeCompare(right.identity_key),
  );
  const normalBusinessObjectives = configuredNormalBusinessObjectives(config);
  if (normalBusinessObjectives.length)
    output.normal_business_objectives = normalBusinessObjectives;
  return output;
}

/**
 * A normal-flow model needs the current executable state, not every raw-sized
 * historical recorder artifact. The canonical snapshot keeps the full audit
 * trail. This projection bounds only the provider envelope after the normal
 * business lifecycle has already derived its persisted recovery state.
 *
 * Keep the newest inspection/validation result large enough for a model to
 * select assertion paths and a current selector. Older calls retain IDs,
 * status and compact execution outcomes so capture provenance and repair
 * sequencing remain inspectable without letting each turn grow with every
 * browser snapshot or workflow revision.
 */
const NORMAL_LEARNING_ARTIFACT_TYPES = new Set([
  "business_capture_session",
  "business_identity_login",
  "business_workflow_learning",
  "business_workflow_validation",
  "business_workflow_repair",
  "business_workflow_revision",
  "business_native_trace",
  "business_flow_blocker",
  "business_coverage_retry_scheduled",
  "business_completion_gap",
]);

// Native validation evidence may be present here as a compact repository
// artifact or as an in-memory lifecycle object.  Give the model the finite
// execution protocol needed to choose a repair/revision, never an executor
// diagnostic, trace, request, response, or assertion operand.
const NORMAL_EXECUTION_FAILURE_KINDS = new Set([
  "non_success_response",
  "timeout",
  "transport",
  "mapping_or_variable",
  "executor",
]);

function compactNormalValidationArtifact(value: any): Record<string, any> {
  const execution = value?.execution || {};
  const execution_failures = (
    Array.isArray(execution.execution_failures)
      ? execution.execution_failures
      : []
  )
    .slice(0, 64)
    .map((failure: any) => {
      const step_order = Number(failure?.step_order || 0);
      const status = Number(failure?.status || 0);
      const error_kind = String(failure?.error_kind || "");
      if (
        !Number.isInteger(step_order) ||
        step_order < 1 ||
        !NORMAL_EXECUTION_FAILURE_KINDS.has(error_kind)
      )
        return undefined;
      return {
        step_order,
        ...(status >= 100 && status <= 599 ? { status } : {}),
        error_kind,
      };
    })
    .filter(Boolean);
  const assertions = (Array.isArray(value?.assertions) ? value.assertions : [])
    .slice(0, 50)
    .map((assertion: any) => {
      const capturedBaseline =
        assertion?.right?.captured_baseline === true ||
        assertion?.right?.type === "captured_baseline";
      return {
        id: assertion?.id,
        step_order: assertion?.step_order,
        description: assertion?.description,
        purpose: assertion?.purpose,
        left: assertion?.left
          ? { type: assertion.left.type, path: assertion.left.path }
          : undefined,
        op: assertion?.op,
        right: assertion?.right
          ? {
              type: capturedBaseline
                ? "captured_baseline"
                : assertion.right.type,
              key:
                capturedBaseline ||
                ["literal", "value_ref"].includes(assertion.right.type)
                  ? undefined
                  : assertion.right.key,
              handle_id:
                !capturedBaseline && assertion.right.type === "value_ref"
                  ? assertion.right.handle_id
                  : undefined,
              value_present:
                !capturedBaseline &&
                assertion.right.type === "literal" &&
                assertion.right.value !== undefined,
            }
          : undefined,
        missing_behavior: assertion?.missing_behavior,
        ...(typeof assertion?.passed === "boolean"
          ? { passed: assertion.passed }
          : {}),
      };
    });
  const coverage_bindings = (
    Array.isArray(value?.coverage_bindings) ? value.coverage_bindings : []
  )
    .slice(0, 120)
    .map((binding: any) => ({
      target_type: binding?.target_type,
      target_id: binding?.target_id,
      endpoint_id: binding?.endpoint_id,
      source_event_id: binding?.source_event_id,
      action_id: binding?.action_id,
      source_step_order: Number.isInteger(binding?.source_step_order)
        ? binding.source_step_order
        : undefined,
      source_workflow_id: binding?.source_workflow_id,
      normal_workflow_id: binding?.normal_workflow_id,
      normal_run_id: binding?.normal_run_id,
      validated: binding?.validated === true,
    }));
  return {
    flow_id: value?.flow_id,
    workflow_id: value?.workflow_id,
    source_workflow_id: value?.source_workflow_id,
    recording_session_id: value?.recording_session_id,
    test_run_id: value?.test_run_id,
    assertions,
    verified: value?.verified === true,
    assertions_verified: value?.assertions_verified === true,
    execution: {
      success: execution.success === true,
      has_execution_error: execution.has_execution_error === true,
      errors_count: Number(execution.errors_count || 0),
      execution_failures,
    },
    coverage_bindings,
    object_handle_catalog_id: value?.object_handle_catalog_id,
    trace: "[Private evidence retained in the originating record]",
  };
}

function normalLearningInvocationBudget(
  age: number,
  currentWorkflowInspection = false,
): { input: number; output: number; summary: number } {
  // A memory lookup or a safe lifecycle read can follow a workflow inspection
  // before the next provider turn. Keep the latest inspection's complete
  // assertion vocabulary available across that one intervening tool; otherwise
  // the model cannot construct a valid semantic validation request.
  if (currentWorkflowInspection)
    return { input: 700, output: 8000, summary: 500 };
  if (age === 0) return { input: 900, output: 5400, summary: 600 };
  if (age <= 2) return { input: 500, output: 1800, summary: 400 };
  return { input: 280, output: 600, summary: 240 };
}

const NORMAL_LEARNING_LIFECYCLE_TOOLS = [
  "bstg.business.capture.start",
  // The newest active inventory is the only safe source for candidate counts.
  // Keep it even after a long sequence of browser interactions so the provider
  // cannot lose the evidence boundary that tells it to refresh the capture.
  "bstg.business.capture.inspect",
  "browser.navigate",
  "bstg.identity.apply_login",
  "bstg.business.capture.stop",
  "bstg.business.workflow.prepare",
  "bstg.business.workflow.inspect",
  "bstg.business.workflow.validate",
  "bstg.business.workflow.repair",
  "bstg.business.workflow.revise",
  "bstg.business.flow.block",
];

function selectNormalLearningProviderInvocations(
  invocations: Record<string, any>[],
): Record<string, any>[] {
  const history = invocations;
  const selected = new Set<number>();
  // The latest turns contain the current selectors, inspection result, and
  // repair feedback. Keep them in chronological order for the model.
  for (
    let index = Math.max(0, history.length - 8);
    index < history.length;
    index++
  )
    selected.add(index);
  // Older lifecycle transitions are still needed to explain why a capture is
  // active/stopped or why a workflow may be validated. Search the complete
  // safely compacted local history, but project only the newest receipt for
  // each transition. This keeps an old strict capture inventory available
  // after a long UI flow without widening the provider envelope.
  for (const toolName of NORMAL_LEARNING_LIFECYCLE_TOOLS) {
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index]?.tool_name === toolName) {
        selected.add(index);
        break;
      }
    }
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => history[index]);
}

function latestSuccessfulPreparedLoginIndex(
  invocations: Record<string, any>[],
): number {
  let index = -1;
  for (const [position, invocation] of invocations.entries()) {
    if (
      invocation?.tool_name === "bstg.identity.apply_login" &&
      invocation?.status === "completed" &&
      invocation?.output_json?.authenticated === true
    )
      index = position;
  }
  return index;
}

function invalidatedPreLoginBrowserInvocation(
  invocation: Record<string, any>,
): Record<string, any> {
  // A prepared login changes the page document. Preserve the lifecycle fact
  // without transporting stale opaque references into the authenticated turn.
  if (
    !["browser.navigate", "browser.interact"].includes(
      String(invocation.tool_name || ""),
    )
  )
    return invocation;
  return {
    ...invocation,
    input_json: { browser_state: "superseded_by_prepared_login" },
    output_summary:
      "Browser observation superseded by prepared identity login.",
    output_json: { browser_state: "superseded_by_prepared_login" },
    error_message: undefined,
  };
}

function hasBrowserObservation(invocation: Record<string, any>): boolean {
  return ["browser.navigate", "browser.interact"].includes(
    String(invocation?.tool_name || ""),
  ) && Boolean(
    invocation?.output_json?.observation &&
      typeof invocation.output_json.observation === "object",
  );
}

/**
 * Opaque browser references are deliberately short-lived.  Keeping refs from
 * older observations in a provider turn makes an otherwise valid model choose
 * between a current control and a handle whose DOM binding has already been
 * superseded.  Preserve the action history, but expose references only from
 * the newest post-login browser observation.  The full history stays local
 * for lifecycle guards and audit receipts.
 */
function withoutHistoricalBrowserReferences(
  invocation: Record<string, any>,
): Record<string, any> {
  const withoutActionReferences = withoutBrowserActionReferences(invocation);
  const output =
    withoutActionReferences.output_json &&
    typeof withoutActionReferences.output_json === "object"
      ? withoutActionReferences.output_json
      : {};
  const { observation: _observation, ...safeOutput } = output;
  return { ...withoutActionReferences, output_json: safeOutput };
}

/** A browser interaction's input reference targets the page that existed
 * before the resulting observation.  It must never compete with references
 * emitted by that resulting, current observation. */
function withoutBrowserActionReferences(
  invocation: Record<string, any>,
): Record<string, any> {
  const input =
    invocation.input_json && typeof invocation.input_json === "object"
      ? invocation.input_json
      : {};
  const operation =
    input.operation && typeof input.operation === "object"
      ? input.operation
      : undefined;
  const inputJson = operation
    ? (() => {
        const {
          control_ref: _controlRef,
          assertion_ref: _assertionRef,
          selector: _selector,
          ...safeOperation
        } = operation as Record<string, unknown>;
        return { ...input, operation: safeOperation };
      })()
    : input;
  return { ...invocation, input_json: inputJson };
}

function projectNormalLearningInvocations(
  invocations: Record<string, any>[],
): Record<string, any>[] {
  const bounded = selectNormalLearningProviderInvocations(invocations);
  const latestWorkflowInspection = bounded
    .map((item) => item.tool_name)
    .lastIndexOf("bstg.business.workflow.inspect");
  const loginBoundary = latestSuccessfulPreparedLoginIndex(bounded);
  let latestCurrentBrowserObservation = -1;
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    if (loginBoundary >= 0 && index < loginBoundary) continue;
    if (hasBrowserObservation(bounded[index])) {
      latestCurrentBrowserObservation = index;
      break;
    }
  }
  return bounded.map((originalInvocation, index) => {
    const afterLoginBoundary =
      loginBoundary >= 0 && index < loginBoundary
        ? invalidatedPreLoginBrowserInvocation(originalInvocation)
        : originalInvocation;
    const browserInvocation = ["browser.navigate", "browser.interact"].includes(
      String(afterLoginBoundary.tool_name || ""),
    );
    // The input handle of even the newest browser action belongs to the page
    // before its output observation. Preserve that newest observation as the
    // model's sole current selection surface, but strip the stale input
    // handle. Older browser observations lose both their output handles and
    // their input handles.
    const invocation = !browserInvocation
      ? afterLoginBoundary
      : index === latestCurrentBrowserObservation
        ? withoutBrowserActionReferences(afterLoginBoundary)
        : withoutHistoricalBrowserReferences(afterLoginBoundary);
    const budget = normalLearningInvocationBudget(
      bounded.length - index - 1,
      index === latestWorkflowInspection,
    );
    return {
      ...invocation,
      input_json: compactModelEvidence(invocation.input_json, budget.input),
      output_summary:
        invocation.output_summary === undefined
          ? undefined
          : compactModelEvidence(invocation.output_summary, budget.summary),
      output_json: compactModelEvidence(invocation.output_json, budget.output),
      error_message:
        invocation.error_message === undefined
          ? undefined
          : sanitizeModelString(String(invocation.error_message)).slice(0, 320),
    };
  });
}

function projectNormalLearningArtifacts(
  artifacts: Record<string, any>[],
): Record<string, any>[] {
  return artifacts
    .filter((artifact) =>
      NORMAL_LEARNING_ARTIFACT_TYPES.has(
        String(artifact.type || artifact.artifact_type || ""),
      ),
    )
    .slice(0, 12)
    .map((artifact, index) => {
      const artifactType = String(
        artifact.type || artifact.artifact_type || "",
      );
      const evidence =
        artifactType === "business_workflow_validation"
          ? compactNormalValidationArtifact(artifact.content_json)
          : artifact.content_json;
      return {
        ...artifact,
        content_json: compactModelEvidence(evidence, index === 0 ? 3000 : 900),
        // The artifact's compact structured evidence is authoritative for this
        // stage. Browser text belongs to the current browser observation, where
        // selector provenance is explicit and bounded.
        content_text: undefined,
      };
    });
}

function projectCurrentNormalLearningFlow(
  context: AutonomousAgentContext,
): Record<string, any>[] {
  const flowId = String(context.task.execution_plan?.flow_id || "");
  const current = (context.business_flows || []).filter(
    (flow) => String(flow?.id || "") === flowId,
  );
  return current.map(
    (flow) => compactModelEvidence(flow, 7000) as Record<string, any>,
  );
}

/**
 * The canonical context remains complete inside BSTG. This projection is only
 * the model transport envelope for a normal-business stage, where later
 * assessment goals and unrelated executor descriptions are not decision
 * inputs. It deliberately preserves current task evidence, endpoint/feature
 * observations, and business-flow state.
 */
export function projectContextForModel(
  context: AutonomousAgentContext,
  scope: ModelContextScope,
): AutonomousAgentContext {
  if (!scope.broader_assessment_context_withheld) {
    return { ...context, model_scope: scope };
  }
  const currentAndDependencies = new Set<string>([
    String(context.task.id || ""),
    ...(Array.isArray(context.task.execution_plan?.dependencies)
      ? context.task.execution_plan.dependencies.map(String)
      : []),
  ]);
  const projectedScanConfig = normalStageScanConfig(
    context.scan.scan_config || {},
    context.browser_context_summary,
  );
  const objectiveManifest = normalObjectiveManifestForTask(context.task as any);
  const safeObjectiveManifest = objectiveManifest.map((objective) => ({
    id: objective.id,
    label: objective.label,
    ...(objective.completion
      ? {
          completion: {
            required_response_paths:
              objective.completion.required_response_paths,
          },
        }
      : {}),
    ...(objective.operation
      ? {
          operation: {
            operation_id: objective.operation.operation_id,
            method: objective.operation.method,
            side_effect_class: objective.operation.side_effect_class,
          },
        }
      : {}),
    ...(objective.requires_prepared_identity
      ? { requires_prepared_identity: true }
      : {}),
  }));
  if (safeObjectiveManifest.length)
    projectedScanConfig.normal_objective_manifest = safeObjectiveManifest;
  const rawPlan = context.task.execution_plan || {};
  const safeTask = {
    ...context.task,
    execution_plan: {
      ...(typeof rawPlan.intent === "string" ? { intent: rawPlan.intent } : {}),
      ...(typeof rawPlan.flow_id === "string"
        ? { flow_id: rawPlan.flow_id }
        : {}),
      ...(Array.isArray(rawPlan.dependencies)
        ? { dependencies: rawPlan.dependencies.map(String).slice(0, 100) }
        : {}),
      ...(rawPlan.strict_normal_objectives === true
        ? { strict_normal_objectives: true }
        : {}),
      ...(safeObjectiveManifest.length
        ? { normal_objective_manifest: safeObjectiveManifest }
        : {}),
      ...(rawPlan.coverage_retry && typeof rawPlan.coverage_retry === "object"
        ? { coverage_retry: rawPlan.coverage_retry }
        : {}),
    },
    agent_goal: scope.purpose,
  };
  const learningEvidence =
    scope.stage === "normal_business_learning"
      ? {
          task_artifacts: projectNormalLearningArtifacts(
            context.task_artifacts || [],
          ),
          task_tool_invocations: projectNormalLearningInvocations(
            context.lifecycle_tool_invocations ||
              context.task_tool_invocations || [],
          ),
          business_flows: projectCurrentNormalLearningFlow(context),
        }
      : {};
  const projected: AutonomousAgentContext = {
    ...context,
    scan: {
      ...context.scan,
      user_prompt: `Current bounded stage only: ${scope.purpose} The broader operator objective remains in the server record for later persisted stages.`,
      scan_config: projectedScanConfig,
    },
    task: safeTask,
    selected_vuln_types: [],
    vulnerability_candidates: [],
    global_recent_artifacts: [],
    shared_resources: [],
    relevant_memories: [],
    recent_tasks: (context.recent_tasks || []).filter((task) =>
      currentAndDependencies.has(String(task.id)),
    ),
    ...learningEvidence,
    operating_rules: normalStageOperatingRules(
      scope,
      Array.isArray(projectedScanConfig.normal_business_objectives)
        ? projectedScanConfig.normal_business_objectives
        : [],
      objectiveManifest,
    ),
    model_scope: scope,
  };
  if (scope.stage === "normal_business_learning") {
    // Do not make this enumerable: JSON serialization of the model envelope
    // must be unable to include the retained lifecycle history by accident.
    Object.defineProperty(projected, "lifecycle_tool_invocations", {
      value:
        context.lifecycle_tool_invocations ||
        context.task_tool_invocations ||
        [],
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(projected, "lifecycle_planner_decisions", {
      value: context.lifecycle_planner_decisions || [],
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const retry = context.task.execution_plan?.coverage_retry;
    if (retry && Array.isArray(retry.targets) && retry.targets.length) {
      const targetLabels = retry.targets
        .slice(0, 40)
        .map((target: any) => {
          const key = sanitizeModelString(String(target?.key || "")).slice(
            0,
            240,
          );
          const name = sanitizeModelString(String(target?.target_name || ""))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240);
          return name ? `${key} (${name})` : key;
        })
        .filter(Boolean);
      projected.operating_rules = [
        ...projected.operating_rules,
        `Coverage-retry focus: prove exactly these server-scheduled target references in this task's fresh native validation: ${targetLabels.join(", ")}. A prior Flow proof cannot satisfy them. Capture inspection returns retry_target_event_candidates; when a scheduled target lists event_ids, explicitly include at least one of those exact IDs in your Workflow event_ids along with any needed prerequisites. Choose the browser actions, observed event subset, and semantic assertions yourself; BSTG never adds an event for you. Complete only after each target has a current task-scoped native binding.`,
      ];
    }
  }
  return projected;
}

/** Model outputs cannot invoke capabilities hidden from their stage context. */
export function modelDecisionScopeError(
  decision: { action?: string; tool_name?: string },
  scope?: Pick<
    ModelContextScope,
    | "purpose"
    | "authorization"
    | "allowed_tool_names"
    | "allowed_actions"
    | "broader_assessment_context_withheld"
  > & { stage: string },
): string | undefined {
  if (!scope) return undefined;
  if (!scope.allowed_actions.includes(String(decision.action || ""))) {
    if (scope.stage === "normal_business_planning") {
      return "Normal-business planning uses the JSON tool_call protocol until the model has saved coverage. The listed planning tools are callable; free-form terminal, wait, and child-task actions are not permitted.";
    }
    if (
      scope.stage === "normal_business_learning" &&
      ["block_task", "fail_task"].includes(String(decision.action || ""))
    ) {
      return `A normal business learning task cannot end with ${String(decision.action)}. Inspect/adapt the persisted evidence, or call bstg.business.flow.block with a concrete blocker artifact.`;
    }
    return `The proposed action ${String(decision.action || "unknown")} is not permitted in model context stage ${scope.stage}.`;
  }
  if (
    decision.action === "tool_call" &&
    !scope.allowed_tool_names.includes(String(decision.tool_name || ""))
  ) {
    return `The proposed tool ${String(decision.tool_name || "unknown")} is outside the persisted model context stage ${scope.stage}.`;
  }
  return undefined;
}
