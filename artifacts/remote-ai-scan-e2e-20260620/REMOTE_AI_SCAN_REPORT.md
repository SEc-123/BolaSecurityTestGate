# Remote AI Scan E2E Report

Generated: 2026-06-19T20:47:41.106Z (UTC). Local UI displayed these runs on 2026-06-20 Asia/Shanghai.

## Environment

- BSTG local UI/API: http://127.0.0.1:3101
- Local AI provider: http://127.0.0.1:3339/v1
- Remote test server: 61.164.252.247:18902 via the configured Skill helper
- Dou Dizhu target: remote /opt/bstg-targets/doudizhu on :18080, accessed locally through http://127.0.0.1:28080/
- Traceability target: remote /opt/bstg-targets/traceability on :18081, accessed locally through http://127.0.0.1:28081/
- Remote process verification: php is listening on 0.0.0.0:18080 and 0.0.0.0:18081 as www-data.

## Product Fixes Closed During Test

1. AI Scan creation now sends selected_vuln_types to the backend and defaults empty UI selection to the full 13-class suite.
2. The local autonomous AI fixture now returns OK for provider tests, produces strict planning JSON, and judges only target response evidence rather than payload text.
3. Generic and upload AI judgements now pass through a local evidence gate. Provider vulnerable verdicts without confirmable mutated-response evidence are downgraded to inconclusive/not_vulnerable and cannot create Findings.
4. Browser discovery no longer turns stylesheet/script/static assets into test endpoints. Scripts are still fetched for inline API extraction.
5. The AI Scan page now shows evidence gate summary: Confirmed, Inconclusive, Not vulnerable, Preconditions, Native gate.
6. The PHP 5-era traceability target was made runnable on the test server with a PHP 7.4 compatibility shim and replacement for the unparsable obfuscated function file.

## Final Runs

### Dou Dizhu

- Run: da6d799c-a154-4305-b5a0-7da7022a333c
- Status: completed, tasks 16/16, failures 0
- Coverage: 1 endpoint, 3 features, 5 candidates, 154 artifacts, 18 tool calls
- Endpoints: GET / (browser_form)
- Judgements: {"inconclusive/inconclusive":5}
- Confirmed findings for this run: 0

### Traceability

- Run: b1019819-587c-4ba8-81ca-5c2f683be491
- Status: completed, tasks 14/14, failures 0
- Coverage: 3 endpoints, 6 features, 6 candidates, 153 artifacts, 18 tool calls
- Endpoints: GET / (browser_page), GET /ts/fwm_ts.php (browser_js_reference), POST /ts/fwm_ts.php (browser_form)
- Judgements: {"inconclusive/inconclusive":5}
- Evidence gates: {"preconditions":2,"native_gate":0}
- Confirmed findings for this run: 0

## Regression Evidence

- Before the AI evidence gate, Dou Dizhu run 239bbb24-cf50-4e08-bfcc-69e57a85f3db produced 4 Findings from weak/static evidence.
- After the gate and static-resource filtering, final Dou Dizhu run da6d799c-a154-4305-b5a0-7da7022a333c produced 0 Findings and only inconclusive judgements.
- Before static filtering, traceability run 23549dd4-c9ee-41cb-8023-6794db1cb176 discovered 8 endpoints including CSS/JS assets.
- After static filtering, final traceability run b1019819-587c-4ba8-81ca-5c2f683be491 discovered 3 endpoints: page, JS-referenced route, and form POST.

## Verification Commands Run

- npm run typecheck:server
- npm run build:server
- npm run build:frontend
- npm run typecheck
- npm run build
- Browser frontend Start/Resume flow for all final runs
- Remote server process check through the Skill SSH helper

## Verdict

Both remote targets were deployed and tested on the Skill-provided server, while BSTG ran locally and was operated through the frontend. The final product behavior is improved: the scanner no longer reports payload-text hallucinations as confirmed vulnerabilities, static assets are removed from endpoint coverage, and the UI exposes evidence-gate state directly. No confirmed target vulnerability remained after the corrected evidence gate. The main residual gap is target depth: post-login/admin workflows require real account/session capture or raw request seeding to go beyond public forms.
