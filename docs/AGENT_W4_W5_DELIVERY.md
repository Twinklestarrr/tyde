# Agent W4／W5 本轮交付清单

2026-10-23 · 合并基线 `51a863e` · `integration/agent-w4-w5`

## 范围与当前结果

本轮开始时基线工作区干净，没有需要归入本轮的既有用户修改。用户已完成 W4／W5 合并并授权联调；原 9 处冲突与 23 项接口接入已在合并提交中，不把它们再列为本轮新开发。本轮修改 2 个源码、4 个配套测试、1 个运行清单，并维护下列 6 个文档；没有自行暂存、提交、推送、合并或发布应用。

工程检查、受控 SDK／专用 PG、无演示独立目录与真实模型页面分别登记在 [联合记录](AGENT_W4_W5_INTEGRATION.md)。真实工具、已有结果追问、普通问题、工具中停止、刷新／切换及重启重连已通过；无演示默认 PG 普通聊天通过真实产品 HTTP，不声称 clean 页面浏览器验通。实际 7 个 Task、9 次模型／3 次工具授权，工具 2 成功／1 取消。公开继续／重试／补充、业务写工具、多实例和 Electron 不在本轮交付范围。

## 本轮通用文件：配套提交

建议提交 A：`fix(agent): 修复工具重入授权与合流回归`。源码、测试和匹配运行清单必须配套，不能只选源码或沿用旧 manifest。

| 实际相对路径                                                 | 修改用途                                                                              | 分类／依赖与缺席影响                                                   | 建议提交 | 已有验证                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `apps/agent/src/pi/session.ts`                               | 同 source／真实调用 ID 回调共享在途保存／授权；换绑拒绝；未获准错误结果不伪造公开过程 | 通用需提交；所有工具循环依赖，缺席会重复授权或混淆结果关联             | A        | 服务 189 通过；PG 工具链通过；真实工具／追问通过                            |
| `apps/agent/src/storage/pi-deployment.ts`                    | 将 fail 声明收敛为 `never` 函数声明，使可信部署分支类型正确收窄                       | 通用需提交；PG 可信资源装配依赖，缺席无法保持本轮类型检查结果          | A        | Agent／全仓类型、构建、部署回归通过                                         |
| `apps/agent/tests/pi-session.test.ts`                        | 按 customType 分开用量记录与新增配置条目；停止仍保留唯一配置事实                      | 通用需提交；原生完整捕获的配套回归，缺席会漏检／误判配置条目           | A        | 服务套件包含该回归，189 通过                                                |
| `apps/agent/tests/pi-w4.test.ts`                             | 覆盖重复真实 ID 不重复授权／执行及同来源 beforeTool 回调重入                          | 通用需提交；固定 Pi 1.3.0 兼容回归，缺席会失去重复回调证据             | A        | 服务套件通过，SDK hook 替身仅测试内使用                                     |
| `apps/agent/tests/storage-migrations-runtime.integration.ts` | 测试目标限定 `_test`；临时非 owner LOGIN 使用内存随机密码兼容 SCRAM，不降低认证       | 通用需提交；PG 权限与真实 HTTP 受控执行回归；仅专用测试库              | A        | 专用 PG 分批套件通过；追加 guard 后真实阳性 1／1 通过，4 类误配在连接前拒绝 |
| `apps/agent/tests/tool-loop.integration.ts`                  | 实际 SDK＋PG 中重复原生 ID 保留首次成功过程，仅授权／执行一次，禁止第三模型派发       | 通用需提交；持久预算／工具过程关联回归，缺席会漏检重复许可             | A        | 专用 PG 工具循环通过，受控模型传输                                          |
| `apps/agent/runtime/manifest.json`                           | 由生成器重建当前 source／compiled 的固定 SDK／代码／迁移／契约／锁文件运行身份        | 通用需提交；新快照与启动匹配依赖，缺席会使用旧身份或拒绝启动；不得手改 | A        | 两构建通过；稳定身份见下文                                                  |

稳定运行身份：`a4cd78f5bf877cae84f997a866ea758fd90180bb826d6bd85294e75f43830e8c`。应用源码改变后重新生成并发布新执行快照，不修改已发布历史快照。

建议提交 B：`docs(agent): 更新联合验证与本机运行说明`。

