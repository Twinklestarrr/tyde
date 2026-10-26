# Agent W4／W5 合流记录

2026-10-23 · `integration/agent-w4-w5` · 用户确认后的联合验证进行中

## 本轮范围与验证状态

本轮处理用户已经启动的 `feature/agent-w5-persistence` 合并，保留 W4 可信工具／Skill、独立工具过程与页面追溯，同时保留 W5 PostgreSQL、完整原生版本、持久命令／outbox／预算及单机隔离恢复。业务最新 07 验收与 08 入口安排保留，业务 Agent 继续 mock；不修改业务接口、Prisma、业务数据库或业务迁移。

用户最初要求冲突解决后先确认再测试，静态阶段已遵守。用户随后完成合并提交 `51a863e` 并确认开始联调，本轮从干净工作区执行实际检查、必要修复与受控／真实验证。下文的冲突期安排保留为历史，当前结果以末尾“用户确认后的实际验证”与 [本轮交付清单](AGENT_W4_W5_DELIVERY.md) 为准；本轮不自行暂存、提交、推送或发布应用。

[W4 验收记录](AGENT_W4_VALIDATION.md)和[W5 验收记录](AGENT_W5_VALIDATION.md)保留各自独立分支的真实证据；包括既有工具调用、PG 故障、重启追问与真实 600000ms 计时，均不能转记为合并后通过。新联合证据在本记录单独累计，不据此宣称未执行场景或完整 M3／W6 已通过。

## 冲突处理原则

原始冲突为以下 9 个文件；冲突已保留双方能力解决，用户已完成合并提交 `51a863e`。下面保留冲突处理归属，不表示本轮重新修改或提交这些文件。

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

四项工作已随合并接入；本轮在同一代码上进行类型、SDK／PG 与真实页面验证，结果分项记录在末尾。

| 接口                 | 合流要求与静态核对点                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可信工具／Skill 装配 | PG 宿主使用 `createApp(config, { deployment })`，从 `deployment.resources` 向实际 Pi Session 注入同一冻结资源，并把匹配的 `toolManifest`／`resourceManifestHash` 交给 `AgentPostgresRuntime`；显式 memory 模式可只传 `resources`。PG 启用资源必须提供 `TrustedPiDeployment`。`storage/pi-deployment.ts` 的创建／准备／发布适配器连接固定成员、代码身份及数据库规范化资源摘要。默认启动不扫描 `.local`、用户目录或加载演示包 |
| 一次性派发许可       | `beforeTool` 保存原生 assistant 并授权，`checkToolEligibility` 纯检查可重复；running 投影等待前后复检，`beforeToolDispatch` 真正执行前仅消费一次持久许可。`afterTool` 保存原生 toolResult 后等待终态投影。已用授权失败不退，停止后不再派发                                                                                                                                                                                  |
| 工具过程持久化       | 新增 Agent `0002` 的 `agent_tool_executions` 承载审核后的公开投影，与冻结的 `tool.updated` 同事务提交。工具身份关联真实模型请求 ID、Pi tool_call_id 及 source/result native entry；快照、历史、任务／结果读取与补读使用同一投影。终态和迟到结果不能恢复旧执行，只读工具不生成 Operation                                                                                                                                     |
| 执行配置身份         | `createTrustedPiDeployment`／`prepareTrustedPiDeployment`／`publishTrustedPiDeploymentSnapshot` 核对固定资源与实际成员字节，使用数据库规范化的 `resourceManifestHash`；执行快照 `tool_manifest.host_resources` 保存完整 W4 manifest。生成新的运行清单与新快照，不修改旧快照，HTTP 不自动发布                                                                                                                                |

完整原生 header／entries／leafId 和提交关联仍由 W5 原生仓储负责；公开工具投影不透传原始参数、完整结果、思考、服务端路径或凭据。原生数据捕获、数据库提交、公开终态与实际执行资格分别核对，数据库失败不能伪造成功。

## 配置与本机演示边界

W4 具体工具、Skill、合成人员／规则与专用启动材料仍只位于忽略的 `.local/agent-w4-demo/`，不随合并或通用提交复制。通用源码、shared、默认启动、构建和测试不依赖本机包；仅拉取通用代码不能直接复现完整演示。Skill 使用 `host-preloaded-system-prompt`，完整可信正文进入实际 system prompt；原生自动发现、read／bash 和目录扫描仍关闭。

