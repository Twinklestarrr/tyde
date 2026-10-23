# Agent W4／W5 合流记录

2026-10-23 · `integration/agent-w4-w5` · 静态接入，联合验证待用户确认

## 本轮范围与验证状态

本轮处理用户已经启动的 `feature/agent-w5-persistence` 合并，保留 W4 可信工具／Skill、独立工具过程与页面追溯，同时保留 W5 PostgreSQL、完整原生版本、持久命令／outbox／预算及单机隔离恢复。业务最新 07 验收与 08 入口安排保留，业务 Agent 继续 mock；不修改业务接口、Prisma、业务数据库或业务迁移。

用户明确要求“合并冲突解决后你告诉我，等我确认后再开始测试”。因此本轮只修改代码／文档并做静态核对，不执行测试、类型检查、lint、格式检查、构建、服务启动、数据库连接／迁移／快照发布或真实模型／浏览器联调。不自动暂存、提交或完成 merge。

[W4 验收记录](AGENT_W4_VALIDATION.md)和[W5 验收记录](AGENT_W5_VALIDATION.md)保留各自独立分支的真实证据；包括既有工具调用、PG 故障、重启追问与真实 600000ms 计时，均不能转记为合并后通过。本记录不声明联合功能已经验收或没有缺陷。

## 冲突处理原则

原始冲突为以下 9 个文件；消除文本标记并不自动消除 Git 索引的 unmerged 状态。用户确认内容后仍需明确标记解决并完成合并。

| 文件                                            | 保留与合流内容                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `AGENTS.md`                                     | 保留业务最新验收、W4／W5 独立证据及边界；更新当前入口并明确联合待验 |
| `apps/agent-web/README.md`                      | 保留工具卡／追溯、可靠事件收敛，以及服务端实际存储模式与重启提示    |
| `apps/agent/src/api/documentation.ts`           | W4 工具契约／示例与 W5 认证运行模式接口使用同一 Swagger 装配        |
| `apps/agent/src/application.ts`                 | 保留身份／运行模式检查、PG 装配与显式可信资源注入                   |
| `apps/agent/src/maas/transport.ts`              | 保留完整结束／用量与工具参数校验，合并持久派发屏障                  |
| `apps/agent/src/pi/index.ts`                    | 同时导出 W4 资源／工具与 W5 完整原生版本接口                        |
| `apps/agent/src/pi/session.ts`                  | 合并资源身份、真实工具循环、原生保存／派发门禁与取消语义            |
| `docs/AGENT_DEVELOPMENT.md`                     | 区分原分支历史验证与当前合流状态，不回退工具或持久化能力            |
| `packages/shared/src/agent/contracts/README.md` | 保留 W4 22 号扩展与同源生成规则；W5 不维护另一套工具契约            |

## 四项接口对接

四项工作与冲突处理一同接入；最终实现以对应源码为准，当前仅静态核对，运行证据待用户确认后补充。

| 接口                 | 合流要求与静态核对点                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可信工具／Skill 装配 | PG 宿主使用 `createApp(config, { deployment })`，从 `deployment.resources` 向实际 Pi Session 注入同一冻结资源，并把匹配的 `toolManifest`／`resourceManifestHash` 交给 `AgentPostgresRuntime`；显式 memory 模式可只传 `resources`。PG 启用资源必须提供 `TrustedPiDeployment`。`storage/pi-deployment.ts` 的创建／准备／发布适配器连接固定成员、代码身份及数据库规范化资源摘要。默认启动不扫描 `.local`、用户目录或加载演示包 |
| 一次性派发许可       | `beforeTool` 保存原生 assistant 并授权，`checkToolEligibility` 纯检查可重复；running 投影等待前后复检，`beforeToolDispatch` 真正执行前仅消费一次持久许可。`afterTool` 保存原生 toolResult 后等待终态投影。已用授权失败不退，停止后不再派发                                                                                                                                                                                  |
| 工具过程持久化       | 新增 Agent `0002` 的 `agent_tool_executions` 承载审核后的公开投影，与冻结的 `tool.updated` 同事务提交。工具身份关联真实模型请求 ID、Pi tool_call_id 及 source/result native entry；快照、历史、任务／结果读取与补读使用同一投影。终态和迟到结果不能恢复旧执行，只读工具不生成 Operation                                                                                                                                     |
| 执行配置身份         | `createTrustedPiDeployment`／`prepareTrustedPiDeployment`／`publishTrustedPiDeploymentSnapshot` 核对固定资源与实际成员字节，使用数据库规范化的 `resourceManifestHash`；执行快照 `tool_manifest.host_resources` 保存完整 W4 manifest。生成新的运行清单与新快照，不修改旧快照，HTTP 不自动发布                                                                                                                                |

