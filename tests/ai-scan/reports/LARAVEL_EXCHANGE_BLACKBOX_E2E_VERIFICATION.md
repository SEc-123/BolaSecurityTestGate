# Laravel Exchange Blackbox AI Scan E2E Verification

This verification was executed locally against a source-derived blackbox target generated from the uploaded Laravel exchange source route files.

## Direct Laravel boot check

The uploaded source tree does not contain `vendor/autoload.php`; direct Laravel boot via `php -S -t public` returns HTTP 500 with `Failed opening required vendor/autoload.php`. I did not claim the Laravel application itself was bootable from that ZIP. To still perform a blackbox closed-loop validation against the uploaded project shape, the test target reads the uploaded `routes/*.php` files and exposes a local route-faithful HTTP harness covering the exchange project's login, OTP, upload, order, wallet, OTC, admin, article/content, file/download, and debug-style endpoints.

## Commands run

```bash
npm --prefix server run typecheck
npm --prefix server run build
npm run typecheck
npm run build
npm run test:ai-scan:e2e
TARGET_SOURCE_DIR=/mnt/data/work/target npm run test:ai-scan:laravel-blackbox
```

## Laravel-source-derived blackbox result

- Route count parsed from uploaded source: 420
- Discovered endpoints: 186
- Persistent AI tasks: 53
- Failed AI tasks: 0
- Native BSTG execution artifacts: 51
- Confirmed findings after AI/evidence gate: 32

Native BSTG assets created/executed:

| Asset | Count |
|---|---:|
| api_templates | 154 |
| workflows | 153 |
| workflow_steps | 154 |
| workflow_variable_configs | 172 |
| workflow_extractors | 515 |
| workflow_variables | 4 |
| workflow_mappings | 52 |
| security_rules | 102 |
| checklists | 57 |
| accounts | 3 |
| test_runs | 153 |
| findings | 32 |

Vulnerability classes exercised end-to-end:

- file_upload
- file_download
- path_traversal
- bola_idor
- bfla
- business_logic
- xss
- command_injection
- auth_otp
- replay_race

Key evidence confirmed in findings:

- Dangerous upload payloads accepted and stored.
- Traversal/download payload returned `/etc/passwd`-style content.
- Command injection payload returned `uid=1000/gid=1000` evidence.
- BOLA/IDOR mutation accessed `victim-bob`/other-user order data.
- BFLA mutation accessed admin user-management evidence.
- Business-logic mutation accepted negative quantity/amount and produced negative total.
- XSS mutation reflected `<script>alert(1337)</script>`.

## Original BSTG capability usage verified

The AI scan no longer bypasses the original BSTG engine. For each executable task it creates native BSTG assets and executes native test runs:

- `api_templates`
- `security_rules`
- `checklists`
- `accounts`
- `workflows`
- `workflow_steps`
- `workflow_variable_configs`
- `workflow_extractors`
- `workflow_variables`
- `workflow_mappings`
- native `template` test runs
- native `workflow` test runs
- session jar enabled in workflows
- extractor-driven cross-step variable propagation
- account binding / attacker-victim account material
- mutation profile fields such as `swap_account_at_steps`, `skip_steps`, `repeat_steps`, `concurrent_replay`, `lock_variables`, and `reuse_tickets`

Native runner auto-findings are cleaned from final findings and retained as execution artifacts; final findings are created only by the AI/evidence gate to avoid flooding the DB with baseline-diff noise.

Detailed machine-readable report:

- `tests/ai-scan/reports/latest-laravel-exchange-blackbox-report.json`
