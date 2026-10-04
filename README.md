# Bola Security Test Gate (BSTG)

BSTG is a self-hosted security testing workbench for authorized web and mobile targets. Its Agent learns normal business flows, turns them into native BSTG workflows and test runs, then plans experiments and evaluates the resulting evidence.

The model makes the business and test decisions. BSTG executes them through its native recording, API Template, Workflow, Test Run, identity, and evidence systems so results remain reproducible and reviewable.

## Start developing

Requirements: Node.js, npm, and Docker for the isolated browser runtime.

```bash
npm ci
npm run dev:server
```

In a second terminal:

```bash
npm run dev
```

The Vite development server proxies API requests to the local backend. For a production-style local run:

```bash
npm run build
npm start
```

The backend listens on `127.0.0.1:3001` by default. See [deployment instructions](DEPLOYMENT.md) before exposing a service beyond the local machine.

## Browser runtime

BSTG provides its own headless Playwright runtime image. Install the project dependencies, then start the isolated browser worker:

```bash
docker pull hahawo65/bstg-browser-runtime:pw-1.62.1
npm run start:browser:local
```

The worker image supplies Chromium and browser dependencies; the Agent, project code, and Playwright client stay in this checkout. See [browser runtime setup](docs/product/local-runtime-reuse.md) and the [HTTPS capture contract](docs/product/https-business-capture-contract.md).

## Agent execution model

The Agent first observes and verifies normal business behavior. It can use that run to build native workflows and test runs, then design controlled experiments against the observed flow. Evidence gates require actual execution and business-state checks; a model hypothesis or HTTP status alone is not a confirmed finding. See the [Agent execution overview](docs/product/agent-execution.md).

Use BSTG only on systems for which you have authorization.

## Validation

```bash
npm run typecheck
npm run typecheck:server
npm run test:agent-business
```

Some end-to-end checks require a configured AI provider, a running Docker engine, or a separately prepared test target. Their prerequisites are described by the corresponding test scripts.

## 中文简介

BSTG 是面向已获授权 Web 与移动目标的自托管安全测试平台。Agent 会先学习并验证正常业务流程，再把业务流转成 BSTG 原生 Workflow 和 Test Run，随后设计实验并依据真实执行证据评估结果。模型负责业务判断与实验决策，BSTG 负责可复现的录制、执行、身份隔离和证据校验。

开发启动方式：先运行 `npm ci` 和 `npm run dev:server`，再在另一个终端运行 `npm run dev`。浏览器执行环境和 HTTPS 约束见上方文档链接。仅可对获得授权的系统进行测试。
