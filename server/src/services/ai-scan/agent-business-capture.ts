import { createHash, randomUUID } from "node:crypto";
import { dbAll, dbRun } from "../../db/sql-helpers.js";
import type { AgentToolContext } from "../../agent/tool-types.js";
import type { RecordingEvent, RecordingSession } from "../../types/index.js";
import {
  createRecordingSession,
  finishRecordingSession,
  getRecordingSessionDetail,
  ingestRecordingEventsBatch,
  publishWorkflowDraft,
} from "../recording-service.js";
import {
  generateWorkflowDraftArtifacts,
  isWorkflowReplayCandidate,
} from "../recording-generator.js";
import { FieldDictionary } from "../field-dictionary.js";
import {
  buildRecordingLearningSuggestions,
  isRequiredRecordingReplayMapping,
} from "../learning-source-recording.js";
import {
  applyLearningPayload,
  generateAndApplyExecutionLearning,
} from "./bstg-learning-automation.js";
import { createMapping, createVariable } from "../variable-pool.js";
import {
  executeWorkflowRun,
  evaluateStepAssertions,
  getAssertionLeftValue,
} from "../workflow-runner.js";
import { getTraceByRunId } from "../debug-trace.js";
import { assertUrlInTargetScope } from "./target-scope.js";
import { assertScanActive } from "./run-control.js";
import {
  BUSINESS_LEARNING_INTENT,
  BUSINESS_PLAN_INTENT,
  isPlanningCoverageEndpoint,
  latestBusinessCoverage,
} from "../../agent/business-task-lifecycle.js";
import {
  BusinessAssertionValidationError,
  getBusinessFlow,
  saveBusinessFlow,
  validateBusinessAssertions,
  type BusinessAssertion,
  type BusinessAssertionIssue,
  type BusinessCoverageBinding,
  type BusinessCoverageProof,
} from "./agent-business-contract.js";
import { createBusinessObjectHandles } from "./business-object-handles.js";
import {
  browserContextKey,
  closeTaskBrowserContexts,
  interruptPersistentBusinessCapturesForTask,
  startPersistentBusinessCapture,
  stopPersistentBusinessCapture,
  type BusinessBrowserCaptureEvent,
  type BusinessCaptureEndReason,
  type PersistentBrowserScope,
} from "./browser/persistent-browser-runtime.js";
import {
  resolvePreparedBrowserIdentity,
  type PreparedBrowserIdentityResolution,
} from "./browser/prepared-identity.js";
import { publicTechnicalPath } from "./public-technical-snapshot.js";
import type { AIScanArtifact, AIScanTask } from "./types.js";

type PersistedBusinessBrowserCaptureEvent = BusinessBrowserCaptureEvent & {
  flow_id?: string;
  recording_session_id?: string;
};

/** An ID can be copied into an artifact or survive an older recorder.  It is
 * not enough to prove that the browser action caused the request.  Keep this
 * check private and central so semantic selection, coverage and strict
 * objective candidates all enforce the same recorder contract. */
function hasStrongActionAttribution(
  event: Pick<BusinessBrowserCaptureEvent, "action_id" | "causal_proof"> | null | undefined,
): boolean {
  return Boolean(
    event?.action_id &&
      event.causal_proof === "trusted_browser_interaction_dispatch",
  );
}

/** A normal Workflow requires a successful, model-visible JSON body field for
 * a semantic assertion. This carries only opaque recording event IDs, never a
 * route, request, response body, cookie, credential, or model text. */
export class SemanticBodyCandidateRequiredError extends Error {
  readonly candidate_event_ids: string[];
  constructor(candidateEventIds: string[]) {
    super(
      "Choose a browser action that produces a successful semantic JSON response before preparing a normal Workflow.",
    );
    this.name = "SemanticBodyCandidateRequiredError";
    this.candidate_event_ids = [
      ...new Set(
        candidateEventIds.filter((id) => typeof id === "string" && id),
      ),
    ].slice(0, 80);
  }
}

/**
 * A strict normal objective may declare a value-free response-shape contract
 * for its final outcome.  This error retains only opaque candidate event IDs
 * and field paths, so the model can continue the active browser capture
 * without receiving a route, request, response value, cookie, or credential.
 */
export class ObjectiveCompletionCandidateRequiredError extends Error {
  readonly candidate_event_ids: string[];
  readonly required_response_paths: string[];
  constructor(candidateEventIds: string[], requiredResponsePaths: string[]) {
    super(
      "Continue the browser flow until its server-sealed normal-objective completion evidence is observed.",
    );
    this.name = "ObjectiveCompletionCandidateRequiredError";
    this.candidate_event_ids = [
      ...new Set(
        candidateEventIds.filter((id) => typeof id === "string" && id),
      ),
    ].slice(0, 80);
    this.required_response_paths = [
      ...new Set(
        requiredResponsePaths.filter(
          (path) =>
            typeof path === "string" && /^body\.[^\s]{1,280}$/.test(path),
        ),
      ),
    ].slice(0, 20);
  }
}

/** A state-changing strict objective must be represented by one explicit,
 * action-bound captured operation. All matching details stay server-side. */
export class ObjectiveOperationCandidateRequiredError extends Error {
  readonly candidate_event_ids: string[];
  readonly operation_id: string;
  readonly side_effect_class: string;
  constructor(ids: string[], operationId: string, sideEffectClass: string) {
    super(
      "Continue the browser flow until its server-sealed state-changing objective operation is observed.",
    );
    this.name = "ObjectiveOperationCandidateRequiredError";
    this.candidate_event_ids = [
      ...new Set(ids.filter((id) => typeof id === "string" && id)),
    ].slice(0, 80);
    this.operation_id = /^operation:[a-f0-9]{24}$/.test(operationId)
      ? operationId
      : "";
    this.side_effect_class = [
      "authentication",
      "update",
      "add",
      "create",
      "transaction",
      "write",
    ].includes(sideEffectClass)
      ? sideEffectClass
      : "write";
  }
}

/**
 * A capture can retain private diagnostic/background requests alongside the
 * action-bound requests that the native generator can actually replay.  Never
 * let a model use the former as a Workflow source: return only the current
 * opaque executable event IDs so it can make a corrected selection itself.
 */
export class WorkflowEligibleEventSelectionError extends Error {
  readonly candidate_event_ids: string[];
  readonly candidate_event_count: number;
  constructor(candidateEventIds: string[]) {
    super(
      "Choose only current action-bound events that the native Workflow generator can replay.",
    );
    this.name = "WorkflowEligibleEventSelectionError";
    this.candidate_event_ids = [
      ...new Set(
        candidateEventIds.filter((id) => typeof id === "string" && id),
      ),
    ].slice(0, 80);
    this.candidate_event_count = this.candidate_event_ids.length;
  }
}

const TRANSACTION_PREREQUISITE_EVENT_INTENTS = [
  "add",
  "review",
  "confirm",
] as const;
type TransactionPrerequisiteEventIntent =
  (typeof TRANSACTION_PREREQUISITE_EVENT_INTENTS)[number];

type TransactionPrerequisiteEventSelection = {
  intent: TransactionPrerequisiteEventIntent;
  candidate_event_ids: string[];
};

/**
 * The browser Agent chooses the add/review/confirm controls.  Once it has
 * created action-bound capture evidence, a transaction Workflow may not drop
 * those observed prerequisite stages and then claim to be natively replayable.
 * This exposes only finite intent classes plus opaque current event IDs; it
 * never picks an event or leaks a route, selector, label, or captured value.
 */
export class TransactionPrerequisiteEventSelectionError extends Error {
  readonly missing_prerequisites: TransactionPrerequisiteEventSelection[];
  constructor(missing: TransactionPrerequisiteEventSelection[]) {
    super(
      "The selected transaction Workflow omits one or more observed action-bound prerequisite stages.",
    );
    this.name = "TransactionPrerequisiteEventSelectionError";
    this.missing_prerequisites = missing
      .filter((item) =>
        TRANSACTION_PREREQUISITE_EVENT_INTENTS.includes(
          item.intent,
        ),
      )
      .map((item) => ({
        intent: item.intent,
        candidate_event_ids: [
          ...new Set(
            item.candidate_event_ids.filter(
              (id) => typeof id === "string" && id,
            ),
          ),
        ].slice(0, 80),
      }))
      .filter((item) => item.candidate_event_ids.length > 0)
      .slice(0, TRANSACTION_PREREQUISITE_EVENT_INTENTS.length);
  }
}

const SOURCE = "agent_business";
const secretKey =
  /(?:password|passwd|^pwd$|secret|authorization|api[_-]?key|cookie|token|csrf|ticket|otp|passcode|session(?:[_-]?id)?|verification[_-]?code|^sid$|^_g$)/i;
const digest = (value: unknown): string =>
  createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex");

// Product requests reach this handler only through AIScanAgentRuntime, whose
// whole scan is held by the durable ai_scan_execution_leases DB owner in
// scan-execution.ts. A crashed owner is terminalized, rather than resumed by a
// second worker. This map is deliberately only a narrow same-runtime guard for
// duplicate/reentrant tool turns (and direct unit fixtures): it is not a
// substitute for distributed ownership. The deterministic artifact remains
// the durable audit identity after the single run owner has reset its task
// context.
const coverageRetryContextResetLocks = new Map<
  string,
  Promise<string | undefined>
>();

