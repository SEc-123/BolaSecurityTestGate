# Agent execution model

BSTG's Agent is responsible for discovering and understanding target behavior, deciding what to test, and interpreting evidence. Native BSTG tools perform browser observation, business capture, workflow preparation, test execution, and evidence inspection. This keeps model decisions connected to reproducible runs rather than reducing the Agent to a launcher for a fixed checklist.

## Normal behavior before security experiments

For a business flow, the Agent first identifies relevant pages and operations, uses the browser to exercise the ordinary flow, and inspects the resulting requests and responses. BSTG can turn the captured events into API Templates and a Workflow with dynamic field and session relationships. The Agent then validates the Workflow with a fresh Test Run and semantic assertions. A saved flow is not considered learned merely because it has a name or a successful-looking browser screen.

This step provides the baseline needed to reason about later experiments: which identity performed an action, which object was created or changed, how values and session state move between requests, and what normal completion looks like.

## Model-directed experiments

After the normal flow is verified, the Agent can use the discovered workflow structure and safe field metadata to create an experiment plan. It chooses the relevant steps, identities, request changes, repetition or concurrency, and control/impact checks. BSTG compiles that plan into native Workflow and Test Run assets so the experiment can be inspected and replayed.

The model does not receive private raw captures or credentials. Opaque references let the runtime resolve eligible values from protected traces when compiling a run. Identity separation, fresh execution, and evidence ownership remain enforced by the runtime.

## Evidence and conclusions

A model explanation is not itself evidence. The assessment must refer to the current plan and real test runs, and satisfy the evidence checks for the claim. For object authorization, for example, a status code alone is insufficient: the run must establish the identities, object provenance, control behavior, attempted impact, and authoritative post-write state needed to support the conclusion.

If evidence is incomplete, the result remains inconclusive or blocked and the Agent can revise the plan. Product-facing views expose a safe evidence summary; sensitive request and response material remains in protected execution storage.

## Execution layers

The browser worker supplies an isolated Chromium session for live interaction and capture. BSTG's native Template, Workflow, and Test Run engine handles repeatable HTTP execution and evidence collection. The Agent coordinates both through bounded tools. See the [browser runtime](local-runtime-reuse.md) and [HTTPS capture contract](https-business-capture-contract.md) for the runtime boundaries.

Use these capabilities only against systems where testing is explicitly authorized.
