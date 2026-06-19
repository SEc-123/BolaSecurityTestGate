# BSTG Product Design Direction

BSTG uses a dense security operations console style across all pages.

- Global shell follows the Mission Control direction: dark left navigation, compact top status bar, light working canvas, and grouped primary workflow plus system tools.
- Scope is limited to existing active pages and workflows. Do not restore removed legacy pages, duplicate old manual flows, or add UI controls that are not backed by the current AI-assisted runtime.
- Assessment, Dashboard, Run History, Recorder, and Run Presets should prioritize launch state, execution queue, recent runs, and operational readiness.
- Findings, Review, and Reports should follow the Evidence Workbench direction: list/detail layouts, traceable evidence blocks, request/response comparison, AI verdicts, and governance actions.
- CI Gate, Governance, and Security Suites should follow the Release Gate Board direction: PASS/WARN/BLOCK decisions, thresholds, blockers, suppression queues, audit trails, and export actions.
- Secondary configuration pages should stay compact and utilitarian: toolbar first, table/form surfaces second, status chips and inline actions over large decorative cards.
- Existing support pages should expose real system state through small metric strips, then keep the original table, form, modal, and wizard workflows intact.
- Use neutral surfaces, graphite text, clear blue actions, and semantic red/amber/emerald status colors. Keep radius at 8px or less and avoid decorative gradients, nested cards, and marketing-style hero sections.
