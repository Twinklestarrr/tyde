# 验证入口与已记录范围

最近一轮完整功能回归记录为 2026-10-28 分支整合验证：10阶段通过，包含233项核心、718项后端单测、167项页面、189项 Agent 服务及89项 Agent Web；全仓类型、ESLint、变更格式和 Vercel 构建通过。该结果是历史基线，不能作为之后代码或当前安装包的验收；2026-11-02系统检查及复验结果见下文。

## 日常功能检查

```sh
pnpm test:features
```

该入口使用隔离 HTTP 替身和模拟模型，不连接数据库、不迁移或清库、不调用真实模型。每次运行的日志、JSON汇总、页面截图与 trace 保存在 `artifacts/feature-tests/<本次运行>/`，最近入口是 `artifacts/feature-tests/latest.json`。按实际通过、失败、跳过和重试数量判断，功能和未开放范围见源仓库 `docs/IMPLEMENTED_FEATURES.md`。

类型、静态和格式检查分别使用 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`。文档整理只需检查变更 Markdown 格式、相对链接/锚点和 `git diff --check`。

## 系统自动化检查

```sh
pnpm test:system
```

复用功能回归脚本，先执行全仓类型、ESLint、格式和 Vercel 本地发布构建，再运行原有10个功能阶段，共14阶段。前四项检查独立收集结果，任一失败仍执行其他检查；功能阶段按依赖顺序执行，失败后停止后续功能阶段。只有全部阶段通过且页面报告有效时退出0，检查失败退出1，中断退出130。

每次运行的汇总、逐项日志、页面截图和trace保存在 `artifacts/system-tests/<本次运行>/`，`artifacts/system-tests/latest.json` 指向最近报告。类型检查中的 Prisma generate 仅生成客户端，发布构建仅产生本地产物；此入口不安装依赖、不迁移/清理数据库、不调用真实模型、不发布。它覆盖已接入的 TypeScript 应用与隔离页面，Shadow Python 专项、真实HTTP/OSS、数据库集成和安装包真实设备验收须单独执行，不能凭脚本通过宣称所有环境均无问题。

## 2026-11-02 系统检查结果

### 格式修复后完整重跑

组织审批服务、考试阅卷查询测试、个人工作台测试三份文件仅执行Prettier排版，TypeScript语法结构与内容一致，无业务逻辑或接口变化。本次完整执行 `pnpm test:system`：全仓类型、ESLint、格式、发布构建、249项核心、719项后端、Web构建及Electron构建通过，共8阶段通过。

页面179项中178通过、1失败：`tests/e2e/project-manager.spec.ts:424` 在网络未知结果路径尚未等待确认弹框关闭，同时匹配到面板和弹框内两个“确认更换”按钮，触发strict定位冲突。原排班月份切换用例本次通过。脚本按设计在页面失败后停止，Agent五阶段未执行，不能沿用前轮189/89项作为本次结果。报告为 `artifacts/system-tests/2026-11-02T08-58-32.300Z-21444/report.md`；本轮整体为failed，原3处格式问题已解除，测试进程及5176/5177已清理。未修改接口、业务逻辑、数据库或超时，未提交或发布。

### 修复前历史

`pnpm test:system` 已实际执行，249项核心、完整复跑719项后端通过。页面原179项中178通过、1项因当前已是2026-11而没有实际切月的测试夹具失败；固定起始2026-10后仅复验失败项通过，保留原断言，未重跑原178项。页面失败后未执行的Agent五阶段单独补跑通过，含189项服务与89项Web测试。全仓类型、ESLint、Web/Electron及发布构建通过。

整体仍为失败：3个既有后端文件不符合Prettier（组织审批服务、考试阅卷查询测试、个人工作台测试）。首轮1项人员变动HTTP/Swagger单测5秒超时，单项及完整后端复跑通过，未改超时，保留稳定性风险。Shadow缺少本地Python依赖，数据库、真实HTTP/OSS、真实模型与发布均未执行。原失败、定向复验及补跑记录独立保留，最新入口 `artifacts/system-tests/latest.json` 的 `currentReport` 指向当前汇总，不能记作14阶段一次全过。

## 专项与环境验收

- 业务数据库集成只使用 `.env.test` 指定的既有本机专用 `_test` 库；测试会清表，不能指向开发或部署库。迁移是独立动作，不能因文档整理或测试连接失败而初始化数据库、重复应用迁移。
- 任务13前46批定向结果保留；第四十七—四十八批新增22项仍在初始化连接失败，业务断言未执行，不计通过。前46批不复跑，不重迁移29，业务 Agent 保持 mock，不开始14。详情见源仓库 `docs/backend/PROJECT_WORKBENCH.md`。
- Node 显式携带登录 Cookie 的真实 HTTP 测试，不代替浏览器自动携带、SameSite/Secure、HTTPS、Electron和完整兼容验收；缺少合法结项/删除写命令时，终态夹具也不能代替命令验收。
- 真实模型、Agent 专用数据库、工具演示、跨主机/多实例及桌面恢复分别核对。独立 Agent 已接入 PostgreSQL；其状态与业务自动阅卷 mock 分开判断。
- 安装包构建、签名检查、Mac Intel/Windows真实设备安装和远程部署分开记录。当前安装说明随 `INSTALL_TRIAL.md` 交付，不用2026-10-13旧包名、旧截图或旧后端地址推断新包可用。

2026-10-13—14的最初安装包/Swagger记录，以及后续逐批证据，保留在源仓库 `docs/archive/BACKEND_HISTORY.md`、`docs/archive/ACCEPTANCE_HISTORY.md` 和 `docs/archive/AGENT_MILESTONES.md`。最新任务位置和提交限制沿用根目录 `AGENTS.md`。
