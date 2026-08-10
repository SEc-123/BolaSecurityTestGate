# BSTG 0.3.4 — P0 security boundary hardening

This release hardens the local/self-hosted BSTG deployment model without adding SaaS, tenant, login, or RBAC concepts.

## P0 changes

- **Local access boundary:** the server binds to `127.0.0.1` by default and browser CORS defaults to loopback origins. Operators can explicitly override this with `BSTG_HOST` and `CORS_ORIGIN`.
- **Target egress boundary:** AI Scan and native execution follow redirects only inside the configured target origin. Cross-origin redirects, HTML form actions, browser subrequests, account bootstrap requests, uploaded-file follow-up URLs, and workflow learning requests are blocked from escaping the authorized target origin.
- **AI secret boundary:** The shared AI client redacts credentials/tokens/cookies/passwords immediately before every model transport; Agent planner/judge paths also sanitize their structured context defensively. Legacy AI evidence redaction is now mandatory.
- **Parallel evidence integrity:** debug traces are retained by execution run ID. Native learning and mutation evidence now fetch the exact run trace instead of a process-global “last workflow trace”, preventing cross-task evidence mix-ups under parallel Agents.

## Regression coverage

Run:

```bash
npm run test:p0:security-boundaries
```

The regression covers same-origin vs cross-origin redirects, target URL validation, local bind/CORS defaults, model-context secret redaction, and concurrent workflow trace isolation.
