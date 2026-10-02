/**
 * Selector correction state is derived from persisted tool invocations, rather
 * than a single latest result. A selectorless observation is useful to refresh
 * the live candidate set, but must not let a model escape a rejected selector
 * by submitting an unrelated unique selector on the following turn.
 */
export const selectorRecoveryCodes = new Set([
  "selector_no_match",
  "selector_ambiguous",
  "selector_not_visible",
  "selector_invalid",
  "selector_actionability_timeout",
  // A short-lived opaque reference is deliberately invalidated whenever the
  // live page no longer proves it denotes the same element.  This is the same
  // no-dispatch correction class as an ordinary selector miss: the next model
  // turn must use the returned current observation, never retry the old ref.
  "observation_reference_expired",
  "assertion_not_observed",
  "opaque_reference_required",
]);

export interface SelectorRecoveryState {
  candidates: string[];
}

export function observedSelectorCandidates(value: any): string[] {
  const observation = value?.observation;
  if (!observation || typeof observation !== "object") return [];
  return ["controls", "assertion_targets"]
    .flatMap((property) =>
      Array.isArray(observation[property])
        ? observation[property].map((item: any) =>
            typeof item?.control_ref === "string"
              ? item.control_ref
              : typeof item?.assertion_ref === "string"
                ? item.assertion_ref
                : // Legacy private invocation rows can still be evaluated locally during
                  // migration. They are never copied into a new model context.
                  typeof item?.selector === "string"
                  ? item.selector
                  : "",
          )
        : [],
    )
    .filter(
      (reference: string) => reference.length > 0 && reference.length <= 1000,
    );
}

function retryableSelectorRejection(invocation: any): boolean {
  const output = invocation?.output_json;
  return (
    invocation?.tool_name === "browser.interact" &&
    invocation?.status === "failed" &&
    output?.failure_phase === "pre_action" &&
    output?.action_performed === false &&
    output?.retryable === true &&
    selectorRecoveryCodes.has(String(output?.error_code || ""))
  );
}

function selectorlessRecoveryObservation(invocation: any): boolean {
  if (
    invocation?.tool_name !== "browser.interact" ||
    invocation?.status !== "completed"
  )
    return false;
  const operation = invocation.input_json?.operation;
  const action = String(operation?.action || "");
  return (
    action === "observe" ||
    action === "scroll" ||
    (action === "press" && !operation?.selector && !operation?.control_ref)
  );
}

function successfulObservedSelectorCandidate(
  invocation: any,
  candidates: string[],
): boolean {
  if (
    invocation?.tool_name !== "browser.interact" ||
    invocation?.status !== "completed"
  )
    return false;
  const operation = invocation.input_json?.operation;
  const reference =
    typeof operation?.control_ref === "string"
      ? operation.control_ref
      : typeof operation?.assertion_ref === "string"
        ? operation.assertion_ref
        : typeof operation?.selector === "string"
          ? operation.selector
          : "";
  return reference.length > 0 && candidates.includes(reference);
}

/**
 * Return the active normal-business correction episode, if one exists. A
 * candidate list is refreshed by every successful selectorless observation.
 * It is cleared only by a completed selector action/assertion whose selector
 * exactly matches the list exposed by the immediately preceding observation.
 */
export function deriveSelectorRecovery(
  invocations: any[],
): SelectorRecoveryState | undefined {
  let recovery: SelectorRecoveryState | undefined;
  for (const invocation of invocations || []) {
    // Successful prepared login replaces the page document. Any correction
    // candidates issued for the pre-login page are necessarily stale.
    if (
      invocation?.tool_name === "bstg.identity.apply_login" &&
      invocation?.status === "completed" &&
      invocation?.output_json?.authenticated === true
    ) {
      recovery = undefined;
      continue;
    }
    if (retryableSelectorRejection(invocation)) {
      recovery = {
        candidates: [
          ...new Set(observedSelectorCandidates(invocation.output_json)),
        ],
      };
      continue;
    }
    if (!recovery) continue;
    if (successfulObservedSelectorCandidate(invocation, recovery.candidates)) {
      recovery = undefined;
      continue;
    }
    if (selectorlessRecoveryObservation(invocation)) {
      recovery = {
        candidates: [
          ...new Set(observedSelectorCandidates(invocation.output_json)),
        ],
      };
    }
  }
  return recovery;
}
