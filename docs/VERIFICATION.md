# 验证入口与已记录范围

最近一轮完整功能回归记录为 2026-10-28 分支整合验证：10阶段通过，包含233项核心、718项后端单测、167项页面、189项 Agent 服务及89项 Agent Web；全仓类型、ESLint、变更格式和 Vercel 构建通过。该结果是历史基线，本次文档整理没有重跑这些业务检查，不能作为之后代码或当前安装包的验收。

## 日常功能检查

```sh
pnpm test:features
```

该入口使用隔离 HTTP 替身和模拟模型，不连接数据库、不迁移或清库、不调用真实模型。每次运行的日志、JSON汇总、页面截图与 trace 保存在 `artifacts/feature-tests/<本次运行>/`，最近入口是 `artifacts/feature-tests/latest.json`。按实际通过、失败、跳过和重试数量判断，功能和未开放范围见源仓库 `docs/IMPLEMENTED_FEATURES.md`。

类型、静态和格式检查分别使用 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`。文档整理只需检查变更 Markdown 格式、相对链接/锚点和 `git diff --check`。

## 专项与环境验收

- 业务数据库集成只使用 `.env.test` 指定的既有本机专用 `_test` 库；测试会清表，不能指向开发或部署库。迁移是独立动作，不能因文档整理或测试连接失败而初始化数据库、重复应用迁移。
- 任务13前46批定向结果保留；第四十七—四十八批新增22项仍在初始化连接失败，业务断言未执行，不计通过。前46批不复跑，不重迁移29，业务 Agent 保持 mock，不开始14。详情见源仓库 `docs/backend/PROJECT_WORKBENCH.md`。
- Node 显式携带登录 Cookie 的真实 HTTP 测试，不代替浏览器自动携带、SameSite/Secure、HTTPS、Electron和完整兼容验收；缺少合法结项/删除写命令时，终态夹具也不能代替命令验收。
- 真实模型、Agent 专用数据库、工具演示、跨主机/多实例及桌面恢复分别核对。独立 Agent 已接入 PostgreSQL；其状态与业务自动阅卷 mock 分开判断。
- 安装包构建、签名检查、Mac Intel/Windows真实设备安装和远程部署分开记录。当前安装说明随 `INSTALL_TRIAL.md` 交付，不用2026-10-13旧包名、旧截图或旧后端地址推断新包可用。

2026-10-13—14的最初安装包/Swagger记录，以及后续逐批证据，保留在源仓库 `docs/archive/BACKEND_HISTORY.md`、`docs/archive/ACCEPTANCE_HISTORY.md` 和 `docs/archive/AGENT_MILESTONES.md`。最新任务位置和提交限制沿用根目录 `AGENTS.md`。