function deterministicArtifactUuid(
  namespace: string,
  scanRunId: string,
  taskId: string,
  flowId: string,
  attempt: number,
): string {
  const value = createHash("sha256")
    .update(
      `${namespace}\u0000${scanRunId}\u0000${taskId}\u0000${flowId}\u0000${attempt}`,
    )
    .digest("hex");
  const variant = ((Number.parseInt(value[16], 16) & 0x3) | 0x8).toString(16);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-${variant}${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function coverageRetryContextResetArtifactId(
  scanRunId: string,
  taskId: string,
  flowId: string,
  attempt: number,
): string {
  return deterministicArtifactUuid(
    "bstg:coverage-retry-context-reset:v1",
    scanRunId,
    taskId,
    flowId,
    attempt,
  );
}

function coverageRetryContextResetSourceRef(
  taskId: string,
  attempt: number,
): string {
  return `coverage-retry-context-reset:${taskId}:${attempt}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return /unique|duplicate|constraint/i.test(
    String((error as any)?.message || error || ""),
  );
}

function matchesCoverageRetryContextResetArtifact(
  artifact: AIScanArtifact,
  input: { scanRunId: string; taskId: string; flowId: string; attempt: number },
): boolean {
  const content = artifact.content_json || {};
  return (
    artifact.id ===
      coverageRetryContextResetArtifactId(
        input.scanRunId,
        input.taskId,
        input.flowId,
        input.attempt,
      ) &&
    artifact.scan_run_id === input.scanRunId &&
    String(artifact.task_id || "") === input.taskId &&
    artifact.artifact_type === "business_coverage_retry_context_reset" &&
    String(artifact.source_ref || "") ===
      coverageRetryContextResetSourceRef(input.taskId, input.attempt) &&
    String(content.flow_id || "") === input.flowId &&
    Number(content.recovery_attempt) === input.attempt &&
    content.scope_type === "task" &&
    content.reset_reason === "coverage_retry_completion_gap" &&
    Number.isInteger(content.closed_task_context_count) &&
    Number(content.closed_task_context_count) >= 0
  );
}

function isRelatedCoverageRetryContextResetArtifact(
  artifact: AIScanArtifact,
  input: { taskId: string; flowId: string; attempt: number },
): boolean {
  const content = artifact.content_json || {};
  return (
    artifact.artifact_type === "business_coverage_retry_context_reset" &&
    String(artifact.task_id || "") === input.taskId &&
    String(content.flow_id || "") === input.flowId &&
    Number(content.recovery_attempt) === input.attempt
  );
}

/** Schema-level context supplied by the planner; no raw network value is public. */
export interface BusinessCaptureStart {
  flow_id: string;
  name?: string;
  identity_key?: string;
  account_id?: string;
  context_key?: string;
  scope_type?: PersistentBrowserScope;
  field_names?: string[];
}

export type BusinessGoalAssertion = BusinessAssertion;

export function redactBusinessValue(
  value: any,
  key = "",
  depth = 0,
  secrets: ReadonlySet<string> = new Set(),
  fields: ReadonlySet<string> = new Set(),
): any {
  const safeConfiguration =
    key === "sessionJar" ||
    (["cookieMode", "cookie_mode"].includes(key) && typeof value === "boolean");
  if (
    !safeConfiguration &&
    (secretKey.test(key) ||
      fields.has(key.toLowerCase()) ||
      (typeof value === "string" && secrets.has(value)))
  )
    return {
      redacted: true,
      sha256: digest(typeof value === "object" ? JSON.stringify(value) : value),
    };
  if (depth > 12) return "[nested value omitted]";
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((item) =>
        redactBusinessValue(item, key, depth + 1, secrets, fields),
      );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 200)
        .map(([name, item]) => [
          name,
          redactBusinessValue(item, name, depth + 1, secrets, fields),
        ]),
    );
  if (typeof value === "string") {
    let safe = value;
    for (const secret of secrets)
      if (secret.length >= 8) safe = safe.split(secret).join("[REDACTED]");
    return safe.slice(0, 4000);
  }
  return value;
}

/**
 * Browser recordings are private execution material. The model needs the
 * shape of a message and the names of fields it can bind, not any recorded
 * customer, object, query, header, or response value. Keep this projection
 * intentionally stricter than key-name redaction: an opaque field name is
 * not evidence that its value is safe to disclose.
 */
function publicValueShape(value: any, depth = 0): any {
  if (depth > 12) return { type: "nested", truncated: true };
  if (value === null) return { type: "null" };
  if (Array.isArray(value))
    return {
      type: "array",
      length: value.length,
      items: value
        .slice(0, 20)
        .map((item) => publicValueShape(item, depth + 1)),
    };
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 120)
        .map(([name, item]) => [name, publicValueShape(item, depth + 1)]),
    );
  // Even a length or digest can become an offline oracle for a private
  // captured scalar. The model only needs the scalar type to choose a field.
  if (typeof value === "string") return { type: "string" };
  return { type: typeof value };
}

function publicHeaders(
  headers: Record<string, any> | undefined,
): Record<string, any> {
  return Object.fromEntries(
    Object.keys(headers || {})
      .slice(0, 80)
      .map((name) => [
        name.toLowerCase(),
        {
          present: true,
          value_type:
            typeof headers?.[name] === "string"
              ? "string"
              : typeof headers?.[name],
          sensitive: secretKey.test(name),
        },
      ]),
  );
}

/** A browser-capture result is model-facing. Preserve a route shape for
 * planning but never an object-bearing pathname segment. Canonical raw URLs
 * stay only in the recording and private evidence artifacts. */
export function publicBusinessCaptureTarget(
  rawUrl: string,
): Record<string, any> {
  try {
    const url = new URL(rawUrl);
    return {
      origin: url.origin,
      path: publicTechnicalPath(url.pathname),
      query_fields: [...new Set([...url.searchParams.keys()])]
        .slice(0, 80)
        .map((name) => ({ name, sensitive: secretKey.test(name) })),
    };
  } catch {
    return { path: "[unavailable]" };
  }
}

function publicDiagnostic(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.replace(/[\r\n\t]+/g, " ").trim();
  const status = text.match(
    /\b(?:http\s*)?(?:status|response)?\s*[:=]?\s*([1-5]\d\d)\b/i,
  );
  if (status)
    return `HTTP ${status[1]} execution gap; private diagnostic retained.`;
  if (/timed?\s*out|timeout/i.test(text))
    return "Timeout execution gap; private diagnostic retained.";
  if (/network|socket|econn|fetch failed|connection/i.test(text))
    return "Transport execution gap; private diagnostic retained.";
  if (/mapping|variable|extract/i.test(text))
    return "Variable or mapping execution gap; private diagnostic retained.";
  return "Execution gap; private diagnostic retained.";
}

function publicTemplateStructure(value: any): Record<string, any> {
  const shape = publicValueShape(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return shape;
  const out: Record<string, any> = shape;
  if (typeof value.path === "string") {
    out.path = publicTechnicalPath(value.path);
  }
  if (typeof value.method === "string")
    out.method = value.method.toUpperCase().slice(0, 16);
  if (typeof value.content_type === "string")
    out.content_type = value.content_type.slice(0, 120);
  return out;
}

function publicBusinessAssertion(assertion: any): Record<string, any> {
  const capturedBaseline =
    assertion?.right?.captured_baseline === true ||
    assertion?.right?.type === "captured_baseline";
  return {
    id: assertion?.id,
    step_order: Number(assertion?.step_order || 0),
    description:
      typeof assertion?.description === "string"
        ? assertion.description.slice(0, 500)
        : undefined,
    purpose: assertion?.purpose,
    left: assertion?.left
      ? { type: assertion.left.type, path: assertion.left.path }
      : undefined,
    op: assertion?.op,
    right: assertion?.right
      ? {
          type: capturedBaseline ? "captured_baseline" : assertion.right.type,
          key:
            capturedBaseline || assertion.right.type === "literal"
              ? undefined
              : assertion.right.key,
          // A literal's shape/hash can be used to guess a private normal
          // baseline offline. The model only needs to know that a comparison is
          // executable; it never needs a fingerprint of the hidden value.
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
}

function publicLearningProjection(learning: any): Record<string, any> {
  const suggestions = learning?.suggestions || {};
  return {
    summary: publicValueShape(learning?.summary || {}),
    suggestions: {
      workflowVariables: (suggestions.workflowVariables || [])
        .slice(0, 120)
        .map((item: any) => ({
          id: item.id,
          variableName: item.variableName,
          predictedType: item.predictedType,
          sourceStepOrder: item.sourceStepOrder,
          sourceLocation: item.sourceLocation,
          sourcePath: item.sourcePath,
          confidence: item.confidence,
          writePolicySuggestion: item.writePolicySuggestion,
          lockSuggestion: item.lockSuggestion,
          source: item.source,
        })),
      mappings: (suggestions.mappings || []).slice(0, 160).map((item: any) => ({
        id: item.id,
        fromStepOrder: item.fromStepOrder,
        fromLocation: item.fromLocation,
        fromPath: item.fromPath,
        toStepOrder: item.toStepOrder,
        toLocation: item.toLocation,
        toPath: item.toPath,
        variableName: item.variableName,
        transformHint: item.transformHint,
        confidence: item.confidence,
        evidenceCount: item.evidenceCount,
        reason: item.reason,
        predictedType: item.predictedType,
        source: item.source,
        selectedByDefault: item.selectedByDefault,
        required_for_replay: item.requiredForReplay === true,
      })),
      extractors: (suggestions.extractors || [])
        .slice(0, 120)
        .map((item: any) => ({
          id: item.id,
          stepOrder: item.stepOrder,
          extractorType: item.extractorType,
          sourceLocation: item.sourceLocation,
          sourcePath: item.sourcePath,
          targetVariableName: item.targetVariableName,
          confidence: item.confidence,
          required: item.required,
          source: item.source,
        })),
      sessionJar: suggestions.sessionJar
        ? {
            cookieMode: suggestions.sessionJar.cookieMode === true,
            headerKeys: Array.isArray(suggestions.sessionJar.headerKeys)
              ? suggestions.sessionJar.headerKeys.slice(0, 80)
              : [],
            bodyJsonPaths: Array.isArray(suggestions.sessionJar.bodyJsonPaths)
              ? suggestions.sessionJar.bodyJsonPaths.slice(0, 80)
              : [],
            confidence: suggestions.sessionJar.confidence,
            reason: suggestions.sessionJar.reason,
            source: suggestions.sessionJar.source,
          }
        : null,
      assertions: (suggestions.assertions || [])
        .slice(0, 120)
        .map((item: any) => ({
          id: item.id,
          stepOrder: item.stepOrder,
          type: item.type,
          confidence: item.confidence,
          reason: item.reason,
          source: item.source,
          config: item.config
            ? {
                operator: item.config.operator,
                expected_shape:
                  item.config.expected === undefined
                    ? undefined
                    : publicValueShape(item.config.expected),
              }
            : undefined,
        })),
    },
    conflicts: publicValueShape(learning?.conflicts || {}),
  };
}

type PublicExecutionFailureKind =
  | "non_success_response"
  | "timeout"
  | "transport"
  | "mapping_or_variable"
  | "executor";

function publicExecutionFailureKind(
  record: any,
): PublicExecutionFailureKind | undefined {
  if (!record) return undefined;
  const status = Number(record.response?.status || 0);
  if (status && !isSuccessfulNormalResponseStatus(status))
    return "non_success_response";
  const diagnostic = String(record.error || "").toLowerCase();
  if (!diagnostic) return undefined;
  if (/timeout|timed out|deadline/.test(diagnostic)) return "timeout";
  if (/network|socket|connect|dns|econn|tls/.test(diagnostic))
    return "transport";
  if (
    /mapping|variable|extractor|missing.*(?:value|field)|unresolved/.test(
      diagnostic,
    )
  )
    return "mapping_or_variable";
  return "executor";
}

/** A value-free native failure projection for model-selected recovery. */
function publicExecutionFailures(
  trace: any,
): Array<{
  step_order: number;
  status?: number;
  error_kind: PublicExecutionFailureKind;
}> {
  const failures: Array<{
    step_order: number;
    status?: number;
    error_kind: PublicExecutionFailureKind;
  }> = [];
  for (const record of Array.isArray(trace?.records) ? trace.records : []) {
    const errorKind = publicExecutionFailureKind(record);
    if (!errorKind) continue;
    const stepOrder = Number(record?.meta?.step_order || 0);
    if (!Number.isInteger(stepOrder) || stepOrder < 1) continue;
    const status = Number(record?.response?.status || 0);
    failures.push({
      step_order: stepOrder,
      ...(status > 0 ? { status } : {}),
      error_kind: errorKind,
    });
    if (failures.length >= 64) break;
  }
  return failures;
}

function publicExecution(execution: any, trace?: any): Record<string, any> {
  return {
    success: execution?.success === true,
    has_execution_error: execution?.has_execution_error === true,
    errors_count: Number(execution?.errors_count || 0),
    findings_count: Number(execution?.findings_count || 0),
    warnings_count: Array.isArray(execution?.warnings)
      ? execution.warnings.length
      : 0,
    execution_failures: publicExecutionFailures(trace),
    ...(execution?.error
      ? { diagnostic: publicDiagnostic(execution.error) }
      : {}),
  };
}

function parseObservedBody(
  text: string | undefined,
  contentType: string | undefined,
): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (!contentType?.includes("application/x-www-form-urlencoded"))
      return null;
    const parsed: Record<string, any> = {};
    for (const [key, value] of new URLSearchParams(text))
      parsed[key] =
        parsed[key] === undefined
          ? value
          : Array.isArray(parsed[key])
            ? [...parsed[key], value]
            : [parsed[key], value];
    return parsed;
  }
}

async function recordingRedaction(
  context: AgentToolContext,
  session: RecordingSession,
  artifacts: Awaited<ReturnType<AgentToolContext["repo"]["listArtifacts"]>>,
): Promise<{ secrets: Set<string>; fields: Set<string> }> {
  const fields = new Set(
    (session.requested_field_names || []).map((name) => name.toLowerCase()),
  );
  const secrets = new Set<string>();
  const add = (value: any) => {
    if (typeof value === "string" && value) secrets.add(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === "object")
      Object.values(value).forEach(add);
  };
  const visit = (value: any) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (secretKey.test(key) || fields.has(key.toLowerCase())) {
          add(item);
          if (typeof item === "string" && /cookie/i.test(key))
            for (const match of item.matchAll(
              /(?:^|[;\n,])\s*([^=;,]+)=([^;,\n]*)/g,
            ))
              add(match[2].trim());
          if (typeof item === "string" && /authorization/i.test(key))
            add(item.replace(/^Bearer\s+/i, ""));
        } else visit(item);
      }
  };
  for (const artifact of artifacts.filter(
    (item) =>
      item.artifact_type === "business_capture_event" &&
      item.source_ref === session.id,
  )) {
    const event = artifact.content_json as BusinessBrowserCaptureEvent;
    visit(event.request_headers);
    visit(event.response_headers);
    visit(
      parseObservedBody(
        event.request_body_text,
        event.request_headers["content-type"],
      ),
    );
    visit(
      parseObservedBody(
        event.response_body_text,
        event.response_headers["content-type"],
      ),
    );
  }
  const contexts = await context.db.repos.recordingRuntimeContext.findAll({
    where: { session_id: session.id } as any,
  });
  for (const item of contexts)
    if (
      secretKey.test(item.context_key) ||
      fields.has(item.context_key.toLowerCase()) ||
      /auth|token|cookie|csrf|ticket/i.test(item.category || "")
    )
      add(item.value_text);
  return { secrets, fields };
}

function sensitiveResponseField(
  name: string,
  redaction?: { secrets: Set<string>; fields: Set<string> },
): boolean {
  return (
    secretKey.test(name) || redaction?.fields.has(name.toLowerCase()) === true
  );
}

/** JSON object keys can themselves be customer/object data when an API returns
 * a map keyed by an ID, email, or opaque token.  Keep ordinary schema fields,
 * but never expose keys that are clearly values or ambiguous long identifiers. */
function dataLikeResponseKey(name: string): boolean {
  const lower = name.toLowerCase();
  if (
    ["__proto__", "prototype", "constructor"].includes(lower) ||
    /^[+-]?\d+$/.test(name) ||
    name.includes("@")
  )
    return true;
  if (/^\{?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}?$/i.test(name))
    return true;
  if (/^[0-9a-f]{24,}$/i.test(name)) return true; // Object IDs and compact UUIDs.
  if (
    name.length >= 24 &&
    /^[A-Za-z0-9+/_=-]+$/.test(name) &&
    (/[+/=]/.test(name) || (/[A-Z]/.test(name) && /\d/.test(name)))
  )
    return true;
  if (name.length >= 32 && /^[A-Za-z0-9_-]+$/.test(name)) return true; // Opaque token-like map keys.
  return false;
}

function responsePathSegment(name: string): boolean {
  return (
    Boolean(name) &&
    name.length <= 160 &&
    !/[\s.]/.test(name) &&
    !["__proto__", "prototype", "constructor"].includes(name.toLowerCase())
  );
}

function modelVisibleJsonKey(name: string): boolean {
  return responsePathSegment(name) && !dataLikeResponseKey(name);
}

/** Only field names and value types may cross the model boundary. Response
 * values stay private even when their field name is useful for an assertion. */
function publicResponseShape(
  value: any,
  redaction?: { secrets: Set<string>; fields: Set<string> },
  depth = 0,
): any {
  if (depth > 12) return { type: "nested", truncated: true };
  if (value === null) return { type: "null" };
  if (Array.isArray(value))
    return {
      type: "array",
      length: value.length,
      items: value
        .slice(0, 20)
        .map((item) => publicResponseShape(item, redaction, depth + 1)),
    };
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 120)
        .filter(
          ([name]) =>
            modelVisibleJsonKey(name) &&
            !sensitiveResponseField(name, redaction),
        )
        .map(([name, item]) => [
          name,
          publicResponseShape(item, redaction, depth + 1),
        ]),
    );
  return { type: typeof value };
}

function jsonResponseBody(text?: string, base64?: string): any | undefined {
  if (base64 || typeof text !== "string" || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface PublicAssertionPath {
  path: string;
  semantic: boolean;
}
interface ResponseAssertionProjection {
  response_summary: Record<string, any>;
  assertion_paths: PublicAssertionPath[];
  semantic_body_path_available: boolean;
}

function isSuccessfulNormalResponseStatus(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 200 && Number(value) < 300;
}

function responseAssertionProjection(
  response:
    | {
        response_status?: number;
        response_headers?: Record<string, any>;
        response_body_text?: string;
        response_body_base64?: string;
      }
    | undefined,
  redaction?: { secrets: Set<string>; fields: Set<string> },
): ResponseAssertionProjection {
  if (!response)
    return {
      response_summary: {
        response_body_available: false,
        response_body_is_json: false,
      },
      assertion_paths: [],
      semantic_body_path_available: false,
    };
  const assertion_paths: PublicAssertionPath[] = [];
  if (Number.isInteger(response.response_status))
    assertion_paths.push({ path: "status", semantic: false });
  for (const rawName of [
    ...new Set(
      Object.keys(response.response_headers || {}).map((name) =>
        name.toLowerCase(),
      ),
    ),
  ].sort()) {
    if (
      responsePathSegment(rawName) &&
      !sensitiveResponseField(rawName, redaction)
    )
      assertion_paths.push({ path: `headers.${rawName}`, semantic: false });
  }
  const parsed = jsonResponseBody(
    response.response_body_text,
    response.response_body_base64,
  );
  const addBodyPaths = (
    value: any,
    segments: string[],
    depth: number,
  ): void => {
    if (
      assertion_paths.length >= 120 ||
      depth > 12 ||
      value === null ||
      value === undefined
    )
      return;
    if (Array.isArray(value)) {
      value
        .slice(0, 40)
        .forEach((item, index) =>
          addBodyPaths(item, [...segments, String(index)], depth + 1),
        );
      return;
    }
    if (value && typeof value === "object") {
      for (const [name, item] of Object.entries(value).slice(0, 120)) {
        if (
          !modelVisibleJsonKey(name) ||
          sensitiveResponseField(name, redaction)
        )
          continue;
        addBodyPaths(item, [...segments, name], depth + 1);
      }
      return;
    }
    if (!segments.length) return;
    const path = `body.${segments.join(".")}`;
    if (path.length <= 400) assertion_paths.push({ path, semantic: true });
  };
  // A normal-flow semantic proof can only begin from an observed successful
  // response. Error bodies remain private diagnostic material: allowing their
  // fields to become selectable would let a model prove an error such as
  // `body.error === "not found"` as a normal business outcome.
  if (
    parsed !== undefined &&
    isSuccessfulNormalResponseStatus(response.response_status)
  )
    addBodyPaths(parsed, [], 0);
  const bodyPaths = assertion_paths.filter((item) => item.semantic);
  return {
    response_summary: {
      response_body_available:
        typeof response.response_body_text === "string" ||
        Boolean(response.response_body_base64),
      response_body_is_json: parsed !== undefined,
      ...(parsed !== undefined
        ? { response_shape: publicResponseShape(parsed, redaction) }
        : {}),
    },
    assertion_paths,
    semantic_body_path_available: bodyPaths.length > 0,
  };
}

interface ObjectiveCompletionRequirement {
  required_response_paths: string[];
}

interface ObjectiveCompletionCandidate {
  event_id: string;
  action_id: string;
  sequence: number;
}

function objectiveCompletionRequirement(
  flow: Record<string, any> | undefined,
): ObjectiveCompletionRequirement | undefined {
  const paths = flow?.objective_completion?.required_response_paths;
  if (!Array.isArray(paths)) return undefined;
  const required_response_paths = [
    ...new Set(
      paths.flatMap((path: unknown) => {
        const value = typeof path === "string" ? path.trim() : "";
        return /^body\.[^\s]{1,280}$/.test(value) ? [value] : [];
      }),
    ),
  ].slice(0, 20);
  return required_response_paths.length
    ? { required_response_paths }
    : undefined;
}

function hasObjectiveCompletionPaths(
  projection: ResponseAssertionProjection,
  requirement: ObjectiveCompletionRequirement,
): boolean {
  const paths = new Set(
    projection.assertion_paths
      .filter((item) => item.semantic === true)
      .map((item) => item.path),
  );
  return requirement.required_response_paths.every((path) => paths.has(path));
}

/** Resolve only event/action references and response-field shape.  The raw
 * capture remains private; even this helper's callers receive no route or
 * request/response value. */
async function objectiveCompletionCandidates(
  context: AgentToolContext,
  session: RecordingSession,
  flow?: Record<string, any>,
  artifacts?: AIScanArtifact[],
  redaction?: { secrets: Set<string>; fields: Set<string> },
): Promise<ObjectiveCompletionCandidate[]> {
  const currentFlow =
    flow ||
    (await requireBusinessFlow(
      context,
      String(session.capture_filters?.flow_id || ""),
    ));
  const requirement = objectiveCompletionRequirement(currentFlow);
  if (!requirement) return [];
  const allArtifacts =
    artifacts || (await context.repo.listArtifacts(context.scanRunId));
  const activeRedaction =
    redaction || (await recordingRedaction(context, session, allArtifacts));
  const candidates: ObjectiveCompletionCandidate[] = [];
  for (const artifact of allArtifacts.filter(
    (item) =>
      item.artifact_type === "business_capture_event" &&
      item.source_ref === session.id,
  )) {
    const event = artifact.content_json as BusinessBrowserCaptureEvent;
    if (
      !event?.complete ||
      !hasStrongActionAttribution(event) ||
      !hasObjectiveCompletionPaths(
        responseAssertionProjection(event, activeRedaction),
        requirement,
      )
    )
      continue;
    const link = allArtifacts.find(
      (item) =>
        item.artifact_type === "business_capture_event_link" &&
        item.content_json?.raw_artifact_id === artifact.id,
    );
    const eventId = String(link?.content_json?.recording_event_id || "");
    if (!eventId) continue;
    candidates.push({
      event_id: eventId,
      action_id: String(event.action_id),
      sequence: Number(event.sequence || 0),
    });
  }
  const unique = new Map<string, ObjectiveCompletionCandidate>();
  for (const candidate of candidates)
    if (!unique.has(candidate.event_id))
      unique.set(candidate.event_id, candidate);
  return [...unique.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(0, 80);
}

async function objectiveCompletionStepOrders(
  context: AgentToolContext,
  session: RecordingSession,
  workflowId: string,
  steps: any[],
  templates: any[],
  flow?: Record<string, any>,
  artifacts?: AIScanArtifact[],
  redaction?: { secrets: Set<string>; fields: Set<string> },
): Promise<number[]> {
  const candidates = await objectiveCompletionCandidates(
    context,
    session,
    flow,
    artifacts,
    redaction,
  );
  if (!candidates.length) return [];
  const candidateIds = new Set(
    candidates.map((candidate) => candidate.event_id),
  );
  const drafts = await context.db.repos.workflowDraftSteps.findAll({
    where: { session_id: session.id } as any,
  });
  const draftById = new Map(drafts.map((step) => [step.id, step]));
  return steps
    .flatMap((step, index) => {
      const sourceId = sourceDraftStepId(templates[index]);
      const source = sourceId ? draftById.get(sourceId) : undefined;
      return source && candidateIds.has(String(source.source_event_id || ""))
        ? [Number(step.step_order)]
        : [];
    })
    .filter((order) => Number.isInteger(order) && order > 0);
}

function objectiveCompletionAssertionIssues(
  requirement: ObjectiveCompletionRequirement | undefined,
  sourceStepOrders: number[],
  assertions: BusinessAssertion[],
): BusinessAssertionIssue[] {
  if (!requirement) return [];
  if (!sourceStepOrders.length)
    return requirement.required_response_paths.map(
      (path) =>
        ({
          semantic_body_required: true,
          unobserved_path: true,
          required_response_path: path,
        }) as BusinessAssertionIssue,
    );
  return requirement.required_response_paths.flatMap((path) =>
    assertions.some(
      (assertion) =>
        sourceStepOrders.includes(assertion.step_order) &&
        assertion.left.path === path &&
        ["goal", "state"].includes(assertion.purpose),
    )
      ? []
      : [
          {
            semantic_body_required: true,
            step_order: sourceStepOrders[0],
            required_response_path: path,
          } as BusinessAssertionIssue,
        ],
  );
}

interface ObjectiveOperationRequirement {
  operation_id: string;
  method: string;
  route_shape: string;
  side_effect_class:
    "authentication" | "update" | "add" | "create" | "transaction" | "write";
}
function objectiveOperationRequirement(
  flow: Record<string, any> | undefined,
): ObjectiveOperationRequirement | undefined {
  const value = flow?.objective_operation;
  if (!value || typeof value !== "object") return undefined;
  const operation_id =
    typeof value.operation_id === "string" &&
    /^operation:[a-f0-9]{24}$/.test(value.operation_id)
      ? value.operation_id
      : "";
  const method =
    typeof value.method === "string" ? value.method.toUpperCase() : "";
  const route_shape =
    typeof value.route_shape === "string" ? value.route_shape.trim() : "";
  const side_effect_class =
    typeof value.side_effect_class === "string" ? value.side_effect_class : "";
  if (
    !operation_id ||
    !/^(POST|PUT|PATCH|DELETE)$/.test(method) ||
    !/^\/[A-Za-z0-9._~:/{}-]{1,280}$/.test(route_shape) ||
    ![
      "authentication",
      "update",
      "add",
      "create",
      "transaction",
      "write",
    ].includes(side_effect_class)
  )
    return undefined;
  return {
    operation_id,
    method,
    route_shape,
    side_effect_class:
      side_effect_class as ObjectiveOperationRequirement["side_effect_class"],
  };
}
function operationRouteMatches(shape: string, rawUrl: string): boolean {
  try {
    const expected = shape.split("/"),
      actual = new URL(rawUrl).pathname.split("/");
    return (
      expected.length === actual.length &&
      expected.every(
        (part, index) =>
          /^\{[A-Za-z][A-Za-z0-9_:-]{0,80}\}$/.test(part) ||
          part === actual[index],
      )
    );
  } catch {
    return false;
  }
}
interface ObjectiveOperationCandidate {
  event_id: string;
  action_id: string;
  sequence: number;
}
async function objectiveOperationCandidates(
  context: AgentToolContext,
  session: RecordingSession,
  flow?: Record<string, any>,
  artifacts?: AIScanArtifact[],
  redaction?: { secrets: Set<string>; fields: Set<string> },
): Promise<ObjectiveOperationCandidate[]> {
  const current =
    flow ||
    (await requireBusinessFlow(
      context,
      String(session.capture_filters?.flow_id || ""),
    ));
  const req = objectiveOperationRequirement(current);
  if (!req) return [];
  const all =
      artifacts || (await context.repo.listArtifacts(context.scanRunId)),
    active = redaction || (await recordingRedaction(context, session, all)),
    out: ObjectiveOperationCandidate[] = [];
  for (const artifact of all.filter(
    (item) =>
      item.artifact_type === "business_capture_event" &&
      item.source_ref === session.id,
  )) {
    const event = artifact.content_json as BusinessBrowserCaptureEvent;
    if (
      !event?.complete ||
      !hasStrongActionAttribution(event) ||
      String(event.method || "").toUpperCase() !== req.method ||
      !operationRouteMatches(req.route_shape, String(event.url || "")) ||
      !responseAssertionProjection(event, active).semantic_body_path_available
    )
      continue;
    const link = all.find(
        (item) =>
          item.artifact_type === "business_capture_event_link" &&
          item.content_json?.raw_artifact_id === artifact.id,
      ),
      id = String(link?.content_json?.recording_event_id || "");
    if (id)
      out.push({
        event_id: id,
        action_id: String(event.action_id),
        sequence: Number(event.sequence || 0),
      });
  }
  const unique = new Map<string, ObjectiveOperationCandidate>();
  for (const item of out)
    if (!unique.has(item.event_id)) unique.set(item.event_id, item);
  return [...unique.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(0, 80);
}
async function objectiveOperationStepOrders(
  context: AgentToolContext,
  session: RecordingSession,
  steps: any[],
  templates: any[],
  flow?: Record<string, any>,
  artifacts?: AIScanArtifact[],
  redaction?: { secrets: Set<string>; fields: Set<string> },
): Promise<number[]> {
  const candidates = await objectiveOperationCandidates(
    context,
    session,
    flow,
    artifacts,
    redaction,
  );
  if (!candidates.length) return [];
  const ids = new Set(candidates.map((item) => item.event_id));
  const drafts = await context.db.repos.workflowDraftSteps.findAll({
      where: { session_id: session.id } as any,
    }),
    byId = new Map(drafts.map((step) => [step.id, step]));
  return steps
    .flatMap((step, index) => {
      const sourceId = sourceDraftStepId(templates[index]),
        source = sourceId ? byId.get(sourceId) : undefined;
      return source && ids.has(String(source.source_event_id || ""))
        ? [Number(step.step_order)]
        : [];
    })
    .filter((order) => Number.isInteger(order) && order > 0);
}
function objectiveOperationAssertionIssues(
  req: ObjectiveOperationRequirement | undefined,
  orders: number[],
  assertions: BusinessAssertion[],
): BusinessAssertionIssue[] {
  if (!req) return [];
  if (!orders.length)
    return [
      {
        semantic_body_required: true,
        unobserved_path: true,
        required_operation_id: req.operation_id,
      } as BusinessAssertionIssue,
    ];
  return assertions.some(
    (a) =>
      orders.includes(a.step_order) &&
      a.left.path.startsWith("body.") &&
      ["goal", "state"].includes(a.purpose),
  )
    ? []
    : [
        {
          semantic_body_required: true,
          step_order: orders[0],
          required_operation_id: req.operation_id,
        } as BusinessAssertionIssue,
      ];
}

function bodySummary(
  text?: string,
  base64?: string,
  contentType?: string,
  redaction?: { secrets: Set<string>; fields: Set<string> },
): Record<string, any> {
  if (base64)
    return { kind: "binary", bytes: Buffer.from(base64, "base64").length };
  if (text === undefined) return { kind: "absent" };
  const parsed = parseObservedBody(text, contentType);
  return parsed
    ? {
        kind: contentType?.includes("application/x-www-form-urlencoded")
          ? "form"
          : "json",
        bytes: Buffer.byteLength(text),
        structure: publicResponseShape(parsed, redaction),
      }
    : { kind: "text", bytes: Buffer.byteLength(text) };
}

function sourceDraftStepId(template: any): string | undefined {
  let config = template?.advanced_config;
  if (typeof config === "string")
    try {
      config = JSON.parse(config);
    } catch {
      return undefined;
    }
  const id = config?.source_workflow_draft_step_id;
  return typeof id === "string" && id ? id : undefined;
}

async function workflowResponseProjections(
  context: AgentToolContext,
  session: RecordingSession,
  steps: any[],
  templates: any[],
  redaction: { secrets: Set<string>; fields: Set<string> },
): Promise<Map<string, ResponseAssertionProjection>> {
  const [draftSteps, events] = await Promise.all([
    context.db.repos.workflowDraftSteps.findAll({
      where: { session_id: session.id } as any,
    }),
    context.db.repos.recordingEvents.findAll({
      where: { session_id: session.id } as any,
    }),
  ]);
  const draftsById = new Map(draftSteps.map((step) => [step.id, step]));
  const eventsById = new Map(events.map((event) => [event.id, event]));
  return new Map(
    steps.map((step, index) => {
      const source = sourceDraftStepId(templates[index]);
      const draft = source ? draftsById.get(source) : undefined;
      const event = draft ? eventsById.get(draft.source_event_id) : undefined;
      return [step.id, responseAssertionProjection(event, redaction)] as [
        string,
        ResponseAssertionProjection,
      ];
    }),
  );
}

export async function requireBusinessFlow(
  context: AgentToolContext,
  flowId: string,
): Promise<Record<string, any>> {
  if (!flowId || flowId.length > 200)
    throw new Error("A bounded flow_id is required.");
  return getBusinessFlow(context.repo, context.scanRunId, flowId);
}

/**
 * A coverage retry is the one deliberate succession case for a normal Flow.
 * It is not enough for a child task to copy a coverage_retry-shaped object:
 * the scheduler must have persisted the matching append-only scheduling
 * artifact, the parent must own the same Flow, and every target reference must
 * agree.  Keep this predicate server-side and reuse it at every task/Flow
 * ownership gate so a retry cannot gain a broader cross-task capability.
 */
function coverageRetryTargetKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const keys: string[] = [];
  for (const item of value) {
    const targetType = String((item as any)?.target_type || "");
    const targetId = String((item as any)?.target_id || "");
    const key = String((item as any)?.key || "");
    if (
      !["feature", "operation"].includes(targetType) ||
      !targetId ||
      key !== `${targetType}:${targetId}`
    )
      return undefined;
    keys.push(key);
  }
  return new Set(keys).size === keys.length ? keys.sort() : undefined;
}

function sameCoverageRetryTargets(left: unknown, right: unknown): boolean {
  const leftKeys = coverageRetryTargetKeys(left),
    rightKeys = coverageRetryTargetKeys(right);
  return Boolean(
    leftKeys &&
    rightKeys &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index]),
  );
}

export async function isAuthorizedBusinessCoverageRetryTask(
  context: AgentToolContext,
  task: AIScanTask | null | undefined,
  flow: Record<string, any>,
): Promise<boolean> {
  const retry = task?.execution_plan?.coverage_retry;
  const parentTaskId = String(task?.parent_task_id || "");
  const flowId = String(flow?.id || "");
  if (
    !task ||
    task.scan_run_id !== context.scanRunId ||
    task.task_type !== "learn_business_flow" ||
    task.execution_plan?.intent !== BUSINESS_LEARNING_INTENT ||
    String(task.execution_plan?.flow_id || "") !== flowId ||
    !parentTaskId ||
    String(retry?.origin_task_id || "") !== parentTaskId ||
    Number(retry?.attempt) !== 1 ||
    !coverageRetryTargetKeys(retry?.targets)
  )
    return false;
  if (
    !Array.isArray(task.dependencies) ||
    !task.dependencies.includes(parentTaskId)
  )
    return false;
  const parent = await context.repo.getTask(parentTaskId);
  if (
    !parent ||
    parent.scan_run_id !== context.scanRunId ||
    parent.id !== parentTaskId ||
    parent.execution_plan?.intent !== BUSINESS_LEARNING_INTENT ||
    String(parent.execution_plan?.flow_id || "") !== flowId ||
    String(flow.owner_task_id || "") !== parentTaskId
  )
    return false;
  const artifacts = await context.repo.listArtifacts(context.scanRunId);
  return artifacts.some(
    (artifact) =>
      artifact.artifact_type === "business_coverage_retry_scheduled" &&
      String(artifact.task_id || "") === parentTaskId &&
      String(artifact.source_ref || "") === task.id &&
      String(artifact.content_json?.flow_id || "") === flowId &&
      String(artifact.content_json?.source_task_id || "") === parentTaskId &&
      String(artifact.content_json?.retry_task_id || "") === task.id &&
      sameCoverageRetryTargets(retry.targets, artifact.content_json?.targets),
  );
}

async function flowEvent(
  context: AgentToolContext,
  flowId: string,
  patch: Record<string, any>,
): Promise<void> {
  const flow = await requireBusinessFlow(context, flowId);
  await saveBusinessFlow(context.repo, context.scanRunId, context.taskId, {
    ...flow,
    ...patch,
    id: flowId,
  } as any);
}

/** The normal-flow handle is bound to the exact operator-provisioned subject
 * when one exists. Store only its digest; later cross-identity compilation
 * compares that digest to the server-built probe requirement. */
function configuredIdentitySubjectHash(account: any): string | undefined {
  const profile = account?.auth_profile;
  const probe =
    profile && typeof profile === "object"
      ? (profile.identity_probe ?? profile.identityProbe)
      : undefined;
  const value =
    probe && typeof probe === "object"
      ? (probe.expected_subject ?? probe.expectedSubject)
      : undefined;
  return ["string", "number", "boolean"].includes(typeof value)
    ? digest(value)
    : undefined;
}

/** Path comparison runs only inside the executor.  Endpoint values are never
 * exposed to the model here; the public result carries opaque endpoint/event
 * IDs that let later lifecycle gates prove what was actually exercised. */
function canonicalRequestPath(
  value: string,
  baseUrl: string,
): string | undefined {
  try {
    const path = new URL(value, baseUrl).pathname.replace(/\/{2,}/g, "/");
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  } catch {
    return undefined;
  }
}

function publicCoverageBinding(
  binding: BusinessCoverageBinding,
): Record<string, any> {
  return {
    target_type: binding.target_type,
    target_id: binding.target_id,
    endpoint_id: binding.endpoint_id,
    source_event_id: binding.source_event_id,
    action_id: binding.action_id,
    source_step_order: binding.source_step_order,
    source_workflow_id: binding.source_workflow_id,
    normal_workflow_id: binding.normal_workflow_id,
    normal_run_id: binding.normal_run_id,
    validation_assertion_ids: binding.validation_assertion_ids,
    validated: binding.validated === true,
  };
}

function coverageProofKey(
  proof: Pick<
    BusinessCoverageProof,
    | "target_type"
    | "target_id"
    | "endpoint_id"
    | "source_event_id"
    | "source_step_order"
    | "source_workflow_id"
    | "normal_workflow_id"
    | "normal_run_id"
    | "validation_artifact_id"
  >,
): string {
  return [
    proof.target_type,
    proof.target_id,
    proof.endpoint_id,
    proof.source_event_id,
    proof.source_step_order,
    proof.source_workflow_id,
    proof.normal_workflow_id,
    proof.normal_run_id,
    proof.validation_artifact_id,
  ].join(":");
}

function sealedCoverageProof(
  binding: BusinessCoverageBinding,
  input: {
    taskId: string;
    validationArtifactId: string;
    traceArtifactId?: string;
  },
): BusinessCoverageProof | undefined {
  const assertionIds = Array.isArray(binding.validation_assertion_ids)
    ? [
        ...new Set(
          binding.validation_assertion_ids.filter(
            (id) => typeof id === "string" && id,
          ),
        ),
      ]
    : [];
  if (
    binding.validated !== true ||
    !binding.target_type ||
    !binding.target_id ||
    !binding.endpoint_id ||
    !binding.source_event_id ||
    !binding.action_id ||
    !Number.isInteger(binding.source_step_order) ||
    !binding.source_workflow_id ||
    !binding.normal_workflow_id ||
    !binding.normal_run_id ||
    !assertionIds.length ||
    !input.taskId ||
    !input.validationArtifactId
  )
    return undefined;
  return {
    target_type: binding.target_type,
    target_id: binding.target_id,
    endpoint_id: binding.endpoint_id,
    source_event_id: binding.source_event_id,
    action_id: binding.action_id,
    source_step_order: binding.source_step_order,
    source_workflow_id: binding.source_workflow_id,
    normal_workflow_id: binding.normal_workflow_id!,
    normal_run_id: binding.normal_run_id!,
    validation_assertion_ids: assertionIds,
    validated: true,
    validated_task_id: input.taskId,
    validation_artifact_id: input.validationArtifactId,
    ...(input.traceArtifactId
      ? { trace_artifact_id: input.traceArtifactId }
      : {}),
  };
}

function appendCoverageProofs(
  existing: unknown,
  fresh: BusinessCoverageProof[],
): BusinessCoverageProof[] {
  const result: BusinessCoverageProof[] = [];
  const seen = new Set<string>();
  for (const proof of [
    ...(Array.isArray(existing) ? existing : []),
    ...fresh,
  ]) {
    if (!proof || typeof proof !== "object") continue;
    const key = coverageProofKey(proof as BusinessCoverageProof);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(proof as BusinessCoverageProof);
  }
  return result;
}

/** Upgrade an older in-memory Flow to the same sealed ledger shape before a
 * coverage retry clears its mutable bindings. A matching native validation
 * artifact is mandatory; a hand-written Flow binding alone is never promoted. */
function legacyCoverageProofs(
  flow: Record<string, any>,
  artifacts: any[],
): BusinessCoverageProof[] {
  const bindings = Array.isArray(flow.coverage_bindings)
    ? (flow.coverage_bindings as BusinessCoverageBinding[])
    : [];
  return bindings.flatMap((binding) => {
    if (
      binding.validated !== true ||
      !binding.normal_workflow_id ||
      !binding.normal_run_id
    )
      return [];
    const validation = artifacts.find(
      (artifact) =>
        artifact.artifact_type === "business_workflow_validation" &&
        String(artifact.content_json?.flow_id || "") ===
          String(flow.id || "") &&
        String(artifact.content_json?.workflow_id || "") ===
          String(binding.normal_workflow_id) &&
        String(artifact.content_json?.test_run_id || "") ===
          String(binding.normal_run_id) &&
        artifact.content_json?.assertions_verified === true &&
        typeof artifact.task_id === "string" &&
        artifact.task_id,
    );
    if (!validation) return [];
    const asserted = new Set(
      (Array.isArray(validation.content_json?.assertions)
        ? validation.content_json.assertions
        : []
      )
        .filter((assertion: any) => assertion?.passed === true)
        .map((assertion: any) => String(assertion.id || "")),
    );
    const assertionIds = Array.isArray(binding.validation_assertion_ids)
      ? binding.validation_assertion_ids
      : [];
    if (
      !assertionIds.length ||
      assertionIds.some((id) => !asserted.has(String(id)))
    )
      return [];
    const trace = artifacts.find(
      (artifact) =>
        artifact.artifact_type === "business_native_trace" &&
        String(artifact.source_ref || "") === String(binding.normal_run_id) &&
        String(artifact.content_json?.flow_id || "") === String(flow.id || ""),
    );
    const proof = sealedCoverageProof(binding, {
      taskId: validation.task_id,
      validationArtifactId: validation.id,
      traceArtifactId: trace?.id,
    });
    return proof ? [proof] : [];
  });
}

async function deriveCoverageBindings(
  context: AgentToolContext,
  workflowId: string,
  session: RecordingSession,
): Promise<{
  steps: Array<{
    id: string;
    description?: string;
    step_order: number;
    endpoint_id?: string;
    event_id?: string;
  }>;
  bindings: BusinessCoverageBinding[];
}> {
  const run = await context.repo.getRun(context.scanRunId);
  if (!run) throw new Error("Assessment not found.");
  const [
    workflowSteps,
    draftSteps,
    recordingEvents,
    endpoints,
    features,
    artifacts,
  ] = await Promise.all([
    context.db.repos.workflowSteps.findAll({
      where: { workflow_id: workflowId } as any,
    }),
    context.db.repos.workflowDraftSteps.findAll({
      where: { session_id: session.id } as any,
    }),
    context.db.repos.recordingEvents.findAll({
      where: { session_id: session.id } as any,
    }),
    context.repo.listEndpoints(context.scanRunId),
    context.repo.listFeatures(context.scanRunId),
    context.repo.listArtifacts(context.scanRunId),
  ]);
  const draftById = new Map(draftSteps.map((step) => [step.id, step]));
  const recordingEventById = new Map(
    recordingEvents.map((event) => [String(event.id), event]),
  );
  const actionByEventId = new Map(
    [...currentCapturedEventSources({artifacts,events:recordingEvents,session,
      taskId:String(context.taskId||''),flowId:String(session.capture_filters?.flow_id||'')}).entries()]
      .flatMap(([eventId,raw])=>raw.action_id?[[eventId,String(raw.action_id)] as [string,string]]:[]),
  );
  const bindings: BusinessCoverageBinding[] = [];
  const steps: Array<{
    id: string;
    description?: string;
    step_order: number;
    endpoint_id?: string;
    event_id?: string;
  }> = [];
  for (const step of [...workflowSteps].sort(
    (left, right) => left.step_order - right.step_order,
  )) {
    const template = await context.db.repos.apiTemplates.findById(
      step.api_template_id,
    );
    const sourceDraftId = String(
      template?.advanced_config?.source_workflow_draft_step_id || "",
    );
    const draft = sourceDraftId ? draftById.get(sourceDraftId) : undefined;
    const observed = draft
      ? endpoints.filter(
          (endpoint) =>
            isProofBindableEndpoint(endpoint) &&
            endpoint.method.toUpperCase() === draft.method.toUpperCase() &&
            canonicalRequestPath(
              endpoint.url || endpoint.path,
              run.base_url,
            ) === canonicalRequestPath(draft.path, run.base_url),
        )
      : [];
    steps.push({
      id: step.id,
      description: step.snapshot_template_name,
      step_order: step.step_order,
      ...(observed.length === 1 ? { endpoint_id: observed[0].id } : {}),
      ...(draft ? { event_id: draft.source_event_id } : {}),
    });
    const actionId = actionByEventId.get(String(draft?.source_event_id || ""));
    if (
      !draft ||
      !actionId ||
      !isSuccessfulCoverageObservation(
        recordingEventById.get(String(draft.source_event_id)) || {},
      )
    )
      continue;
    for (const endpoint of observed) {
      bindings.push({
        target_type: "operation",
        target_id: endpoint.id,
        endpoint_id: endpoint.id,
        source_event_id: draft.source_event_id,
        action_id: actionId,
        source_step_order: step.step_order,
        source_workflow_id: workflowId,
        validated: false,
      });
      for (const feature of features.filter((item) =>
        (item.endpoint_ids || []).includes(endpoint.id),
      )) {
        bindings.push({
          target_type: "feature",
          target_id: feature.id,
          endpoint_id: endpoint.id,
          source_event_id: draft.source_event_id,
          action_id: actionId,
          source_step_order: step.step_order,
          source_workflow_id: workflowId,
          validated: false,
        });
      }
    }
  }
  const unique = new Map<string, BusinessCoverageBinding>();
  for (const binding of bindings) {
    const key = [
      binding.target_type,
      binding.target_id,
      binding.endpoint_id,
      binding.source_event_id,
      binding.source_step_order,
    ].join(":");
    unique.set(key, binding);
  }
  return { steps, bindings: [...unique.values()] };
}

/** Seal the strict objective's final browser-action provenance before native
 * execution.  This is deliberately separate from discovery coverage: an
 * objective can expose a final confirmation action only after an earlier
 * browser step has changed the page. */
async function deriveObjectiveCompletionBinding(
  context: AgentToolContext,
  workflowId: string,
  session: RecordingSession,
  flow: Record<string, any>,
  selectedEventIds: Set<string>,
): Promise<Record<string, any> | undefined> {
  const requirement = objectiveCompletionRequirement(flow);
  if (!requirement) return undefined;
  const [steps, artifacts] = await Promise.all([
    context.db.repos.workflowSteps.findAll({
      where: { workflow_id: workflowId } as any,
    }),
    context.repo.listArtifacts(context.scanRunId),
  ]);
  const orderedSteps = [...steps].sort(
    (left, right) => left.step_order - right.step_order,
  );
  const templates = await Promise.all(
    orderedSteps.map((step) =>
      context.db.repos.apiTemplates.findById(step.api_template_id),
    ),
  );
  const redaction = await recordingRedaction(context, session, artifacts);
  const candidates = (
    await objectiveCompletionCandidates(
      context,
      session,
      flow,
      artifacts,
      redaction,
    )
  ).filter((candidate) => selectedEventIds.has(candidate.event_id));
  if (!candidates.length) {
    throw new ObjectiveCompletionCandidateRequiredError(
      [],
      requirement.required_response_paths,
    );
  }
  const candidateIds = new Set(
    candidates.map((candidate) => candidate.event_id),
  );
  const drafts = await context.db.repos.workflowDraftSteps.findAll({
    where: { session_id: session.id } as any,
  });
  const draftById = new Map(drafts.map((step) => [step.id, step]));
  const source_step_orders = orderedSteps
    .flatMap((step, index) => {
      const sourceId = sourceDraftStepId(templates[index]);
      const source = sourceId ? draftById.get(sourceId) : undefined;
      return source && candidateIds.has(String(source.source_event_id || ""))
        ? [Number(step.step_order)]
        : [];
    })
    .filter((order) => Number.isInteger(order) && order > 0);
  if (!source_step_orders.length) {
    throw new ObjectiveCompletionCandidateRequiredError(
      [],
      requirement.required_response_paths,
    );
  }
  return {
    required_response_paths: requirement.required_response_paths,
    source_event_ids: candidates.map((candidate) => candidate.event_id),
    action_ids: [
      ...new Set(candidates.map((candidate) => candidate.action_id)),
    ],
    source_workflow_id: workflowId,
    source_step_orders: [...new Set(source_step_orders)].sort(
      (left, right) => left - right,
    ),
    validated: false,
  };
}

/** Bind the selected source workflow to the exact server-sealed write operation. */
async function deriveObjectiveOperationBinding(
  context: AgentToolContext,
  workflowId: string,
  session: RecordingSession,
  flow: Record<string, any>,
  selectedEventIds: Set<string>,
): Promise<Record<string, any> | undefined> {
  const req = objectiveOperationRequirement(flow);
  if (!req) return undefined;
  const [steps, artifacts] = await Promise.all([
    context.db.repos.workflowSteps.findAll({
      where: { workflow_id: workflowId } as any,
    }),
    context.repo.listArtifacts(context.scanRunId),
  ]);
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order),
    templates = await Promise.all(
      ordered.map((step) =>
        context.db.repos.apiTemplates.findById(step.api_template_id),
      ),
    ),
    redaction = await recordingRedaction(context, session, artifacts);
  const candidates = (
    await objectiveOperationCandidates(
      context,
      session,
      flow,
      artifacts,
      redaction,
    )
  ).filter((candidate) => selectedEventIds.has(candidate.event_id));
  if (!candidates.length)
    throw new ObjectiveOperationCandidateRequiredError(
      [],
      req.operation_id,
      req.side_effect_class,
    );
  const ids = new Set(candidates.map((item) => item.event_id)),
    drafts = await context.db.repos.workflowDraftSteps.findAll({
      where: { session_id: session.id } as any,
    }),
    byId = new Map(drafts.map((step) => [step.id, step]));
  const source_step_orders = ordered
    .flatMap((step, index) => {
      const sourceId = sourceDraftStepId(templates[index]),
        source = sourceId ? byId.get(sourceId) : undefined;
      return source && ids.has(String(source.source_event_id || ""))
        ? [Number(step.step_order)]
        : [];
    })
    .filter((order) => Number.isInteger(order) && order > 0);
  if (!source_step_orders.length)
    throw new ObjectiveOperationCandidateRequiredError(
      [],
      req.operation_id,
      req.side_effect_class,
    );
  return {
    operation_id: req.operation_id,
    side_effect_class: req.side_effect_class,
    source_event_ids: candidates.map((item) => item.event_id),
    action_ids: [...new Set(candidates.map((item) => item.action_id))],
    source_workflow_id: workflowId,
    source_step_orders: [...new Set(source_step_orders)].sort((a, b) => a - b),
    validated: false,
  };
}

export async function requireBusinessRecording(
  context: AgentToolContext,
  sessionId: string,
): Promise<RecordingSession> {
  const session = await context.db.repos.recordingSessions.findById(sessionId);
  if (
    !session ||
    session.capture_filters?.source !== SOURCE ||
    session.capture_filters?.scan_run_id !== context.scanRunId
  )
    throw new Error("Recording session is not owned by this assessment.");
  await requireBusinessFlow(
    context,
    String(session.capture_filters.flow_id || ""),
  );
  return session;
}

/** A normal-learning task owns one persisted flow.  Browser contexts may be
 * intentionally shared by identity, but a capture/workflow may never cross
 * that task/flow boundary. */
async function requireCurrentBusinessLearningFlow(
  context: AgentToolContext,
  flowId: string,
): Promise<Record<string, any>> {
  const taskId = String(context.taskId || "");
  if (!taskId)
    throw new Error("Business learning requires an owned current task.");
  const task = await context.repo.getTask(taskId);
  if (
    !task ||
    task.execution_plan?.intent !== BUSINESS_LEARNING_INTENT ||
    String(task.execution_plan?.flow_id || "") !== flowId
  ) {
    throw new Error(
      "Business capture and workflow operations belong only to the current normal-learning task flow.",
    );
  }
  const flow = await requireBusinessFlow(context, flowId);
  if (
    flow.owner_task_id &&
    flow.owner_task_id !== taskId &&
    !(await isAuthorizedBusinessCoverageRetryTask(context, task, flow))
  ) {
    throw new Error(
      "Business flow is owned by a different normal-learning task.",
    );
  }
  return flow;
}

export async function requireCurrentBusinessLearningRecording(
  context: AgentToolContext,
  sessionId: string,
): Promise<RecordingSession> {
  const session = await requireBusinessRecording(context, sessionId);
  const filters = session.capture_filters || {};
  const flowId = String(filters.flow_id || "");
  await requireCurrentBusinessLearningFlow(context, flowId);
  if (String(filters.task_id || "") !== String(context.taskId || "")) {
    throw new Error(
      "Business recording is owned by a different normal-learning task.",
    );
  }
  return session;
}

/**
 * Resolve the capture that the current normal-learning task already owns.
 *
 * A recording-session ID is executor plumbing, rather than a business choice:
 * the model chooses captured events, assertions, and mappings, but it must not
 * replay an opaque handle from an earlier turn. The Flow is the server-owned
 * binding from this task to its one live or stopped capture. Strict ownership
 * checks remain in place so a stale Flow pointer fails closed.
 */
export async function resolveCurrentBusinessLearningRecording(
  context: AgentToolContext,
): Promise<RecordingSession> {
  const taskId = String(context.taskId || "");
  if (!taskId)
    throw new Error("Business learning requires an owned current task.");
  const task = await context.repo.getTask(taskId);
  const flowId = String(task?.execution_plan?.flow_id || "");
  if (!flowId)
    throw new Error(
      "Business capture and workflow operations require the current normal-learning task flow.",
    );
  const flow = await requireCurrentBusinessLearningFlow(context, flowId);
  const sessionId = String(flow.recording_session_id || "");
  if (!sessionId)
    throw new Error(
      "The current normal-learning task has no server-bound recording.",
    );
  return requireCurrentBusinessLearningRecording(context, sessionId);
}

/** A normal Flow that names an execution identity must establish that identity
 * inside this Flow's own capture.  A shared identity context can carry a
 * discovery cookie, which makes an authenticated browser action look valid
 * while leaving no native login/session source for workflow replay. */
function requiresPreparedIdentityLogin(identity: string): boolean {
  return Boolean(identity) && identity !== "anonymous";
}

function preparedIdentityResolutionError(
  identity: string,
  resolution: Exclude<
    PreparedBrowserIdentityResolution,
    { status: "resolved" }
  >,
): string {
  if (resolution.status === "ambiguous_scan_bound_account") {
    return `Normal Flow identity ${identity} has ${resolution.account_count} active scan-bound accounts. Resolve the duplicate role binding before recording; the Agent will not choose one credential record.`;
  }
  if (resolution.status === "credentials_unavailable") {
    return `Normal Flow identity ${identity} has a scan-bound account but no usable username/password browser credential. Update that exact account before recording; configuration fallback is disabled.`;
  }
  if (resolution.status === "account_not_bound") {
    return `The requested capture account is not the exact active scan-bound account for normal Flow identity ${identity}.`;
  }
  if (resolution.status === "scan_bound_account_missing") {
    return `Normal Flow identity ${identity} has no active scan-bound account with a durable browser credential binding. Create one before recording; configuration fallback is disabled.`;
  }
  return "The normal Flow identity is invalid for prepared browser login.";
}

async function ensureCoverageRetryRecoveryContextReset(
  context: AgentToolContext,
  input: { flowId: string; attempt: number },
): Promise<string | undefined> {
  const taskId = String(context.taskId || "");
  if (!taskId)
    throw new Error("Coverage retry context reset requires an owned task.");
  const reset = {
    scanRunId: context.scanRunId,
    taskId,
    flowId: input.flowId,
    attempt: input.attempt,
  };
  const lockKey = `${reset.scanRunId}:${reset.taskId}:${reset.flowId}:${reset.attempt}`;
  const inFlight = coverageRetryContextResetLocks.get(lockKey);
  if (inFlight) return inFlight;
  const work = (async () => {
    const expected = (artifact: AIScanArtifact) =>
      matchesCoverageRetryContextResetArtifact(artifact, reset);
    const related = (artifact: AIScanArtifact) =>
      isRelatedCoverageRetryContextResetArtifact(artifact, reset);
    const existing = await context.repo.listArtifacts(reset.scanRunId);
    if (existing.some(expected))
      return coverageRetryContextResetArtifactId(
        reset.scanRunId,
        taskId,
        reset.flowId,
        reset.attempt,
      );
    // An artifact for the same recovery boundary must be exactly the expected
    // deterministic audit record. Do not let a partial/forged record suppress
    // the reset or cause a second audit chain to be silently accepted.
    if (existing.some(related))
      throw new Error(
        "Coverage retry context reset artifact identity mismatch.",
      );
    const closedContextCount = await closeTaskBrowserContexts(
      context.repo,
      reset.scanRunId,
      taskId,
    );
    const artifactInput = {
      id: coverageRetryContextResetArtifactId(
        reset.scanRunId,
        taskId,
        reset.flowId,
        reset.attempt,
      ),
      scan_run_id: reset.scanRunId,
      task_id: taskId,
      artifact_type: "business_coverage_retry_context_reset",
      source_ref: coverageRetryContextResetSourceRef(taskId, reset.attempt),
      title: "Coverage retry browser context reset",
      content_json: {
        flow_id: reset.flowId,
        recovery_attempt: reset.attempt,
        scope_type: "task",
        reset_reason: "coverage_retry_completion_gap",
        closed_task_context_count: closedContextCount,
      },
    };
    try {
      return (await context.repo.createArtifact(artifactInput)).id;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const concurrent = (
        await context.repo.listArtifacts(reset.scanRunId)
      ).find(expected);
      if (!concurrent) throw error;
      return concurrent.id;
    }
  })();
  coverageRetryContextResetLocks.set(lockKey, work);
  try {
    return await work;
  } finally {
    if (coverageRetryContextResetLocks.get(lockKey) === work)
      coverageRetryContextResetLocks.delete(lockKey);
  }
}

/** Raw events have a separate private artifact; the existing recorder remains
 * the canonical event/field/variable pipeline. Repeated HTTP calls retain their
 * request-start sequence even when responses arrive out of order. */
export async function startBusinessCapture(
  context: AgentToolContext,
  input: BusinessCaptureStart,
): Promise<Record<string, any>> {
  assertScanActive();
  const flow = await requireCurrentBusinessLearningFlow(context, input.flow_id),
    run = await context.repo.getRun(context.scanRunId);
  if (!run) throw new Error("Assessment not found.");
  const currentTask = await context.repo.getTask(String(context.taskId || ""));
  // Only the scheduler can authorize this retry after a persisted
  // coverage-binding gap. A model cannot turn an arbitrary failed validation
  // into a second recording by passing an input flag or copying task-plan data.
  const coverageRetry = await isAuthorizedBusinessCoverageRetryTask(
    context,
    currentTask,
    flow,
  );
  const completionRecovery = coverageRetry
    ? currentTask?.execution_plan?.coverage_retry?.completion_recovery
    : undefined;
  // A retry inherits the Flow's immutable parent evidence, so its first fresh
  // task capture is allowed even though that Flow already names a recording
  // and Test Run. Once this retry itself owns a recording, another capture
  // would let a model discard its current evidence path. Only terminal
  // reconciliation may persist capture_required for the one recovery below.
  const retryAlreadyOwnsCapture =
    coverageRetry &&
    Boolean(context.taskId) &&
    (await context.db.repos.recordingSessions.findAll()).some((session) => {
      const filters = session.capture_filters || {};
      return (
        filters.source === SOURCE &&
        String(filters.scan_run_id || "") === context.scanRunId &&
        String(filters.task_id || "") === String(context.taskId || "") &&
        String(filters.flow_id || "") === input.flow_id
      );
    });
  if (
    coverageRetry &&
    retryAlreadyOwnsCapture &&
    completionRecovery?.status !== "capture_required"
  ) {
    throw new Error(
      "An existing business capture belongs to this coverage-retry task. Only server-authorized completion recovery may start another capture.",
    );
  }
  // A Flow with an existing recording/workflow/run is an immutable evidence
  // chain. A fresh capture would let a model discard a failed semantic or
  // execution result instead of inspecting, repairing, and revalidating the
  // same native assets. Interrupted captures are terminal blockers in this
  // bounded task; recovery begins only in a newly planned Flow.
  const runArtifacts = await context.repo.listArtifacts(context.scanRunId);
  const hasPriorNativeValidation = runArtifacts.some(
    (artifact) =>
      artifact.artifact_type === "business_workflow_validation" &&
      artifact.content_json?.flow_id === input.flow_id &&
      typeof artifact.content_json?.workflow_id === "string" &&
      typeof artifact.content_json?.test_run_id === "string",
  );
  if (
    ((flow.workflow_id && flow.normal_run_id) || hasPriorNativeValidation) &&
    !coverageRetry
  ) {
    throw new Error(
      "The current normal Flow already has native workflow/Test Run evidence. Inspect, repair when needed, and revalidate that same workflow instead of starting a new capture.",
    );
  }
  if (flow.recording_session_id) {
    const prior = await context.db.repos.recordingSessions.findById(
      flow.recording_session_id,
    );
    if (prior?.capture_filters?.capture_status === "recording") {
      throw new Error(
        "The current normal Flow already has an active recording. Continue it in its bound browser context or stop it before preparing the Workflow.",
      );
    }
    if (
      prior?.capture_filters?.capture_status === "stopped" &&
      !coverageRetry
    ) {
      throw new Error(
        "The current normal Flow already has a complete recording. Prepare and inspect that same recording instead of starting a new capture.",
      );
    }
  }
  const identity = String(input.identity_key || flow.role || "");
  if (flow.role && identity !== flow.role)
    throw new Error("Capture identity must match this business flow role.");
  const preparedIdentity = requiresPreparedIdentityLogin(identity);
  let accountId: string | undefined;
  if (preparedIdentity) {
    // Resolve the Account ID and actual browser credential together before the
    // recording exists. The later trusted login re-resolves only this exact
    // persisted account, so browser action, recording, Test Run and proof all
    // name the same identity source.
    const resolution = await resolvePreparedBrowserIdentity({
      db: context.db,
      scan_run_id: context.scanRunId,
      identity_key: identity,
      account_id: input.account_id,
    });
    if (resolution.status !== "resolved")
      throw new Error(preparedIdentityResolutionError(identity, resolution));
    accountId = resolution.binding.account_id;
  } else {
    const account = input.account_id
      ? await context.db.repos.accounts.findById(input.account_id)
      : undefined;
    if (
      input.account_id &&
      (!account ||
        account.status !== "active" ||
        !(account.tags || []).includes(`scan:${context.scanRunId}`))
    )
      throw new Error(
        "Capture account must be an active account belonging to this assessment.",
      );
    accountId = account?.id;
  }
  // A task context is deliberately canonical rather than model-selected here.
  // It starts without discovery's authenticated state, records the real login,
  // and makes a replayable session jar possible for the native Workflow.
  // The completion-gap recovery may follow a capture that authenticated an
  // anonymous Flow through its UI, too.  Therefore every scheduler-authorized
  // recovery gets a new task context, rather than limiting the reset to
  // prepared-identity flows.
  const recoveryContextReset = Boolean(
    completionRecovery?.status === "capture_required",
  );
  const requiredContext =
    preparedIdentity || recoveryContextReset
      ? browserContextKey({
          scope_type: "task",
          task_id: context.taskId,
          identity_key: identity || undefined,
        })
      : undefined;
  // Capture scope is executor-owned plumbing, not a model-owned business
  // decision. In particular, an authenticated Flow must never fail simply
  // because the model echoed a discovery identity context: discard any
  // supplied scope/context and always create this task's fresh login capture.
  const captureScope =
    preparedIdentity || recoveryContextReset ? "task" : input.scope_type;
  const captureContextKey =
    preparedIdentity || recoveryContextReset
      ? requiredContext!.key
      : input.context_key;
  // A coverage retry normally owns a new task context. Its one completion-gap
  // recovery happens inside that same task, however, so the canonical task key
  // may still point to the first capture's authenticated browser. Reset only
  // this server-scheduled recovery boundary before it creates its recording.
  // No browser action, event sequence, or assertion is selected here.
  let recoveryContextResetArtifactId: string | undefined;
  if (recoveryContextReset) {
    recoveryContextResetArtifactId =
      await ensureCoverageRetryRecoveryContextReset(context, {
        flowId: input.flow_id,
        attempt: Number(completionRecovery?.attempt || 1),
      });
  }
  const session = await createRecordingSession(context.db, {
    name: String(input.name || flow.name || flow.goal || "正常业务录制").slice(
      0,
      200,
    ),
    mode: "workflow",
    intent: "learning_seed",
    source_tool: "bstg.business.capture",
    role: identity || undefined,
    account_id: accountId,
    capture_filters: {
      source: SOURCE,
      scan_run_id: context.scanRunId,
      task_id: context.taskId,
      flow_id: input.flow_id,
      identity_key: identity,
      context_key: captureContextKey,
      scope_type: captureScope,
      preserve_repeated_events: true,
      capture_status: "recording",
      prepared_identity_login_required: preparedIdentity,
      ...(preparedIdentity ? { identity_account_id: accountId } : {}),
    },
    requested_field_names: input.field_names,
    target_fields: (input.field_names || []).map((name) => ({ name })),
  });
  let tail = Promise.resolve();
  const errors: string[] = [];
  const sink = {
    id: session.id,
    sensitiveFieldNames: input.field_names,
    record: (event: BusinessBrowserCaptureEvent) => {
      const write = tail.then(async () => {
        assertUrlInTargetScope(event.url, run.base_url);
        if (event.identity_key !== identity)
          throw new Error("Captured request identity mismatch.");
        const raw = await context.repo.createArtifact({
          scan_run_id: context.scanRunId,
          task_id: event.task_id || context.taskId,
          artifact_type: "business_capture_event",
          source_ref: session.id,
          title: `业务请求 ${event.sequence}`,
          content_json: {
            ...event,
            flow_id: input.flow_id,
            recording_session_id: session.id,
            private: true,
          },
        });
        await ingestRecordingEventsBatch(context.db, session.id, [
          {
            sequence: event.sequence,
            source_tool: "bstg.business.capture",
            method: event.method,
            url: event.url,
            request_headers: event.request_headers,
            request_body_text: event.request_body_text,
            response_status: event.response_status,
            response_headers: event.response_headers,
            response_body_text: event.response_body_text,
          },
        ]);
        const row = (
          await context.db.repos.recordingEvents.findAll({
            where: { session_id: session.id, sequence: event.sequence } as any,
            limit: 1,
          })
        )[0];
        if (!row)
          throw new Error(
            "Recorded request did not produce a canonical recording event.",
          );
        await context.repo.createArtifact({
          scan_run_id: context.scanRunId,
          task_id: event.task_id || context.taskId,
          artifact_type: "business_capture_event_link",
          source_ref: session.id,
          title: `业务步骤 ${event.sequence}`,
          content_json: {
            flow_id: input.flow_id,
            recording_session_id: session.id,
            recording_event_id: row.id,
            raw_artifact_id: raw.id,
            sequence: event.sequence,
            action_id: event.action_id,
            task_id: event.task_id,
            identity_key: event.identity_key,
            complete: event.complete,
          },
        });
      });
      tail = write.catch((error) => {
        errors.push(String(error?.message || error));
      });
      return write;
    },
    ended: async (
      reason: BusinessCaptureEndReason,
      captureErrors: string[],
    ) => {
      await tail;
      const current = await context.db.repos.recordingSessions.findById(
        session.id,
      );
      if (!current) return;
      const interrupted =
        reason === "context_closed" || reason === "task_terminal";
      const gaps = [...captureErrors, ...errors],
        state = interrupted
          ? "interrupted"
          : gaps.length
            ? "incomplete"
            : "stopped";
      await context.db.repos.recordingSessions.update(session.id, {
        status: state === "interrupted" ? "failed" : "finished",
        finished_at: new Date().toISOString(),
        capture_filters: { ...current.capture_filters, capture_status: state },
        summary: { ...current.summary, capture_errors: gaps },
      } as any);
      const captureArtifact = await context.repo.createArtifact({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        artifact_type: "business_capture_session",
        source_ref: session.id,
        title: "正常业务录制状态",
        content_json: {
          flow_id: input.flow_id,
          recording_session_id: session.id,
          status: state,
          event_count: current.event_count,
          errors: gaps,
        },
      });
      if (state !== "stopped") {
        const flow = await requireBusinessFlow(context, input.flow_id);
        await flowEvent(context, input.flow_id, {
          status: "blocked",
          blockers:
            state === "interrupted"
              ? [
                  reason === "task_terminal"
                    ? "所属任务已结束，正常业务录制已中断。"
                    : "浏览器关闭，正常业务录制已中断。",
                ]
              : gaps,
          evidence_artifact_ids: [
            ...new Set([
              ...(flow.evidence_artifact_ids || []),
              captureArtifact.id,
            ]),
          ],
        });
      }
    },
  };
  try {
    const started = await startPersistentBusinessCapture({
      repo: context.repo,
      scanRunId: context.scanRunId,
      taskId: context.taskId,
      scope_base_url: run.base_url,
      scope_type: captureScope,
      identity_key: identity || undefined,
      context_key: captureContextKey,
      sink,
      signal: context.signal,
      credential_boundary: preparedIdentity,
      authentication_origins: run.scan_config?.authentication_origins,
    });
    const browserContext = browserContextKey({
      context_key: started.context_key,
      task_id: context.taskId,
      identity_key: identity || undefined,
    });
    const recordingIdentity = browserContext.identity || identity || undefined;
    await context.db.repos.recordingSessions.update(session.id, {
      capture_filters: {
        ...session.capture_filters,
        context_key: browserContext.key,
        scope_type: browserContext.scope,
        identity_key: recordingIdentity,
      },
    } as any);
    // The retry receives a fresh mutable capture/workflow, while every prior
    // validated native proof remains in its append-only ledger and evidence
    // chain. Clearing that ledger would force the child to replay unrelated
    // parent actions and turn a bounded missing-target retry into a full rerun.
    const coverageRetryReset = coverageRetry
      ? {
          workflow_id: undefined,
          normal_run_id: undefined,
          assertions_verified: false,
          baseline_verified: false,
          object_handle_catalog_id: undefined,
          steps: [],
          assertions: [],
          coverage_bindings: [],
          objective_completion_binding: undefined,
          objective_operation_binding: undefined,
          coverage_proof_ledger: appendCoverageProofs(
            flow.coverage_proof_ledger,
            legacyCoverageProofs(flow, runArtifacts),
          ),
        }
      : {};
    await flowEvent(context, input.flow_id, {
      ...coverageRetryReset,
      status: "learning",
      recording_session_id: session.id,
      recording_context_key: browserContext.key,
      recording_context_scope: browserContext.scope,
      recording_identity_key: recordingIdentity,
      blockers: [],
    });
    return {
      recording_session_id: session.id,
      flow_id: input.flow_id,
      identity_key: recordingIdentity,
      context_key: browserContext.key,
      context_scope: browserContext.scope,
      capture_status: "recording",
      prepared_identity_login_required: preparedIdentity,
      identity_account_bound: Boolean(accountId),
      coverage_retry: coverageRetry,
      ...(recoveryContextResetArtifactId
        ? { recovery_context_reset_artifact_id: recoveryContextResetArtifactId }
        : {}),
    };
  } catch (error) {
    await context.db.repos.recordingSessions.update(session.id, {
      status: "failed",
      capture_filters: { ...session.capture_filters, capture_status: "failed" },
      summary: { ...session.summary, error: String(error) },
    } as any);
    throw error;
  }
}

/** Derive semantic candidates from private capture storage without returning
 * any transport values. This is the same assertion projection later exposed
 * by capture.inspect, so stop and prepare share one semantic definition. */
async function semanticCaptureCandidateEventIds(
  context: AgentToolContext,
  session: RecordingSession,
): Promise<string[]> {
  const [artifacts, events] = await Promise.all([
    context.repo.listArtifacts(context.scanRunId),
    context.db.repos.recordingEvents.findAll({
      where: { session_id: session.id } as any,
    }),
  ]);
  const redaction = await recordingRedaction(context, session, artifacts);
  const actionAttributedEventIds = linkedActionAttributedCaptureEventIds({
    artifacts,
    events,
    session,
    taskId: String(context.taskId || ""),
    flowId: String(session.capture_filters?.flow_id || ""),
  });
  const candidates: string[] = [];
  for (const artifact of artifacts.filter(
    (item) =>
      item.artifact_type === "business_capture_event" &&
      item.source_ref === session.id,
  )) {
    const raw = artifact.content_json as BusinessBrowserCaptureEvent;
    const link = artifacts.find(
      (item) =>
        item.artifact_type === "business_capture_event_link" &&
        item.content_json.raw_artifact_id === artifact.id,
    );
    const eventId = String(link?.content_json?.recording_event_id || "");
    if (
      !actionAttributedEventIds.has(eventId) ||
      !responseAssertionProjection(raw, redaction).semantic_body_path_available
    )
      continue;
    candidates.push(eventId);
  }
  return [...new Set(candidates)].slice(0, 80);
}

export async function stopBusinessCapture(
  context: AgentToolContext,
  sessionId: string,
): Promise<Record<string, any>> {
  const session = await requireCurrentBusinessLearningRecording(
      context,
      sessionId,
    ),
    filters = session.capture_filters!;
  if (
    filters.capture_status === "recording" &&
    Number(session.event_count || 0) < 1
  ) {
    throw new Error(
      "The active normal-business recording has no completed browser request. Navigate or interact in its bound browser context before stopping it.",
    );
  }
  if (
    filters.capture_status === "recording" &&
    !(await semanticCaptureCandidateEventIds(context, session)).length
  ) {
    // Leave the persistent capture active. A navigation/HTML-only trace cannot
    // produce the required semantic assertion, so sealing it would create an
    // impossible assertion-revision loop.
    throw new SemanticBodyCandidateRequiredError([]);
  }
  if (filters.capture_status === "recording") {
    const flow = await requireBusinessFlow(
      context,
      String(filters.flow_id || ""),
    );
    const requirement = objectiveCompletionRequirement(flow);
    if (requirement) {
      const candidates = await objectiveCompletionCandidates(
        context,
        session,
        flow,
      );
      if (!candidates.length)
        throw new ObjectiveCompletionCandidateRequiredError(
          [],
          requirement.required_response_paths,
        );
    }
    const operation = objectiveOperationRequirement(flow);
    if (
      operation &&
      !(await objectiveOperationCandidates(context, session, flow)).length
    )
      throw new ObjectiveOperationCandidateRequiredError(
        [],
        operation.operation_id,
        operation.side_effect_class,
      );
  }
  if (filters.capture_status === "recording")
    await stopPersistentBusinessCapture({
      scanRunId: context.scanRunId,
      taskId: context.taskId,
      capture_id: session.id,
      context_key: filters.context_key,
      scope_type: filters.scope_type,
      identity_key: filters.identity_key || undefined,
    });
  return inspectBusinessCapture(context, session.id);
}

/**
 * Task-finalization backstop for captures that are deliberately attached to a
 * shared identity/scan browser context.  The live runtime ends those captures
 * under its per-context lease; this layer then recovers a recording row left
 * as `recording` after a process/browser interruption, so a later task cannot
 * inherit a stale capture boundary or accidentally compile a partial flow.
 */
export async function interruptBusinessCapturesForTask(
  context: AgentToolContext,
): Promise<{
  live_interrupted: number;
  recovered_recordings: number;
  errors: string[];
  unresolved_recording_ids: string[];
}> {
  if (!context.taskId)
    return {
      live_interrupted: 0,
      recovered_recordings: 0,
      errors: [],
      unresolved_recording_ids: [],
    };
  const live = await interruptPersistentBusinessCapturesForTask({
    scanRunId: context.scanRunId,
    taskId: context.taskId,
  });
  const errors = [...live.errors];
  const sessions = await context.db.repos.recordingSessions.findAll();
  const stranded = sessions.filter((session) => {
    const filters = session.capture_filters || {};
    return (
      filters.source === SOURCE &&
      filters.scan_run_id === context.scanRunId &&
      filters.task_id === context.taskId &&
      filters.capture_status === "recording"
    );
  });
  let recovered = 0;
  for (const session of stranded) {
    const filters = session.capture_filters || {},
      flowId = String(filters.flow_id || "");
    const reason =
      "The owner task reached a terminal state before this browser capture was stopped.";
    const prior = Array.isArray(session.summary?.capture_errors)
      ? session.summary.capture_errors.map(String)
      : [];
    try {
      await context.db.repos.recordingSessions.update(session.id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        capture_filters: { ...filters, capture_status: "interrupted" },
        summary: { ...session.summary, capture_errors: [...prior, reason] },
      } as any);
      const captureArtifact = await context.repo.createArtifact({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        artifact_type: "business_capture_session",
        source_ref: session.id,
        title: "正常业务录制状态",
        content_json: {
          flow_id: flowId,
          recording_session_id: session.id,
          status: "interrupted",
          event_count: session.event_count,
          errors: [...prior, reason],
          recovered_after_task_terminal: true,
        },
      });
      if (flowId) {
        const flow = await requireBusinessFlow(context, flowId);
        await flowEvent(context, flowId, {
          status: "blocked",
          blockers: ["所属任务已结束，正常业务录制已中断。"],
          evidence_artifact_ids: [
            ...new Set([
              ...(flow.evidence_artifact_ids || []),
              captureArtifact.id,
            ]),
          ],
        });
      }
      recovered += 1;
    } catch (error: any) {
      errors.push(`${session.id}: ${error?.message || String(error)}`);
    }
  }
  const remaining = (await context.db.repos.recordingSessions.findAll())
    .filter((session) => {
      const filters = session.capture_filters || {};
      return (
        filters.source === SOURCE &&
        filters.scan_run_id === context.scanRunId &&
        filters.task_id === context.taskId &&
        filters.capture_status === "recording"
      );
    })
    .map((session) => session.id);
  return {
    live_interrupted: live.interrupted,
    recovered_recordings: recovered,
    errors,
    unresolved_recording_ids: remaining,
  };
}

export async function inspectBusinessCapture(
  context: AgentToolContext,
  sessionId: string,
): Promise<Record<string, any>> {
  const session = await requireCurrentBusinessLearningRecording(
    context,
    sessionId,
  );
  const artifacts = await context.repo.listArtifacts(context.scanRunId);
  const redaction = await recordingRedaction(context, session, artifacts);
  const flow = await requireBusinessFlow(
    context,
    String(session.capture_filters!.flow_id || ""),
  );
  const completion = objectiveCompletionRequirement(flow);
  const completionCandidates = completion
    ? await objectiveCompletionCandidates(
        context,
        session,
        flow,
        artifacts,
        redaction,
      )
    : [];
  const operation = objectiveOperationRequirement(flow);
  const operationCandidates = operation
    ? await objectiveOperationCandidates(
        context,
        session,
        flow,
        artifacts,
        redaction,
      )
    : [];
  const recordingEvents = (
    await context.db.repos.recordingEvents.findAll({
      where: { session_id: session.id } as any,
    })
  ).sort(
    (left, right) => Number(left.sequence || 0) - Number(right.sequence || 0),
  );
  const rawByEventId = currentCapturedEventSources({
    artifacts,
    events: recordingEvents,
    session,
    taskId: String(context.taskId || ""),
    flowId: String(session.capture_filters!.flow_id || ""),
  });
  const actionAttributedEventIds = new Set(rawByEventId.keys());
  const workflowEligibleEventIds = await workflowEligibleCaptureEventIds(
    context,
    session,
    recordingEvents,
    rawByEventId,
  );
  const coverageByEvent = await coverageTargetsByRecordedEvent(
    context,
    recordingEvents.filter((event) => actionAttributedEventIds.has(event.id)),
  );
  const retryTargets = await currentCoverageRetryTargets(context, session);
  const retryTargetEventCandidates = coverageRetryEventCandidates(
    retryTargets,
    coverageByEvent,
  );
  const events = artifacts
    .filter(
      (a) =>
        a.artifact_type === "business_capture_event" &&
        a.source_ref === session.id,
    )
    .sort((a, b) => a.content_json.sequence - b.content_json.sequence)
    .map((a) => {
      const event = a.content_json as BusinessBrowserCaptureEvent;
      const link = artifacts.find(
        (item) =>
          item.artifact_type === "business_capture_event_link" &&
          item.content_json.raw_artifact_id === a.id,
      );
      const assertionProjection = responseAssertionProjection(event, redaction);
      const eventId=String(link?.content_json.recording_event_id||'');
      const actionAttributed=actionAttributedEventIds.has(eventId);
      const workflowEligible=workflowEligibleEventIds.has(eventId);
      const transactionIntent=event.action_intent as TransactionPrerequisiteEventIntent | undefined;
      return {
        sequence: event.sequence,
        // Only a task-bound action source which the native generator can
        // replay receives a model-selectable ID. Background and static/poll
        // evidence remain visible as capture facts but cannot poison an
        // initial Workflow or later immutable revision.
        event_id: workflowEligible ? link?.content_json.recording_event_id : undefined,
        raw_artifact_id: a.id,
        action_id: workflowEligible && actionAttributed ? event.action_id : undefined,
        action: workflowEligible && actionAttributed ? event.action : "background",
        workflow_eligible: workflowEligible,
        ...(workflowEligible &&
        TRANSACTION_PREREQUISITE_EVENT_INTENTS.includes(transactionIntent as TransactionPrerequisiteEventIntent)
          ? { observed_control_intent: transactionIntent }
          : {}),
        task_id: event.task_id,
        identity_key: event.identity_key,
        method: event.method,
        target: publicBusinessCaptureTarget(event.url),
        status: event.response_status,
        complete: event.complete,
        request: {
          headers: publicHeaders(event.request_headers),
          body: bodySummary(
            event.request_body_text,
            event.request_body_base64,
            event.request_headers["content-type"],
            redaction,
          ),
        },
        response: {
          headers: publicHeaders(event.response_headers),
          body: bodySummary(
            event.response_body_text,
            event.response_body_base64,
            event.response_headers["content-type"],
            redaction,
          ),
        },
        response_summary: assertionProjection.response_summary,
        assertion_paths: assertionProjection.assertion_paths,
        semantic_body_path_available:
          actionAttributed && assertionProjection.semantic_body_path_available,
        observed_coverage_targets: (
          coverageByEvent.get(
            String(link?.content_json.recording_event_id || ""),
          ) || []
        ).map((target) => ({
          target_type: target.target_type,
          target_id: target.target_id,
        })),
        diagnostic: publicDiagnostic(event.error),
      };
    });
  const transactionPrerequisiteCandidates = transactionPrerequisiteEventCandidates(
    flow,
    recordingEvents,
    rawByEventId,
    workflowEligibleEventIds,
  );
  return {
    flow_id: session.capture_filters!.flow_id,
    recording_session_id: session.id,
    status: session.capture_filters!.capture_status,
    identity_key: session.role,
    context_key: session.capture_filters!.context_key,
    context_scope: session.capture_filters!.scope_type,
    event_count: events.length,
    events,
    capture_error_count: (session.summary?.capture_errors || []).length,
    ...(completion
      ? {
          objective_completion: {
            required_response_paths: completion.required_response_paths,
            completion_candidate_event_ids: completionCandidates.map(
              (candidate) => candidate.event_id,
            ),
          },
        }
      : {}),
    ...(operation
      ? {
          objective_operation: {
            operation_id: operation.operation_id,
            side_effect_class: operation.side_effect_class,
            operation_candidate_event_ids: operationCandidates.map(
              (candidate) => candidate.event_id,
            ),
          },
        }
      : {}),
    ...(transactionPrerequisiteCandidates.length
      ? {
          transaction_prerequisite_event_candidates:
            transactionPrerequisiteCandidates.map((candidate) => ({
              intent: candidate.intent,
              event_ids: candidate.event_ids,
            })),
        }
      : {}),
    ...(retryTargets.length
      ? { retry_target_event_candidates: retryTargetEventCandidates }
      : {}),
    notice:
      "Requests are observed facts. A recorded success response does not prove the normal business goal was completed.",
  };
}

function restoredEvent(
  event: RecordingEvent,
  raw: BusinessBrowserCaptureEvent,
): RecordingEvent {
  return {
    ...event,
    request_headers: raw.request_headers,
    request_body_text: raw.request_body_text,
    parsed_request_body: parseObservedBody(
      raw.request_body_text,
      raw.request_headers["content-type"],
    ),
    response_headers: raw.response_headers,
    response_body_text: raw.response_body_text,
    parsed_response_body: parseObservedBody(
      raw.response_body_text,
      raw.response_headers["content-type"],
    ),
  };
}

/**
 * A selected normal Workflow is stronger evidence than a page crawl: its
 * source event is task/flow-bound and the generator has already accepted it
 * as an executable step. Promote only that narrow metadata into the endpoint
 * inventory. The private recording remains the sole request/response
 * baseline; this function never creates endpoint_request evidence or copies
 * headers, bodies, cookies, query values, or response values.
 *
 * The current planning coverage record is intentionally not expanded by these
 * rows. Normal-business learning happens after planning, so adding them to
 * the current target manifest would silently invalidate a model-owned plan.
 * If discovery already owns the same method/path, leave that row and its
 * provenance untouched: it is already available for binding, and rewriting
 * it as runtime-only evidence could make an existing planned target stale.
 */
async function promoteNormalBusinessCaptureEndpoints(
  context: AgentToolContext,
  session: RecordingSession,
  selectedEvents: RecordingEvent[],
  rawByEventId: Map<string, PersistedBusinessBrowserCaptureEvent>,
  generatedSteps: Array<{ source_event_id?: string }>,
): Promise<void> {
  const run = await context.repo.getRun(context.scanRunId);
  if (!run) throw new Error("Assessment not found.");
  const generatedEventIds = new Set(
    generatedSteps
      .map((step) => String(step.source_event_id || ""))
      .filter(Boolean),
  );
  const knownEndpointKeys = new Set(
    (await context.repo.listEndpoints(context.scanRunId)).flatMap(
      (endpoint) => {
        const path = canonicalRequestPath(
          endpoint.url || endpoint.path,
          run.base_url,
        );
        return path
          ? [`${String(endpoint.method || "").toUpperCase()}\u0000${path}`]
          : [];
      },
    ),
  );
  for (const event of selectedEvents) {
    if (!generatedEventIds.has(event.id)) continue;
    const raw = rawByEventId.get(event.id);
    if (!raw)
      throw new Error(
        "A generated normal Workflow step has no task-bound private browser source.",
      );
    const method = String(raw.method || event.method || "").toUpperCase();
    const resourceType = String(raw.resource_type || "").toLowerCase();
    const responseStatus = Number(raw.response_status);
    // A main-document GET is navigation context, even when the generator
    // retains it as a replay prerequisite. It must not become a later
    // operation target or feature edge. XHR/fetch GETs and document form
    // submissions remain useful executable operation metadata.
    if (
      !method ||
      (resourceType === "document" && method === "GET") ||
      !Number.isInteger(responseStatus) ||
      responseStatus < 200 ||
      responseStatus >= 400
    )
      continue;
    let url: URL;
    let path: string | undefined;
    try {
      url = new URL(raw.url, run.base_url);
      path = canonicalRequestPath(url.toString(), run.base_url);
    } catch {
      continue;
    }
    if (!path) continue;
    const endpointKey = `${method}\u0000${path}`;
    if (knownEndpointKeys.has(endpointKey)) continue;
    await context.repo.upsertEndpoint({
      scan_run_id: context.scanRunId,
      method,
      path,
      url: `${url.origin}${path}`,
      source_type: "normal_business_capture",
      source_id: session.id,
      auth_required: String(session.role || "") !== "anonymous",
      request_summary: `Observed model-selected normal Workflow ${method} operation`,
      response_summary: `Observed normal Workflow HTTP ${responseStatus}`,
    });
    knownEndpointKeys.add(endpointKey);
  }
}

/** Finish, generate and promote through the established recording services.
 * Private captured values only restore the executor's request snapshot; the
 * model sees fields/references and chooses which learned mappings to apply. */
export async function prepareBusinessWorkflow(
  context: AgentToolContext,
  input: { recording_session_id: string; event_ids: string[]; name?: string },
): Promise<Record<string, any>> {
  assertScanActive();
  const session = await requireCurrentBusinessLearningRecording(
    context,
    input.recording_session_id,
  );
  const flow = await requireBusinessFlow(
    context,
    String(session.capture_filters!.flow_id || ""),
  );
  if (session.capture_filters!.capture_status !== "stopped")
    throw new Error("Stop a complete recording before preparing its workflow.");
  const requestedIds = Array.isArray(input.event_ids)
    ? input.event_ids.map((value) => String(value || "")).filter(Boolean)
    : [];
  if (!requestedIds.length)
    throw new Error(
      "event_ids must explicitly select one or more observed events from this stopped recording.",
    );
  const allArtifacts = await context.repo.listArtifacts(context.scanRunId);
  const awaitedRedaction = await recordingRedaction(
    context,
    session,
    allArtifacts,
  );
  const rawEvents = allArtifacts
    .filter(
      (a) =>
        a.artifact_type === "business_capture_event" &&
        a.source_ref === session.id,
    )
    .map((a) => a.content_json as BusinessBrowserCaptureEvent);
  if (!rawEvents.length || rawEvents.some((event) => !event.complete))
    throw new Error("The recording has missing or incomplete requests.");
  if (rawEvents.some((event) => event.request_body_base64))
    throw new Error(
      "This recording includes a binary request body; use the existing multipart executor instead of a text workflow snapshot.",
    );
  const events = (
    await context.db.repos.recordingEvents.findAll({
      where: { session_id: session.id } as any,
    })
  ).sort(
    (left, right) => Number(left.sequence || 0) - Number(right.sequence || 0),
  );
  if (
    new Set(requestedIds).size !== requestedIds.length ||
    requestedIds.some((id) => !events.some((event) => event.id === id))
  )
    throw new Error(
      "event_ids must select unique observed events from this recording.",
    );
  const rawByEventId = currentCapturedEventSources({
    artifacts: allArtifacts,
    events,
    session,
    taskId: String(context.taskId || ""),
    flowId: String(session.capture_filters!.flow_id || ""),
  });
  const actionAttributedEventIds = new Set(rawByEventId.keys());
  const workflowEligibleEventIds = await workflowEligibleCaptureEventIds(
    context,
    session,
    events,
    rawByEventId,
  );
  if (requestedIds.some((eventId) => !workflowEligibleEventIds.has(eventId)))
    throw new WorkflowEligibleEventSelectionError([
      ...workflowEligibleEventIds,
    ]);
  const semanticCandidateEventIds = events.flatMap((event) => {
    const raw = rawByEventId.get(event.id);
    return workflowEligibleEventIds.has(event.id) &&
      raw &&
      responseAssertionProjection(raw, awaitedRedaction)
        .semantic_body_path_available
      ? [event.id]
      : [];
  });
  if (
    !requestedIds.some((eventId) => semanticCandidateEventIds.includes(eventId))
  ) {
    throw new SemanticBodyCandidateRequiredError(semanticCandidateEventIds);
  }
  const completion = objectiveCompletionRequirement(flow);
  const completionCandidates = completion
    ? (
        await objectiveCompletionCandidates(
          context,
          session,
          flow,
          allArtifacts,
          awaitedRedaction,
        )
      ).filter((candidate) => workflowEligibleEventIds.has(candidate.event_id))
    : [];
  if (completion) {
    if (
      !requestedIds.some((eventId) =>
        completionCandidates.some((candidate) => candidate.event_id === eventId),
      )
    ) {
      throw new ObjectiveCompletionCandidateRequiredError(
        completionCandidates.map((candidate) => candidate.event_id),
        completion.required_response_paths,
      );
    }
  }
  const objectiveOperation = objectiveOperationRequirement(flow);
  const objectiveOperationCandidatesForSelection = objectiveOperation
    ? (
        await objectiveOperationCandidates(
          context,
          session,
          flow,
          allArtifacts,
          awaitedRedaction,
        )
      ).filter((candidate) => workflowEligibleEventIds.has(candidate.event_id))
    : [];
  if (objectiveOperation) {
    if (
      !requestedIds.some((eventId) =>
        objectiveOperationCandidatesForSelection.some(
          (candidate) => candidate.event_id === eventId,
        ),
      )
    )
      throw new ObjectiveOperationCandidateRequiredError(
        objectiveOperationCandidatesForSelection.map(
          (candidate) => candidate.event_id,
        ),
        objectiveOperation.operation_id,
        objectiveOperation.side_effect_class,
      );
  }
  const transactionTerminalSequence = selectedObjectiveTerminalSequence(
    requestedIds,
    [...completionCandidates, ...objectiveOperationCandidatesForSelection],
  );
  if (transactionTerminalSequence !== undefined) {
    const missing = missingTransactionPrerequisiteSelections(
      requestedIds,
      transactionPrerequisiteEventCandidates(
        flow,
        events,
        rawByEventId,
        workflowEligibleEventIds,
        transactionTerminalSequence,
      ),
    );
    if (missing.length)
      throw new TransactionPrerequisiteEventSelectionError(missing);
  }
  const existing = (
    await context.db.repos.workflows.findAll({
      where: { source_recording_session_id: session.id } as any,
    })
  )[0];
  if (existing) return inspectBusinessWorkflow(context, existing.id);
  await finishRecordingSession(context.db, session.id);
  let detail = await getRecordingSessionDetail(context.db, session.id);
  const draft = detail.workflow_drafts[0];
  if (!draft)
    throw new Error("Recording did not produce an executable workflow draft.");
  const selectedIds = new Set(requestedIds);
  // A prepared login is a transport prerequisite rather than a model-selected
  // business assertion. If the model narrows a task-scoped authenticated Flow
  // to later actions, retain the observed login and every request leading into
  // it. This preserves a fresh Set-Cookie/CSRF source for native replay while
  // leaving later operation, mapping, and semantic assertion choices intact.
  const preparedLogin =
    requiresPreparedIdentityLogin(String(session.role || "")) &&
    session.capture_filters?.scope_type === "task"
      ? [...rawByEventId.entries()]
          .map(([eventId, event]) => ({ eventId, event }))
          .filter(
            (item) =>
              item.event.action === "identity_apply_login" &&
              item.event.complete &&
              isSuccessfulNormalResponseStatus(item.event.response_status),
          )
          .sort((left, right) => right.event.sequence - left.event.sequence)[0]
      : undefined;
  const autoIncludedEventIds: string[] = [];
  if (preparedLogin) {
    for (const event of events)
      if (
        event.sequence <= preparedLogin.event.sequence &&
        workflowEligibleEventIds.has(event.id) &&
        !selectedIds.has(event.id)
      ) {
        selectedIds.add(event.id);
        autoIncludedEventIds.push(event.id);
      }
  }
  const selected = events.filter((event) => selectedIds.has(event.id));
  const coverageByEvent = await coverageTargetsByRecordedEvent(
    context,
    events.filter((event) => actionAttributedEventIds.has(event.id)),
  );
  const retryTargets = await currentCoverageRetryTargets(context, session);
  // A retry target must be represented by a selected *executable* source
  // event. `coverageTargetsByRecordedEvent` shares the generator predicate,
  // so a target with no event IDs here cannot acquire a Workflow step later.
  const omittedRetryTargets = coverageRetryEventCandidates(
    retryTargets,
    coverageByEvent,
  ).filter(
    (target) => !target.event_ids.some((eventId) => selectedIds.has(eventId)),
  );
  if (omittedRetryTargets.length)
    throw new CoverageRetryEventSelectionError(omittedRetryTargets);
  const dictionary = new FieldDictionary(context.db);
  await dictionary.load("global");
  const generated = generateWorkflowDraftArtifacts({
    session,
    events: selected.map((event) => restoredEvent(event, rawByEventId.get(event.id)!)),
    fieldHits: await context.db.repos.recordingFieldHits.findAll({
      where: { session_id: session.id } as any,
    }),
    runtimeContexts: await context.db.repos.recordingRuntimeContext.findAll({
      where: { session_id: session.id } as any,
    }),
    dictionary,
  });
  if (!generated)
    throw new Error(
      "No business steps remain after filtering transport/static requests.",
    );
  await promoteNormalBusinessCaptureEndpoints(
    context,
    session,
    selected,
    rawByEventId,
    generated.steps,
  );
  // Refresh the existing draft with the canonical generator's private source,
  // preserving source-event IDs and avoiding a second recorder or compiler.
  const draftSteps = await context.db.repos.workflowDraftSteps.findAll({
    where: { workflow_draft_id: draft.id } as any,
  });
  for (const step of draftSteps) {
    const source = generated.steps.find(
      (item) => item.source_event_id === step.source_event_id,
    );
    await context.db.repos.workflowDraftSteps.update(
      step.id,
      source
        ? { ...source, workflow_draft_id: draft.id }
        : ({ enabled: false } as any),
    );
  }
  detail = await getRecordingSessionDetail(context.db, session.id);
  const published = await publishWorkflowDraft(context.db, draft.id, {
    workflow_name: input.name,
    published_by: "agent_business",
  });
  const workflow = published.workflow;
  await context.db.repos.workflows.update(workflow.id, {
    assertion_strategy: "all_steps_pass",
    enable_baseline: false,
    enable_extractor: false,
    enable_session_jar: false,
    baseline_config: {
      capture_replay_only: true,
      exact_captured_baseline: true,
    },
    learning_status: "unlearned",
  } as any);
  const learning = await buildRecordingLearningSuggestions(
    context.db,
    workflow.id,
    session.id,
    {
      includeExtractors: true,
      includeSessionJar: true,
      includeAssertions: true,
    },
  );
  await context.repo.createArtifact({
    scan_run_id: context.scanRunId,
    task_id: context.taskId,
    artifact_type: "business_workflow_learning",
    source_ref: workflow.id,
    title: "正常业务参数依赖候选",
    content_json: {
      flow_id: session.capture_filters!.flow_id,
      recording_session_id: session.id,
      workflow_id: workflow.id,
      selection_origin: "explicit_observed_event_ids",
      selection_tool_name: "bstg.business.workflow.prepare",
      requested_event_ids: requestedIds,
      auto_included_event_ids: autoIncludedEventIds,
      effective_event_ids: selected.map((event) => event.id),
      selected_event_count: selected.length,
      summary: learning.summary,
      suggestions: learning.suggestions,
      conflicts: learning.conflicts,
      private: true,
    },
  });
  const coverage = await deriveCoverageBindings(context, workflow.id, session);
  const objectiveCompletionBinding = await deriveObjectiveCompletionBinding(
    context,
    workflow.id,
    session,
    flow,
    selectedIds,
  );
  const objectiveOperationBinding = await deriveObjectiveOperationBinding(
    context,
    workflow.id,
    session,
    flow,
    selectedIds,
  );
  await flowEvent(context, String(session.capture_filters!.flow_id), {
    workflow_id: workflow.id,
    recording_session_id: session.id,
    status: "learning",
    steps: coverage.steps,
    coverage_bindings: coverage.bindings,
    ...(objectiveCompletionBinding
      ? { objective_completion_binding: objectiveCompletionBinding }
      : {}),
    ...(objectiveOperationBinding
      ? { objective_operation_binding: objectiveOperationBinding }
      : {}),
  });
  return inspectBusinessWorkflow(context, workflow.id);
}

function revisionWorkflowName(value: unknown, fallback: string): string {
  const requested =
    typeof value === "string"
      ? value.replace(/\s+/g, " ").trim().slice(0, 200)
      : "";
  return requested || fallback.slice(0, 200);
}

function coverageTargetKey(value: {
  target_type: string;
  target_id: string;
}): string {
  return `${value.target_type}:${value.target_id}`;
}

type CoverageTargetReference = {
  target_type: "feature" | "operation";
  target_id: string;
};
type CoverageRetryEventCandidate = CoverageTargetReference & {
  event_ids: string[];
};
export type CoverageRetryTargetAssertionRequirement =
  CoverageTargetReference & {
    source_step_orders: number[];
    semantic_body_assertion_required: true;
  };

/**
 * A selected normal-capture operation may be promoted after it becomes a real
 * Workflow step.  That promotion can bind its own proof and later security
 * modeling, but must not revise the planning inventory.  All other evidence
 * must still be an eligible planning operation; a static JavaScript reference
 * is a lead, not runtime proof authority.
 */
function isProofBindableEndpoint(endpoint: {
  method?: string;
  source_type?: string;
}): boolean {
  return (
    String(endpoint.source_type || "") === "normal_business_capture" ||
    isPlanningCoverageEndpoint(endpoint)
  );
}

/**
 * Failed HTTP responses remain private diagnostic evidence, but cannot seal a
 * normal-flow coverage target.  Otherwise a 4xx/5xx navigation or error route
 * could force the model to invent a semantic body assertion that cannot exist.
 */
function isSuccessfulCoverageObservation(event: {
  response_status?: number;
}): boolean {
  const status = Number(event.response_status);
  return Number.isInteger(status) && status >= 200 && status < 400;
}

/**
 * Keep the retry-proof contract directly executable by the model without
 * exposing a route, captured value, or request/response body.  A scheduled
 * target can be sealed only by a successful semantic assertion at one of its
 * server-derived source Workflow steps.
 */
export function coverageRetryTargetAssertionRequirementsForBindings(
  targets: CoverageTargetReference[],
  bindings: BusinessCoverageBinding[],
): CoverageRetryTargetAssertionRequirement[] {
  return targets.map((target) => ({
    ...target,
    source_step_orders: [
      ...new Set(
        bindings
          .filter(
            (binding) =>
              binding.target_type === target.target_type &&
              binding.target_id === target.target_id,
          )
          .map((binding) => Number(binding.source_step_order))
          .filter((stepOrder) => Number.isInteger(stepOrder) && stepOrder > 0),
      ),
    ].sort((left, right) => left - right),
    semantic_body_assertion_required: true,
  }));
}

/** A retry is a server-owned capability.  Expose only its already-authorized
 * opaque target references to the model; labels, URLs, values and request
 * payloads stay outside this projection. */
async function currentCoverageRetryTargets(
  context: AgentToolContext,
  session: RecordingSession,
): Promise<CoverageTargetReference[]> {
  const taskId = String(context.taskId || ""),
    flowId = String(session.capture_filters?.flow_id || "");
  if (!taskId || !flowId) return [];
  const [task, flow] = await Promise.all([
    context.repo.getTask(taskId),
    requireBusinessFlow(context, flowId),
  ]);
  if (
    !task ||
    !(await isAuthorizedBusinessCoverageRetryTask(context, task, flow))
  )
    return [];
  const targets = Array.isArray(task.execution_plan?.coverage_retry?.targets)
    ? task.execution_plan.coverage_retry.targets
    : [];
  if (!coverageRetryTargetKeys(targets)) return [];
  return targets.map((target: any) => ({
    target_type: target.target_type as CoverageTargetReference["target_type"],
    target_id: String(target.target_id),
  }));
}

/** This is server-derived provenance, not a model assertion: an opaque
 * captured event maps to an already-discovered endpoint/feature only when
 * its method and canonical path agree with the executor's inventory. */
async function coverageTargetsByRecordedEvent(
  context: AgentToolContext,
  events: RecordingEvent[],
): Promise<Map<string, CoverageTargetReference[]>> {
  if (!events.length) return new Map();
  const run = await context.repo.getRun(context.scanRunId);
  if (!run) throw new Error("Assessment not found.");
  const eventIds = new Set(events.map((event) => event.id));
  const sessionId = events[0].session_id;
  const [endpoints, features, fieldHits, runtimeContexts] = await Promise.all([
    context.repo.listEndpoints(context.scanRunId),
    context.repo.listFeatures(context.scanRunId),
    context.db.repos.recordingFieldHits.findAll({
      where: { session_id: sessionId } as any,
    }),
    context.db.repos.recordingRuntimeContext.findAll({
      where: { session_id: sessionId } as any,
    }),
  ]);
  const fieldHitsByEvent = new Map<string, any[]>(),
    runtimeContextsByEvent = new Map<string, any[]>();
  for (const hit of fieldHits) {
    if (!eventIds.has(String(hit.event_id || ""))) continue;
    const values = fieldHitsByEvent.get(String(hit.event_id)) || [];
    values.push(hit);
    fieldHitsByEvent.set(String(hit.event_id), values);
  }
  for (const runtimeContext of runtimeContexts) {
    if (!eventIds.has(String(runtimeContext.event_id || ""))) continue;
    const values =
      runtimeContextsByEvent.get(String(runtimeContext.event_id)) || [];
    values.push(runtimeContext);
    runtimeContextsByEvent.set(String(runtimeContext.event_id), values);
  }
  const result = new Map<string, CoverageTargetReference[]>();
  for (const event of events) {
    // This must use the same inclusion rule as generateWorkflowDraftArtifacts.
    // Otherwise a static/polling/OPTIONS request can appear as a retry target
    // candidate, be selected by the model, then disappear before it ever has
    // a workflow step on which a semantic assertion could be made.
    if (
      !isWorkflowReplayCandidate(
        event,
        fieldHitsByEvent.get(event.id) || [],
        runtimeContextsByEvent.get(event.id) || [],
      ) ||
      !isSuccessfulCoverageObservation(event)
    ) {
      result.set(event.id, []);
      continue;
    }
    const observed = endpoints.filter(
      (endpoint) =>
        isProofBindableEndpoint(endpoint) &&
        endpoint.method.toUpperCase() ===
          String(event.method || "").toUpperCase() &&
        canonicalRequestPath(endpoint.url || endpoint.path, run.base_url) ===
          canonicalRequestPath(String(event.path || ""), run.base_url),
    );
    const targets = new Map<string, CoverageTargetReference>();
    for (const endpoint of observed) {
      const operation: CoverageTargetReference = {
        target_type: "operation",
        target_id: endpoint.id,
      };
      targets.set(coverageTargetKey(operation), operation);
      for (const feature of features.filter((item) =>
        (item.endpoint_ids || []).includes(endpoint.id),
      )) {
        const target: CoverageTargetReference = {
          target_type: "feature",
          target_id: feature.id,
        };
        targets.set(coverageTargetKey(target), target);
      }
    }
    result.set(event.id, [...targets.values()]);
  }
  return result;
}

function coverageRetryEventCandidates(
  targets: CoverageTargetReference[],
  coverageByEvent: Map<string, CoverageTargetReference[]>,
): CoverageRetryEventCandidate[] {
  return targets.map((target) => {
    const key = coverageTargetKey(target);
    const event_ids = [...coverageByEvent.entries()]
      .filter(([, observed]) =>
        observed.some((item) => coverageTargetKey(item) === key),
      )
      .map(([eventId]) => eventId);
    return { ...target, event_ids };
  });
}

/** The server never appends events on the model's behalf.  If a scheduled
 * retry target is already present in the stopped recording, the model must
 * explicitly choose one of those event IDs before a Workflow can be built. */
export class CoverageRetryEventSelectionError extends Error {
  readonly missing_scheduled_targets: CoverageRetryEventCandidate[];
  readonly no_executable_candidate: boolean;

  constructor(missing: CoverageRetryEventCandidate[]) {
    const noExecutableCandidate = missing.some(
      (target) => target.event_ids.length === 0,
    );
    super(
      noExecutableCandidate
        ? `The stopped retry recording has no executable Workflow candidate for ${missing.filter((target) => target.event_ids.length === 0).length} server-scheduled coverage-retry target(s). Do not compile an unprovable Workflow; inspect the capture boundary and record a target-reaching browser action before stopping it.`
        : `The selected event subset omits ${missing.length} server-scheduled coverage-retry target(s) that are present in this stopped recording. Inspect the current capture and explicitly include a candidate event ID for each listed target; BSTG will not add an event automatically.`,
    );
    this.name = "CoverageRetryEventSelectionError";
    this.missing_scheduled_targets = missing;
    this.no_executable_candidate = noExecutableCandidate;
  }
}

/** The model-owned coverage record remains immutable during normal-flow
 * recovery. A revision may prove the currently observed portion of that plan,
 * and a later native completion gate will schedule a fresh task-scoped retry
 * for any planned target not present in this recording. */
async function plannedCoverageKeysForFlow(
  context: AgentToolContext,
  flowId: string,
): Promise<Set<string>> {
  const [tasks, artifacts] = await Promise.all([
    context.repo.listTasks(context.scanRunId),
    context.repo.listArtifacts(context.scanRunId),
  ]);
  const planningTask = tasks.find(
    (task) => task.execution_plan?.intent === BUSINESS_PLAN_INTENT,
  );
  if (!planningTask) return new Set();
  const coverage = latestBusinessCoverage(
    artifacts,
    planningTask.id,
  )?.content_json;
  const entries = Array.isArray(coverage?.entries) ? coverage.entries : [];
  return new Set(
    entries
      .filter(
        (entry: any) =>
          entry?.disposition === "planned" &&
          String(entry?.flow_id || "") === flowId,
      )
      .map((entry: any) =>
        coverageTargetKey({
          target_type: String(entry.target_type || ""),
          target_id: String(entry.target_id || ""),
        }),
      ),
  );
}

/** A revision cannot discard coverage that the current source Workflow
 * already bound to observed browser actions. This protects against using event
 * selection as a shortcut, while still allowing a later fresh retry for a
 * separately planned target that this recording never exercised. */
function assertRevisionKeepsCurrentCoverage(
  required: Set<string>,
  available: Iterable<string>,
): void {
  if (!required.size) return;
  const availableKeys = new Set(available);
  const missing = [...required].filter((key) => !availableKeys.has(key));
  if (missing.length) {
    throw new Error(
      `The selected event subset would remove ${missing.length} current observed coverage target(s) from this Flow. Keep events that exercise those already-bound targets; separately planned but unobserved targets remain scheduled for a fresh coverage retry after native validation.`,
    );
  }
}

async function selectedEventCoverageKeys(
  context: AgentToolContext,
  selectedEvents: RecordingEvent[],
  actionAttributedEventIds: Set<string>,
): Promise<Set<string>> {
  const coverageByEvent = await coverageTargetsByRecordedEvent(
    context,
    selectedEvents.filter((event) => actionAttributedEventIds.has(event.id)),
  );
  const keys = new Set<string>();
  for (const targets of coverageByEvent.values())
    for (const target of targets) keys.add(coverageTargetKey(target));
  return keys;
}

/** Return only sources whose canonical event, link, raw capture and current
 * task/Flow agree.  The model may select opaque event IDs, never an arbitrary
 * canonical row that happened to share the recording session. */
function currentCapturedEventSources(input: {
  artifacts: Awaited<ReturnType<AgentToolContext["repo"]["listArtifacts"]>>;
  events: RecordingEvent[];
  session: RecordingSession;
  taskId: string;
  flowId: string;
}): Map<string, PersistedBusinessBrowserCaptureEvent> {
  const eventsById = new Map(input.events.map((event) => [event.id, event]));
  const rawByArtifactId = new Map(
    input.artifacts
      .filter(
        (artifact) =>
          artifact.artifact_type === "business_capture_event" &&
          artifact.source_ref === input.session.id,
      )
      .map((artifact) => [artifact.id, artifact]),
  );
  const sources = new Map<string, PersistedBusinessBrowserCaptureEvent>();
  for (const link of input.artifacts.filter(
    (artifact) =>
      artifact.artifact_type === "business_capture_event_link" &&
      artifact.source_ref === input.session.id,
  )) {
    const detail = link.content_json || {};
    const eventId = String(detail.recording_event_id || "");
    const event = eventsById.get(eventId);
    const rawArtifact = rawByArtifactId.get(
      String(detail.raw_artifact_id || ""),
    );
    const raw = rawArtifact?.content_json as
      PersistedBusinessBrowserCaptureEvent | undefined;
    if (!event || !raw) continue;
    if (
      String(link.task_id || "") !== input.taskId ||
      String(detail.task_id || "") !== input.taskId ||
      String(detail.flow_id || "") !== input.flowId ||
      String(detail.recording_session_id || "") !== input.session.id ||
      String(rawArtifact?.task_id || "") !== input.taskId ||
      String(raw.task_id || "") !== input.taskId ||
      rawArtifact?.content_json?.private !== true ||
      detail.complete !== true ||
      String(raw.flow_id || "") !== input.flowId ||
      String(raw.recording_session_id || "") !== input.session.id ||
      Number(detail.sequence) !== event.sequence ||
      Number(raw.sequence) !== event.sequence ||
      String(raw.method || "").toUpperCase() !==
        String(event.method || "").toUpperCase() ||
      String(raw.url || "") !== String(event.url || "") ||
      String(raw.response_status ?? "") !==
        String(event.response_status ?? "") ||
      String(detail.action_id || "") !== String(raw.action_id || "") ||
      !hasStrongActionAttribution(raw) ||
      raw.complete !== true
    )
      continue;
    sources.set(eventId, raw);
  }
  return sources;
}

/** Capture provenance is accepted only when the private raw event and its
 * canonical recording row are linked to this task/Flow and a recorder-proved
 * browser input created the XHR/fetch. `RecordingEvent` deliberately contains
 * no action ID or causal proof, so callers must derive this server-only set
 * before treating a canonical event as normal-flow semantic or coverage
 * evidence. */
function linkedActionAttributedCaptureEventIds(input: {
  artifacts: Awaited<ReturnType<AgentToolContext["repo"]["listArtifacts"]>>;
  events: RecordingEvent[];
  session: RecordingSession;
  taskId: string;
  flowId: string;
}): Set<string> {
  return new Set(
    [...currentCapturedEventSources(input).entries()]
      .filter(([, raw]) => hasStrongActionAttribution(raw))
      .map(([eventId]) => eventId),
  );
}

/**
 * The capture inspector, initial compiler, and immutable revision compiler
 * must agree on the exact event set that can become a native Workflow step.
 * An event needs both task/Flow-bound causal source evidence and the existing
 * generator's replay predicate; either condition alone is insufficient.
 */
async function workflowEligibleCaptureEventIds(
  context: AgentToolContext,
  session: RecordingSession,
  events: RecordingEvent[],
  rawByEventId: Map<string, PersistedBusinessBrowserCaptureEvent>,
): Promise<Set<string>> {
  const [fieldHits, runtimeContexts] = await Promise.all([
    context.db.repos.recordingFieldHits.findAll({
      where: { session_id: session.id } as any,
    }),
    context.db.repos.recordingRuntimeContext.findAll({
      where: { session_id: session.id } as any,
    }),
  ]);
  const fieldHitsByEventId = new Map<string, any[]>();
  const runtimeContextsByEventId = new Map<string, any[]>();
  for (const hit of fieldHits) {
    const eventId = String(hit.event_id || "");
    if (!eventId) continue;
    const values = fieldHitsByEventId.get(eventId) || [];
    values.push(hit);
    fieldHitsByEventId.set(eventId, values);
  }
  for (const runtimeContext of runtimeContexts) {
    const eventId = String(runtimeContext.event_id || "");
    if (!eventId) continue;
    const values = runtimeContextsByEventId.get(eventId) || [];
    values.push(runtimeContext);
    runtimeContextsByEventId.set(eventId, values);
  }
  return new Set(
    events
      .filter(
        (event) =>
          rawByEventId.has(event.id) &&
          isWorkflowReplayCandidate(
            event,
            fieldHitsByEventId.get(event.id) || [],
            runtimeContextsByEventId.get(event.id) || [],
          ),
      )
      .map((event) => event.id),
  );
}

type TransactionPrerequisiteEventCandidate = {
  intent: TransactionPrerequisiteEventIntent;
  event_ids: string[];
};

/**
 * This correlation stays entirely server-side. action_intent is set only when
 * the browser runtime bound a live selected control to the exact request that
 * Chromium intercepted. The model still owns which opaque event in each group
 * it wants to retain; the server only checks that a replayable transaction did
 * not lose an observed prerequisite it relies on.
 */
function transactionPrerequisiteEventCandidates(
  flow: Record<string, any>,
  events: RecordingEvent[],
  rawByEventId: Map<string, PersistedBusinessBrowserCaptureEvent>,
  workflowEligibleEventIds: Set<string>,
  terminalSequence = Number.POSITIVE_INFINITY,
): TransactionPrerequisiteEventCandidate[] {
  if (objectiveOperationRequirement(flow)?.side_effect_class !== "transaction")
    return [];
  const grouped = new Map<
    TransactionPrerequisiteEventIntent,
    Array<{ event_id: string; sequence: number }>
  >();
  for (const event of events) {
    if (
      event.sequence > terminalSequence ||
      !workflowEligibleEventIds.has(event.id)
    )
      continue;
    const intent = rawByEventId.get(event.id)?.action_intent;
    if (
      !TRANSACTION_PREREQUISITE_EVENT_INTENTS.includes(
        intent as TransactionPrerequisiteEventIntent,
      )
    )
      continue;
    const values = grouped.get(intent as TransactionPrerequisiteEventIntent) || [];
    values.push({ event_id: event.id, sequence: Number(event.sequence || 0) });
    grouped.set(intent as TransactionPrerequisiteEventIntent, values);
  }
  return TRANSACTION_PREREQUISITE_EVENT_INTENTS.flatMap((intent) => {
    const event_ids = [
      ...new Set(
        (grouped.get(intent) || [])
          .sort((left, right) => left.sequence - right.sequence)
          .map((item) => item.event_id),
      ),
    ].slice(0, 80);
    return event_ids.length ? [{ intent, event_ids }] : [];
  });
}

function selectedObjectiveTerminalSequence(
  requestedIds: string[],
  candidates: Array<{ event_id: string; sequence: number }>,
): number | undefined {
  const requested = new Set(requestedIds);
  const sequences = candidates
    .filter((candidate) => requested.has(candidate.event_id))
    .map((candidate) => Number(candidate.sequence))
    .filter((sequence) => Number.isInteger(sequence) && sequence > 0);
  return sequences.length ? Math.min(...sequences) : undefined;
}

function missingTransactionPrerequisiteSelections(
  requestedIds: string[],
  candidates: TransactionPrerequisiteEventCandidate[],
): TransactionPrerequisiteEventSelection[] {
  const requested = new Set(requestedIds);
  return candidates.flatMap((candidate) =>
    candidate.event_ids.some((eventId) => requested.has(eventId))
      ? []
      : [
          {
            intent: candidate.intent,
            candidate_event_ids: candidate.event_ids,
          },
        ],
  );
}

/**
 * The original generated draft becomes read-only as soon as it is published.
 * A model-selected normal-flow revision therefore creates a fresh draft from
 * the same private recording rather than changing that draft, its published
 * Workflow, or any prior Test Run evidence.  The model can choose event IDs;
 * the server owns raw recording restoration and all generated native assets.
 */
async function publishBusinessWorkflowRevision(
  context: AgentToolContext,
  session: RecordingSession,
  selectedEvents: RecordingEvent[],
  rawByEventId: Map<string, PersistedBusinessBrowserCaptureEvent>,
  workflowName: string,
  requestedEventIds: string[],
  autoIncludedEventIds: string[],
): Promise<{ workflow: any; learning_artifact_id: string }> {
  if (!selectedEvents.length)
    throw new Error("The selected event subset is empty.");
  const restored = selectedEvents.map((event) => {
    const raw = rawByEventId.get(event.id);
    if (!raw)
      throw new Error(
        "A selected observed event has no private recording source.",
      );
    if (raw.request_body_base64)
      throw new Error(
        "A selected observed event has a binary request body; use the existing multipart executor instead of a text workflow snapshot.",
      );
    return restoredEvent(event, raw);
  });
  const selectedIds = new Set(selectedEvents.map((event) => event.id));
  const [fieldHits, runtimeContexts] = await Promise.all([
    context.db.repos.recordingFieldHits.findAll({
      where: { session_id: session.id } as any,
    }),
    context.db.repos.recordingRuntimeContext.findAll({
      where: { session_id: session.id } as any,
    }),
  ]);
  const dictionary = new FieldDictionary(context.db);
  await dictionary.load("global");
  const generated = generateWorkflowDraftArtifacts({
    session,
    events: restored,
    fieldHits: fieldHits.filter((hit) => selectedIds.has(hit.event_id)),
    runtimeContexts: runtimeContexts.filter(
      (item) =>
        Boolean(item.event_id) && selectedIds.has(String(item.event_id)),
    ),
    dictionary,
  });
  if (!generated)
    throw new Error(
      "No business steps remain after model-selected event filtering.",
    );
  await promoteNormalBusinessCaptureEndpoints(
    context,
    session,
    selectedEvents,
    rawByEventId,
    generated.steps,
  );
  const draft = await context.db.repos.workflowDrafts.create({
    ...generated.draft,
    name: `${workflowName} · Agent revision draft`.slice(0, 240),
    status: "generated",
    published_workflow_id: undefined,
  } as any);
  const eventToStep = new Map<string, any>();
  for (const step of generated.steps) {
    const created = await context.db.repos.workflowDraftSteps.create({
      ...step,
      workflow_draft_id: draft.id,
    } as any);
    eventToStep.set(created.source_event_id, created);
  }
  for (const candidate of generated.extractorCandidates) {
    const step = candidate.source_event_id
      ? eventToStep.get(candidate.source_event_id)
      : undefined;
    await context.db.repos.recordingExtractorCandidates.create({
      ...candidate,
      workflow_draft_id: draft.id,
      workflow_draft_step_id: step?.id,
    } as any);
  }
  for (const candidate of generated.variableCandidates) {
    const step = candidate.source_event_id
      ? eventToStep.get(candidate.source_event_id)
      : undefined;
    await context.db.repos.recordingVariableCandidates.create({
      ...candidate,
      workflow_draft_id: draft.id,
      workflow_draft_step_id: step?.id,
    } as any);
  }
  const published = await publishWorkflowDraft(context.db, draft.id, {
    workflow_name: workflowName,
    published_by: "agent_business_revision",
  });
  const workflow = published.workflow;
  await context.db.repos.workflows.update(workflow.id, {
    assertion_strategy: "all_steps_pass",
    enable_baseline: false,
    enable_extractor: false,
    enable_session_jar: false,
    baseline_config: {
      capture_replay_only: true,
      agent_business_normal_validation: true,
    },
    learning_status: "unlearned",
  } as any);
  const learning = await buildRecordingLearningSuggestions(
    context.db,
    workflow.id,
    session.id,
    {
      includeExtractors: true,
      includeSessionJar: true,
      includeAssertions: true,
    },
  );
  const artifact = await context.repo.createArtifact({
    scan_run_id: context.scanRunId,
    task_id: context.taskId,
    artifact_type: "business_workflow_learning",
    source_ref: workflow.id,
    title: "正常业务参数依赖候选",
    content_json: {
      flow_id: session.capture_filters!.flow_id,
      recording_session_id: session.id,
      workflow_id: workflow.id,
      // A repair is still compiled from exact model-selected event IDs. Keep
      // the same opaque selection receipt as the initial preparation so a
      // later validation can prove which source workflow was learned.
      selection_origin: "explicit_observed_event_ids",
      selection_tool_name: "bstg.business.workflow.revise",
      requested_event_ids: requestedEventIds,
      auto_included_event_ids: autoIncludedEventIds,
      effective_event_ids: selectedEvents.map((event) => event.id),
      selected_event_count: selectedEvents.length,
      summary: learning.summary,
      suggestions: learning.suggestions,
      conflicts: learning.conflicts,
      private: true,
    },
  });
  return { workflow, learning_artifact_id: artifact.id };
}

/**
 * Let the model replace an unworkable normal Workflow with a new native
 * revision composed only of event IDs observed in this task's recording.  It
 * is deliberately not an automatic retry: the server validates ownership and
 * preserves authentication prerequisites, while the model supplies the exact
 * business sequence and its rationale.
 */
export async function reviseBusinessWorkflow(
  context: AgentToolContext,
  input: {
    workflow_id: string;
    test_run_id: string;
    event_ids: string[];
    name?: string;
    rationale: string;
  },
): Promise<Record<string, any>> {
  assertScanActive();
  const taskId = String(context.taskId || ""),
    workflowId = String(input.workflow_id || ""),
    testRunId = String(input.test_run_id || "");
  if (!taskId || !workflowId || !testRunId)
    throw new Error(
      "A current normal-learning task, workflow_id, and test_run_id are required for workflow revision.",
    );
  const task = await context.repo.getTask(taskId);
  if (!task || task.execution_plan?.intent !== BUSINESS_LEARNING_INTENT)
    throw new Error(
      "Workflow revision belongs only to the current normal business learning task.",
    );
  const flowId = String(task.execution_plan?.flow_id || "");
  const flow = await requireBusinessFlow(context, flowId);
  if (
    flow.status !== "failed" ||
    flow.assertions_verified === true ||
    String(flow.workflow_id || "") !== workflowId ||
    String(flow.normal_run_id || "") !== testRunId
  ) {
    throw new Error(
      "Workflow revision requires the current Flow's latest failed native normal validation.",
    );
  }
  const previousRun = await context.db.repos.testRuns.findById(testRunId);
  const runParams = previousRun?.execution_params || {};
  if (
    !previousRun ||
    previousRun.workflow_id !== workflowId ||
    String(runParams.scan_run_id || "") !== context.scanRunId ||
    String(runParams.ai_scan_task_id || "") !== taskId ||
    String(runParams.flow_id || "") !== flowId ||
    runParams.business_normal_run !== true ||
    previousRun.has_execution_error !== true
  ) {
    throw new Error(
      "Workflow revision requires the current task-bound failed normal Test Run.",
    );
  }
  const previousWorkflow =
    await context.db.repos.workflows.findById(workflowId);
  const recordingSessionId = String(
    previousWorkflow?.source_recording_session_id ||
      flow.recording_session_id ||
      "",
  );
  if (!previousWorkflow || !recordingSessionId)
    throw new Error(
      "The failed normal Workflow has no current recording provenance.",
    );
  const session = await requireCurrentBusinessLearningRecording(
    context,
    recordingSessionId,
  );
  if (session.capture_filters?.capture_status !== "stopped")
    throw new Error(
      "Only a complete stopped recording can supply a normal Workflow revision.",
    );
  if (String(session.capture_filters?.flow_id || "") !== flowId)
    throw new Error(
      "Workflow revision is outside the current normal business Flow.",
    );
  const requestedIds = Array.isArray(input.event_ids)
    ? input.event_ids.map((value) => String(value || "")).filter(Boolean)
    : [];
  if (
    !requestedIds.length ||
    new Set(requestedIds).size !== requestedIds.length
  )
    throw new Error(
      "event_ids must select unique observed events from the current recording.",
    );
  const events = await context.db.repos.recordingEvents.findAll({
    where: { session_id: session.id } as any,
  });
  const observedIds = new Set(events.map((event) => event.id));
  if (requestedIds.some((id) => !observedIds.has(id)))
    throw new Error(
      "event_ids must select only observed events from the current recording.",
    );
  const artifacts = await context.repo.listArtifacts(context.scanRunId);
  const traceArtifact = artifacts.find(
    (artifact) =>
      artifact.artifact_type === "business_native_trace" &&
      artifact.task_id === taskId &&
      artifact.source_ref === testRunId &&
      artifact.content_json?.private === true &&
      artifact.content_json?.flow_id === flowId &&
      artifact.content_json?.test_run_id === testRunId &&
      artifact.content_json?.workflow_id === workflowId,
  );
  const validationArtifact = artifacts.find(
    (artifact) =>
      artifact.artifact_type === "business_workflow_validation" &&
      artifact.task_id === taskId &&
      artifact.source_ref === testRunId &&
      artifact.content_json?.flow_id === flowId &&
      artifact.content_json?.test_run_id === testRunId &&
      artifact.content_json?.workflow_id === workflowId &&
      artifact.content_json?.execution?.has_execution_error === true,
  );
  const trace = traceArtifact?.content_json?.trace;
  if (
    !traceArtifact ||
    !validationArtifact ||
    trace?.run_meta?.run_id !== testRunId ||
    !Array.isArray(trace.records) ||
    trace.records.length === 0
  ) {
    throw new Error(
      "Workflow revision requires the current failed normal validation and its matching private native trace evidence.",
    );
  }
  const rawByEventId = currentCapturedEventSources({
    artifacts,
    events,
    session,
    taskId,
    flowId,
  });
  const workflowEligibleEventIds = await workflowEligibleCaptureEventIds(
    context,
    session,
    events,
    rawByEventId,
  );
  if (requestedIds.some((eventId) => !workflowEligibleEventIds.has(eventId)))
    throw new WorkflowEligibleEventSelectionError([
      ...workflowEligibleEventIds,
    ]);
  const selectedIds = new Set(requestedIds);
  // Identity login is an executor prerequisite, not a model-selected business
  // assertion. Preserve the observed login transition and earlier setup when
  // an authenticated task-scoped recording is narrowed to later events.
  const preparedLogin =
    requiresPreparedIdentityLogin(String(session.role || "")) &&
    session.capture_filters?.scope_type === "task"
      ? [...rawByEventId.entries()]
          .map(([eventId, event]) => ({ eventId, event }))
          .filter(
            (item) =>
              item.event.action === "identity_apply_login" &&
              isSuccessfulNormalResponseStatus(item.event.response_status),
          )
          .sort((left, right) => right.event.sequence - left.event.sequence)[0]
      : undefined;
  const autoIncludedIds: string[] = [];
  if (preparedLogin) {
    for (const event of events)
      if (
        event.sequence <= preparedLogin.event.sequence &&
        workflowEligibleEventIds.has(event.id) &&
        !selectedIds.has(event.id)
      ) {
        selectedIds.add(event.id);
        autoIncludedIds.push(event.id);
      }
  }
  const selectedEvents = events
    .filter((event) => selectedIds.has(event.id))
    .sort((left, right) => left.sequence - right.sequence);
  if (selectedEvents.some((event) => !rawByEventId.has(event.id)))
    throw new Error(
      "Each selected event must have a current task-bound browser capture link and private source.",
    );
  const objectiveCompletion = objectiveCompletionRequirement(flow);
  const completionCandidates = objectiveCompletion
    ? (
        await objectiveCompletionCandidates(
          context,
          session,
          flow,
          artifacts,
        )
      ).filter((candidate) => workflowEligibleEventIds.has(candidate.event_id))
    : [];
  if (objectiveCompletion) {
    if (
      !requestedIds.some((eventId) =>
        completionCandidates.some((candidate) => candidate.event_id === eventId),
      )
    ) {
      throw new ObjectiveCompletionCandidateRequiredError(
        completionCandidates.map((candidate) => candidate.event_id),
        objectiveCompletion.required_response_paths,
      );
    }
  }
  const objectiveOperation = objectiveOperationRequirement(flow);
  const objectiveOperationCandidatesForSelection = objectiveOperation
    ? (
        await objectiveOperationCandidates(
          context,
          session,
          flow,
          artifacts,
        )
      ).filter((candidate) => workflowEligibleEventIds.has(candidate.event_id))
    : [];
  if (
    objectiveOperation &&
    !requestedIds.some((eventId) =>
      objectiveOperationCandidatesForSelection.some(
        (candidate) => candidate.event_id === eventId,
      ),
    )
  )
    throw new ObjectiveOperationCandidateRequiredError(
      objectiveOperationCandidatesForSelection.map(
        (candidate) => candidate.event_id,
      ),
      objectiveOperation.operation_id,
      objectiveOperation.side_effect_class,
    );
  const transactionTerminalSequence = selectedObjectiveTerminalSequence(
    requestedIds,
    [...completionCandidates, ...objectiveOperationCandidatesForSelection],
  );
  if (transactionTerminalSequence !== undefined) {
    const missing = missingTransactionPrerequisiteSelections(
      requestedIds,
      transactionPrerequisiteEventCandidates(
        flow,
        events,
        rawByEventId,
        workflowEligibleEventIds,
        transactionTerminalSequence,
      ),
    );
    if (missing.length)
      throw new TransactionPrerequisiteEventSelectionError(missing);
  }
  const actionAttributedEventIds = new Set(rawByEventId.keys());
  const [plannedCoverageKeys, selectedCoverageKeys] = await Promise.all([
    plannedCoverageKeysForFlow(context, flowId),
    selectedEventCoverageKeys(
      context,
      selectedEvents,
      actionAttributedEventIds,
    ),
  ]);
  const currentCoverageKeys = new Set(
    (Array.isArray(flow.coverage_bindings) ? flow.coverage_bindings : []).map(
      coverageTargetKey,
    ),
  );
  // Preserve what this source Workflow has already actually bound. Do not make
  // a revision impossible merely because the model's broader coverage plan
  // contains another target that this stopped recording never reached: that
  // target remains in the plan and is handled by a new coverage-retry task
  // after a successful native proof.
  assertRevisionKeepsCurrentCoverage(currentCoverageKeys, selectedCoverageKeys);
  const workflowName = revisionWorkflowName(
    input.name,
    `${flow.name} · Agent normal revision`,
  );
  const revised = await publishBusinessWorkflowRevision(
    context,
    session,
    selectedEvents,
    rawByEventId,
    workflowName,
    requestedIds,
    autoIncludedIds,
  );
  const coverage = await deriveCoverageBindings(
    context,
    revised.workflow.id,
    session,
  );
  const objectiveCompletionBinding = await deriveObjectiveCompletionBinding(
    context,
    revised.workflow.id,
    session,
    flow,
    selectedIds,
  );
  const objectiveOperationBinding = await deriveObjectiveOperationBinding(
    context,
    revised.workflow.id,
    session,
    flow,
    selectedIds,
  );
  // Recheck actual generated bindings before changing the active Flow because
  // the generator may omit a transport/static event from a Workflow draft.
  const revisedCoverageKeys = coverage.bindings.map(coverageTargetKey);
  assertRevisionKeepsCurrentCoverage(currentCoverageKeys, revisedCoverageKeys);
  const unresolvedPlannedCoverageKeys = [...plannedCoverageKeys]
    .filter((key) => !new Set(revisedCoverageKeys).has(key))
    .sort();
  const revisionArtifact = await context.repo.createArtifact({
    scan_run_id: context.scanRunId,
    task_id: taskId,
    artifact_type: "business_workflow_revision",
    source_ref: revised.workflow.id,
    title: "模型选择的正常 Workflow 修订",
    content_json: {
      flow_id: flowId,
      recording_session_id: session.id,
      previous_workflow_id: workflowId,
      previous_test_run_id: previousRun.id,
      workflow_id: revised.workflow.id,
      requested_event_ids: requestedIds,
      auto_included_event_ids: autoIncludedIds,
      effective_event_ids: selectedEvents.map((event) => event.id),
      selected_event_count: selectedEvents.length,
      model_requested_event_count: requestedIds.length,
      selection_origin: "model_explicit_observed_event_ids",
      retained_current_coverage_keys: [...currentCoverageKeys].sort(),
      unresolved_planned_coverage_keys: unresolvedPlannedCoverageKeys,
      ...(objectiveCompletionBinding
        ? { objective_completion_binding: objectiveCompletionBinding }
        : {}),
      ...(objectiveOperationBinding
        ? { objective_operation_binding: objectiveOperationBinding }
        : {}),
      learning_artifact_id: revised.learning_artifact_id,
    },
  });
  await flowEvent(context, flowId, {
    status: "learning",
    workflow_id: revised.workflow.id,
    normal_run_id: undefined,
    assertions: [],
    assertions_verified: false,
    baseline_verified: false,
    object_handle_catalog_id: undefined,
    blockers: [],
    steps: coverage.steps,
    coverage_bindings: coverage.bindings,
    ...(objectiveCompletionBinding
      ? { objective_completion_binding: objectiveCompletionBinding }
      : { objective_completion_binding: undefined }),
    ...(objectiveOperationBinding
      ? { objective_operation_binding: objectiveOperationBinding }
      : { objective_operation_binding: undefined }),
    evidence_artifact_ids: [
      ...new Set([
        ...(flow.evidence_artifact_ids || []),
        revisionArtifact.id,
        revised.learning_artifact_id,
      ]),
    ],
  });
  const inspection = await inspectBusinessWorkflow(
    context,
    revised.workflow.id,
  );
  return {
    ...inspection,
    status: "revised",
    previous_workflow_id: workflowId,
    previous_test_run_id: previousRun.id,
    revision_artifact_id: revisionArtifact.id,
    requested_event_ids: requestedIds,
    auto_included_event_ids: autoIncludedIds,
    effective_event_ids: selectedEvents.map((event) => event.id),
    unresolved_planned_coverage_keys: unresolvedPlannedCoverageKeys,
    summary: `A model-selected observed-event subset was compiled into a new task-bound normal Workflow revision. Inspect its current steps and choose fresh mappings/assertions before native validation.${unresolvedPlannedCoverageKeys.length ? ` ${unresolvedPlannedCoverageKeys.length} separately planned target(s) remain outside this stopped recording; a successful validation keeps them in the coverage plan and schedules a fresh task-scoped retry.` : ""}`,
  };
}

export async function inspectBusinessWorkflow(
  context: AgentToolContext,
  workflowId: string,
): Promise<Record<string, any>> {
  const workflow = await context.db.repos.workflows.findById(workflowId);
  if (!workflow?.source_recording_session_id)
    throw new Error("Workflow has no business recording provenance.");
  const session = await requireCurrentBusinessLearningRecording(
    context,
    workflow.source_recording_session_id,
  );
  const steps = (
    await context.db.repos.workflowSteps.findAll({
      where: { workflow_id: workflowId } as any,
    })
  ).sort((a, b) => a.step_order - b.step_order);
  const templates = await Promise.all(
    steps.map((step) =>
      context.db.repos.apiTemplates.findById(step.api_template_id),
    ),
  );
  const [artifacts, learning] = await Promise.all([
    context.repo.listArtifacts(context.scanRunId),
    buildRecordingLearningSuggestions(context.db, workflowId, session.id, {
      includeExtractors: true,
      includeSessionJar: true,
      includeAssertions: true,
    }),
  ]);
  const redaction = await recordingRedaction(context, session, artifacts);
  const responseProjections = await workflowResponseProjections(
    context,
    session,
    steps,
    templates,
    redaction,
  );
  const flow = await requireBusinessFlow(
    context,
    String(session.capture_filters!.flow_id),
  );
  const objectiveCompletion = objectiveCompletionRequirement(flow);
  const completionSourceStepOrders = objectiveCompletion
    ? await objectiveCompletionStepOrders(
        context,
        session,
        workflowId,
        steps,
        templates,
        flow,
        artifacts,
        redaction,
      )
    : [];
  const objectiveOperation = objectiveOperationRequirement(flow);
  const operationSourceStepOrders = objectiveOperation
    ? await objectiveOperationStepOrders(
        context,
        session,
        steps,
        templates,
        flow,
        artifacts,
        redaction,
      )
    : [];
  const coverageBindings = Array.isArray((flow as any).coverage_bindings)
    ? ((flow as any).coverage_bindings as BusinessCoverageBinding[])
    : [];
  const currentCoverageBindings = coverageBindings.filter(
    (binding) => binding.source_workflow_id === workflowId,
  );
  const retryTargetAssertionRequirements =
    coverageRetryTargetAssertionRequirementsForBindings(
      await currentCoverageRetryTargets(context, session),
      currentCoverageBindings,
    );
  return {
    flow_id: session.capture_filters!.flow_id,
    goal: flow.goal,
    recording_session_id: session.id,
    workflow_id: workflowId,
    identity_key: session.role,
    steps: steps.map((step, index) => {
      const assertionProjection = responseProjections.get(step.id)!;
      return {
        step_id: step.id,
        step_order: step.step_order,
        template_id: step.api_template_id,
        name: step.snapshot_template_name,
        structure: publicTemplateStructure(templates[index]?.parsed_structure),
        assertions: (step.step_assertions || []).map(publicBusinessAssertion),
        response_summary: assertionProjection.response_summary,
        assertion_paths: assertionProjection.assertion_paths,
        semantic_body_path_available:
          assertionProjection.semantic_body_path_available,
      };
    }),
    learning_candidates: {
      ...publicLearningProjection(learning),
      interpretation:
        "Observed correlations are candidates, not verified dependencies. Select mappings justified by business state; matching transport headers or static values alone do not establish propagation.",
    },
    coverage_bindings: currentCoverageBindings.map(publicCoverageBinding),
    ...(objectiveCompletion
      ? {
          objective_completion: {
            required_response_paths:
              objectiveCompletion.required_response_paths,
            completion_source_step_orders: completionSourceStepOrders,
            binding:
              flow.objective_completion_binding &&
              typeof flow.objective_completion_binding === "object"
                ? {
                    source_event_ids: Array.isArray(
                      flow.objective_completion_binding.source_event_ids,
                    )
                      ? flow.objective_completion_binding.source_event_ids
                      : [],
                    action_ids: Array.isArray(
                      flow.objective_completion_binding.action_ids,
                    )
                      ? flow.objective_completion_binding.action_ids
                      : [],
                    source_workflow_id:
                      flow.objective_completion_binding.source_workflow_id,
                    source_step_orders: Array.isArray(
                      flow.objective_completion_binding.source_step_orders,
                    )
                      ? flow.objective_completion_binding.source_step_orders
                      : [],
                  }
                : undefined,
          },
        }
      : {}),
    ...(objectiveOperation
      ? {
          objective_operation: {
            operation_id: objectiveOperation.operation_id,
            side_effect_class: objectiveOperation.side_effect_class,
            operation_source_step_orders: operationSourceStepOrders,
            binding:
              flow.objective_operation_binding &&
              typeof flow.objective_operation_binding === "object"
                ? {
                    operation_id: flow.objective_operation_binding.operation_id,
                    side_effect_class:
                      flow.objective_operation_binding.side_effect_class,
                    source_event_ids: Array.isArray(
                      flow.objective_operation_binding.source_event_ids,
                    )
                      ? flow.objective_operation_binding.source_event_ids
                      : [],
                    action_ids: Array.isArray(
                      flow.objective_operation_binding.action_ids,
                    )
                      ? flow.objective_operation_binding.action_ids
                      : [],
                    source_workflow_id:
                      flow.objective_operation_binding.source_workflow_id,
                    source_step_orders: Array.isArray(
                      flow.objective_operation_binding.source_step_orders,
                    )
                      ? flow.objective_operation_binding.source_step_orders
                      : [],
                  }
                : undefined,
          },
        }
      : {}),
    ...(retryTargetAssertionRequirements.length
      ? {
          retry_target_assertion_requirements: retryTargetAssertionRequirements,
        }
      : {}),
    notice:
      "Learning candidates are observed correlations, not verified business dependencies. Use only each step's assertion_paths: status, headers.<observed header>, or body.<observed JSON field>; bare body, text and HTML are never executable semantic assertions.",
  };
}

async function snapshotBusinessWorkflow(
  context: AgentToolContext,
  workflowId: string,
): Promise<string> {
  const workflow = await context.db.repos.workflows.findById(workflowId);
  if (!workflow) throw new Error("Workflow not found.");
  const {
    id: _id,
    created_at: _created,
    updated_at: _updated,
    ...values
  } = workflow;
  const snapshot = await context.db.repos.workflows.create({
    ...values,
    name: `${workflow.name} · 正常执行快照`,
    // Keep strict replay as this snapshot's durable default. The one private
    // normal-validation request below carries the explicit semantic mode, so a
    // later generic rerun cannot accidentally turn into a security finding.
    baseline_config: {
      ...workflow.baseline_config,
      capture_replay_only: true,
      agent_business_normal_validation: true,
    },
    assertion_strategy: "all_steps_pass",
  } as any);
  for (const [repository, where] of [
    [context.db.repos.workflowSteps, { workflow_id: workflowId }],
    [context.db.repos.workflowVariableConfigs, { workflow_id: workflowId }],
    [context.db.repos.workflowExtractors, { workflow_id: workflowId }],
  ] as const) {
    for (const row of await repository.findAll({ where } as any)) {
      const { id, created_at, updated_at, ...fields } = row as any;
      await repository.create({ ...fields, workflow_id: snapshot.id } as any);
    }
  }
  for (const table of ["workflow_variables", "workflow_mappings"]) {
    const rows = await dbAll<Record<string, any>>(
      context.db,
      `SELECT * FROM ${table} WHERE workflow_id = ?`,
      [workflowId],
    );
    for (const row of rows) {
      const { created_at, updated_at, ...fields } = row;
      const copy = { ...fields, id: randomUUID(), workflow_id: snapshot.id },
        keys = Object.keys(copy);
      await dbRun(
        context.db,
        `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
        Object.values(copy),
      );
    }
  }
  return snapshot.id;
}