W5 默认 `AGENT_STORAGE_MODE=postgres`，使用 Agent 自有 PostgreSQL 18 及独立迁移／发布／运行账号；显式开发 `memory` 保留 W3／W4 进程内行为，PG 错误不回退内存。合流后需要重新生成 source／compiled 运行清单、应用 Agent 独立 `0002` 迁移，并用相同资源装配发布对应新执行快照；冲突阶段没有执行生成、迁移或发布；用户确认后已生成新清单、应用 `0001`／`0002` 并发布匹配快照，实际身份见末尾。默认 `publish:agent-config` 只发布默认无工具配置，启用资源须使用可信部署适配器。旧任务仍绑定旧快照，加载旧 head 时比较 `model_config`、`tool_manifest`、资源摘要与 `execution_policy`，不能强换为新工具资源或新 Session 绕过不兼容。默认提示词已与旧 W5 内容静态核对一致；自定义配置缺乏一致性证据时拒绝加载，不据此宣称旧历史联合恢复已经通过。原 W4 本机启动入口不直接适用 PG；本机联合入口需要显式创建资源和 `TrustedPiDeployment` 并使用同一适配器发布／启动，不允许从前端指定模块路径或自动发现。

### 本机联合入口与来源

合并阶段在 `tyde` 的忽略目录 `.local/agent-w4-demo/` 准备以下 10 个初始文件；本轮另新增统一 runner、目标校验器和手测指南，均仅本机保留。它们仅为本机演示材料，不暂存、不提交；没有复制凭据、W4 历史证据或旧构建产物。

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

当前 source／compiled 运行身份已重新生成，Agent 专用库已迁移，固定资源与匹配新执行快照已发布。本机 `run.mjs` 统一 start／publish／web／copy-token，`database-target.mjs` 在 runner 及直接入口都核对固定本机库与对应角色。服务不自动重建清单、迁移或修补快照；源码改变后仍须重新生成并发布新身份。

通用启动仍使用独立 Agent 数据库、分权账号及已经发布的无凭据配置。具体本机演示、合成人员／规则及操作资料不进入通用代码；完整手测步骤在忽略的 `.local/agent-w4-demo/MANUAL_TEST.md`。已有本机包时，在 tyde 根目录实际切换 Node 24.19.0 后使用：

```sh
node .local/agent-w4-demo/run.mjs publish
node .local/agent-w4-demo/run.mjs start
```

另开终端启动界面并复制现有开发身份：

```sh
node .local/agent-w4-demo/run.mjs web
node .local/agent-w4-demo/run.mjs copy-token
```

`copy-token` 只把原开发 Bearer 交给本机剪贴板，不打印它。打开 `http://127.0.0.1:3103`，粘贴后连接并确认 PostgreSQL 模式。runner 固定 Agent `3102`、页面 `3103` 和本轮专用库，过滤旧连接环境，不覆盖原模型／身份文件；默认服务入口不加载这个目录。刷新需要重新输入身份，URL 中的会话 UUID 只用于恢复原会话读取。

### 新增实现与回归源码的状态

本轮新增通用源码 `apps/agent/src/storage/pi-deployment.ts` 与 `apps/agent/src/storage/tool-executions.ts`，分别承接可信资源部署／发布和工具过程持久投影；Agent `0002` 迁移提供 `agent_tool_executions` 载体。新增回归源码 `apps/agent/tests/pi-deployment.test.ts`、`apps/agent/tests/storage-tool-executions.test.ts`，并增强 execution-config、Pi 与 tool-loop 相关测试。源码已合流不代表对应断言已经执行；这些合并接口的联合检查已在用户确认后执行；具体通过、跳过和基线格式失败见末尾，不将原分支历史结果当作本轮执行。

## 本轮接口追加文件清单

以下保留原合并阶段相对自动合入结果的 23 项接口调整，已进入用户完成的合并提交；前文 9 个冲突文件不重复列出。表内“未测”是冲突静态阶段的当时记录，当前联合结果见末尾。本轮新修复及建议提交范围单独列在 [交付清单](AGENT_W4_W5_DELIVERY.md)，不把全部已合入文件重复列为新增改动。

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

