import test from "node:test";
import assert from "node:assert/strict";
import { deriveSelectorRecovery } from "../../server/src/agent/selector-recovery.ts";

const controlObservation = (control_ref) => ({
  observation: { controls: [{ control_ref }] },
});
const assertionObservation = (assertion_ref) => ({
  observation: { assertion_targets: [{ assertion_ref }] },
});
const rejectedControl = (control_ref) => ({
  tool_name: "browser.interact",
  status: "failed",
  input_json: { operation: { action: "click", control_ref } },
  output_json: {
    error_code: "selector_no_match",
    failure_phase: "pre_action",
    action_performed: false,
    retryable: true,
    ...controlObservation("control_ref_current"),
  },
});
const rejectedAssertion = (assertion_ref) => ({
  tool_name: "browser.interact",
  status: "failed",
  input_json: { operation: { action: "assert", assertion_ref } },
  output_json: {
    error_code: "selector_no_match",
    failure_phase: "pre_action",
    action_performed: false,
    retryable: true,
    ...assertionObservation("assertion_ref_current"),
  },
});
const rejectedExpiredObservation = (control_ref) => ({
  tool_name: "browser.interact",
  status: "failed",
  input_json: { operation: { action: "click", control_ref } },
  output_json: {
    error_code: "observation_reference_expired",
    failure_phase: "pre_action",
    action_performed: false,
    retryable: true,
    ...controlObservation("control_ref_reobserved_current"),
  },
});
const observeControls = (control_ref) => ({
  tool_name: "browser.interact",
  status: "completed",
  input_json: { operation: { action: "observe" } },
  output_json: controlObservation(control_ref),
});
const observeAssertions = (assertion_ref) => ({
  tool_name: "browser.interact",
  status: "completed",
  input_json: { operation: { action: "observe" } },
  output_json: assertionObservation(assertion_ref),
});
const asserted = (assertion_ref) => ({
  tool_name: "browser.interact",
  status: "completed",
  input_json: { operation: { action: "assert", assertion_ref } },
  output_json: assertionObservation(assertion_ref),
});

test("selector recovery survives a bounded prompt window of selectorless observations", () => {
  const invocations = [
    rejectedControl("control_ref_expired"),
    ...Array.from({ length: 40 }, () => observeControls("control_ref_current")),
  ];
  assert.deepEqual(deriveSelectorRecovery(invocations), {
    candidates: ["control_ref_current"],
  });
});

test("only a successful exact current opaque assertion reference resolves selector recovery", () => {
  const prefix = [
    rejectedAssertion("assertion_ref_expired"),
    observeAssertions("assertion_ref_current"),
  ];
  assert.deepEqual(
    deriveSelectorRecovery([...prefix, asserted("assertion_ref_invented")]),
    { candidates: ["assertion_ref_current"] },
  );
  assert.equal(
    deriveSelectorRecovery([...prefix, asserted("assertion_ref_current")]),
    undefined,
  );
});

test("successful prepared login clears a pre-login selector correction episode", () => {
  const invocations = [
    rejectedControl("control_ref_login_page"),
    observeControls("control_ref_login_page_current"),
    {
      tool_name: "bstg.identity.apply_login",
      status: "completed",
      output_json: { authenticated: true },
    },
  ];
  assert.equal(deriveSelectorRecovery(invocations), undefined);
});

test("an expired opaque reference reuses the current returned observation as a bounded correction", () => {
  const rejected = rejectedExpiredObservation("control_ref_stale");
  assert.deepEqual(deriveSelectorRecovery([rejected]), {
    candidates: ["control_ref_reobserved_current"],
  });
  assert.equal(
    deriveSelectorRecovery([
      rejected,
      {
        tool_name: "browser.interact",
        status: "completed",
        input_json: {
          operation: {
            action: "click",
            control_ref: "control_ref_reobserved_current",
          },
        },
        output_json: controlObservation("control_ref_reobserved_current"),
      },
    ]),
    undefined,
    "only the newly observed reference resolves the expired-reference episode",
  );
});