function normalizedReplayRequestTarget(
  location: unknown,
  path: unknown,
): string {
  const prefix = String(location || "")
    .replace(/^request\./, "")
    .replace(/s$/, "");
  const suffix = String(path || "")
    .replace(/^\$\.?/, "")
    .replace(/^request\./, "")
    .replace(/^\./, "");
  return `${prefix}.${suffix}`.replace(/\.+/g, ".").replace(/\.$/, "");
}

function normalizedVariableConfigTarget(path: unknown): string {
  return String(path || "")
    .trim()
    .replace(/^\$\.?/, "")
    .replace(/^request\./, "")
    .replace(/^\./, "")
    .replace(/\.+/g, ".");
}

function configTargetsRequiredReplay(
  config: any,
  requiredReplayMappings: any[],
): boolean {
  if (
    config?.data_source !== "account_field" &&
    config?.data_source !== "workflow_context"
  )
    return false;
  const bindings = Array.isArray(config?.step_variable_mappings)
    ? config.step_variable_mappings
    : [];
  return requiredReplayMappings.some((mapping) =>
    bindings.some(
      (binding: any) =>
        Number(binding?.step_order) === Number(mapping.toStepOrder) &&
        normalizedVariableConfigTarget(binding?.json_path) ===
          normalizedReplayRequestTarget(mapping.toLocation, mapping.toPath),
    ),
  );
}