完整原生 header／entries／leafId 和提交关联仍由 W5 原生仓储负责；公开工具投影不透传原始参数、完整结果、思考、服务端路径或凭据。原生数据捕获、数据库提交、公开终态与实际执行资格分别核对，数据库失败不能伪造成功。

## 配置与本机演示边界

W4 具体工具、Skill、合成人员／规则与专用启动材料仍只位于忽略的 `.local/agent-w4-demo/`，不随合并或通用提交复制。通用源码、shared、默认启动、构建和测试不依赖本机包；仅拉取通用代码不能直接复现完整演示。Skill 使用 `host-preloaded-system-prompt`，完整可信正文进入实际 system prompt；原生自动发现、read／bash 和目录扫描仍关闭。

W5 默认 `AGENT_STORAGE_MODE=postgres`，使用 Agent 自有 PostgreSQL 18 及独立迁移／发布／运行账号；显式开发 `memory` 保留 W3／W4 进程内行为，PG 错误不回退内存。合流后需要重新生成 source／compiled 运行清单、应用 Agent 独立 `0002` 迁移，并用相同资源装配发布对应新执行快照；本轮不会实际运行生成、迁移或发布。默认 `publish:agent-config` 只发布默认无工具配置，启用资源须使用可信部署适配器。旧任务仍绑定旧快照，加载旧 head 时比较 `model_config`、`tool_manifest`、资源摘要与 `execution_policy`，不能强换为新工具资源或新 Session 绕过不兼容。默认提示词已与旧 W5 内容静态核对一致；自定义配置缺乏一致性证据时拒绝加载，不据此宣称旧历史联合恢复已经通过。原 W4 本机启动入口不直接适用 PG；本机联合入口需要显式创建资源和 `TrustedPiDeployment` 并使用同一适配器发布／启动，不允许从前端指定模块路径或自动发现。

### 当前本机联合入口

当前 `tyde` 的忽略目录 `.local/agent-w4-demo/` 已准备以下 10 个文件。它们仅为本机演示材料，不暂存、不提交；没有复制凭据、W4 历史证据或旧构建产物。

| 相对路径（均在 `.local/agent-w4-demo/` 下） | 来源与用途                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                             | 从 W4 固定演示包复制的逻辑版本与文件摘要                                                                                        |
| `prompt.md`                                 | 从 W4 复制的固定演示提示词                                                                                                      |
| `SKILL.md`                                  | 从 W4 复制的固定 Skill 正文，使用宿主预加载                                                                                     |
| `data.json`                                 | 从 W4 复制的合成人员／规则数据                                                                                                  |
| `demo-tool.mjs`                             | 从 W4 复制的具体只读演示工具实现                                                                                                |
| `load.mjs`                                  | 从 W4 复制的固定资源加载器；严格核对 manifest，不扫描目录                                                                       |
| `deployment.mjs`                            | 新增 `loadDemoDeployment`，将同一资源、实际文件字节／模式／摘要、固定加载顺序与 `createDemoTool` 显式导出绑定交给可信部署适配器 |
| `publish.mjs`                               | 新增独立发布入口，使用 `loadDemoDeployment` 与独立发布账号发布资源及匹配执行快照                                                |
| `start.mjs`                                 | 新增 PG 启动入口，使用同一 `loadDemoDeployment`；强制 `postgres`、`127.0.0.1:3102`，不能回退 memory                             |
| `README.md`                                 | 新增本机材料边界、配置前提及后续步骤                                                                                            |