原生工具结果先经 `afterTool` 完整保存，再等待工具终态投影／outbox 事务，之后才允许下一模型派发。工具表中的 source／result revision 与 entry、模型请求及 tool_call_id 为内部关联；模型请求还核对原生 usage observation，不产生业务 Operation。重复状态或迟到结果不重新开放执行或重复授权；结束与显式孤立恢复把遗留 running 收敛为对应 failed／cancelled。上述语义由本轮 SDK 与专用 PG 测试分项验证；真实供应商证据另列，不互相替代。

`package.json` 与 `pnpm-lock.yaml` 是 W5 自动合入的配套依赖变更，本轮接口对接没有再新增依赖；原工作区已按 frozen lockfile 安装，隔离目录亦独立安装复验。`apps/agent/runtime/manifest.json` 同样来自 W5 自动合入，本轮已重新生成并核验 source／compiled 身份；运行产物必须与本轮源码／契约／迁移配套提交。本轮未新增外部代码复制，既有许可证与 `SOURCE` 来源记录保持；没有新增许可证来源项。具体演示初始文件与本轮新增 runner／目标校验／手测指南均仅留本机，精确路径见交付清单，不加入通用提交。

## 合并前提交维护与原覆盖清单（历史）

以下保留用户完成 `51a863e` 前的维护经过；当时未开展功能联调，后续用户已确认执行。原暂存脚本中的 HEAD／MERGE_HEAD 约束不适用于当前已合并状态，不能再次运行旧脚本作为本轮提交入口。

### 提交校验维护补充

随后用户继续合并时，提交钩子因 4 个文件格式不符合要求而中止，ESLint 任务被同时终止，不能据此判定有代码错误。该轮提交维护按现有锁文件执行依赖同步，并整理本轮合流文件的格式；业务测试、类型检查、构建、数据库迁移／发布及真实联调仍待用户确认，不将提交校验转记为功能验收。

该次维护已完成：Node 24.19.0／pnpm 11.23.0 下，`pnpm install --frozen-lockfile --config.confirmModulesPurge=false` 成功；锁文件和依赖声明未变。Prettier 检查覆盖 85 个合流路径（未知格式按现有规则跳过），ESLint 检查 57 个合流代码文件，均通过。静态词表检查无命中，HEAD、MERGE_HEAD 和原暂存内容保持不变；没有运行 lint-staged、业务测试、类型检查、构建、数据库或服务。

本轮 23 个配套文件此前仍有未暂存部分，加上 4 个需重新暂存格式的冲突文件，共 27 个文件需完整进入合并。仅暂存冲突文件会遗漏资源适配器、工具持久过程和 `0002` 等必要实现。忽略的 `.local/agent-merge-stage.sh` 列出这 27 个精确路径，并检查当前分支、HEAD 和 MERGE_HEAD；它仅供用户审阅后手动运行，不含 `.env`、词表或本机演示资源，不执行提交。准备脚本不会修改暂存区，本轮没有自动执行它。

以下保留最初冻结的覆盖清单；当时未运行，当前执行结果见下一节，不能据清单存在把未执行场景记为通过。

1. 实际切换 Node 24.19.0／pnpm 11.23.0；核对当前 staged／unstaged 和本机忽略策略，保存既有配置。运行契约一致性、Agent 类型／单测／前端测试、两项构建、lint 与格式检查；shared 或依赖变化补全仓类型及业务／核心回归。
2. 在独立 Agent 专用测试库验证完整原生状态往返，模型请求／工具调用／结果 entry 关联、等待保存阻断、一次性许可仅消费一次、重复回调与命令重放不重复执行。
3. 验证工具 running／succeeded／failed／cancelled 投影与 `tool.updated` 的事务关联，以及保存失败／提交不明核实、旧 owner／generation／head、租约或连接失效、工具前／中停止、迟到结果、deadline 和 N／N+1 预算边界。
4. 验证快照水位、按序冻结补读、重复／缺口／背压、旧回包／旧订阅隔离，以及工具过程和文字终态收敛。刷新／切换／重连／进程重启只恢复展示；已完成会话后续问题使用同一 Pi Session 的原工具上下文。
5. 核对执行配置发布与实际资源完全匹配，缺失／摘要不符或不兼容资源失败关闭。另构造不携带 `.local`、演示配置或遗留产物的通用代码目录，验证独立安装、检查、构建和默认普通聊天。
6. 显式装配本机演示，使用少量短问题验证真实页面 → Agent → 原有真实模型 → 只读工具 → 模型使用真实返回，分别记录相关问题、普通问答、连续追问、工具卡／真实计数、停止与重启重连。真实供应商证据与受控 SDK／PG 替身证据分开，不换模型、路由、鉴权或降低协议校验。