/**
 * The generic recording publisher may parameterize a captured nonce as an
 * account or workflow-context field.  Once the same private recording proves
 * that an earlier response refreshes that exact target, the stale generator
 * config must not participate in account-pool validation or overwrite the
 * native VariablePool injection.  This deletes only the target-equivalent
 * config on an immutable normal-execution snapshot; it never alters the
 * source Workflow or an unrelated account variable.
 */
async function removeShadowedRequiredReplayConfigs(
  context: AgentToolContext,
  workflowId: string,
  requiredReplayMappings: any[],
): Promise<number> {
  if (!requiredReplayMappings.length) return 0;
  const configs = await context.db.repos.workflowVariableConfigs.findAll({
    where: { workflow_id: workflowId } as any,
  });
  const shadowed = configs.filter((config: any) =>
    configTargetsRequiredReplay(config, requiredReplayMappings),
  );
  for (const config of shadowed)
    await context.db.repos.workflowVariableConfigs.delete(config.id);
  return shadowed.length;
}

/** Reinstall the narrow recording-proved bindings after generic execution
 * learning.  The latter intentionally replaces heuristic mappings, so repair
 * must not make a dynamic response→request prerequisite disappear again. */
async function restoreRequiredReplayMappings(
  context: AgentToolContext,
  workflowId: string,
  recordingSessionId: string,
): Promise<{
  requiredReplayMappings: any[];
  variablesCreated: number;
  mappingsCreated: number;
  configsRemoved: number;
}> {
  const learning = await buildRecordingLearningSuggestions(
    context.db,
    workflowId,
    recordingSessionId,
    {
      includeExtractors: false,
      includeSessionJar: true,
      includeAssertions: false,
    },
  );
  const requiredReplayMappings = learning.suggestions.mappings.filter(
    (item) =>
      item.requiredForReplay === true || isRequiredRecordingReplayMapping(item),
  );
  if (!requiredReplayMappings.length)
    return {
      requiredReplayMappings,
      variablesCreated: 0,
      mappingsCreated: 0,
      configsRemoved: 0,
    };
  const existingVariables = await dbAll<Record<string, any>>(
    context.db,
    "SELECT name FROM workflow_variables WHERE workflow_id = ?",
    [workflowId],
  );
  const existingNames = new Set(
    existingVariables.map((item) => String(item.name)),
  );
  let variablesCreated = 0,
    mappingsCreated = 0;
  for (const mapping of requiredReplayMappings) {
    if (!existingNames.has(mapping.variableName)) {
      await createVariable(context.db, workflowId, {
        name: mapping.variableName,
        type: mapping.predictedType || "FLOW_TICKET",
        source: "extracted",
        write_policy: "on_success_only",
        is_locked: false,
        description: "Recording-proved dynamic normal-flow replay prerequisite",
        current_value: undefined,
      } as any);
      existingNames.add(mapping.variableName);
      variablesCreated += 1;
    }
    const before = await dbAll<Record<string, any>>(
      context.db,
      `SELECT id FROM workflow_mappings WHERE workflow_id = ? AND from_step_order = ? AND from_location = ? AND from_path = ? AND to_step_order = ? AND to_location = ? AND to_path = ? AND variable_name = ?`,
      [
        workflowId,
        mapping.fromStepOrder,
        mapping.fromLocation,
        mapping.fromPath,
        mapping.toStepOrder,
        mapping.toLocation,
        mapping.toPath,
        mapping.variableName,
      ],
    );
    await createMapping(context.db, workflowId, {
      from_step_order: mapping.fromStepOrder,
      from_location: mapping.fromLocation,
      from_path: mapping.fromPath,
      to_step_order: mapping.toStepOrder,
      to_location: mapping.toLocation,
      to_path: mapping.toPath,
      variable_name: mapping.variableName,
      confidence: mapping.confidence,
      reason: "heuristic",
      is_enabled: true,
    } as any);
    if (!before.length) mappingsCreated += 1;
  }
  const configsRemoved = await removeShadowedRequiredReplayConfigs(
    context,
    workflowId,
    requiredReplayMappings,
  );
  return {
    requiredReplayMappings,
    variablesCreated,
    mappingsCreated,
    configsRemoved,
  };
}

