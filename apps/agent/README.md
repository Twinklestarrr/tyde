# Agent 服务

W1 独立 Fastify 服务骨架，默认监听 `http://127.0.0.1:3002`。当前仅实现 `GET /health/live` 和 `/api/v1/docs/`，健康响应只表示 HTTP 进程存活，不代表 Agent 可执行任务。

在仓库根目录使用 Node.js 24 与 pnpm 11 安装依赖后：

```sh
pnpm --filter @tyde/agent dev
pnpm --filter @tyde/agent test
pnpm --filter @tyde/agent build
pnpm --filter @tyde/agent start
```

配置可通过 shell 注入，或复制 `.env.example` 为本目录 `.env`。`dev` 和 `start` 按需读取该文件，shell 已有变量优先；未配置时使用回环地址和 3002 端口。`NODE_ENV` 仅接受 `development`、`test`、`production`。`AGENT_HOST` 不含协议或端口，`AGENT_PORT` 为 1～65535 的整数。

W1 已提供受控测试身份适配器，默认 `AGENT_AUTH_MODE=disabled`。后续资源接口通过 `app.agentAccess.authenticate(request)` 取得服务端验证后的用户，再调用 `requireOwnedConversation` 校验可信存储中的会话归属；不存在、已删除或其他用户会话统一返回 404。请求 body、query、Cookie 和自报用户头不能证明身份。当前对话／命令资源路由仍未实现，适配器由隔离测试路由验证，不新增模拟成功的业务接口。

需要本机开发身份时，显式设置 `AGENT_AUTH_MODE=development`、`AGENT_TEST_USER_ID` 和 `AGENT_TEST_BEARER_TOKEN`。用户标识固定在服务端；凭证须至少 32 字符，可在本机使用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成，存入忽略的 `.env`，请求时放入 `Authorization: Bearer …`。此模式仅允许 `development`／`test` 环境，且 `AGENT_HOST` 必须为字面地址 `127.0.0.1` 或 `::1`；禁止在生产、主机名或其他监听地址启用。不要把测试凭证提交到仓库、放入前端 `VITE_*` 变量或 URL。

平台身份预留 `createApp(config, { identityAdapter })` 服务端注入点，后续由适配器验证真实平台 Bearer 及撤销状态；开发身份与平台适配器不能同时装配。默认未装配时资源身份验证失败关闭，格式合法的 Bearer 因无法验证返回 503；缺失／格式非法的凭证，以及已装配适配器判定无效的凭证返回 401。匿名健康检查和 Swagger 不变。`pnpm --filter @tyde/agent test` 覆盖显式配置、凭证验证、客户端伪造身份、归属／删除隔离、平台撤销及验证异常。

Pi SDK、模型凭据、真实平台授权、任务 API、事件流和 PostgreSQL 尚未接入；不提供模拟对话或文件会话存储。后续仅服务端持有模型和数据库配置。Agent 数据迁移独立放在 [migrations](migrations/README.md)，不使用业务 Prisma 迁移。

协作边界及后续工作见 [Agent 开发说明](../../docs/AGENT_DEVELOPMENT.md)。