| 实际相对路径                      | 修改用途                                                 | 分类／依赖与缺席影响                                           | 建议提交 | 相关验证                                       |
| --------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- | -------- | ---------------------------------------------- |
| `AGENTS.md`                       | 顶部更新本轮实际证据与遗留，保留业务最新记录和原阶段历史 | 通用需提交；后续开发入口依赖，缺席会把已确认联调误读为仍待确认 | B        | 内容与实际结果对照；最终格式／内容复核随主任务 |
| `docs/AGENT_DEVELOPMENT.md`       | 更新用户确认后的合流阶段与检查结果，保留 W2／W3 证据     | 通用需提交；跨端协作依赖，缺席会保留过时“未测试”状态           | B        | 同上                                           |
| `docs/AGENT_W4_W5_INTEGRATION.md` | 记录接口语义、冲突历史、当前工程／PG／独立环境／真实证据 | 通用需提交；本轮验收唯一汇总，缺席无法区分替身与真实调用       | B        | 逐项来源于实际执行回传，未通过项目保留         |
| `docs/AGENT_W4_W5_DELIVERY.md`    | 本清单：逐文件分类、依赖、建议提交、合流边界             | 通用需提交；审阅与后续提交依赖                                 | B        | 当前 git diff／文件清单静态对照                |
| `apps/agent/README.md`            | 分开默认 PG／原阶段历史／本机工具入口与单进程约束        | 通用需提交；服务启动说明依赖，缺席易混用旧端口或默认无工具发布 | B        | 实际构建／资源发布／启动证据见联合记录         |
| `apps/agent-web/README.md`        | 本机页面连接、原身份复制与工具追溯、刷新恢复说明         | 通用需提交；手工页面验证依赖，缺席会混用 3003 与本轮 3103      | B        | 前端 76、构建与分项真实页面证据                |

B 可在 A 后独立审阅；A 的 runtime manifest 与源码必须同组。这里只给提交建议，不执行 git add／commit／push。

## 契约、依赖与来源：本轮没有新增修改

W4／W5 的共享源与全部相关生成文件已在基线，不需要再次复制或手改。`pnpm check:agent-contracts` 本轮通过 103 Schema；下列具体文件保持基线状态，供核对配套关系：

- `packages/shared/src/agent/contracts/sources/21-commands.openapi.json`：命令源 `1.1.0-design`。
- `packages/shared/src/agent/contracts/sources/22-reads-events.openapi.json`：W4 工具过程源 `1.2.0-w4-design`。
- `packages/shared/src/agent/contracts/generated.ts`：类型、Schema 与 `agentContractSources` 来源摘要。
- `packages/shared/src/agent/contracts/document.generated.ts`：原始 JSON Schema。
- `packages/shared/src/agent/contracts/operations.generated.ts`：路径／示例。
- `packages/shared/src/agent/contracts/validator.generated.ts`：同源静态校验器。
- `packages/shared/src/agent/contracts/index.ts`：唯一语义校验入口。
- `packages/shared/src/agent/contracts/README.md`：来源／兼容规则。

`package.json`、`apps/agent/package.json` 与 `pnpm-lock.yaml` 保持合并基线配套；本轮没有新增包或修改锁文件。PG／Kysely 等 W5 依赖来源保留原公开锁定记录。三个 Pi 公开 SDK 仍精确 1.3.0。无新增外部代码复制，`apps/agent-web/upstream/pi-web/LICENSE` 与 `apps/agent-web/upstream/pi-web/SOURCE.md` 均保持，既有来源和许可不因本轮测试改变。

独立验证目录从 515 个 tracked 工作文件复制，起始不带 `.local`、实际 env、node_modules、dist 或旧 manifest；892 包离线 frozen 安装零下载，契约／Agent 类型／189＋76 Agent 测试／两构建／lint 通过。完整目录路径与检查边界见联合记录。仅拉取 A／B 与基线无需本机演示包即可安装与构建；默认普通 PG 聊天的真实证据仍按实际结果补齐。

## 本机演示文件：全部不提交

以下实际相对路径均为本机材料。通用源码没有静态导入它们；缺席只影响具体演示，默认服务、shared、前端、通用构建和测试不依赖它们。

