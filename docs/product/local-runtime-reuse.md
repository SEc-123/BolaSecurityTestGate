# BSTG 浏览器运行时

BSTG 的 Agent、业务规划、录制、Workflow/Test Run 和证据归属都在 BSTG 服务中。Docker 镜像只提供受管 Chromium worker 的 Node.js、浏览器依赖和私有 CA 所需的 `certutil`；它不含项目源码、账号、目标 CA、模型密钥或业务数据。

## 镜像

公开镜像：[`hahawo65/bstg-browser-runtime:pw-1.62.1`](https://hub.docker.com/r/hahawo65/bstg-browser-runtime)。镜像从 Microsoft 官方 Playwright `v1.62.1-noble` 基础镜像构建，并额外安装 `libnss3-tools`。该版本与 `server/package-lock.json` 锁定的 Playwright `1.62.1` 相同；升级项目 Playwright 时，应同时验证并更新 Dockerfile 基础版本。

镜像针对 `linux/amd64` 和 `linux/arm64` 发布，运行用户为非 root 的 `pwuser`。它复用 Playwright 随版本发布的 Chromium，不安装 Aegicove 镜像中的桌面、VNC 或控制平面组件。

在新机器上显式拉取镜像，再安装项目依赖并启动 worker：

```bash
docker pull hahawo65/bstg-browser-runtime:pw-1.62.1
npm ci
npm run start:browser:local
```

启动器默认使用该镜像，并通过 `--pull=never` 避免在运行时隐式访问镜像仓库。需要替换时可设置 `BSTG_RUNTIME_IMAGE`，但替代镜像必须兼容锁定的 Playwright 版本、Chromium 与 `certutil`，并配置非 root 用户。

## 构建与发布

从仓库根目录运行以下命令可构建并发布多架构镜像。需要 Docker Buildx 与已授权的 Docker Hub 登录：

```bash
cd docker/browser-runtime
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag hahawo65/bstg-browser-runtime:pw-1.62.1 \
  --push .
```

Dockerfile 只扩展官方 Playwright 镜像，不会把当前 checkout、node_modules、环境文件或验收产物放进镜像。基础镜像版本必须与 `server/package-lock.json` 中实际安装的 Playwright 完全一致，否则 Playwright 可能找不到对应浏览器二进制。

## HTTPS 与隔离边界

私有 HTTPS 目标可为 worker 配置受信任的 CA。BSTG 只把 CA 证书以只读方式挂入本次容器，不关闭 Chromium 或 Node 的证书、主机名检查；服务端也必须使用同一 CA 和 worker 输出的摘要。完整约定见[Web HTTPS 业务录制与原生重放契约](https-business-capture-contract.md)。

每次 worker 使用独立容器和浏览器会话，WebSocket capability 保存在仅当前用户可读的本机 runtime file 中。不要复制或上传该文件。浏览器 worker 端口仅绑定主机 loopback，不要公开到公网或共享网络。

当前启动器使用 `seccomp=unconfined` 以允许 Chromium sandbox 所需的 namespace 系统调用；因此应将该 worker 视为受信任的本机测试组件。多租户或远程执行部署需要单独收紧容器 seccomp、用户隔离和主机访问策略。