发布和启动共用一份 `loadDemoDeployment`，默认 `main.ts` 仍不读取本目录。通用适配器不接收前端路径、不自动 import 任意模块；具体模块和导出由可信本机宿主显式提供。

**这些入口均未运行，当前 `apps/agent/runtime/manifest.json` 仍是合并带入的旧 W5 产物，尚未匹配本轮源码／契约／迁移，不能声称当前代码已可启动。** 合流后必须先完成检查与新构建／运行清单生成、Agent `0002` 迁移、同一资源的新快照发布，再启动联合服务。服务不自动重建清单、迁移或修补快照。

用户确认后的命令顺序如下；这里只记录，未执行。先实际切换 Node 24.19.0／pnpm 11.23.0，并保留 `apps/agent/.env` 现有模型／身份凭据。W5 合入的 `package.json`／`pnpm-lock.yaml` 新增公开 `pg`、`kysely` 和 `@types/pg`，原 `tyde/node_modules` 未必完整，本轮没有安装依赖；先按锁文件安装，再构建 source／compiled 运行清单。服务端环境分别配置专用 Agent 数据库的迁移、发布、运行账号；不得使用业务数据库或混用权限。

```sh
# 保持合入的清单与锁文件一致，不更新锁文件
pnpm install --frozen-lockfile

# 新编译产物及 source／compiled 运行身份；build:agent-web 生成页面产物
pnpm build:agent
pnpm build:agent-web

# 仅 Agent 自有迁移，使用 AGENT_MIGRATION_DATABASE_URL
pnpm migrate:agent
pnpm check:agent-db

# 同一固定资源的新快照，使用 AGENT_PUBLISH_DATABASE_URL
node --env-file=apps/agent/.env .local/agent-w4-demo/publish.mjs

# 独立运行账号 AGENT_DATABASE_URL；不会使用旧 W5 独立服务
AGENT_STORAGE_MODE=postgres AGENT_HOST=127.0.0.1 AGENT_PORT=3102 node --env-file=apps/agent/.env .local/agent-w4-demo/start.mjs
```

服务就绪后在另一终端显式启动页面，代理只连接本轮 `3102`：

```sh
AGENT_PROXY_TARGET=http://127.0.0.1:3102 pnpm --filter @tyde/agent-web dev --host 127.0.0.1 --port 3103 --strictPort
```

依赖安装、构建、清单生成、迁移、发布、默认启动与本机联合入口，以及上述页面命令，本轮全部未运行。已准备启动文件不代表资源摘要／发布、数据库或模型调用通过；确认后须分别记录失败与通过证据。

### 新增实现与回归源码的状态

本轮新增通用源码 `apps/agent/src/storage/pi-deployment.ts` 与 `apps/agent/src/storage/tool-executions.ts`，分别承接可信资源部署／发布和工具过程持久投影；Agent `0002` 迁移提供 `agent_tool_executions` 载体。新增回归源码 `apps/agent/tests/pi-deployment.test.ts`、`apps/agent/tests/storage-tool-executions.test.ts`，并增强 execution-config、Pi 与 tool-loop 相关测试。源码已合流不代表对应断言已经执行；这些新增及既有增强测试本轮均未运行，类型、lint、格式和构建同样没有通过结论。

## 本轮接口追加文件清单

以下是相对 Git 自动合入结果，为完成 W4／W5 接口对接而追加的必要调整；前文 9 个原始冲突文件不重复列出。原 W5 自动合入文件仍在既有暂存区，保留其来源和归属；本轮没有重新暂存或提交。表内“未测”包括未运行测试、类型、lint、格式、构建或数据库检查，不能视为通过。

