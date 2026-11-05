# 业务后台代码结构

后台采用 Fastify、TypeScript、Prisma 和 PostgreSQL，按业务模块组织为单体服务。

```text
src/
├── main.ts                  # 独立服务启动、监听与关闭
├── app.ts                   # Vercel 入口
├── application.ts           # 创建依赖、按原顺序装配模块、关闭数据库连接
├── cli/                     # 显式运维、补偿、初始化与诊断命令，不随服务启动执行
├── config/                  # 环境与文件存储配置校验
├── plugins/                 # HTTP 配置、来源校验、Swagger、错误、健康与静态资源
├── infrastructure/
│   ├── database/            # Prisma Client 创建
│   ├── security/            # 密码哈希
│   ├── sms/                 # 短信提供方适配
│   └── storage/             # OSS 适配
├── common/                  # 通用应用错误、装配上下文类型
└── modules/
    ├── auth/
    ├── organizations/
    ├── approval/
    ├── attendance/
    ├── projects/
    ├── expert/
    ├── entrance-exams/
    ├── personnel/
    ├── production/
    ├── files/
    └── users/
prisma/                      # 既有数据模型及迁移
tests/
├── unit/                    # 单元、隔离 HTTP/Swagger、结构约束测试
└── integration/             # 使用专用测试数据库的集成测试
```

## 模块内的职责

| 文件                               | 职责                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| `index.ts`                         | 有 HTTP 入口的模块在这里创建服务、注册路由；由 application 调用 |
| `*.routes.ts`、`*.schema.ts`       | HTTP、认证入口、请求校验与响应序列化                            |
| `*.service.ts`                     | 用例编排、业务授权、事务、卡片/轮次/事件写入                    |
| `*.repository.ts`                  | 复用的数据查询、待办来源采集及数据库锁操作；显式接收调用方事务  |
| `*.domain.ts`                      | 无数据库访问的规则、校验、计算与状态常量                        |
| `*.access.ts` / 既有 `*-access.ts` | 需要实时查询数据库的资格与数据范围校验                          |
| `*.types.ts`                       | 跨文件复用的身份、输入、事务查询结果与快照类型                  |

业务模块增长时按用例拆分，例如 personnel 内将创建、审批命令、到期生效、进度编排和查询分开。模块装配入口不充当所有内部符号的聚合导出，以免引入新的运行时循环。

Service 保留事务控制。Repository 接收同一个 `tx`，不自行开启、提交事务；简单且不复用的 Prisma 写入可以保留在 Service，避免仅为分层增加无业务含义的透传方法。

领域规则与 Repository 不依赖业务 Service，基础设施不依赖业务模块。类型引用使用 `import type`；复用身份、组织状态、成员查询形状等稳定契约时引用 `*.types.ts` 或 `*.domain.ts`，不从 Service 获取它们。跨模块命令协作可以使用明确的服务函数，但依赖图必须无环。

## 保持的行为边界

此次结构调整不改变 API 路径、请求/响应 Schema、权限、状态流转、SQL 条件、锁顺序、事务隔离级别或 Outbox 语义。业务 HTTP 注册顺序及 `createApp` 的测试注入参数保持一致。静态页面目录仍指向服务包根下的 `public/`。

业务 Outbox 仍只登记待投递事实，业务 Agent 继续 mock；结构重构不启用通知投递、调度或真实业务 Agent。数据库模型、迁移和依赖不随这次重构变化。

## 独立命令入口

`src/` 根目录只保留 `main.ts`、`app.ts`、`application.ts` 三个启动/装配文件。
清理、授权维护、到期处理、考试补偿、分类初始化及 OSS 诊断入口统一放在 `cli/`。
业务模块不导入这些带执行副作用的命令；它们只在显式运行时调用既有服务。
项目分类静态数据放在 `modules/projects/project-categories.data.ts`。

原有 pnpm 命令名及参数保持，源文件入口改为 `src/cli/<命令>.ts`，部署编译入口改为 `dist/cli/<命令>.js`。
分类初始化仍定位 `apps/server/.env`，已有环境变量仍优先，不依赖当前工作目录。

## 验证

在仓库根目录执行：

```sh
pnpm --filter @tyde/server typecheck
pnpm test
pnpm test:core
pnpm build:server
```

单测包括检查静态与延迟导入循环的架构约束。已有用例只迁移文件及依赖替身位置，保留业务断言。

`pnpm test:integration` 现在指向 `tests/integration/auth.integration.test.ts`。它会清空显式允许的专用 `_test` 库，不能作为普通重构回归自动执行。数据库与真实 HTTP/OSS、部署和客户端验收保持各自独立的验证范围。