/** Resolve an Agent-selected normal field against the matching private
 * captured response. The value exists only inside the server-side immutable
 * execution snapshot; public tool/artifact projections retain the
 * `captured_baseline` marker and never carry the value or a digest. */
function executionAssertionForCapturedBaseline(
  assertion: BusinessGoalAssertion,
  event: any,
): BusinessGoalAssertion {
  if (assertion.right?.type !== "captured_baseline") return assertion;
  const observed = getAssertionLeftValue(assertion.left, {
    status: Number(event?.response_status || 0),
    headers: event?.response_headers || {},
    body: String(event?.response_body_text || ""),
  });
  if (observed.isMissing) {
    throw new BusinessAssertionValidationError(
      "The selected captured-baseline assertion has no matching private response field for this workflow step.",
      [{ step_order: assertion.step_order, unobserved_path: true }],
    );
  }
  // This resolved assertion is scoped to the current in-process comparison.
  // It is never persisted; retaining the marker here would make the generic
  // fail-closed evaluator reject the private value before the comparison.
  return {
    ...assertion,
    right: { type: "literal", value: observed.value } as any,
  };
}

/**
 * A retry target is proved by one of its own captured source steps. A generic
 * semantic assertion on another replayed step can verify the Flow overall,
 * but cannot make the target's binding or sealed ledger entry valid. Reject
 * that shape before native execution so the model can choose an observed
 * target-step assertion rather than consume its one recovery capture.
 */
