# 部署、场景配置与验收

## 1. 使用范围与基线

完整源码包基于上一轮 `BolaSecurityTestGate-appium-https-closure.zip`，不是最初的 `live-acceptance-final.zip`。增量补丁只能用于此基线。建议解压到新目录，不使用旧 dist，也不要把旧设备验收产物认成本轮结果。本次沿用原有数据库表，不要求新 schema 迁移。

## 2. 生产检查必须先通过

在能访问依赖源的受控构建环境执行：

```bash
npm ci
npm --prefix server ci
npm run typecheck
npm run typecheck:server
npm run build
npm run test:product:experience
npm run test:mobile:closure
npm run test:product:e2e-contract
npm run test:mobile-lab:closed-loop-static
```

前后端依赖与构建需要实际安装；本轮环境缺失 React/Vite/Express/原生数据库模块，完整检查没有通过。不能因为下面的适配器测试通过而跳过生产检查。

仅用于复现实验环境逻辑回归：

```bash
npm run test:product:experience:adapters
npm run test:mobile:closure:adapters
python -m unittest discover -s tests/mobile-closure -p 'capture_addon_test.py'
```

适配器模式使用 Node 自带 SQLite 接口执行项目仓库 SQL，并显式替代外部驱动。Android/Appium 调用与部分抓包输入是测试替身，不是真机。

启动方式沿用项目原部署流程。开发模式可分别运行 `npm run dev:server` 与 `npm run dev:frontend`。前端接口根统一从 `VITE_API_URL` 读取；部署反向代理须同时转发用户事件和图片端点，不要缓存或缓冲事件响应。只向受信任测试用户暴露服务。

## 3. 普通用户怎么操作

打开业务测试，选择 Web 网站或 Android App，填写授权目标和目标说明、检查范围。越权测试使用不同的隔离测试身份，不使用生产账号。Android 选择已准备设备并上传授权安装包，再勾选具体应用的业务场景；无需填写控件选择器、底层动作、工作流或请求变体。

开始后清单随实际业务发现和执行更新。点一项可查看它的关联画面；“跟随当前测试”恢复自动跟随。已完成项自动划线；失败或待复核保持未完成。确认问题独立保留。刷新页面或切换后再回来会重连，而不是重启测试。关闭页面不会停止已提交的后端任务。

## 4. 管理员准备 App 场景

完成上一版 Appium、设备唯一绑定、代理、应用信任 CA 与 APK 验证准备后，在对应移动 profile 的 `config_json.business_scenarios` 写入应用绑定的场景。

```json
{
  "business_scenarios": [
    {
      "id": "rejected_login",
      "business_name": "登录",
      "test_name": "错误密码应被拒绝",
      "app_package": "com.yourcompany.authorizedtest",
      "description": "核对登录失败页面与服务拒绝结果",
      "steps": [
        {
          "action": "tap",
          "target": {"resource_id": "com.yourcompany.authorizedtest:id/login"},
          "expect": {"text": "登录失败"},
          "expect_network": [
            {
              "id": "login_rejection",
              "method": "POST",
              "url": "https://your-authorized-test-host.example/login",
              "response": {"status": 401}
            }
          ],
          "timeout_ms": 10000
        }
      ]
    }
  ]
}
```

**这是结构示例，不是可直接验收的测试场景。** 示例未包含输入账号和错误密码的前置操作；须补齐实际应用的输入步骤、页面状态、HTTPS 请求内容及响应断言。控件、包名和域名必须替换，域名必须列入 `capture_allowed_hosts`。没有真实前置状态时不能只点击就期待成功。

每个场景至少有一个实际动作及 UI+HTTPS 联合断言。`depends_on` 可引用同应用的前置场景；服务器自动拓扑展开，拒绝循环、重复 ID、错应用、模拟环境或缺少断言的配置。业务场景内的实际输入来自服务端受控配置，不会因为在页面填写了测试账号就自动插入任意 App 控件；账号表单用于原有安全执行器的身份配置。

