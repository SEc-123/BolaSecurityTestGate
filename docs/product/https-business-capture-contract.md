# Web HTTPS 业务录制与原生重放契约

Web 业务学习不是先用 HTTP 替代 HTTPS，再把结果标记为安全流量。对 HTTPS 目标，持久化 Chromium、私有业务录制和原生 Template/Workflow 重放必须使用同一份受控 CA 信任来源，且 Chromium 与 Node 都保持证书链和主机名校验。

## 运行时配置

私有目标的 CA 由服务启动环境提供，而不是由模型、页面或扫描配置传入：

```bash
export BSTG_TARGET_CA_FILE=/absolute/path/target-ca.pem
```

该文件必须是绝对路径、常规文件和可解析的 PEM CA bundle。运行时计算 bundle 中 DER 证书的稳定 SHA-256 集合摘要；路径和 PEM 内容不会进入模型上下文、业务录制公开投影或普通产品 API。

原生 API/Test Run/Workflow 请求在这个变量存在时使用严格的 `https.request` 传输：默认公有根证书加这份 CA、`rejectUnauthorized: true`，以及 Node 默认的主机名检查。它不依赖 `NODE_EXTRA_CA_CERTS` 只能在 Node 进程启动时读取一次的行为。公有 HTTPS 不设置该变量，继续使用平台信任库。

Chromium 无法通过 Playwright Context 安全地临时加入任意 CA；`ignoreHTTPSErrors`、`--ignore-certificate-errors`、SPKI 忽略列表和 `--allow-insecure-localhost` 都不允许。私有 CA 必须在一个隔离浏览器 worker 的 NSS 信任库中，或由操作员预先安装进受控系统信任库。

Linux worker 启动时会导入 `BSTG_TARGET_CA_FILE`（也兼容旧的 `BSTG_WORKER_CA`）。普通 stdout/stderr 只报告 worker 就绪和 CA 摘要；Playwright WebSocket capability 及其随机路径属于私有运行时能力，不会显示、复制或写入测试产物。

```text
BSTG_BROWSER_TRUSTED_CA_SHA256=<64-hex>
```

启动器从私有 worker 通道接收 WebSocket capability，并原子写入调用方预先指定的、父目录为 `0700` 且文件为 `0600` 的 runtime file。后端只能在同一用户的受控子进程中从该文件注入 endpoint；不要打印、复制、上传或把它作为跨主机配置交换。完整的文件创建、权限和受控注入方式见[复用本地浏览器与 Android 环境](local-runtime-reuse.md)。启动浏览器前 BSTG 比较 CA bundle 摘要；缺少、格式错误或不匹配都会失败。已经由操作员预配系统信任库的本机 Chromium 可以设置 `BSTG_BROWSER_TRUSTED_CA_MODE=system`，但仍需同一摘要，实际导航仍会因未真正信任、证书链错误或主机名错误而失败。

```bash
export BSTG_TARGET_CA_FILE=/absolute/path/target-ca.pem
export BSTG_BROWSER_TRUSTED_CA_SHA256='worker 输出的 64 位摘要'
export BSTG_BROWSER_EXPOSE_NETWORK='<loopback>' # 仅当受控目标在控制端 loopback
```

worker endpoint 按上述私有 runtime file 方式注入启动 `npm start` 的受控子进程，而不是在交互终端设置或显示。

隔离 worker 是私有 CA 的默认验收路径。对于已由操作员预配 CA 的本机 Chromium，受控验收也接受系统信任模式：不设置 worker endpoint，明确指定实际 Chromium 二进制、`BSTG_BROWSER_TRUSTED_CA_MODE=system` 和同一份 CA bundle 的精确摘要。该模式不会自动导入、信任或删除主机证书；导航本身必须通过 Chromium 的正常证书与主机名校验才会留下录制证据。

对于 HTTPS 基址，Target Scope 把协议纳入 origin 比较。任何重定向或后续请求从 `https://host:port` 变为 `http://host:port` 都会在网络发出前被拒绝，不能把 HTTP 成功当成 HTTPS 验收。

## 录制、重放和证据

业务录制在同一个 Chromium Context 的 CDP Fetch 响应暂停点保存原始请求、完整可读取的响应、Set-Cookie 等实际响应头和动作归属；它不会重新发一个“抓包请求”。每个私有录制事件还记录：

- `tls.scheme`；
- Chromium 仅在 `ignoreHTTPSErrors:false` 下成功接收 HTTPS 响应时的 `certificate_verified: true`；
- 平台/配置 CA 信任模式和配置 CA bundle 摘要；
- CDP 提供时的 TLS 协议与 cipher。

证书主体、签发者、PEM、请求正文、Cookie、CSRF、响应业务值仍留在私有执行记录。模型只得到已脱敏的流程结构和可验证字段路径。录制完成后，既有 Recording → Template → Workflow → Test Run 链路重放同一份捕获请求；原生传输再次使用同一 CA bundle。没有完整响应、TLS 失败、超限或错误主机名的事件不能成为已验证正常 Flow。

## 受控真实验收

先生成一次 CA，**再**以该 CA 启动 worker，最后启动下列验收；不要在 worker 启动后替换 CA 文件。

```bash
LAB="$PWD/artifacts/https-business-lab"
python3 tests/fixtures/prepare-local-tls.py --output "$LAB"

BSTG_RUNTIME_IMAGE=aegicove/runtime-full:v1.7.0-rc.1 \
  BSTG_TARGET_CA_FILE="$LAB/ca.pem" \
  node scripts/live-browser/local-container-runtime.mjs

# worker 的 endpoint 已写入私有 runtime file；依照 local-runtime-reuse 的方式，
# 仅在受控测试子进程中注入它：
export BSTG_TARGET_CA_FILE="$LAB/ca.pem"
export BSTG_WEB_TLS_DIR="$LAB"
export BSTG_BROWSER_EXPOSE_NETWORK='<loopback>'
```

在同一受控进程中完成 runtime-file 注入后，再运行 HTTPS 业务捕获验收；不要把 endpoint 写入 shell 历史、日志或报告。

该验收启动受控 CA 签发 HTTPS 服务，使用真实隔离 Chromium 点击正常业务动作，检查同一浏览器产生的请求与响应/TLS 证据，然后由原生 Workflow 重放并验证服务器状态。结果只输出检查项和 Test Run 引用，原始凭据和业务正文留在 Git 忽略的 `artifacts/` 中。

本轮已在一次性受控 CA 和隔离浏览器 worker 上完成该验收：真实 Chromium 的 HTTPS 业务动作、同浏览器 TLS/录制证据及原生 Workflow 重放均通过。验收没有修改系统 CA，临时 worker 已在结束后清理。这个结果只证明 BSTG 的原生 HTTPS 路径；它不证明外部 Linux Desktop Executor 已接入，也不替代该执行器的同浏览器 CDP/网络 bridge 验收。

若运行环境已有受控系统信任的 Chromium，可以省略 worker endpoint，并用 `BSTG_BROWSER_TRUSTED_CA_MODE=system`、`BSTG_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium` 和同一 `BSTG_BROWSER_TRUSTED_CA_SHA256` 运行相同验收。验收脚本会拒绝未声明的本机信任路径；该备用路径不是证书错误忽略开关，也不取代实际 Chromium 导航验证。

`tests/agent-business/target-tls-trust.test.mjs` 是可移植的严格 native CA、错误主机名、未知 CA、浏览器信任前置条件回归；它不是 Chromium 运行时验收的替代。