export function coverageRetryTargetAssertionIssuesForBindings(
  targets: CoverageTargetReference[],
  bindings: BusinessCoverageBinding[],
  assertions: BusinessGoalAssertion[],
): BusinessAssertionIssue[] {
  const issues: BusinessAssertionIssue[] = [];
  for (const requirement of coverageRetryTargetAssertionRequirementsForBindings(
    targets,
    bindings,
  )) {
    const asserted = requirement.source_step_orders.some((stepOrder) =>
      assertions.some(
        (assertion) =>
          assertion.step_order === stepOrder &&
          assertion.left.path.startsWith("body.") &&
          ["goal", "identity", "state"].includes(assertion.purpose),
      ),
    );
    if (!asserted)
      issues.push({
        ...(requirement.source_step_orders[0]
          ? { step_order: requirement.source_step_orders[0] }
          : {}),
        semantic_body_required: true,
        malformed_assertion: requirement.source_step_orders.length === 0,
      });
  }
  return issues;
}

async function coverageRetryTargetAssertionIssues(
  context: AgentToolContext,
  session: RecordingSession,
  workflowId: string,
  assertions: BusinessGoalAssertion[],
): Promise<BusinessAssertionIssue[]> {
  const targets = await currentCoverageRetryTargets(context, session);
  if (!targets.length) return [];
  const flow = await requireBusinessFlow(
    context,
    String(session.capture_filters?.flow_id || ""),
  );
  const bindings = (
    Array.isArray(flow.coverage_bindings) ? flow.coverage_bindings : []
  ).filter((binding) => binding.source_workflow_id === workflowId);
  return coverageRetryTargetAssertionIssuesForBindings(
    targets,
    bindings,
    assertions,
  );
}