继续／重试／provide_input、通用插件或资源市场、真实业务写工具、多实例／跨主机恢复、Electron 与完整 M3/W6 不在本轮合流交付范围。

## 用户确认后的实际验证

### 工程与隔离检查

实际使用 Node **24.19.0**、pnpm **11.23.0**，三个 Pi 公开 SDK 仍精确 **1.3.0**。本轮修复真实调用 ID 的重入授权：相同 source／call 的 beforeTool 回调共享一次在途保存／授权；相同 ID 换绑原生来源／模型请求时失败关闭。未通过保存／预算门禁的原生错误结果保留原始事实，不伪造已获准的公开工具过程。配置检查中的 `never` 函数声明收敛以及 SCRAM 测试身份、测试库目标保护随配套回归修正。

| 检查                                       | 本轮实际结果                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `pnpm check:agent-contracts`               | 通过，103 个 Schema；唯一公开契约源未再次修改                                                      |
| `pnpm typecheck:agent`、`pnpm typecheck`   | 通过                                                                                               |
| `pnpm test:agent`                          | 服务 190 项：189 通过、0 失败、1 项 PG 专属用例在普通套件跳过；前端 76／76                         |
| 专用 PostgreSQL 测试                       | 49 项分两批 47＋2 全部通过；测试库名称 guard 最终版额外真实阳性 1／1 通过，4 类误配在连接前拒绝    |
| `pnpm test`、`pnpm test:core`              | 业务 438／438，核心 91／91                                                                         |
| `pnpm lint`                                | 通过                                                                                               |
| `pnpm build:agent`、`pnpm build:agent-web` | 通过；Web 保留既有 >500kB chunk 提醒                                                               |
| `pnpm format:check`                        | 仅既有 `apps/server/tests/exam-grading-query.test.ts` 失败，未修改该业务文件，不能记为全仓格式通过 |

最终稳定 source／compiled 运行身份为 `a4cd78f5bf877cae84f997a866ea758fd90180bb826d6bd85294e75f43830e8c`。本轮未新增依赖；原 W5 package 与锁文件配套不变。

无演示独立目录 `/private/tmp/tyde-agent-w4-w5-clean-Lv3vGg` 从 515 个 tracked 工作文件复制构造，起始不携带 `.local`、实际 env、node_modules、dist 或旧运行清单，不创建提交。离线 frozen install 892 包、零下载成功；契约、Agent 类型、同一 189＋76 测试、两构建及 lint 通过；全仓格式仍仅上述原业务文件失败。在先停演示服务后，该目录实际构建的默认 `dist/main.js` 于 3104 启动，通过真实产品 HTTP 完成普通聊天：1 次模型／0 次工具、未加载演示资源。该项没有通过 clean 页面浏览器执行，不能写成默认 clean 页面浏览器验通；临时 3104／3105 已停止。

### 本机数据库与配置

独立 PG18.6 位于 `127.0.0.1:55436`；仅使用新建 Agent 联调／测试库，保留业务库与旧 W5 实例。两库已应用 `0001_agent_baseline` 与 `0002_tool_executions`，各 19 张领域表另加迁移记录表。分权账号与本机凭据仅在忽略目录保存，原模型／身份 `.env` 未改。15 项基础连接／只读 ACL／跨库与错误密码拒绝检查，以及 6 项本机目标防误连检查通过；它们不是完整 Agent 功能测试。

本机演示执行快照为 `faaec12f-6fcf-4d14-a488-adf82d8862b6`，默认无工具快照为 `2227b655-0a0c-488f-a449-abe6d7022eb6`。两者分别绑定各自固定资源身份，不能互换。旧 head 继续核对模型、工具声明、资源摘要和执行策略，不能换配置或新 Session 绕过不兼容。

同一 Agent 数据库仍只允许一个服务进程。本轮第二进程启动真实返回 `AGENT_PROCESS_ALREADY_RUNNING`；安排默认服务验证时先停演示进程，再启动默认入口，之后恢复演示。这个拒绝证据不表示已支持多实例。