| 实际相对路径                               | 用途／依赖与缺席影响                                                   | 分类／建议提交     | 相关验证                                |
| ------------------------------------------ | ---------------------------------------------------------------------- | ------------------ | --------------------------------------- |
| `.local/agent-w4-demo/manifest.json`       | 固定版本／文件摘要；loader 校验依据，缺席拒绝演示装配                  | 本机演示不提交／无 | 本轮资源发布及真实工具使用              |
| `.local/agent-w4-demo/prompt.md`           | 固定演示提示词，参与摘要／装配                                         | 本机演示不提交／无 | 同上                                    |
| `.local/agent-w4-demo/SKILL.md`            | 固定 Skill 正文，宿主预加载；不声明自动发现                            | 本机演示不提交／无 | 真实工具与普通问题均有分项证据          |
| `.local/agent-w4-demo/data.json`           | 合成人员／规则，不读取真实业务                                         | 本机演示不提交／无 | 真实工具返回实际合成结果                |
| `.local/agent-w4-demo/demo-tool.mjs`       | 具体只读工具实现，严格参数、可取消等待                                 | 本机演示不提交／无 | 真实 SDK 工具执行；取消结果按实测登记   |
| `.local/agent-w4-demo/load.mjs`            | 固定文件集合／顺序与 SHA 校验，不扫描目录                              | 本机演示不提交／无 | 固定资源装配                            |
| `.local/agent-w4-demo/deployment.mjs`      | 同一资源、字节与导出绑定给发布／启动共用                               | 本机演示不提交／无 | PG 发布与启动匹配                       |
| `.local/agent-w4-demo/database-target.mjs` | runner 和直接入口的目标库／端口／角色检查                              | 本机演示不提交／无 | 6 项只读目标 guard 检查                 |
| `.local/agent-w4-demo/publish.mjs`         | 独立发布账号发布固定资源与执行快照                                     | 本机演示不提交／无 | 本轮快照发布成功                        |
| `.local/agent-w4-demo/start.mjs`           | PG 运行账号启动注入实际资源的服务                                      | 本机演示不提交／无 | 实际 3102 服务与真实工具回答            |
| `.local/agent-w4-demo/run.mjs`             | 统一 publish／start／web／copy-token；固定本机目标，身份仅复制到剪贴板 | 本机演示不提交／无 | 本轮实际运行；不输出凭据                |
| `.local/agent-w4-demo/README.md`           | 本机依赖、启动顺序与范围                                               | 本机演示不提交／无 | 与 runner／实际结果对照                 |
| `.local/agent-w4-demo/MANUAL_TEST.md`      | 用户手动页面、停止／重启与只读 SQL 操作步骤                            | 本机演示不提交／无 | SQL 按 DDL 静态校准；未执行步骤不记通过 |

## 本机数据库与教学材料：全部不提交

| 实际相对路径                                                            | 用途／依赖与缺席影响                                      | 分类／建议提交         | 相关验证                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------- | ------------------------------------------------- |
| `.local/agent-postgres/manage.mjs`                                      | 固定实例／角色配置、启动／只读检查／迁移辅助入口          | 本机配置工具不提交／无 | 15 项基础连接／ACL检查，start／只读 psql 额外检查 |
| `.local/agent-postgres/run-db-tests.mjs`                                | 固定 `_test` 库与角色、连接预检、串行数据库套件及脱敏日志 | 本机测试工具不提交／无 | 专用 PG 49 项分批通过                             |
| `.local/agent-postgres/admin.env`                                       | 本机维护账号配置，辅助脚本内部读取                        | 配置不提交／无         | 本机初始化；不输出内容                            |
| `.local/agent-postgres/accounts.env`                                    | 本机账号维护材料                                          | 配置不提交／无         | 同上                                              |
| `.local/agent-postgres/development.env`                                 | Agent 运行角色 URL                                        | 配置不提交／无         | 实际运行账号连接／权限                            |
| `.local/agent-postgres/migration.env`                                   | 迁移角色 URL                                              | 配置不提交／无         | 两库 0001／0002 迁移                              |
| `.local/agent-postgres/publisher.env`                                   | 发布角色 URL                                              | 配置不提交／无         | 新快照发布                                        |
| `.local/agent-postgres/test.env`                                        | 专用测试 owner URL，禁止用于服务                          | 配置不提交／无         | 独立 PG 套件                                      |
| `.local/agent-postgres-guide/README.md`                                 | 初学者本机操作步骤、环境与权限实际状态                    | 本机教学不提交／无     | 只记录环境证据，不声称用户已学会                  |
| `.local/agent-postgres-guide/MISSION.md`                                | 固定本机只读检查与库隔离的学习目标                        | 本机教学不提交／无     | 文档                                              |
| `.local/agent-postgres-guide/RESOURCES.md`                              | 已浏览 PG18 官方主要来源                                  | 本机教学不提交／无     | 官方资料逐项引用                                  |
| `.local/agent-postgres-guide/NOTES.md`                                  | 环境／用户学习状态区分                                    | 本机教学不提交／无     | 无学习完成记录                                    |
| `.local/agent-postgres-guide/assets/course.css`                         | 课程／速查共用样式与打印布局                              | 本机教学不提交／无     | HTML 共用，不进入产品构建                         |
| `.local/agent-postgres-guide/assets/quiz.js`                            | 本页即时反馈；不连接数据库                                | 本机教学不提交／无     | 教学交互，不等于 Agent 测试                       |
| `.local/agent-postgres-guide/lessons/0001-identify-agent-database.html` | 单页连接目标课程                                          | 本机教学不提交／无     | 关联实际本机命令与来源                            |
| `.local/agent-postgres-guide/reference/agent-postgres-cheatsheet.html`  | 可打印速查                                                | 本机教学不提交／无     | 同上                                              |
| `.local/agent-postgres-guide/.DS_Store`                                 | 本机 Finder 元数据，无程序依赖                            | 配置产物不提交／无     | 不属于本轮代码                                    |
| `.local/agent-postgres/db-tests-2026-10-23T09-11-25-870Z.log`           | 专用 PG 分批执行脱敏日志                                  | 验证产物不提交／无     | 原始受控证据之一                                  |
| `.local/agent-postgres/db-tests-2026-10-23T09-12-46-108Z.log`           | 专用 PG 后续分批脱敏日志                                  | 验证产物不提交／无     | 原始受控证据之一                                  |
| `.local/agent-postgres/db-tests-2026-10-23T09-38-43-653Z.log`           | 最终测试库 guard 追加阳性复验脱敏日志                     | 验证产物不提交／无     | 最终版本 1／1 通过                                |