| 实际相对路径                                                 | 本轮用途                                                                     | 交付分类／验证状态         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------- |
| `apps/agent/src/execution/recovery.ts`                       | 显式孤立恢复时同步收敛遗留 running 工具过程，保留旧执行隔离                  | 通用需提交／未测           |
| `apps/agent/src/pi/native-state.ts`                          | 完整原生状态与宿主配置捕获信封共同保存／加载，保留真实条目身份               | 通用需提交／未测           |
| `apps/agent/src/runtime/memory-runtime.ts`                   | 同步新的 Pi 工具资格与生命周期接口，保留开发内存模式                         | 通用需提交／未测           |
| `apps/agent/src/runtime/postgres-runtime.ts`                 | 接入资源摘要与工具声明、可等待工具过程事务、读取及终态收敛                   | 通用需提交／未测           |
| `apps/agent/src/storage/database.ts`                         | 增加工具过程持久载体的数据库类型及关联字段                                   | 通用需提交／未测           |
| `apps/agent/src/storage/execution-config.ts`                 | 执行快照发布／匹配使用实际资源摘要与工具声明，阻止混入配置                   | 通用需提交／未测           |
| `apps/agent/src/storage/migrations.ts`                       | 登记追加的 `0002`、最新结构指纹及兼容迁移检查                                | 通用需提交／未测           |
| `apps/agent/src/storage/projections.ts`                      | 持久记录转换为共享工具安全投影，复用可靠事件来源                             | 通用需提交／未测           |
| `apps/agent/src/storage/tool-executions.ts`                  | 实现工具身份／原生关联、状态去重、投影与 `tool.updated` 同事务及遗留过程收敛 | 通用需提交／未测           |
| `apps/agent/src/storage/pi-deployment.ts`                    | 连接可信冻结资源、代码导出身份、资源发布及执行快照匹配                       | 通用需提交／未测           |
| `apps/agent/migrations/README.md`                            | 说明 `0002` 工具过程载体与合流后显式迁移边界                                 | 通用需提交／未测           |
| `apps/agent/migrations/0002-tool-executions-spec.json`       | 新增工具过程迁移的结构规格及指纹输入                                         | 通用需提交／未测           |
| `apps/agent/migrations/sql/0002/01_tool_executions.sql`      | 新增 Agent 自有 `agent_tool_executions` 表、关联与约束；不改 `0001`          | 通用需提交／未测           |
| `apps/agent/migrations/sql/0002/02_privileges.sql`           | 为新增载体配置 Agent 迁移／发布／运行账号权限边界                            | 通用需提交／未测           |
| `apps/agent/tests/execution-config.test.ts`                  | 增强资源摘要和工具声明参与快照身份的回归源码                                 | 通用需提交／未测           |
| `apps/agent/tests/pi-w4.test.ts`                             | 增强 W4 真实 SDK 工具循环、资格检查与可等待屏障回归源码                      | 通用需提交／未测           |
| `apps/agent/tests/pi-deployment.test.ts`                     | 新增可信部署资源／导出绑定、摘要与发布匹配回归源码                           | 通用需提交／未测           |
| `apps/agent/tests/storage-tool-executions.test.ts`           | 新增工具过程安全白名单和持久投影回归源码                                     | 通用需提交／未测           |
| `apps/agent/tests/storage-migrations-runtime.integration.ts` | 更新新迁移、运行权限及结构指纹集成回归源码                                   | 通用需提交／未测           |
| `apps/agent/tests/storage-migrations.integration.test.ts`    | 更新追加迁移与完整结构规格的集成回归源码                                     | 通用需提交／未测           |
| `apps/agent/tests/tool-loop.integration.ts`                  | 增强持久工具完整过程、去重、停止／迟到和重启读取回归源码                     | 通用需提交／未测           |
| `apps/agent/README.md`                                       | 说明可信部署注入、一次性许可、PG 演示及新快照前提                            | 通用需提交／仅文档静态调整 |
| `docs/AGENT_W4_W5_INTEGRATION.md`                            | 记录合流范围、追加文件、用户确认边界和未执行的联合步骤                       | 通用需提交／仅文档静态调整 |

原生工具结果先经 `afterTool` 完整保存，再等待工具终态投影／outbox 事务，之后才允许下一模型派发。工具表中的 source／result revision 与 entry、模型请求及 tool_call_id 为内部关联；模型请求还核对原生 usage observation，不产生业务 Operation。重复状态或迟到结果不重新开放执行或重复授权；结束与显式孤立恢复把遗留 running 收敛为对应 failed／cancelled。上述为静态接入语义，数据库与竞态证据尚待执行。