### 真实模型与页面（分项累计）

页面走本轮 3103 → 3102 → 原有服务端模型配置 → 实际只读工具 → 模型使用真实返回。没有切换模型、路由、鉴权或降低结束／用量／参数协议校验。以下是本轮真实调用，和受控 SDK／PG 测试分开记录。

| 场景                     | 已得到的实际证据                                                                                             | 状态                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 相关问题实际查询         | 真实返回两条合成人员／可用日与规则，回答标明演示并使用返回；2 次模型／1 次工具，工具 succeeded               | 通过                                       |
| 已有工具上下文追问       | 同会话正确使用此前结果，1 次模型／0 次工具                                                                   | 通过                                       |
| 普通问答                 | 已有完成会话正确回答短算术问题，1 次模型／0 次工具，无强制工具                                               | 通过                                       |
| 刷新／切换／重连         | 刷新后重新验证身份并切换恢复；停服时模式 unknown 且保留原卡，恢复服务后重新连接成功                          | 通过                                       |
| 工具中停止及迟到保护     | 页面实际看见 running 后停止，Attempt stopped／工具 cancelled；1 次模型／1 次工具，无该尝试 Result 或下一模型 | 真实停止通过；迟到穷举由隔离测试覆盖       |
| 服务重启后只读恢复及追问 | 完成／停止会话只读恢复均与重启前深度相等；随后显式追问正确使用原上下文，1 次模型／0 次工具，同一 Pi Session  | 通过                                       |
| 无演示包默认 PG 普通聊天 | 独立目录默认服务 3104，真实产品 HTTP 普通问题，1 次模型／0 次工具，未加载演示包                              | HTTP 通过；未声称默认 clean 页面浏览器验通 |

首个真实工具会话 `e522f671-16b8-4885-8e0e-e75423a81ed9`，任务 `c705ac4b-e55d-41f0-913a-6c51d5852afa`，Attempt `c0465e03-0f72-4e1e-8d40-1c3c582ca276`，工具过程 `cd8d17ce-ad0e-4696-8684-51cfb793a2db`，Pi 调用 `call_00_Yl1rrOjivGVrJbMHics61537`。这些是可核对的产品关联 ID，不含身份凭据。具体演示内容、SQL 手测与公开字段证据只留 `.local`。本轮截图只在浏览器工具内查看，未保存为本地文件，不虚列截图产物。

刷新前／后分别存为 `.local/agent-joint-validation/before-refresh.json` 与 `after-refresh.json`，逐字段 deepEqual 相同：3 个 Task、4 次模型授权、1 次工具授权、31 个可靠事件、6 条消息、3 个 Result、0 个 Operation，原生 head 相同。切换只恢复原卡与最终正文。

真实工具中停止位于第二会话 `3d4c6eb5-a4a1-40a6-b34f-18e13e06e9da`，任务 `ad696031-f283-4659-b5a7-7a7b56d2cbab`，Attempt `ec995051-a9d3-4348-816c-62d1dbecec65`，工具过程 `5d8b0252-c8e6-4b54-8edf-6793bd41cf69`，调用 `call_00_RKerGT1ZGqrngJw6ofX78192`。该会话此前一次工具已先完成，2 次模型／1 次工具，第一次没有赶上停止窗口，不计为“工具中停止通过”；随后新问题确实运行中被停止，1／1，0 个 Operation、无该 Attempt Result／后续模型。

停止演示服务后，页面暂停连接、模式 unknown，并保留已取消卡；完成默认服务的顺序验证并恢复演示后，`after-restart.json` 与 `before-refresh.json` 相同，`stopped-after-restart.json` 与 `stopped.json` 相同，包含原生 head、事件及计数。只读重启恢复没有新增执行。之后用户显式发送的新追问记录于 `resumed-context.json`：Pi UUID `5f0b2b86-2eed-42ef-b689-a51bc939b61b`、原生 Session 标识和原工具对象完全相同，新问题 1／0 且正确使用上下文。

