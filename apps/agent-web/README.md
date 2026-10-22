# Agent 界面

W1 提供独立 React／Vite 界面、真实服务健康检查及 pi-web 的前端组件子集，并准备共享契约、SSE 解析／游标基础和测试事件样例。实际对话、模型、事件订阅、平台身份和数据库尚未接入页面；发送入口保持禁用，编辑草稿仅保存在页面内存。

在仓库根目录使用 Node.js 24、pnpm 11：

```sh
pnpm dev:agent
pnpm dev:agent-web
```

服务默认 `http://127.0.0.1:3002`，界面默认 `http://127.0.0.1:3003`。界面请求 `/agent-api/health/live`，Vite 将 `/agent-api` 前缀去除后代理至 Agent 服务。需要连接其他服务时，将 `.env.example` 复制为忽略的 `.env.local`，设置 `AGENT_PROXY_TARGET` 服务源并重启 Vite。此变量只供 Vite 读取；界面不接收模型或数据库密钥。

```sh
pnpm --filter @tyde/agent-web build
pnpm --filter @tyde/agent-web typecheck
pnpm --filter @tyde/agent-web test
pnpm --filter @tyde/agent-web preview
```

预览默认端口 `4003`，提供同样的本地代理。生产构建是 `dist/` 中的静态文件；生产部署需要配置反向代理，将 `/agent-api/*` 转给 Agent 服务并去掉前缀。Vite 开发代理不会进入构建产物。Electron 的装载、可信远程地址和 CSP 接入在后续工作包完成。

- `src/services/agent-client.ts`：集中处理 Agent HTTP 请求与共享响应校验，失败不回退为假数据。
- `src/agent-events/`：按 22 号 v0.1 契约解析分块 SSE、校验帧并按序应用可靠事件；只有应用成功才推进游标。control／delta 不推进；实际 fetch 连接、重连与 UI 合并留待 W3。
- `fixtures/`、`tests/events.test.ts`：7 类可靠事件、控制帧、临时增量和字节／顺序边界测试；样例不进入页面请求链路。
- `src/components/`、`src/lib/markdown-*`：从 pi-web 选择并适配的 Markdown 展示、分块和列表输入。
- `src/styles/pi-web.css`：上游浅色、深色、Mist 主题和 Markdown 样式子集；与业务 UI 样式独立。
- [上游来源与改动记录](upstream/pi-web/SOURCE.md)：固定提交、原文件摘要和引入范围；MIT 许可证保留在同目录。

对话 API／事件契约在 `@tyde/shared/agent` 统一定义，来源与生成规则见 [共享契约说明](../../packages/shared/src/agent/contracts/README.md)，使用 `validateAgentContract` 验证。Pi 执行归 `apps/agent`。本应用未引入上游 Next API、Pi 执行、本地文件与凭据存储、终端、服务工作线程或生产演示响应。