`.local/agent-w4-w5-postgres/` 下是 PostgreSQL 自动维护的数据页／WAL／服务配置，不是拟提交代码；不逐页复制、筛选或打包进提交。`commit-policy.json` 与原 `apps/agent/.env` 都继续忽略，本轮不提交、不覆盖、不在文档展示其内容。下节逐文件列出本轮验证材料；截图仅在工具结果内查看，没有保存本地 PNG，也不虚列截图文件。独立验证目录仍为本机产物。

## 本机联合证据：逐文件不提交

以下实际文件均位于 `.local/agent-joint-validation/`，不进入通用提交。查询脚本只 SELECT 审核字段；JSON 不含原始工具回执或凭据。`stdout.json` 是对应捕获的终端副本，不另计一次模型或测试。

| 实际相对路径                                                         | 用途／依赖与缺席影响                                                 | 分类／建议提交         | 对应证据                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `.local/agent-joint-validation/clean-path.txt`                       | 记录独立无演示验证目录；缺席不影响运行，但不便定位独立环境           | 验证产物不提交／无     | `/private/tmp/tyde-agent-w4-w5-clean-Lv3vGg`                                     |
| `.local/agent-joint-validation/clean-checks.mjs`                     | 独立目录检查驱动；不进入真实页面                                     | 本机验证工具不提交／无 | 契约／类型／测试／构建／lint／格式                                               |
| `.local/agent-joint-validation/generic-clean.mjs`                    | 从已构建的独立目录发布默认快照、启动默认服务／页面；凭据从目录外注入 | 本机验证工具不提交／无 | 默认无演示 PG 服务与真实普通聊天                                                 |
| `.local/agent-joint-validation/generic-chat.mjs`                     | 默认 PG 服务真实产品 HTTP 普通聊天验证驱动                           | 本机验证工具不提交／无 | 不加载演示；不是默认 clean 页面浏览器证据                                        |
| `.local/agent-joint-validation/generic-chat.json`                    | 默认服务实际会话／结果／计数记录                                     | 验证产物不提交／无     | 1 个 Task、1 模型／0 工具                                                        |
| `.local/agent-joint-validation/capture.mjs`                          | 只 SELECT 已审核标识、状态、计数、工具投影及原生 head                | 本机验证工具不提交／无 | 刷新／重启前后比较，不输出原始回执                                               |
| `.local/agent-joint-validation/before-refresh.json`                  | 主会话刷新前基线                                                     | 验证产物不提交／无     | 3 Task／4 模型／1 工具／31 事件／6 消息／3 结果／0 Operation                     |
| `.local/agent-joint-validation/after-refresh.json`                   | 刷新后捕获，与基线 deepEqual                                         | 验证产物不提交／无     | 刷新未重复执行                                                                   |
| `.local/agent-joint-validation/after-refresh.stdout.json`            | 对应捕获终端副本                                                     | 验证产物不提交／无     | 不另计请求                                                                       |
| `.local/agent-joint-validation/after-restart.json`                   | 恢复演示服务后的只读主会话状态                                       | 验证产物不提交／无     | 与 before-refresh.json deepEqual                                                 |
| `.local/agent-joint-validation/after-restart.stdout.json`            | 对应捕获终端副本                                                     | 验证产物不提交／无     | 不另计请求                                                                       |
| `.local/agent-joint-validation/resumed-context.json`                 | 重启后显式追问的新增 Task 与原上下文比较                             | 验证产物不提交／无     | 主会话最终 4 Task／5 模型／1 工具，同 Pi／原生 Session，原 3 Task 与工具对象不变 |
| `.local/agent-joint-validation/resumed-context.stdout.json`          | 对应捕获终端副本                                                     | 验证产物不提交／无     | 不另计请求                                                                       |
| `.local/agent-joint-validation/stopped.json`                         | 第二会话实际工具中停止的终态                                         | 验证产物不提交／无     | 会话共 2 Task／3 模型／2 工具，停止尝试无 Result／下一模型                       |
| `.local/agent-joint-validation/stopped.stdout.json`                  | 对应捕获终端副本                                                     | 验证产物不提交／无     | 不另计请求                                                                       |
| `.local/agent-joint-validation/stopped-after-restart.json`           | 重启后取消工具与停止尝试恢复                                         | 验证产物不提交／无     | 与 stopped.json deepEqual                                                        |
| `.local/agent-joint-validation/stopped-after-restart.stdout.json`    | 对应捕获终端副本                                                     | 验证产物不提交／无     | 不另计请求                                                                       |
| `.local/agent-joint-validation/clean-logs/check-agent-contracts.log` | 独立目录契约检查日志                                                 | 验证产物不提交／无     | 103 Schema 通过                                                                  |
| `.local/agent-joint-validation/clean-logs/typecheck-agent.log`       | 独立目录 Agent 类型日志                                              | 验证产物不提交／无     | 通过                                                                             |
| `.local/agent-joint-validation/clean-logs/test-agent.log`            | 独立目录 Agent 两应用测试日志                                        | 验证产物不提交／无     | 服务 189 通过＋1 PG 单列跳过；前端 76                                            |
| `.local/agent-joint-validation/clean-logs/build-agent.log`           | 独立目录服务构建日志                                                 | 验证产物不提交／无     | 通过，新运行身份                                                                 |
| `.local/agent-joint-validation/clean-logs/build-agent-web.log`       | 独立目录页面构建日志                                                 | 验证产物不提交／无     | 通过，保留大 chunk 提醒                                                          |
| `.local/agent-joint-validation/clean-logs/lint.log`                  | 独立目录 lint 日志                                                   | 验证产物不提交／无     | 通过                                                                             |
| `.local/agent-joint-validation/clean-logs/format-check.log`          | 独立目录全仓格式日志                                                 | 验证产物不提交／无     | 仅原业务测试文件失败，不记全过                                                   |

## 合入建议与后续边界

A 的通用修复可配套独立合入已有 W4／W5 合并基线；B 随后的说明提交不引入运行依赖。W5 需要保留并继续维护同一工具调用身份、可等待原生保存、一次性派发、工具过程／outbox 事务与资源快照接口，不另造公开工具 DTO。

只有 W4 的具体 Skill／人员／规则／演示执行器与本机部署工具留在 `.local`；W5 不依赖这些内容运行。后续源码或固定资源变更后重新生成运行身份、发布新快照，再复验旧 head 兼容与单进程启动。

当前遗留：全仓格式检查的既有业务测试文件。无演示默认聊天已走真实产品 HTTP，未做默认 clean 页面浏览器验收。完整 M3／W6、公开继续／重试／补充、业务写工具、多实例／跨主机恢复与 Electron 仍未交付。

最终内容检查覆盖 518 个仓库文件和 50 份本机文本材料：受限内容及已知本机凭据均无泄漏命中；4 个已有图标二进制未改，提取文本／元数据无命中，两份 PNG 已目视检查。无新增外部依赖或来源复制，package／lock／许可记录未变；锁文件下载地址为既有公开来源。没有暂存、提交或推送。