本轮共 **7 个实际 Task、9 次真实模型授权／3 次工具授权**：主会话 4 Task／5 模型／1 工具，第二会话 2 Task／3 模型／2 工具，无演示默认 PG HTTP 聊天 1 Task／1 模型／0 工具；工具共 2 成功、1 取消。受控测试不计入这些真实次数。本机证据目录为 `.local/agent-joint-validation/`，`capture.mjs` 仅 SELECT 审核字段，不输出原始回执或凭据。当前保留演示服务 3102 与页面 3103 供用户手测；临时无演示 3104／3105 已停止。

公开 continue／retry／provide_input、真实业务写工具、跨主机／多实例恢复和 Electron 仍未开放；业务 Agent 继续 mock。

## 前端同会话快照刷新修复

2026-10-23，修复同一会话重读 snapshot 时先清空投影、导致已有聊天短暂显示空会话提示的问题。同会话刷新现在保留已确认正文与工具卡，清除临时文字并显示“正在同步会话”；真正切换会话时显示“正在加载会话”。旧投影仅供阅读，新快照及水位 H 完整安装后再恢复操作与可靠订阅，旧请求／订阅隔离继续生效。

新增回归先在原实现取得两项失败（等待 snapshot 时 `view=null`），修复后定向测试转绿。补齐发送／停止门禁、metadata 等待期重复发送、跨会话旧回包、鉴权失败、网络失败与旧列表回流保护。保留原 pending 至快照刷新结束；刷新失败时保留的内容只读，401／403／404 或非法快照清除旧投影。认证失效及模式变化同时使旧列表代次失效。

实际检查：Node.js 24.19.0／pnpm 11.23.0；Agent 前端测试 **89 项通过（新增 13 项）**；前端类型、生产构建、103 Schema 契约检查、全仓 lint、变更文件 Prettier 与 `git diff --check` 通过。全仓 `format:check` 仍仅既有 `apps/server/tests/exam-grading-query.test.ts` 不通过，未修改该文件。构建保留既有大 chunk 提示。仅前端变更，本次未复跑 Agent 服务／数据库／业务全套，不将前文历史结果当作本次重跑。

真实 Chrome 独立标签通过本机 3103 → 3102 认证只读恢复已有会话：首次读取实际看到“正在加载会话”；重复选择同会话后正文与工具卡仍在；切换普通算术会话再切回，成功／取消工具卡、消息时间及 1 次模型／1 次工具／2 秒统计保持原值。慢快照等待期间不闪空由受控延迟回归证明，未对真实网络注入延迟。本次未发送问题、停止任务或新增模型／工具调用，临时验证标签已关闭，原页面保留。构建 shared 时开发页曾需重载，重载后重新认证验证通过。

改动仅涉及前端与配套说明，没有新增依赖、外部源码或公开契约，也没有修改提示词、Skill、UUID、数据库或服务端资源身份。本机演示资源未改动；`package.json`、`pnpm-lock.yaml`、来源映射、许可证及契约生成文件无变更，无需配套更新。当前变更路径／文本、凭据模式及建议提交说明经本机策略检查通过；无新增二进制，未暂存、提交或推送。

本次六个文件均属通用需提交，可作为一个独立前端修复合入，建议说明为 `fix(agent-web): 修复同会话刷新闪屏与读取竞态`：

| 实际相对路径                                     | 用途与缺席影响                                                                       | 相关验证                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------- |
| `apps/agent-web/src/services/chat-controller.ts` | 保留同会话投影，隔离旧读取并封住命令与列表竞态；核心修复，需与页面及回归配套         | 89 项前端测试、类型、lint、构建 |
| `apps/agent-web/src/App.tsx`                     | 区分加载／同步文案，禁用刷新／阻断期停止按钮；缺席会保留误导文案                     | 类型、lint、构建、真实浏览器    |
| `apps/agent-web/tests/chat-refresh.test.ts`      | 13 项通用合成回归；依赖已有提交的 `chat-fixtures.ts`，不进入真实页面，不依赖本机演示 | 原实现两项先红，修复后全绿      |
| `apps/agent-web/README.md`                       | 页面行为与只读恢复约定；无运行依赖                                                   | Prettier、内容检查              |
| `AGENTS.md`                                      | 前端模块约定同步；无运行依赖                                                         | Prettier、内容检查              |
| `docs/AGENT_W4_W5_INTEGRATION.md`                | 本次证据、限制与精确提交清单；保留历史                                               | Prettier、内容检查              |