export async function validateBusinessWorkflow(
  context: AgentToolContext,
  input: {
    workflow_id: string;
    assertions: BusinessGoalAssertion[];
    mapping_ids?: string[];
    apply_session_jar?: boolean;
  },
): Promise<Record<string, any>> {
  assertScanActive();
  const inspected = await inspectBusinessWorkflow(context, input.workflow_id),
    session = await requireCurrentBusinessLearningRecording(
      context,
      inspected.recording_session_id,
    );
  const flowId = String(session.capture_filters!.flow_id),
    run = await context.repo.getRun(context.scanRunId);
  if (!run) throw new Error("Assessment not found.");
  const flowBeforeValidation = await requireBusinessFlow(context, flowId);
  let steps = (
    await context.db.repos.workflowSteps.findAll({
      where: { workflow_id: input.workflow_id } as any,
    })
  ).sort((a, b) => a.step_order - b.step_order);
  const assertions = validateBusinessAssertions(input.assertions, {
    requireSemantic: true,
  });
  if (
    assertions.length > 50 ||
    assertions.some(
      (item) => !steps.some((step) => step.step_order === item.step_order),
    )
  )
    throw new Error(
      "A business assertion references an unobserved workflow step.",
    );
  const [artifacts, templates] = await Promise.all([
    context.repo.listArtifacts(context.scanRunId),
    Promise.all(
      steps.map((step) =>
        context.db.repos.apiTemplates.findById(step.api_template_id),
      ),
    ),
  ]);
  const redaction = await recordingRedaction(context, session, artifacts);
  const responseProjections = await workflowResponseProjections(
    context,
    session,
    steps,
    templates,
    redaction,
  );
  const objectiveCompletion =
    objectiveCompletionRequirement(flowBeforeValidation);
  // A native validation snapshots the selected source Workflow. On a semantic
  // retry, the current Flow therefore points at that snapshot rather than the
  // original capture Workflow. Accept only the Flow's current snapshot (or,
  // on its first validation, its source Workflow); never let a stale source
  // Workflow reopen a later Flow revision.
  if (
    objectiveCompletion &&
    flowBeforeValidation.workflow_id &&
    String(flowBeforeValidation.workflow_id) !== input.workflow_id
  ) {
    throw new Error(
      "The strict normal objective can be validated only through its current Flow Workflow snapshot.",
    );
  }
  const completionSourceStepOrders = objectiveCompletion
    ? await objectiveCompletionStepOrders(
        context,
        session,
        input.workflow_id,
        steps,
        templates,
        flowBeforeValidation,
        artifacts,
        redaction,
      )
    : [];
  const objectiveOperation =
    objectiveOperationRequirement(flowBeforeValidation);
  const operationSourceStepOrders = objectiveOperation
    ? await objectiveOperationStepOrders(
        context,
        session,
        steps,
        templates,
        flowBeforeValidation,
        artifacts,
        redaction,
      )
    : [];
  const pathIssues = assertions.flatMap((assertion) => {
    const step = steps.find((item) => item.step_order === assertion.step_order);
    const supported = step
      ? responseProjections
          .get(step.id)
          ?.assertion_paths.some((item) => item.path === assertion.left.path)
      : false;
    return supported
      ? []
      : [
          {
            assertion_index: assertions.indexOf(assertion) + 1,
            step_order: assertion.step_order,
            unobserved_path: true,
          },
        ];
  });
  if (pathIssues.length)
    throw new BusinessAssertionValidationError(
      "Each business assertion must use an observed executable response path for its own workflow step.",
      pathIssues,
    );
  const existingObjectiveCompletionBinding =
    flowBeforeValidation.objective_completion_binding;
  const completionBindingValid =
    !objectiveCompletion ||
    Boolean(
      existingObjectiveCompletionBinding &&
      (existingObjectiveCompletionBinding.source_workflow_id ===
        input.workflow_id ||
        existingObjectiveCompletionBinding.normal_workflow_id ===
          input.workflow_id) &&
      Array.isArray(existingObjectiveCompletionBinding.source_event_ids) &&
      existingObjectiveCompletionBinding.source_event_ids.length &&
      Array.isArray(existingObjectiveCompletionBinding.action_ids) &&
      existingObjectiveCompletionBinding.action_ids.length &&
      Array.isArray(existingObjectiveCompletionBinding.source_step_orders) &&
      completionSourceStepOrders.length &&
      completionSourceStepOrders.every((order) =>
        existingObjectiveCompletionBinding.source_step_orders.includes(order),
      ),
    );
  const completionIssues = [
    ...objectiveCompletionAssertionIssues(
      objectiveCompletion,
      completionSourceStepOrders,
      assertions,
    ),
    ...(completionBindingValid
      ? []
      : [
          {
            semantic_body_required: true,
            malformed_assertion: true,
            ...(completionSourceStepOrders[0]
              ? { step_order: completionSourceStepOrders[0] }
              : {}),
          } as BusinessAssertionIssue,
        ]),
  ];
  if (completionIssues.length)
    throw new BusinessAssertionValidationError(
      "The strict normal objective needs its server-derived completion step and a goal/state semantic assertion for every required response field before native validation.",
      completionIssues,
    );
  const existingObjectiveOperationBinding =
    flowBeforeValidation.objective_operation_binding;
  const operationBindingValid =
    !objectiveOperation ||
    Boolean(
      existingObjectiveOperationBinding &&
      (existingObjectiveOperationBinding.source_workflow_id ===
        input.workflow_id ||
        existingObjectiveOperationBinding.normal_workflow_id ===
          input.workflow_id) &&
      existingObjectiveOperationBinding.operation_id ===
        objectiveOperation.operation_id &&
      Array.isArray(existingObjectiveOperationBinding.source_event_ids) &&
      existingObjectiveOperationBinding.source_event_ids.length &&
      Array.isArray(existingObjectiveOperationBinding.action_ids) &&
      existingObjectiveOperationBinding.action_ids.length &&
      Array.isArray(existingObjectiveOperationBinding.source_step_orders) &&
      operationSourceStepOrders.length &&
      operationSourceStepOrders.every((order) =>
        existingObjectiveOperationBinding.source_step_orders.includes(order),
      ),
    );
  const operationIssues = [
    ...objectiveOperationAssertionIssues(
      objectiveOperation,
      operationSourceStepOrders,
      assertions,
    ),
    ...(operationBindingValid
      ? []
      : [
          {
            semantic_body_required: true,
            malformed_assertion: true,
            ...(operationSourceStepOrders[0]
              ? { step_order: operationSourceStepOrders[0] }
              : {}),
          } as BusinessAssertionIssue,
        ]),
  ];
  if (operationIssues.length)
    throw new BusinessAssertionValidationError(
      "The strict normal objective needs its server-derived state-changing operation step and a goal/state semantic body assertion before native validation.",
      operationIssues,
    );
  const retryTargetIssues = await coverageRetryTargetAssertionIssues(
    context,
    session,
    input.workflow_id,
    assertions,
  );
  if (retryTargetIssues.length)
    throw new BusinessAssertionValidationError(
      "Each scheduled coverage-retry target needs a semantic body assertion on one of its own observed source workflow steps before native validation.",
      retryTargetIssues,
    );
  const learning = await buildRecordingLearningSuggestions(
    context.db,
    input.workflow_id,
    session.id,
    {
      includeExtractors: true,
      includeSessionJar: true,
      includeAssertions: false,
    },
  );
  const requestedIds = input.mapping_ids || [];
  if (
    requestedIds.some(
      (id) => !learning.suggestions.mappings.some((item) => item.id === id),
    )
  )
    throw new Error(
      "A selected mapping is not an observed learning candidate.",
    );
  // A normal Flow is an executable replay of a browser-observed transaction,
  // not a request for the model to rediscover a rotating form token from
  // redacted names alone.  Preserve narrowly classified, recording-proved
  // transport prerequisites even when the Agent chooses no optional mapping.
  // The strict predicate rules out generic/header/object correlations, and the
  // values remain inside native recording/execution storage.
  const requiredReplayMappings = learning.suggestions.mappings.filter(
    (item) =>
      item.requiredForReplay === true || isRequiredRecordingReplayMapping(item),
  );
  const ids = [
    ...new Set([
      ...requestedIds,
      ...requiredReplayMappings.map((item) => item.id),
    ]),
  ];
  const selected = learning.suggestions.mappings.filter((item) =>
    ids.includes(item.id),
  );
  const snapshotId = await snapshotBusinessWorkflow(context, input.workflow_id);
  await context.db.repos.workflows.update(snapshotId, {
    baseline_config: {
      // Keep the immutable snapshot safe if any generic runner later executes
      // it. This call's private normal_business_evidence flag selectively
      // enables dynamic mappings and semantic verification below.
      capture_replay_only: true,
      exact_captured_baseline:
        selected.length === 0 && !input.apply_session_jar,
      agent_business_normal_validation: true,
    },
    enable_extractor: selected.length > 0,
    enable_session_jar: input.apply_session_jar === true,
  } as any);
  steps = (
    await context.db.repos.workflowSteps.findAll({
      where: { workflow_id: snapshotId } as any,
    })
  ).sort((a, b) => a.step_order - b.step_order);
  if (selected.length || input.apply_session_jar) {
    const variables = new Set(selected.map((item) => item.variableName));
    const selectedLearning = {
      ...learning,
      suggestions: {
        ...learning.suggestions,
        mappings: selected.map((item) => ({
          ...item,
          selectedByDefault: true,
        })),
        workflowVariables: learning.suggestions.workflowVariables.filter(
          (item) => variables.has(item.variableName),
        ),
        extractors: learning.suggestions.extractors.filter((item) =>
          variables.has(item.targetVariableName),
        ),
        assertions: [],
        sessionJar: input.apply_session_jar
          ? learning.suggestions.sessionJar
          : null,
      },
    };
    await applyLearningPayload(context.db, snapshotId, selectedLearning, {
      applyMode: "merge_keep_manual",
      applySessionJar: input.apply_session_jar === true,
      applyAssertions: false,
      minConfidence: 0,
    });
    await context.db.repos.workflows.update(snapshotId, {
      enable_extractor: selected.length > 0,
    } as any);
  }
  const requiredReplayConfigsRemoved =
    await removeShadowedRequiredReplayConfigs(
      context,
      snapshotId,
      requiredReplayMappings,
    );
  const executionAssertionsById = new Map<string, BusinessGoalAssertion>();
  for (const step of steps) {
    const template = await context.db.repos.apiTemplates.findById(
      step.api_template_id,
    );
    if (!template) throw new Error("Observed step template is missing.");
    const source = (
      await context.db.repos.workflowDraftSteps.findAll({
        where: { session_id: session.id } as any,
      })
    ).find(
      (draft) =>
        draft.id === template.advanced_config?.source_workflow_draft_step_id,
    );
    const event = source
      ? await context.db.repos.recordingEvents.findById(source.source_event_id)
      : null;
    const checks = assertions
      .filter((item) => item.step_order === step.step_order)
      .map((assertion) => {
        const resolved = executionAssertionForCapturedBaseline(
          assertion,
          event,
        );
        const checked = {
          ...resolved,
          missing_behavior: "fail",
        } as BusinessGoalAssertion;
        executionAssertionsById.set(assertion.id, checked);
        return checked;
      });
    // Do not write an internally resolved captured-baseline literal into the
    // generic Workflow row. Workflow REST/asset views are wider than private
    // business evidence, so the raw normal response value must remain only in
    // this server-side validation call and the private trace. Do not add a
    // source-status assertion either: non-2xx is enforced below, while this
    // snapshot's executable assertions must be exactly the model-selected
    // semantic checks.
    const persistedChecks = assertions
      .filter(
        (assertion) =>
          assertion.step_order === step.step_order &&
          assertion.right?.type !== "captured_baseline" &&
          assertion.right?.captured_baseline !== true,
      )
      .map((assertion) => ({ ...assertion, missing_behavior: "fail" }));
    await context.db.repos.workflowSteps.update(step.id, {
      step_assertions: persistedChecks,
      assertions_mode: "all",
    } as any);
  }
  const environment = await context.db.repos.environments.create({
    name: `业务验证 ${flowId}`,
    base_url: run.base_url,
    is_active: true,
  } as any);
  const accountIds = session.account_id ? [session.account_id] : [];
  const testRun = await context.db.repos.testRuns.create({
    name: `正常业务验证 ${session.name}`,
    status: "pending",
    execution_type: "workflow",
    trigger_type: "ai_scan",
    workflow_id: snapshotId,
    account_ids: accountIds,
    environment_id: environment.id,
    rule_ids: [],
    progress_percent: 0,
    source_recording_session_id: session.id,
    execution_params: {
      ai_scan_task_id: context.taskId,
      scan_run_id: context.scanRunId,
      flow_id: flowId,
      business_normal_run: true,
      source_workflow_id: input.workflow_id,
      business_assertions: assertions,
      mapping_ids: ids,
      requested_mapping_ids: requestedIds,
      required_replay_mapping_ids: requiredReplayMappings.map(
        (item) => item.id,
      ),
      required_replay_configs_removed: requiredReplayConfigsRemoved,
      apply_session_jar: input.apply_session_jar === true,
    },
  } as any);
  const nativeExecution = await executeWorkflowRun({
    test_run_id: testRun.id,
    workflow_id: snapshotId,
    account_ids: accountIds,
    environment_id: environment.id,
    evidence_only: true,
    normal_business_evidence: true,
  });
  const trace = getTraceByRunId("workflow", testRun.id);
  const nonSuccessStepOrders = [
    ...new Set(
      (trace?.records || [])
        .filter(
          (record) =>
            !isSuccessfulNormalResponseStatus(record.response?.status),
        )
        .map((record) => Number(record.meta?.step_order || 0))
        .filter((order) => order > 0),
    ),
  ].sort((left, right) => left - right);
  const normalStatusError = nonSuccessStepOrders.length
    ? `Normal business verification received non-success HTTP response at workflow step(s): ${nonSuccessStepOrders.join(", ")}.`
    : undefined;
  // executeWorkflowRun is shared with security experiments, where a 4xx can be
  // valid counterexample evidence. This normal-flow adapter adds the stricter
  // invariant and persists it on this normal Test Run only.
  if (normalStatusError) {
    const persistedRun = await context.db.repos.testRuns.findById(testRun.id);
    await context.db.repos.testRuns.update(testRun.id, {
      ...(persistedRun?.status === "failed"
        ? {}
        : { status: "completed_with_errors" }),
      has_execution_error: true,
      errors_count: Math.max(
        Number(nativeExecution.errors_count || 0),
        nonSuccessStepOrders.length,
      ),
      error_message: nativeExecution.error
        ? `${nativeExecution.error}; ${normalStatusError}`
        : normalStatusError,
    } as any);
  }
  const execution = normalStatusError
    ? {
        ...nativeExecution,
        success: false,
        has_execution_error: true,
        errors_count: Math.max(
          Number(nativeExecution.errors_count || 0),
          nonSuccessStepOrders.length,
        ),
        error: nativeExecution.error
          ? `${nativeExecution.error}; ${normalStatusError}`
          : normalStatusError,
      }
    : nativeExecution;
  const normalAssertionResults = new Map<string, boolean[]>();
  for (const result of nativeExecution.normal_business_assertion_results ||
    []) {
    if (typeof result.assertion_id !== "string" || !result.assertion_id)
      continue;
    const values = normalAssertionResults.get(result.assertion_id) || [];
    values.push(result.passed === true);
    normalAssertionResults.set(result.assertion_id, values);
  }
  const checks = assertions.map((assertion) => {
    const executionAssertion =
      executionAssertionsById.get(assertion.id) || assertion;
    const records =
      trace?.records.filter(
        (record) => record.meta?.step_order === assertion.step_order,
      ) || [];
    const capturedBaseline = assertion.right.type === "captured_baseline";
    const selectedResults = normalAssertionResults.get(assertion.id) || [];
    const recordsUsable =
      records.length > 0 &&
      records.every((record) => !record.error && record.response !== undefined);
    const capturedBaselinePassed =
      executionAssertion.right.type === "literal" &&
      records.every((record) => {
        const response = record.response;
        if (!response) return false;
        return evaluateStepAssertions(
          [
            {
              left: executionAssertion.left,
              op: executionAssertion.op,
              right: executionAssertion.right,
              missing_behavior: "fail",
            },
          ],
          "all",
          {
            status: response.status,
            headers: response.headers,
            body: response.body || "",
          },
          {},
          { extractedValues: {}, cookies: {}, sessionFields: {} },
        ).passed;
      });
    const passed =
      recordsUsable &&
      execution.success &&
      (capturedBaseline
        ? capturedBaselinePassed
        : selectedResults.length > 0 &&
          selectedResults.every((value) => value));
    return {
      ...assertion,
      name: assertion.description,
      passed,
      verified_by: "native_workflow_assertion_evaluator",
    };
  });
  const baseVerified =
    execution.success &&
    !execution.has_execution_error &&
    Boolean(trace?.records.length) &&
    checks.every((check) => check.passed);
  const completionAssertionIds = objectiveCompletion
    ? checks
        .filter(
          (check) =>
            check.passed &&
            completionSourceStepOrders.includes(check.step_order) &&
            objectiveCompletion.required_response_paths.includes(
              check.left.path,
            ) &&
            ["goal", "state"].includes(check.purpose),
        )
        .map((check) => check.id)
    : [];
  const objectiveCompletionVerified =
    !objectiveCompletion ||
    (completionBindingValid &&
      objectiveCompletion.required_response_paths.every((path) =>
        checks.some(
          (check) =>
            check.passed &&
            completionSourceStepOrders.includes(check.step_order) &&
            check.left.path === path &&
            ["goal", "state"].includes(check.purpose),
        ),
      ));
  const operationAssertionIds = objectiveOperation
    ? checks
        .filter(
          (check) =>
            check.passed &&
            operationSourceStepOrders.includes(check.step_order) &&
            check.left.path.startsWith("body.") &&
            ["goal", "state"].includes(check.purpose),
        )
        .map((check) => check.id)
    : [];
  const objectiveOperationVerified =
    !objectiveOperation ||
    (operationBindingValid &&
      operationSourceStepOrders.some((order) =>
        checks.some(
          (check) =>
            check.passed &&
            check.step_order === order &&
            check.left.path.startsWith("body.") &&
            ["goal", "state"].includes(check.purpose),
        ),
      ));
  const verified =
    baseVerified && objectiveCompletionVerified && objectiveOperationVerified;
  const successfulOrders = new Set(
    (trace?.records || [])
      .filter((record) => !record.error && record.response)
      .map((record) => Number(record.meta?.step_order || 0)),
  );
  const coverageBindings = (
    Array.isArray((flowBeforeValidation as any).coverage_bindings)
      ? ((flowBeforeValidation as any)
          .coverage_bindings as BusinessCoverageBinding[])
      : []
  ).map((binding) =>
    // The initial validation binds a captured source workflow to its immutable
    // normal snapshot. A repair operates on that failed snapshot, so retain
    // the captured source provenance while allowing the next snapshot to
    // replace its failed normal-workflow/run edge. Without this branch, a
    // repaired workflow can pass but its original browser-action coverage
    // binding can never advance beyond the failed run.
    !(
      binding.source_workflow_id === input.workflow_id ||
      (binding.normal_workflow_id === input.workflow_id &&
        binding.normal_run_id === flowBeforeValidation.normal_run_id)
    )
      ? binding
      : (() => {
          // Coverage is proved at the captured source step, not by a successful
          // assertion from some other request in the same workflow.  Otherwise a
          // later state assertion could incorrectly mark every earlier endpoint as
          // business-validated.
          const assertionIds = checks
            .filter(
              (check) =>
                check.passed && check.step_order === binding.source_step_order,
            )
            .map((check) => check.id);
          return {
            ...binding,
            normal_workflow_id: snapshotId,
            normal_run_id: testRun.id,
            validation_assertion_ids: assertionIds,
            validated:
              verified &&
              successfulOrders.has(binding.source_step_order) &&
              assertionIds.length > 0,
          };
        })(),
  );
  const objectiveCompletionBinding =
    objectiveCompletion && existingObjectiveCompletionBinding
      ? {
          required_response_paths: objectiveCompletion.required_response_paths,
          source_event_ids: existingObjectiveCompletionBinding.source_event_ids,
          action_ids: existingObjectiveCompletionBinding.action_ids,
          // Preserve the original captured Workflow provenance across semantic
          // retries. input.workflow_id may be a later immutable normal snapshot.
          source_workflow_id:
            existingObjectiveCompletionBinding.source_workflow_id,
          source_step_orders: completionSourceStepOrders,
          normal_workflow_id: snapshotId,
          normal_run_id: testRun.id,
          validation_assertion_ids: completionAssertionIds,
          validated: objectiveCompletionVerified && baseVerified,
        }
      : undefined;
  const objectiveOperationBinding =
    objectiveOperation && existingObjectiveOperationBinding
      ? {
          operation_id: objectiveOperation.operation_id,
          side_effect_class: objectiveOperation.side_effect_class,
          source_event_ids: existingObjectiveOperationBinding.source_event_ids,
          action_ids: existingObjectiveOperationBinding.action_ids,
          source_workflow_id:
            existingObjectiveOperationBinding.source_workflow_id,
          source_step_orders: operationSourceStepOrders,
          normal_workflow_id: snapshotId,
          normal_run_id: testRun.id,
          validation_assertion_ids: operationAssertionIds,
          validated: objectiveOperationVerified && baseVerified,
        }
      : undefined;
  const traceArtifact = trace
    ? await context.repo.createArtifact({
        scan_run_id: context.scanRunId,
        task_id: context.taskId,
        artifact_type: "business_native_trace",
        source_ref: testRun.id,
        title: "原生正常流程执行证据",
        content_json: {
          flow_id: flowId,
          test_run_id: testRun.id,
          workflow_id: snapshotId,
          source_workflow_id: input.workflow_id,
          identity_key: session.role,
          trace,
          private: true,
        },
      })
    : undefined;
  const ownerAccount = session.account_id
    ? await context.db.repos.accounts.findById(session.account_id)
    : undefined;
  // flowEvent below creates exactly the next append-only flow revision. Bind
  // the handle to that revision now, so a later flow update makes it stale.
  const verifiedFlowRevision = Number(flowBeforeValidation.revision || 0) + 1;
  const handleCatalog =
    traceArtifact && verified
      ? await createBusinessObjectHandles({
          repo: context.repo,
          scanRunId: context.scanRunId,
          taskId: context.taskId,
          flow: {
            ...(flowBeforeValidation as any),
            status: "verified",
            workflow_id: snapshotId,
            normal_run_id: testRun.id,
            assertions: checks,
            assertions_verified: true,
          },
          normalRunId: testRun.id,
          normalWorkflowId: snapshotId,
          traceArtifactId: traceArtifact.id,
          trace,
          ownerRole: session.role || "anonymous",
          flowRevision: verifiedFlowRevision,
          ...(ownerAccount
            ? {
                ownerAccountId: ownerAccount.id,
                ownerSubjectHash: configuredIdentitySubjectHash(ownerAccount),
              }
            : {}),
        })
      : undefined;
  const validationArtifact = await context.repo.createArtifact({
    scan_run_id: context.scanRunId,
    task_id: context.taskId,
    artifact_type: "business_workflow_validation",
    source_ref: testRun.id,
    title: "正常业务执行与结果验证",
    content_json: {
      flow_id: flowId,
      workflow_id: snapshotId,
      source_workflow_id: input.workflow_id,
      recording_session_id: session.id,
      test_run_id: testRun.id,
      assertions: checks.map(publicBusinessAssertion),
      assertions_verified: verified,
      execution: publicExecution(execution, trace),
      trace: trace
        ? {
            total_requests: trace.summary.total_requests,
            errors_count: trace.summary.errors_count,
            records: trace.records.map((record) => ({
              step_order: record.meta?.step_order,
              status: record.response?.status,
              diagnostic: publicDiagnostic(record.error),
            })),
          }
        : null,
      coverage_bindings: coverageBindings
        .filter(
          (binding) =>
            binding.source_workflow_id === input.workflow_id ||
            binding.normal_workflow_id === snapshotId,
        )
        .map(publicCoverageBinding),
      ...(objectiveCompletionBinding
        ? { objective_completion_binding: objectiveCompletionBinding }
        : {}),
      ...(objectiveOperationBinding
        ? { objective_operation_binding: objectiveOperationBinding }
        : {}),
      object_handle_catalog_id: handleCatalog?.id,
    },
  });
  // The validation artifact is the immutable receipt for an objective operation
  // binding.  Keep the receipt itself value-free: it references only opaque
  // server IDs and model-selected assertion IDs. A Flow may claim `verified`
  // only with this post-artifact sealed form.
  const sealedObjectiveOperationBinding =
    objectiveOperationBinding?.validated === true
      ? {
          ...objectiveOperationBinding,
          validation_artifact_id: validationArtifact.id,
        }
      : objectiveOperationBinding;
  // A coverage proof is sealed only after this exact native validation artifact
  // exists and all its matching semantic assertions passed. The active binding
  // list remains mutable for workflow repair/revision; this ledger is what lets
  // a later task-scoped retry add one missing target without erasing prior proof.
  const sealedProofs =
    verified && traceArtifact
      ? coverageBindings.flatMap((binding) => {
          const proof = sealedCoverageProof(binding, {
            taskId: String(context.taskId || ""),
            validationArtifactId: validationArtifact.id,
            traceArtifactId: traceArtifact.id,
          });
          return proof ? [proof] : [];
        })
      : [];
  const coverageProofLedger = appendCoverageProofs(
    flowBeforeValidation.coverage_proof_ledger,
    sealedProofs,
  );
  await flowEvent(context, flowId, {
    status: verified ? "verified" : "failed",
    normal_run_id: testRun.id,
    workflow_id: snapshotId,
    assertions: checks,
    assertions_verified: verified,
    baseline_verified: verified,
    evidence_artifact_ids: [
      ...new Set([
        ...(flowBeforeValidation.evidence_artifact_ids || []),
        validationArtifact.id,
        ...(traceArtifact ? [traceArtifact.id] : []),
        ...(handleCatalog ? [handleCatalog.id] : []),
      ]),
    ],
    blockers: verified
      ? []
      : [execution.error || "正常执行未通过全部业务结果断言。"],
    coverage_bindings: coverageBindings,
    coverage_proof_ledger: coverageProofLedger,
    ...(objectiveCompletionBinding
      ? { objective_completion_binding: objectiveCompletionBinding }
      : {}),
    ...(sealedObjectiveOperationBinding
      ? { objective_operation_binding: sealedObjectiveOperationBinding }
      : {}),
    ...(handleCatalog ? { object_handle_catalog_id: handleCatalog.id } : {}),
  });
  return {
    flow_id: flowId,
    workflow_id: snapshotId,
    source_workflow_id: input.workflow_id,
    test_run_id: testRun.id,
    verified,
    assertions: checks.map(publicBusinessAssertion),
    execution: publicExecution(execution, trace),
    requested_mapping_ids: requestedIds,
    required_replay_mapping_ids: requiredReplayMappings.map((item) => item.id),
    required_replay_configs_removed: requiredReplayConfigsRemoved,
    coverage_proofs_added: sealedProofs.length,
    coverage_proof_count: coverageProofLedger.length,
    ...(objectiveCompletionBinding
      ? { objective_completion_binding: objectiveCompletionBinding }
      : {}),
    ...(sealedObjectiveOperationBinding
      ? { objective_operation_binding: sealedObjectiveOperationBinding }
      : {}),
    object_handle_count: Array.isArray(handleCatalog?.content_json?.handles)
      ? handleCatalog!.content_json.handles.length
      : 0,
    summary: verified
      ? "正常业务流程已由原生执行器重新执行并验证。"
      : "流程执行或业务结果验证未通过，相关安全实验不能把此基线视为已完成。",
  };
}

