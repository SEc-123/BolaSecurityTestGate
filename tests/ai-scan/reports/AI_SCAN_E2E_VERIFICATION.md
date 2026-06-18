# AI Scan End-to-End Verification

This package was verified with a real local vulnerable target and the BSTG backend, not only by typecheck.

## Executed command

`npm --prefix server run build && npm --prefix server run typecheck && npm run typecheck && npm run test:ai-scan:e2e`

## Closed-loop result

- Scan ID: `fec04504-2841-43be-8900-8bf2570fec80`
- Target: `http://127.0.0.1:3320/`
- Scan status: `completed`
- Endpoints discovered: 17
- Persistent tasks: 48
- Artifacts: 285
- Tool invocations: 51
- Findings confirmed: 12
- Severities: medium=7, critical=1, high=4

## Created BSTG assets

- api_templates: 46
- workflows: 46
- workflow_steps: 46
- security_rules: 46
- checklists: 3
- findings: 12

## Candidate types

- auth_otp: 1
- bfla: 2
- bola_idor: 9
- business_logic: 9
- command_injection: 1
- file_download: 3
- file_upload: 3
- path_traversal: 3
- replay_race: 6
- xss: 10

## Confirmed finding evidence

- **medium** 文件上传点 /api/avatar/upload 接受危险文件或危险内容 — status=200; evidence=`{"ok":true,"avatar_url":"/uploads/bstg-svg-xss.svg","url":"/uploads/bstg-svg-xss.svg","path":"/uploads/bstg-svg-xss.svg","filename":"bstg-svg-xss.svg"}`
- **medium** 文件上传点 /api/community/image/upload 接受危险文件或危险内容 — status=200; evidence=`{"ok":true,"avatar_url":"/uploads/bstg-svg-xss.svg","url":"/uploads/bstg-svg-xss.svg","path":"/uploads/bstg-svg-xss.svg","filename":"bstg-svg-xss.svg"}`
- **critical** GET /api/ping 可能存在 command_injection 漏洞 — status=200; evidence=`PING localhost
uid=1000(bstg) gid=1000(bstg) groups=1000(bstg)`
- **high** GET /admin/users 可能存在 bfla 漏洞 — status=200; evidence=`{"admin":true,"users":[{"id":1,"email":"admin@example.com"}],"message":"admin function accessible"}`
- **high** GET /api/order 可能存在 bola_idor 漏洞 — status=200; evidence=`{"id":2,"owner":"victim-bob","amount":999,"secret":"other user order exposed"}`
- **medium** GET /api/cart 可能存在 business_logic 漏洞 — status=200; evidence=`{"ok":true,"quantity":-1,"total":-100,"message":"negative quantity accepted"}`
- **medium** GET /admin/users 可能存在 business_logic 漏洞 — status=200; evidence=`{"admin":false,"message":"user view"}`
- **medium** GET /api/cart 可能存在 business_logic 漏洞 — status=200; evidence=`{"ok":true,"quantity":-1,"total":-100,"message":"negative quantity accepted"}`
- **high** GET /download 可能存在 file_download 漏洞 — status=200; evidence=`root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin`
- **high** GET /download 可能存在 path_traversal 漏洞 — status=200; evidence=`root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin`
- **medium** GET /api/cart 可能存在 replay_race 漏洞 — status=200; evidence=`{"ok":true,"quantity":-1,"total":-100,"message":"negative quantity accepted"}`
- **medium** GET /search 可能存在 xss 漏洞 — status=200; evidence=`<title>Search</title><div id="result"><script>alert(1337)</script></div>`

## What the E2E proves

1. A URL is submitted to AI Scan.
2. The system automatically discovers pages, forms, file inputs, and API endpoints.
3. It builds feature/vulnerability candidates.
4. The user-selection API fixes the vulnerability scope.
5. The Agent expands the selected vulnerabilities into persistent executable tasks.
6. Each task creates BSTG assets and evidence artifacts.
7. File upload, file download/path traversal, BOLA/IDOR, BFLA, business logic, XSS, command injection, and replay/race tasks execute end-to-end.
8. Confirmed evidence is written into findings.