本次新上传会保存服务器持有的安装包描述文件。旧版导入但缺少描述文件的 APK 需要重新上传，不能把客户端自报路径当作已验证安装包。界面筛选同包名业务场景，没有场景时阻止开始并要求管理员补齐，不提供假成功示例。

Appium+HTTPS 设备验收仍用：

```bash
npm run test:mobile:appium:https
```

相关设备、APK、证书及实际流程环境变量见既有 `docs/mobile-lab/APPIUM_HTTPS_E2E.md`。

## 5. 部署后的用户视图验收

新增入口只观察一轮**已经授权且正在执行的真实测试**，不生成模拟帧，不伪造事件，不替代设备验收。需要服务器依赖中的 Playwright 及其浏览器已安装。

```bash
export BSTG_UX_AUTHORIZED=true
export BSTG_UX_FRONTEND_URL=https://your-controlled-bstg.example
export BSTG_UX_API_URL=https://your-controlled-bstg.example
export BSTG_UX_RUN_ID=actual-running-scan-id
export BSTG_UX_SURFACE=android
export BSTG_UX_ARTIFACT_DIR=/absolute/path/new-evidence-directory
npm run test:product:live
```

对 Web 使用独立真实运行并设置 `BSTG_UX_SURFACE=web`。需要登录的部署可通过 `BSTG_UX_STORAGE_STATE` 指定受控 Playwright 登录状态文件，不将文件提交到源码库。前后端使用不同域名时应按真实部署配置会话及跨域访问，不关闭 TLS 校验。

验收要求观察到真实执行项、至少两次新鲜非模拟画面、正在执行项变为已验证完成、刷新后恢复、最终清单删除线与确认问题数吻合。已结束的历史记录不算实时证明。中途失败、超时、跳过或尚待复核不会算完整通过。没有漏洞也可以通过，不要求制造一个漏洞。

本次没有在真实部署上运行此入口；交付中它的状态为 NOT_RUN。

## 6. 离线界面测试的复现边界

`tests/product-experience/ui/` 运行生产 TSX、投影和状态逻辑，但显式注入 React19、事件/请求/历史/icon 适配器；与项目的 React18 生产构建不同。只用于组件回归，不可拿截图当作设备证据。

本轮 Chromium 禁止访问网络页面，测试因此全部在离线内存页面内完成，没有修改或绕过浏览器策略。复现需要 Python Playwright、可执行 Chromium、TypeScript、明确选择的 React19 测试 bundle 与 Tailwind4 测试 CSS 生成器。

```bash
# 只用于复现本轮离线测试，不用于生产构建。
export BSTG_UI_REACT_FIXTURE=/absolute/path/to/compatible/playwright-react19-shared-bundle.js
export BSTG_TAILWIND_FIXTURE=/absolute/path/to/tailwindcss-4.1.10
node tests/product-experience/ui/build-offline.cjs
BSTG_TEST_ADAPTERS=1 node --import ./tests/mobile-closure/register.mjs tests/product-experience/ui/generate-states.mjs
node tests/product-experience/ui/build-css-fixture.cjs
python tests/product-experience/ui/check-offline.py
```

React 测试 bundle 的版本和导出签名会被检查，不能随意传一个生产 React 文件冒充。未分发第三方 bundle 或字体；完整包含脚本、日志和带标记的截图。真实生产验收应优先使用上一节入口，而不是改动浏览器策略来跑测试。

## 7. 故障与运维

连接中断时先显示重连，HTTP 快照能读到时显示定时更新；两者都失败时保留最后状态并标离线。画面失败不回退到原始工具输出，也不会影响已执行业务动作的重试次数。图片停更只说明没有新观察，不能说明设备还在持续操作。

单轮结果保留失败、未执行和待复核项。所有业务项完成但整轮失败时检查收尾及设备清理。不要因为列表划线就忽略清理失败。已有单设备隔离、单后端调度和主机崩溃后人工恢复要求仍有效。

报告与截图可能包含测试账号和业务信息；应限制保存目录和 API 访问。用户视图隐藏内部结构不等于禁止调用内部管理 API，部署仍需原有授权与网络隔离。