/**
 * Apply execution learning only to the exact failed normal-flow snapshot
 * belonging to the active task. The generic learning tool is deliberately not
 * reused here: it accepts any in-memory debug trace, while this adapter binds
 * a persisted private trace to one scan, task, Flow, workflow, and Test Run.
 *
 * The trace is never projected to the model. It is used server-side to learn
 * mappings/extractors/session handling, after which the model must inspect the
 * repaired workflow and choose a new semantic validation itself.
 */
export async function repairBusinessWorkflow(
  context: AgentToolContext,
  input: { workflow_id: string; test_run_id: string },
): Promise<Record<string, any>> {
  assertScanActive();
  const taskId = String(context.taskId || ""),
    workflowId = String(input.workflow_id || ""),
    testRunId = String(input.test_run_id || "");
  if (!taskId || !workflowId || !testRunId)
    throw new Error(
      "A current normal-learning task, workflow_id, and test_run_id are required for workflow repair.",
    );
  const task = await context.repo.getTask(taskId);
  if (!task || task.execution_plan?.intent !== BUSINESS_LEARNING_INTENT)
    throw new Error(
      "Workflow repair belongs only to the current normal business learning task.",
    );
  const inspection = await inspectBusinessWorkflow(context, workflowId);
  const recordingSessionId = String(inspection.recording_session_id || "");
  const session = await requireCurrentBusinessLearningRecording(
    context,
    recordingSessionId,
  );
  if (session.capture_filters?.capture_status !== "stopped")
    throw new Error(
      "Only a complete stopped recording can supply normal-workflow repair evidence.",
    );
  const flowId = String(session.capture_filters?.flow_id || "");
  if (!flowId || String(task.execution_plan?.flow_id || "") !== flowId)
    throw new Error(
      "Workflow repair is outside the current normal business Flow.",
    );
  const flow = await requireBusinessFlow(context, flowId);
  if (
    String(flow.workflow_id || "") !== workflowId ||
    String(flow.normal_run_id || "") !== testRunId
  ) {
    throw new Error(
      "Workflow repair requires the current Flow's latest failed workflow snapshot and normal Test Run.",
    );
  }
  const testRun = await context.db.repos.testRuns.findById(testRunId);
  const params = testRun?.execution_params || {};
  if (
    !testRun ||
    testRun.workflow_id !== workflowId ||
    String(params.scan_run_id || "") !== context.scanRunId ||
    String(params.ai_scan_task_id || "") !== taskId ||
    String(params.flow_id || "") !== flowId ||
    params.business_normal_run !== true
  ) {
    throw new Error(
      "The requested Test Run is not the current task-bound native normal-flow execution.",
    );
  }
  if (testRun.has_execution_error !== true) {
    throw new Error(
      "Execution learning repair is available only after a current normal Test Run reports an execution error; revise semantic assertions directly when execution itself succeeded.",
    );
  }
  const artifacts = await context.repo.listArtifacts(context.scanRunId);
  const traceArtifact = artifacts.find(
    (artifact) =>
      artifact.artifact_type === "business_native_trace" &&
      artifact.task_id === taskId &&
      artifact.source_ref === testRunId &&
      artifact.content_json?.private === true &&
      artifact.content_json?.flow_id === flowId &&
      artifact.content_json?.test_run_id === testRunId &&
      artifact.content_json?.workflow_id === workflowId,
  );
  const trace = traceArtifact?.content_json?.trace;
  if (
    !trace ||
    trace?.run_meta?.run_id !== testRunId ||
    !Array.isArray(trace.records) ||
    trace.records.length === 0
  ) {
    throw new Error(
      "The current failed normal Test Run has no matching persisted private workflow trace for repair.",
    );
  }
  const learning = await generateAndApplyExecutionLearning(
    context.db,
    workflowId,
    trace,
    {
      sourceExecutionRunId: testRunId,
      includeAssertions: false,
      minConfidence: 0.5,
    },
  );
  if (!learning.ok)
    throw new Error(
      `Native execution learning repair could not be applied: ${String(learning.reason || "unknown")}`,
    );
  const applied = learning.applied || {};
  const requiredReplay = await restoreRequiredReplayMappings(
    context,
    workflowId,
    session.id,
  );
  const repair = {
    step_snapshots: Number(learning.step_snapshots || 0),
    variables_created: Number(applied.variables_created || 0),
    mappings_created: Number(applied.mappings_created || 0),
    extractors_created: Number(applied.extractors_created || 0),
    session_jar_applied: applied.session_jar_applied === true,
    required_replay_mapping_count: requiredReplay.requiredReplayMappings.length,
    required_replay_variables_created: requiredReplay.variablesCreated,
    required_replay_mappings_created: requiredReplay.mappingsCreated,
    required_replay_configs_removed: requiredReplay.configsRemoved,
  };
  const repairArtifact = await context.repo.createArtifact({
    scan_run_id: context.scanRunId,
    task_id: taskId,
    artifact_type: "business_workflow_repair",
    source_ref: testRunId,
    title: "Normal business workflow execution-learning repair",
    content_json: {
      flow_id: flowId,
      workflow_id: workflowId,
      test_run_id: testRunId,
      source_trace_artifact_id: traceArtifact.id,
      status: "repaired",
      ...repair,
    },
  });
  await flowEvent(context, flowId, {
    ...flow,
    status: "learning",
    blockers: [],
    evidence_artifact_ids: [
      ...new Set([...(flow.evidence_artifact_ids || []), repairArtifact.id]),
    ],
  });
  return {
    flow_id: flowId,
    workflow_id: workflowId,
    test_run_id: testRunId,
    status: "repaired",
    repair_artifact_id: repairArtifact.id,
    ...repair,
    summary:
      "Server-side execution learning repaired only the current failed normal Workflow and restored any recording-proved replay prerequisite. Inspect the repaired workflow, then choose optional mappings, semantic assertions, and a fresh native validation.",
  };
}