`package.json` 与 `pnpm-lock.yaml` 是 W5 自动合入的配套依赖变更，本轮接口对接没有再新增依赖；原工作区仍需在用户确认后按 frozen lockfile 安装。`apps/agent/runtime/manifest.json` 同样来自 W5 自动合入，当前仍为旧运行产物，待本轮源码／契约／迁移确定后重新生成并核验 source／compiled 身份。本轮未新增外部代码复制，既有许可证与 `SOURCE` 来源记录保持；没有新增许可证来源项。具体演示文件仍按前文 10 文件清单仅留本机，不加入通用提交。

## 用户确认后的联合验证

### 提交校验维护补充

随后用户继续合并时，提交钩子因 4 个文件格式不符合要求而中止，ESLint 任务被同时终止，不能据此判定有代码错误。该轮提交维护按现有锁文件执行依赖同步，并整理本轮合流文件的格式；业务测试、类型检查、构建、数据库迁移／发布及真实联调仍待用户确认，不将提交校验转记为功能验收。

该次维护已完成：Node 24.19.0／pnpm 11.23.0 下，`pnpm install --frozen-lockfile --config.confirmModulesPurge=false` 成功；锁文件和依赖声明未变。Prettier 检查覆盖 85 个合流路径（未知格式按现有规则跳过），ESLint 检查 57 个合流代码文件，均通过。静态词表检查无命中，HEAD、MERGE_HEAD 和原暂存内容保持不变；没有运行 lint-staged、业务测试、类型检查、构建、数据库或服务。

本轮 23 个配套文件此前仍有未暂存部分，加上 4 个需重新暂存格式的冲突文件，共 27 个文件需完整进入合并。仅暂存冲突文件会遗漏资源适配器、工具持久过程和 `0002` 等必要实现。忽略的 `.local/agent-merge-stage.sh` 列出这 27 个精确路径，并检查当前分支、HEAD 和 MERGE_HEAD；它仅供用户审阅后手动运行，不含 `.env`、词表或本机演示资源，不执行提交。准备脚本不会修改暂存区，本轮没有自动执行它。

以下仅为后续执行清单，本轮全部未运行。

1. 实际切换 Node 24.19.0／pnpm 11.23.0；核对当前 staged／unstaged 和本机忽略策略，保存既有配置。运行契约一致性、Agent 类型／单测／前端测试、两项构建、lint 与格式检查；shared 或依赖变化补全仓类型及业务／核心回归。
2. 在独立 Agent 专用测试库验证完整原生状态往返，模型请求／工具调用／结果 entry 关联、等待保存阻断、一次性许可仅消费一次、重复回调与命令重放不重复执行。
3. 验证工具 running／succeeded／failed／cancelled 投影与 `tool.updated` 的事务关联，以及保存失败／提交不明核实、旧 owner／generation／head、租约或连接失效、工具前／中停止、迟到结果、deadline 和 N／N+1 预算边界。
4. 验证快照水位、按序冻结补读、重复／缺口／背压、旧回包／旧订阅隔离，以及工具过程和文字终态收敛。刷新／切换／重连／进程重启只恢复展示；已完成会话后续问题使用同一 Pi Session 的原工具上下文。
5. 核对执行配置发布与实际资源完全匹配，缺失／摘要不符或不兼容资源失败关闭。另构造不携带 `.local`、演示配置或遗留产物的通用代码目录，验证独立安装、检查、构建和默认普通聊天。
6. 显式装配本机演示，使用少量短问题验证真实页面 → Agent → 原有真实模型 → 只读工具 → 模型使用真实返回，分别记录相关问题、普通问答、连续追问、工具卡／真实计数、停止与重启重连。真实供应商证据与受控 SDK／PG 替身证据分开，不换模型、路由、鉴权或降低协议校验。

继续／重试／provide_input、通用插件或资源市场、真实业务写工具、多实例／跨主机恢复、Electron 与完整 M3/W6 不在本轮合流交付范围。
