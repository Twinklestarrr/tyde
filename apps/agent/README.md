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

Pi SDK、模型凭据、平台授权、任务 API、事件流和 PostgreSQL 尚未接入；不提供模拟对话或文件会话存储。后续仅服务端持有模型和数据库配置。Agent 数据迁移独立放在 [migrations](migrations/README.md)，不使用业务 Prisma 迁移。

协作边界及后续工作见 [Agent 开发说明](../../docs/AGENT_DEVELOPMENT.md)。
