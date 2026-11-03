# Agent 阶段交付与验证历史

以下按原文件合并保留阶段交付、验证结果和故障处理证据。记录中的“当前”“下一步”“未实现”和命令只适用于原批次，不作为今天的执行指令。现行功能与限制见[文档导航](../README.md)及仓库根目录的 `AGENTS.md`。

- [AGENT_W3_VALIDATION.md](#agent-w3-validation)
- [AGENT_W4_DELIVERY.md](#agent-w4-delivery)
- [AGENT_W4_VALIDATION.md](#agent-w4-validation)
- [AGENT_W4_W5_DELIVERY.md](#agent-w4-w5-delivery)
- [AGENT_W4_W5_INTEGRATION.md](#agent-w4-w5-integration)
- [AGENT_W5_D1.md](#agent-w5-d1)
- [AGENT_W5_PI.md](#agent-w5-pi)
- [AGENT_W5_REVIEW.md](#agent-w5-review)
- [AGENT_W5_STANDARDS_REVIEW.md](#agent-w5-standards-review)
- [AGENT_W5_VALIDATION.md](#agent-w5-validation)

<a id="agent-w3-validation"></a>

原文件：`AGENT_W3_VALIDATION.md`。

<a id="agent-w3-validation--agent-w3-开发与验收记录"></a>

## Agent W3 开发与验收记录

2026-10-22 · 浏览器 M1 聊天闭环 · 开发内存模式

<a id="agent-w3-validation--实现范围"></a>

### 实现范围

- 21／22 源快照从 `1.0.0-design` 同步到当前 `1.1.0-design`，公开 `schema_version=1` 不变。21 路径与请求结构未变；22 新增 AttemptBudgetView、AttemptView.budget 及预算错误。通过现有生成器生成 99 个 Schema、静态浏览器校验器、来源摘要与 Swagger 同源接口定义，未手改生成文件。
- Agent API 提供私有空会话、列表与签名分页、概况、一致快照、消息历史、任务／结果、命令提交与按 key 核实、产品 SSE 订阅和同进程补读。请求拒绝重复 JSON 键、非法 UTF-8／Unicode、超限请求与非 JSON 媒体；所有资源校验可信身份与归属，SSE 逐批复核并在存活期间检查授权。
- `start_task` 只支持 `business_query`；`stop_attempt` 明确绑定目标。命令按用户＋key 去重、原意图摘要冲突拒绝、冻结原 HTTP／裁决；同一会话互斥执行。同 Conversation 至多固定绑定一个 Pi Session，已完成后的追问创建后续 Task，复用 Pi 原生上下文。
- 停止、失败和未完成目标保留，不以新 Task 绕过。`provide_input`、`continue_task`、`retry_task`、排班草案本轮均未开放；服务返回明确 422，页面不展示这些动作。
- 页面支持自由输入、会话切换、历史、Markdown 流式、发送核实、停止中／停止／完成／失败、断线提示、有界重连与手动重新连接。先完整应用 snapshot 和 H，再顺序应用 H 之后的可靠事件；control／delta／心跳不推进游标。临时文字按输出流与连续索引合并，终态正文／结果原子替换，不重复叠字；旧 HTTP／订阅不能覆盖当前会话。
- 每个 Attempt 默认 600000ms／12 次模型授权／10 次工具授权；放行前同步预占、失败不退、同 key 不重置、达到 N 次仍可交付，第 N+1 次才锁存次数限制。期限先于次数判断，stop／completed／limit 首因裁决；最终发送与工具 execute 再检查资格，取消信号贯通，单次请求超时取剩余时长上界。预算锁存收尾显示明确提示，不伪造用户 stopping。模型 usage 缺失继续是 null，不用 Pi 默认零或静态价格冒充用量／费用。

<a id="agent-w3-validation--启动与本机身份"></a>

### 启动与本机身份

实际执行版本为 Node.js **24.19.0**、pnpm **11.23.0**。启动时默认 node 是 22.22.3；本次显式把已安装的 `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` 放到 PATH 首位，再核对版本。`.nvmrc` 本身不会切换终端；其他机器使用自身版本管理器切换到同一版本。

完整可运行步骤见 [Agent 服务说明](../../apps/agent/README.md#w3-浏览器聊天与本机身份历史阶段)。保留已有 `apps/agent/.env` 的 URL／Key／模型，只补齐开发身份：

1. 用 Node crypto 生成至少 32 字符的本机 Bearer；在忽略的服务端 `.env` 配置 `NODE_ENV=development`、`AGENT_HOST=127.0.0.1`、`AGENT_AUTH_MODE=development`、`AGENT_TEST_USER_ID`、`AGENT_TEST_BEARER_TOKEN`。
2. 两个终端分别运行 `pnpm dev:agent`、`pnpm dev:agent-web`，打开 `http://127.0.0.1:3003`；输入开发 Bearer 后连接、新建会话。模型 URL／Key 仅由 Agent 服务读取，不输入页面。
3. 刷新后重新输入开发身份，页面依据 URL 会话 ID 查询原进程历史；这不会发命令。真实登录／业务页面 mock 用户均不能替代此身份。

本次浏览器使用进程级临时开发身份，未写入或覆盖现有 `.env`。验证结束清理本次启动的临时服务。完整上游 pi-web 只读参考固定提交 `7c0778a8bc7342f1ededc6f5fb190dc6f4e43044`，仍在忽略的 `.local/`，不参与构建或交付；许可证与来源映射保留在应用内。

<a id="agent-w3-validation--分阶段隔离验证"></a>

### 分阶段隔离验证

| 阶段            | 覆盖与证据                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约与预算      | 99 Schema 生成一致性；10 项虚拟时钟预算测试覆盖 599999／600000／600001ms、模型 11／12／13、工具 9／10／11、重复授权、失败不退、首因锁存、停止与完成竞争                       |
| 内存 API        | Runtime 21 项覆盖 key 重放／冲突、并发互斥、跨用户／多会话、完成新 Task 同 Pi、多轮原生上下文、停止竞争和迟到输出、签名分页／历史、冻结事件、超限与剩余单请求时限             |
| HTTP／Swagger   | 5 项测试验证实际响应共享契约、严格 JSON／Unicode／媒体／大小／版本、冻结核实、停止与背压；实际 OpenAPI 含完整中文字段说明和可校验示例，未实现成功分支不展示，通用占位说明为 0 |
| 真 TCP 产品 SSE | 3 项：开流后撤销授权，旧流只发 reauthenticate 后关闭、不再发私有 product／delta；snapshot 到订阅之间竞态连续补读；断开期间完成后按 after_seq 补读且 starts=1、stops=0         |
| 页面与故障      | 客户端、投影、读取代次、事件重复／缺口、临时增量收敛、历史迟到、原命令未知结果核实、接收方敏感 fetch、身份失效清缓存及预算收尾展示                                            |

以上模型替身／虚拟时钟测试不当作真实供应商验收。未接工具的生产页面不加载测试夹具。

<a id="agent-w3-validation--真实浏览器与模型验收"></a>

### 真实浏览器与模型验收

链路为 **Chrome 页面 → 本机 Agent → 已有服务端配置的 DeepSeek `deepseek-flash`**。沿用 URL／Key、模型和鉴权方式；本轮总共 **5 次真实模型请求**，未换模型、路由或参数重试，未调用专用平台入口。

| 场景           | 实际观察                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新建与第一轮   | 空会话不触发模型；首次输入合成口令，收到“已记住”，Task completed                                                                                      |
| 连续追问       | 下一 Task 正确返回上一轮口令“潮汐-青舟-742”，证明同会话原生上下文连续；每个 Attempt 模型授权为 1                                                      |
| 流式与真实失败 | 长 Markdown 回答达到现有 1024 输出上限，收到 `MAAS_OUTPUT_TRUNCATED`；页面保留已接收正文并显示 failed，没有误报 completed，也不能发新 Task 绕过该目标 |
| 文字流式停止   | 新会话先看到 Markdown 标题及第一条真实增量，立即点击停止；最终显示 stopped、输出已中断，保留两条科普片段，不形成最终 Result                           |
| 多会话隔离     | 第三个会话询问另一个会话的口令，真实回答“不知道”；切换会话分别恢复自己的历史与状态                                                                    |
| 断线提示       | 保持 Agent 进程存活，停止本地前端代理，页面显示“连接已断开”；未把断线当作实际停止                                                                     |
| 重连           | 构建预览不含 HMR，短暂停启代理后原页面自动恢复实时连接；长断线有界重试耗尽后使用“重新连接”恢复。均不新发任务                                          |
| 刷新           | URL 保留会话 ID；刷新清除内存 Bearer，重新输入后恢复原 stopped 历史及正文，不启动执行                                                                 |
| 服务重启       | 重启 Agent 后原会话不可访问，重新连接显示“开发内存服务重启会清空旧会话”，列表为空；没有从聊天重建执行                                                 |
| 不重复执行     | 停止会话在断线、自动／手动重连和刷新后始终 messages=2、eventSeq=9、model_requests_used=1；首会话仍为 messages=6、eventSeq=22                          |

验收截图保存在被 Git 忽略的 `artifacts/agent-w3/`：`browser-completed.jpg`、`browser-reconnected-stopped.jpg`。它们只含本轮合成问题和真实模型输出，不含凭据。

用户已提供的 **W2** 证据另行保留：DeepSeek Flash 两轮召回、流式和本地停止通过；DeepSeek V4 Pro 仅配置检查；可选专用平台路径尚未真实联调。本轮浏览器记录不改写这些边界。

<a id="agent-w3-validation--最终检查"></a>

### 最终检查

全部使用 Node 24.19.0／pnpm 11.23.0：

| 命令                                       | 结果                                               |
| ------------------------------------------ | -------------------------------------------------- |
| `pnpm check:agent-contracts`               | 通过，99 Schema／2 源快照                          |
| `pnpm typecheck:agent`                     | 通过                                               |
| `pnpm test:agent`                          | 服务端 132／132，前端 45／45，共 177／177          |
| `pnpm build:agent`、`pnpm build:agent-web` | 通过                                               |
| `pnpm typecheck`                           | 全仓通过，包括业务 Web、Electron、业务后端与共享包 |
| `pnpm lint`、`pnpm format:check`           | 通过                                               |
| `pnpm test`                                | 业务后端 208／208                                  |
| `pnpm test:core`                           | 48／48                                             |

真 TCP／tsx IPC 首次在沙箱内遇到 EPERM，允许本机监听后完整重跑通过，未跳过测试。Agent Web 构建保留 Vite 的单包超过 500kB 提醒；构建成功，后续可独立优化代码拆分。本轮未改 platform／Electron，未额外运行需要业务登录与数据库环境的双端 E2E。

交付前执行当前文本／路径、9 份依赖清单与锁文件来源检查；本轮无依赖改动，锁文件仅有公共包来源与公开 SheetJS 下载。现有 4 个图标二进制已检查可提取文本、图像与元数据，没有本轮新增产品二进制资源。`commit-policy.json` 当前不存在，保持 Git 忽略，未创建／暂存它；因此未宣称已跑过本机指定词表匹配。新增代码未引入私有包、内部地址或上游运行时，测试截图位于忽略的 artifacts。没有拟用提交或 PR 文案，未自行提交或发布。

<a id="agent-w3-validation--内存模式与后续边界"></a>

### 内存模式与后续边界

- 只在同一 Agent 进程存活期间保存会话、Pi 原生状态、命令裁决、产品投影和冻结事件。事件最多保留 10000 条，过期游标必须重取快照；不是正式可靠 outbox。
- 服务重启后旧会话返回 404、旧游标失效；不会凭聊天内容或 JSONL 重建 Pi，也不会自动重启执行。PostgreSQL、迁移、持久幂等、持久预占／deadline、提交不明核实和恢复保护属于 W5。
- 26 号完整设计还包括真实十分钟持续集成、持久落库和恢复保护；本轮只完成进程内预算及虚拟时钟／受控 SDK 边界，不宣称完整 26 号已验收。
- 继续／重试／补充、waiting_input 的产品执行语义、真实工具／Skill 属于后续工作；模型选择器不在本轮，任务执行中不换模型。正式平台鉴权和授权续期仍需接入；现有适配器注入及撤销边界已测试。
- 不接终端／文件／扩展发现、不接真实业务写工具，不修改 `apps/server` 接口、Prisma 或迁移；Electron 装配属于 W6。本轮未提交、发布或执行数据库迁移。

<a id="agent-w3-validation--2026-10-22-聊天展示补充验证"></a>

### 2026-10-22 聊天展示补充验证

本次按用户确认范围完善展示：默认会话标题由首条受理输入预览生成，折叠空白并取前 80 个 Unicode 码点，自定义标题和后续追问不改名，不产生额外模型调用；消息右下角显示服务端消息时间，跨日补日期，午夜及休眠恢复后更新。统计只展示已用模型请求／工具调用次数及耗时，服务端预算保护保留。耗时由服务端起止时间计算，运行时更新，终态冻结，刷新／重连不重置。浅色改为业务界面的青蓝品牌色，深色同步调整。继续／重试仍未开放。

Node 24.19.0／pnpm 11.23.0 下，`pnpm check:agent-contracts`、`pnpm typecheck:agent`、`pnpm test:agent`（服务端 134／134、前端 52／52）、两项 Agent 构建及全仓 `pnpm lint` 均通过。新增覆盖首条标题及幂等副作用、实时标题与迟到列表回包、停止前未执行、计数未知、耗时边界与冻结，以及虚拟时钟下午夜／跨日休眠／清理。Swagger 已同步默认标题行为，实际接口文档说明与示例测试通过。

全仓 `pnpm format:check` 发现 `apps/server/tests/exam-grading-query.test.ts` 的既有格式问题；该文件与 HEAD 一致，本次未修改。全部本次变更单独执行 Prettier 检查通过，`git diff --check` 通过。构建继续有既有的大于 500kB 包体提醒。未改共享契约、依赖、业务接口或数据库，因此未重复业务全套回归。

真实浏览器沿用现有服务端模型配置，共 4 次模型请求：首轮短答完成，连续追问保留首条标题；两次长答触发现有输出上限，页面如实显示 `MAAS_OUTPUT_TRUNCATED` 并冻结耗时；最终构建预览中，在收到真实正文后点击停止，显示已停止，统计为“1 次模型请求 · 0 次工具调用 · 耗时 6秒”。刷新后重新输入身份、暂停并恢复本地代理后自动重订阅，标题／正文／停止结局及统计均保持，未产生额外执行。开发热更新曾打断一次停止操作，未将其算作停止通过，最终使用无 HMR 的构建预览重验成功。截图在忽略目录 `artifacts/agent-display/`，包括完成、失败、停止、深色和刷新重连后浅色状态。

本轮无依赖变更；9 份清单与锁文件中的依赖 URL 均为已知公开来源。45 个 Agent 构建文件未匹配本机服务端密钥／身份凭据，未新增产品二进制资源。当前仍无本机 `commit-policy.json`，未宣称执行指定词表匹配；未暂存、提交、发布或修改现有 `.env`。W3 开发内存模式和前述后续阶段边界保持有效。

<a id="agent-w4-delivery"></a>

原文件：`AGENT_W4_DELIVERY.md`。

<a id="agent-w4-delivery--agent-w4-逐文件交付清单"></a>

## Agent W4 逐文件交付清单

2026-10-23 · 仅提供建议，不执行暂存、提交、推送或合并。

原目录启动时干净；当前 W4 worktree 分支为 `feature/agent-w4-tools`，基线 `d73ea7a45693b59bbf36f5dc4eb9f509185a95d2`。原目录、用户配置和 W5 目录未切分支或覆盖。W2／W3 历史记录不改。

<a id="agent-w4-delivery--通用需提交37-个文件"></a>

### 通用需提交：37 个文件

下表每行的“提交”对应后续精确分组。所有生成文件由现有生成器维护；21 源未改，生成器脚本未改。

| 实际相对路径                                                               | 修改用途                            | 依赖与缺席影响                             | 建议提交 | 相关验证                        |
| -------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------ | -------- | ------------------------------- |
| `AGENTS.md`                                                                | 当前工程入口/装配/兼容/W5协作说明   | 不参与执行；缺席会留下旧阶段说明           | 4        | 实现/命令/边界交叉核对          |
| `README.md`                                                                | 当前工程入口/装配/兼容/W5协作说明   | 不参与执行；缺席会留下旧阶段说明           | 4        | 实现/命令/边界交叉核对          |
| `apps/agent-web/README.md`                                                 | 真实工具过程与默认无demo边界        | 运行说明；缺席不影响编译但交付不完整       | 3        | 说明与实现核对                  |
| `apps/agent-web/src/App.tsx`                                               | 在聊天回答旁装配工具卡              | 依赖ChatMessages；缺席不显示工具过程       | 3        | 71项前端/真实浏览器             |
| `apps/agent-web/src/agent-events/projection.ts`                            | 快照历史事件工具缓存/终态不可回退   | controller依赖；缺席无法恢复工具过程       | 3        | 竞态/终态/换绑/文字收敛回归     |
| `apps/agent-web/src/agent-events/protocol.ts`                              | 工具可靠事件归属检查                | SSE客户端依赖；缺席跨会话校验不完整        | 3        | 未知/缺口/归属回归              |
| `apps/agent-web/src/components/ChatMessages.tsx`                           | 消息/工具按task与attempt组合        | App依赖；缺席编译失败                      | 3        | 展示/时间/归属回归              |
| `apps/agent-web/src/components/ToolExecutions.tsx`                         | 安全摘要/四态/演示标识/追溯         | ChatMessages依赖；缺席编译失败             | 3        | SSR展示/真实截图                |
| `apps/agent-web/src/styles/global.css`                                     | 工具卡主题/布局/追溯样式            | 卡片样式依赖；缺席显示退化                 | 3        | 构建/浅深色截图                 |
| `apps/agent-web/tests/chat-controller.test.ts`                             | 工具补读/旧订阅/终态/安全展示回归   | 与UI和投影配套；缺席失去覆盖               | 3        | 前端71/71                       |
| `apps/agent-web/tests/chat-fixtures.ts`                                    | 最小工具投影测试夹具                | 前端测试依赖；不被真实页面导入             | 3        | 前端71项                        |
| `apps/agent-web/tests/events.test.ts`                                      | 工具补读/旧订阅/终态/安全展示回归   | 与UI和投影配套；缺席失去覆盖               | 3        | 前端71/71                       |
| `apps/agent-web/tests/projection.test.ts`                                  | 工具补读/旧订阅/终态/安全展示回归   | 与UI和投影配套；缺席失去覆盖               | 3        | 前端71/71                       |
| `apps/agent-web/tests/tool-display.test.tsx`                               | 工具补读/旧订阅/终态/安全展示回归   | 与UI和投影配套；缺席失去覆盖               | 3        | 前端71/71                       |
| `apps/agent-web/upstream/pi-web/SOURCE.md`                                 | 标记新增组件自研/无新增上游代码     | 许可证来源映射配套；LICENSE原样保留        | 3        | 来源/无依赖变更                 |
| `apps/agent/README.md`                                                     | 当前工程入口/装配/兼容/W5协作说明   | 不参与执行；缺席会留下旧阶段说明           | 4        | 实现/命令/边界交叉核对          |
| `apps/agent/src/api/documentation.ts`                                      | 工具中文Swagger/当前边界            | API文档装配依赖；缺席文档校验失败          | 1        | Swagger字段与例子测试           |
| `apps/agent/src/application.ts`                                            | 可信宿主注入/固定启动配置           | 默认入口与本机宿主依赖；缺席不能注入       | 2        | 默认无demo启动/HTTP/真实页面    |
| `apps/agent/src/maas/transport.ts`                                         | 稳定模型请求ID/阻止重复派发         | Pi传输依赖；缺席无法保证跨层关联           | 2        | 传输13项/工具链                 |
| `apps/agent/src/pi/index.ts`                                               | 导出受控宿主接口                    | 应用/CLI/宿主依赖；缺席导入失败            | 2        | 类型/构建/默认入口              |
| `apps/agent/src/pi/resources.ts`                                           | 可信资源冻结/正文预加载/摘要        | Pi与宿主装配依赖；缺席编译失败             | 2        | 15项W4 Pi/缺失摘要/隔离构建     |
| `apps/agent/src/pi/session.ts`                                             | 工具循环/原生关联/取消/配置捕获     | 运行时与CLI依赖；缺席失去实际执行链        | 2        | 25旧+15新Pi、5工具集成/真实模型 |
| `apps/agent/src/runtime/memory-runtime.ts`                                 | 内存工具投影/原生保存/最终派发门禁  | 所有产品读取/执行依赖；缺席W4无法接入      | 2        | 5工具集成/旧运行时/TCP回归      |
| `apps/agent/tests/api.test.ts`                                             | 契约、序列化、Swagger与例子回归     | 与契约变更配套；缺席会失去对应回归         | 1        | 服务端156项                     |
| `apps/agent/tests/contracts-schema.test.ts`                                | 契约、序列化、Swagger与例子回归     | 与契约变更配套；缺席会失去对应回归         | 1        | 服务端156项                     |
| `apps/agent/tests/memory-tools.test.ts`                                    | 真实SDK到API投影/停止/预算/保存集成 | 最小合成工具在测试内；缺席失去W4集成回归   | 2        | 5/5                             |
| `apps/agent/tests/pi-w4.test.ts`                                           | 固定Pi资源/工具/故障/预算实验       | 最小合成夹具就在文件内；不依赖本机包       | 2        | 15/15                           |
| `docs/AGENT_DEVELOPMENT.md`                                                | 当前工程入口/装配/兼容/W5协作说明   | 不参与执行；缺席会留下旧阶段说明           | 4        | 实现/命令/边界交叉核对          |
| `docs/AGENT_W4_DELIVERY.md`                                                | 逐文件分类/建议提交与未完成项       | 交付索引；不参与执行                       | 4        | 本清单与git逐文件核对           |
| `docs/AGENT_W4_VALIDATION.md`                                              | A—E证据/隔离与真实区分/W5交接       | 交付证据；不参与执行                       | 4        | 156+71/421/87与真实7请求        |
| `packages/shared/src/agent/contracts/README.md`                            | 版本兼容和来源摘要                  | 开发来源记录；缺席不影响运行但交付不完整   | 1        | 摘要/外部源一致性               |
| `packages/shared/src/agent/contracts/document.generated.ts`                | 生成：JSON Schema与来源摘要         | 两端/Swagger配套依赖；不可只提交部分或手改 | 1        | 生成一致性/类型/完整测试        |
| `packages/shared/src/agent/contracts/generated.ts`                         | 生成：DTO和TypeBox                  | 两端/Swagger配套依赖；不可只提交部分或手改 | 1        | 生成一致性/类型/完整测试        |
| `packages/shared/src/agent/contracts/index.ts`                             | 工具状态/时间/结果/错误配对语义     | 两端统一验证；缺席会丢语义约束             | 1        | 契约与前端异常回归              |
| `packages/shared/src/agent/contracts/operations.generated.ts`              | 生成：OpenAPI路由/示例              | 两端/Swagger配套依赖；不可只提交部分或手改 | 1        | 生成一致性/类型/完整测试        |
| `packages/shared/src/agent/contracts/sources/22-reads-events.openapi.json` | 唯一22源；W4独立工具读取和事件      | 生成器唯一输入；缺席无法再生成/核对        | 1        | 103 Schema检查/契约/Swagger     |
| `packages/shared/src/agent/contracts/validator.generated.ts`               | 生成：静态浏览器校验器              | 两端/Swagger配套依赖；不可只提交部分或手改 | 1        | 生成一致性/类型/完整测试        |

<a id="agent-w4-delivery--建议提交顺序与精确文件"></a>

### 建议提交顺序与精确文件

每个分组的文件均在下方逐一列出，不需要手工挑选同一文件的代码块。默认无demo环境已独立验证。提交 1 可先合入 main；提交 2、3 依赖 1，可分批合入，但含新事件的服务部署需与前端配套；提交 4 在对应实现落地后合入。

<a id="agent-w4-delivery--提交-1featagent-补充只读工具过程契约与安全投影"></a>

#### 提交 1：`feat(agent): 补充只读工具过程契约与安全投影`

- `apps/agent/src/api/documentation.ts`
- `apps/agent/tests/api.test.ts`
- `apps/agent/tests/contracts-schema.test.ts`
- `packages/shared/src/agent/contracts/README.md`
- `packages/shared/src/agent/contracts/document.generated.ts`
- `packages/shared/src/agent/contracts/generated.ts`
- `packages/shared/src/agent/contracts/index.ts`
- `packages/shared/src/agent/contracts/operations.generated.ts`
- `packages/shared/src/agent/contracts/sources/22-reads-events.openapi.json`
- `packages/shared/src/agent/contracts/validator.generated.ts`

<a id="agent-w4-delivery--提交-2featagent-接入受控工具与可信资源宿主"></a>

#### 提交 2：`feat(agent): 接入受控工具与可信资源宿主`

- `apps/agent/src/application.ts`
- `apps/agent/src/maas/transport.ts`
- `apps/agent/src/pi/index.ts`
- `apps/agent/src/pi/resources.ts`
- `apps/agent/src/pi/session.ts`
- `apps/agent/src/runtime/memory-runtime.ts`
- `apps/agent/tests/memory-tools.test.ts`
- `apps/agent/tests/pi-w4.test.ts`

<a id="agent-w4-delivery--提交-3featagent-web-展示工具过程与调用追溯"></a>

#### 提交 3：`feat(agent-web): 展示工具过程与调用追溯`

- `apps/agent-web/README.md`
- `apps/agent-web/src/App.tsx`
- `apps/agent-web/src/agent-events/projection.ts`
- `apps/agent-web/src/agent-events/protocol.ts`
- `apps/agent-web/src/components/ChatMessages.tsx`
- `apps/agent-web/src/components/ToolExecutions.tsx`
- `apps/agent-web/src/styles/global.css`
- `apps/agent-web/tests/chat-controller.test.ts`
- `apps/agent-web/tests/chat-fixtures.ts`
- `apps/agent-web/tests/events.test.ts`
- `apps/agent-web/tests/projection.test.ts`
- `apps/agent-web/tests/tool-display.test.tsx`
- `apps/agent-web/upstream/pi-web/SOURCE.md`

<a id="agent-w4-delivery--提交-4docsagent-记录-w4-验证与交付边界"></a>

#### 提交 4：`docs(agent): 记录 W4 验证与交付边界`

- `AGENTS.md`
- `README.md`
- `apps/agent/README.md`
- `docs/AGENT_DEVELOPMENT.md`
- `docs/AGENT_W4_DELIVERY.md`
- `docs/AGENT_W4_VALIDATION.md`

<a id="agent-w4-delivery--本机演示与配置产物逐文件不提交"></a>

### 本机演示与配置产物：逐文件不提交

下表全部不暂存、不推送，没有建议提交。具体资源文件属于“本机演示不提交”；JSON证据、截图、临时日志和清单属于“配置产物不提交”。路径是worktree实际相对路径。

| 实际相对路径                                                                          | 用途／分类                                       | 依赖与缺席影响                                                | 验证                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- | ----------------------- |
| `.local/agent-w4-demo/README.md`                                                      | 本机启动步骤与具体验收输入／本机演示不提交       | 仅显式演示依赖；默认入口/通用检查不依赖                       | 本机步骤核对            |
| `.local/agent-w4-demo/SKILL.md`                                                       | 固定Skill正文／本机演示不提交                    | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/browser-login.mjs`                                              | 本机浏览器身份辅助（不输出凭据）／本机演示不提交 | 仅显式演示依赖；默认入口/通用检查不依赖                       | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/data.json`                                                      | 合成人员和规则／本机演示不提交                   | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/demo-tool.mjs`                                                  | 具体只读演示工具实现／本机演示不提交             | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/demo.test.mjs`                                                  | 具体演示4项测试／本机演示不提交                  | 仅显式演示依赖；默认入口/通用检查不依赖                       | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/evidence/19cae725-2b61-4ab9-8ec5-bd78f3c7d30c-final-build.json` | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/530f1148-f9de-40f6-a756-a776ef40cce0-completed.json`   | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/530f1148-f9de-40f6-a756-a776ef40cce0-followup.json`    | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/530f1148-f9de-40f6-a756-a776ef40cce0-ordinary.json`    | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/530f1148-f9de-40f6-a756-a776ef40cce0-reconnected.json` | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/530f1148-f9de-40f6-a756-a776ef40cce0.json`             | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/547c1bf7-2620-496e-b85a-780db34fd389-reconnected.json` | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/547c1bf7-2620-496e-b85a-780db34fd389-refreshed.json`   | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/547c1bf7-2620-496e-b85a-780db34fd389-stopped.json`     | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/load.mjs`                                                       | 固定路径受控读取和装配／本机演示不提交           | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/manifest.json`                                                  | 预期版本和资源摘要／本机演示不提交               | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/output/playwright/cli/console-2026-10-22T14-36-27-722Z.log`     | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/cli/console-2026-10-22T14-53-51-669Z.log`     | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/cli/page-2026-10-22T14-36-28-270Z.yml`        | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/cli/page-2026-10-22T14-39-08-357Z.yml`        | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/cli/page-2026-10-22T14-53-51-766Z.yml`        | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/completed.png`                                | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/disconnected.png`                             | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/final-build.png`                              | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/followup-ordinary.png`                        | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/reconnected.png`                              | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/refreshed.png`                                | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/running.png`                                  | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/stopped.png`                                  | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/switched-dark.png`                            | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/prompt.md`                                                      | 演示系统提示词／本机演示不提交                   | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/record.mjs`                                                     | 公开安全快照只读验收脚本／本机演示不提交         | 仅显式演示依赖；默认入口/通用检查不依赖                       | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/start.mjs`                                                      | 显式本机服务入口／本机演示不提交                 | 仅显式演示依赖；默认入口/通用检查不依赖                       | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/verification/build-artifacts.json`                              | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/content-audit-script.mjs`                          | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/content-audit.json`                                | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/delivery-files.json`                               | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/FILES.json`                    | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/FINAL_REPORT.md`               | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/GENERIC_FILES.json`            | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/INITIAL_REPORT.md`             | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/default-start-smoke.json`      | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/final-source-comparison.json`  | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/format-only-comparison.json`   | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/incremental-checks.json`       | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/initial-checks.json`           | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/isolated-manifest.json`        | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |

构建生成文件逐文件列在本机 `.local/agent-w4-demo/verification/build-artifacts.json`，每条注明“配置产物不提交”、用途、缺席影响及生成命令；依赖安装目录不作为源码交付。原目录 `apps/agent/.env` 未复制、未改动且不提交；缺席时默认健康可启动，真实聊天须另行显式配置。`commit-policy.json` 在原目录及worktree均缺席，忽略规则有效，没有创建或暂存它。

<a id="agent-w4-delivery--未修改但必须说明的配套文件"></a>

### 未修改但必须说明的配套文件

| 文件                                                                                                    | 状态与处理                                                            |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `package.json`、`apps/agent/package.json`、`apps/agent-web/package.json`、其余包清单及 `pnpm-lock.yaml` | 全部未改；共9份清单，锁文件来源检查，无需提交；3个Pi SDK仍精确1.3.0。 |
| `apps/agent-web/upstream/pi-web/LICENSE`                                                                | 原MIT许可证保留，未引入新的上游切片；SOURCE.md配套提交。              |
| `packages/shared/src/agent/contracts/sources/21-commands.openapi.json`                                  | 字节未改；不提交。                                                    |
| `scripts/generate-agent-contracts.mjs`                                                                  | 原生成器未改；103 Schema生成检查通过。                                |
| `docs/AGENT_W3_VALIDATION.md`                                                                           | 原历史证据未改；不提交。                                              |
| `apps/server/tests/exam-grading-query.test.ts`                                                          | 既有格式问题，与HEAD一致；不属于本轮，不提交或覆盖。                  |

<a id="agent-w4-delivery--仓库外本轮新增设计修订"></a>

### 仓库外本轮新增设计修订

以下路径相对 `shell_engineering相关文档/Pi接入与ShellEngineering/`，不在tyde提交中；需单独同步设计负责人。没有把完整架构规划当实现清单。

| 文件                                     | 用途／缺席影响                                         | 分类与验证                           |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| `22-Agent查询与SSE接口契约.md`           | 明确W4新增设计及兼容、展示恢复语义；缺席来源说明不完整 | 通用设计需另库提交；与实现核对       |
| `contracts/22-reads-events.openapi.json` | 外部当前22唯一设计，与repo sources字节一致             | 通用设计需另库提交；103 Schema       |
| `contracts/22-stream-example.sse`        | W4 tool.updated可靠顺序示例                            | 通用设计需另库提交；序号11/12/13核对 |
| `contracts/22-w4-契约静态核对.json`      | 本轮来源、摘要和静态检查证据；旧核对记录未覆盖         | 通用设计需另库提交；摘要一致         |

<a id="agent-w4-delivery--w5-与后续联调"></a>

### W5 与后续联调

先同步 `PiNativeState.configuration`、`NativeExecutionCapture`、`saveNativeState`、`beforeDispatch`、真实 modelRequestId／toolCallId／entry 关联、资源manifest及独立工具投影契约；详细字段见 [W4验收](#agent-w4-validation)。W5 复用同一公开契约，不依赖具体演示内容。合入后再验原生树往返、提交失败/不明、租约代次、工具结果与产品事件事务、持久预算/deadline和重启保护。

W4没有实现PostgreSQL、持久事件outbox、重启恢复、继续/重试/provide_input、正式平台身份、业务写工具、完整资源平台、真实十分钟预算调优或Electron。

<a id="agent-w4-delivery--最终检查与已有用户修改"></a>

### 最终检查与已有用户修改

启动原目录无已跟踪或未跟踪修改、无暂存；本轮没有用户业务修改需要纳入提交。原有忽略的模型与身份配置保持原位，原目录HEAD/分支最后复核见本机审计。没有对W5工作区作修改。

`check:agent-contracts`、Agent及全仓类型、156项服务端/71项前端、421项业务单测/87项核心、两项构建和全仓lint通过。全仓format:check仍仅基线业务测试文件失败；所有本轮变更格式和git diff --check通过。

真实模型共7次请求，具体演示包仅留本机；本轮临时服务/浏览器已关闭。无demo独立目录完成离线安装、检查、测试、构建与默认启动；其默认聊天使用受控回环替身，真实调用0。

内容/依赖/凭据检查保存在本机verification/content-audit.json。当前缺少本机commit-policy.json，因此指定本机词表匹配未执行，不能宣称已按该词表通过；仍执行当前文件/路径、公开依赖来源、实际凭据值及二进制可提取文本/元数据检查。没有新增私有依赖或产品二进制资源。

<a id="agent-w4-validation"></a>

原文件：`AGENT_W4_VALIDATION.md`。

<a id="agent-w4-validation--agent-w4-实现与验收记录"></a>

## Agent W4 实现与验收记录

2026-10-22—23 · 独立 worktree · 进程内存模式

<a id="agent-w4-validation--基线与交付边界"></a>

### 基线与交付边界

原目录启动时干净，分支 `feature-wfj-agnet`，HEAD `d73ea7a45693b59bbf36f5dc4eb9f509185a95d2`，包含 W3 及标题、时间、统计、配色四项优化。从该提交建立 `feature/agent-w4-tools` 和相邻 `tyde-w4` worktree；原目录未切分支，未暂存、提交、推送、合并或发布。实际执行 `nvm use 24.19.0`，确认 Node 24.19.0、pnpm 11.23.0；三个 Pi 公开 SDK 保持精确 1.3.0。

通用代码与具体演示分离：版本管理只包含受控宿主、资源接口、投影、页面及最小合成测试。具体工具、人员、规则、Skill、提示词和演示启动／验收材料均位于忽略的 `.local/agent-w4-demo/`。其他开发者仅拉取通用提交不能复现完整演示；默认入口、共享包、前端、构建及通用测试不依赖演示包。

仍仅开放 `business_query` 的 `start_task` 和 `stop_attempt`；停止／失败的未完成目标不能用新 Task 绕过。不增加继续、重试、provide_input、JSONL、数据库表、迁移、业务写接口或 Electron 能力。原 W2／[W3 证据](#agent-w3-validation)不改写。

<a id="agent-w4-validation--两项缺口与实际机制"></a>

### 两项缺口与实际机制

原 `OperationSummary`／`operation.updated` 表示业务确认事实，不能承载只读工具生命周期。W4 **本轮新增设计**为独立 `ToolExecutionSummary` 和 `tool.updated`；只读演示始终 `operations=[]`。21 源未改，22 明确升为 `1.2.0-w4-design`，通过现有生成器得到 103 Schema。来源、摘要和唯一源规则见 [共享契约 README](../../packages/shared/src/agent/contracts/README.md)。外部当前 22 文档／JSON／SSE 追加 W4 标记，原历史核对记录保留，未把其他架构规划改写为实现清单。

工具投影含 conversation／task／attempt、宿主模型请求 ID、真实 tool_call_id、名称、四态、实体版本、起止时间、演示／来源标识、审核后的输入／结果摘要、不透明结果 UUID 和安全错误。完整原生参数、结果、条目关联、服务端路径、思考和 SDK 事件不公开。内部 UUID 关联原生调用及结果 entry。快照、消息历史、任务和结果详情返回关联数组，可靠事件沿现有连续游标冻结、补读及背压路径。终态不可回退或改写，调用身份不可换绑，迟到事件不恢复执行；未知可靠事件继续失败关闭。

公开 `schema_version=1` 保持，读取数组可选以接受旧冻结读取；新服务实际总返回数组。新事件需要 Agent 两端配套升级，旧严格客户端无法消费新事件时仍按原规则停止，不能声称无条件向后兼容。没有工具执行 HTTP 入口或新产品命令。

原 `getSkills=[]`、`expandPromptTemplates:false` 确实不会激活 Skill。实际采用 **宿主显式预加载**：`freezePiResources` 校验固定文本、版本和预期 SHA-256，把完整 Skill 正文放入真实 system prompt。固定 Pi 1.3.0 的隔离实验检查每轮真实请求载荷，证明正文在上下文中，并引导工具调用；原生发现仍关闭，不宣称原生自动发现／按需读取验通。普通问答不强制工具调用。

加载顺序为提示词、Skill、非提示词资产；manifest 记录每份资源版本／摘要、工具 schema 摘要和完整声明摘要，整体再取摘要。具体执行器代码和数据由部署资产摘要覆盖，不以函数源码代替制品身份。只接受受控装配器的冻结产物，不扫描环境目录；配置缺失、摘要不符明确失败。工具和资源按 Pi Session 固定。`PiNativeState.configuration` 是额外的宿主捕获信封：记录不含凭据的模型配置、提示词摘要、资源 manifest 及工具声明；原生 header／entries／leafId 保留完整形态。

<a id="agent-w4-validation--分阶段隔离验证"></a>

### 分阶段隔离验证

| 阶段                   | 实际覆盖与结果                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 固定资源与 Pi 兼容   | 15 项新增 Pi 测试与原 25 项 Pi／13 项传输回归：Skill 全文进入真实 SDK 请求；缺失／摘要异常／伪造资源拒绝，部署资产摘要，禁止用户目录资源混入，普通问答零工具                                                                          |
| B 真实 SDK 工具循环    | 模型替身经真实 Pi 工具循环，原生调用 → 执行 → 原生 toolResult → 下一模型使用实际结果；模型请求／HTTP／usage／调用 ID 一致；未知字段、类型、枚举、范围、重复真实调用标识拒绝                                                           |
| C 契约／内存 API／页面 | 103 Schema、中文 Swagger 与示例同源；5 项新增运行时工具集成；快照／历史／任务／结果读取、私有归属、命令重放、连续冻结事件、原生结果保存及安全投影；前端共 71 项                                                                       |
| D 故障与竞态           | 工具前／工具中／保存等待停止，AbortSignal、非协作迟到结果、局部超时、deadline、预算首因、N 与 N+1、重复授权、保存／最终派发门禁失败；停止／失败锁定未完成目标。快照订阅竞态、重复／缺口、旧回包／旧订阅、工具终态换绑及文字收敛均覆盖 |
| 本机演示包             | 4 项独立检查：固定 Skill／数据／代码摘要、严格输入、真实只读返回与空结果、执行前／中取消；仅本机运行，不进入通用测试依赖                                                                                                              |

参数在模型协议层不合法时，传输以 `MAAS_TOOL_ARGUMENTS_INVALID` 失败关闭，工具授权和执行均为 0；没有形成合法原生调用时不伪造工具过程。工具实际执行失败则记录 failed，局部超时为 timeout；用户停止／预算取消分别标 cancelled／budget_exceeded。工具异常会锁住 Pi 会话，本轮没有把它当作可恢复错误。

每回合至多一个工具，顺序执行，不启动隐藏模型或并行工具。Attempt 内授权先预占、失败不退，真实 ID 去重；实际执行前以及异步保存后再次检查停止、deadline 和资格。工具局部时限有界，Attempt deadline 由统一预算信号负责，避免同刻局部计时器抢先误判。工具结果后的保存等待确实被固定 SDK 逐一 await，阻断下一轮模型；停止后的结果捕获不授予派发资格。

<a id="agent-w4-validation--无演示包独立环境"></a>

### 无演示包独立环境

从 HEAD `git archive` 加 31 个通用源码／测试／契约文件覆盖构造 `/private/tmp/tyde-w4-generic-alk00ygl`，未创建提交，不携带 `.local`、实际 `.env`、依赖目录或构建产物。离线 frozen install 显式复用内容寻址缓存，878 包复用、0 下载；没有 `.git`，prepare 按既有逻辑跳过 hook 安装。最终 31／31 SHA-256 与 worktree 一致；配置捕获元数据最后增补后已同步两文件并复验。

契约、Agent 类型、156／156 服务端测试、71／71 前端测试、两项构建通过。默认新构建入口 `dist/main.js` 直接启动，使用隔离回环模型替身完成两轮普通聊天，真实 HTTP 请求携带原生上下文；工具声明、工具过程和 Operation 均为空。重复读取不执行，标题／时间／统计保留。真实模型调用 0。完整报告与文件 SHA 在该目录旁 `-evidence/REPORT.md`、`-manifest.json`、`-evidence/final-source-comparison.json`；属于本机验证产物，不提交。

<a id="agent-w4-validation--真实模型与浏览器"></a>

### 真实模型与浏览器

页面使用已构建 Vite 预览，经 3103 → 3102 → 原目录已有服务端 DeepSeek 配置。没有换模型、URL、鉴权或放宽结束／参数／用量校验。原 `.env` 只由进程读取，不复制到 worktree，不输出凭据；浏览器只获得既有产品身份，不获得模型 Key。真实页面没有加载测试夹具。

首轮相关问题实际调用工具并使用两条真实合成返回值，最终回答明确演示身份；Attempt 为 2 次模型授权／1 次工具授权。连续追问正确回忆工具上下文，1／0；普通问题直接回答，1／0。另一个会话在真实工具等待期间从页面停止，运行中 → 已取消、Attempt stopped、1／1，无最终 Result 或下一轮模型。两会话切换、深色、刷新重验身份、代理断线和重连恢复原工具过程及文字，停止会话 head=13／messages=2，完成会话 head=26／messages=6 不变。

最后补充不含凭据的配置捕获元数据后，最终构建又以一个独立短工具问题复验通过（2／1）。全程真实模型共 **7 次请求**，工具授权共 **3 次**（2 成功、1 取消）。首次后端尚未就绪造成代理拒连，页面如实显示创建未确认；待健康检查通过，先刷新列表核实为空再创建，没有发送模型或静默重放。

真实证据只保留在本机包的 `evidence/` 和 `output/playwright/`，包含实际公开调用标识、结果引用、逐次快照和截图；这些资料不能替代隔离故障测试。浏览器自动化首次在新建会话 HTTP 尚未完成时填入草稿，后续被正常切换清空，没有发送模型；等待创建完成后重做停止验收已通过，不计为真实调用或产品停止失败。

<a id="agent-w4-validation--检查结果"></a>

### 检查结果

| 命令                                       | 结果                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm check:agent-contracts`               | 通过，103 Schema／2 源                                                              |
| `pnpm typecheck:agent`                     | 通过                                                                                |
| `pnpm test:agent`                          | 服务端 156／156，前端 71／71                                                        |
| `pnpm build:agent`、`pnpm build:agent-web` | 通过；前端保留既有 >500kB 包体提醒                                                  |
| `pnpm typecheck`                           | 全仓通过；生成 Prisma 客户端，没有连接或迁移数据库                                  |
| `pnpm test`                                | 39 文件、421／421；首次与 Prisma 生成并行造成未生成类型失败，待生成完成顺序复跑通过 |
| `pnpm test:core`                           | 87／87                                                                              |

启动时重新核对全仓格式，仍只有 `apps/server/tests/exam-grading-query.test.ts` 既有格式问题，与 HEAD 一致，未覆盖。最终 lint、变更格式、全仓格式及内容检查详见交付清单；不把既有失败记为通过。

<a id="agent-w4-validation--w5-先同步的接口与合并后联调"></a>

### W5 先同步的接口与合并后联调

| 接口／数据                 | W4 语义与 W5 接入点                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PiNativeState`            | 完整 header／entries／leafId，加可选内部 configuration；旧测试捕获可无 metadata，真实新 Session 总提供。不得用产品文字重建 Pi                                                 |
| `NativeExecutionCapture`   | conversation／task／attempt、phase、modelRequestId、toolCallId、capturedAt、完整 state；内存按 Attempt 冻结最新完整捕获，完整 entries 包含之前原生结果                        |
| `saveNativeState(capture)` | before_model／after_assistant／before_tool／after_tool 可等待。拒绝锁住会话并阻断后续；W4 未把这个回调实现成数据库事务                                                        |
| `beforeDispatch(dispatch)` | 保存后、模型／工具实际派发前校验 W5 lease 等资格；await 后 W4 再复检 current 和预算。不得在回调中私自执行模型或工具                                                           |
| 调用／结果关联             | modelRequestId 在派发前生成并用于授权、传输和原生 usage；toolCallId 来自 Pi，关联 sourceNativeEntryId／resultNativeEntryId。公开 result_ref 是内部映射 UUID，无另一个执行入口 |
| 终态／迟到结果             | running → succeeded／failed／cancelled；终态不可改写。保存迟到结果与接受成功分开；已撤销执行不能继续。完整 capture 不代表已持久交付                                           |
| 配置／资源                 | configuration 和 manifest 有版本／内容摘要，不含凭据；W5 存储／恢复须校验同一兼容配置，不能依赖本机演示内容                                                                   |
| 产品事件                   | tool.updated 与原产品事件共用连续序号、冻结载荷与授权补读；W5 统一事务内写投影和可靠事件，不维护另一套公开定义                                                                |

W5 合入后需联调：原生树往返、工具调用前提交失败、工具结果保存失败、提交不明核实、执行代次／租约失效、原生结果与产品事件原子收敛、持久授权／deadline、重启后的旧执行保护。继续／重试、正式恢复和 Electron 属于后续阶段。停止不能回滚未来真实业务效果；本轮只读演示没有业务 Operation。

W4 本轮未实现 PostgreSQL、持久 outbox、服务重启恢复、完整资源制品平台、正式平台鉴权、业务工具、真实十分钟预算调优或 Electron。工具失败及空结果、预算极限主要由隔离测试验证，没有用额外真实模型请求穷举故障。

<a id="agent-w4-validation--最终复核与提交前阻塞"></a>

### 最终复核与提交前阻塞

按 code-review 的 Standards／Spec 两轴独立只读复核：Standards 无新增硬规则或需报告的 smell；Spec 无高置信度功能偏差或范围扩张，但保留 1 项 P2 验收缺口：两个已知工作区及已存在的 W5 worktree 都没有本机 `commit-policy.json`，无法执行用户维护的指定词表匹配。不能将该项记为全部安全检查通过；提交前需恢复可信本机词表再复扫，不自行编造词表、提交或发布。

最终扫描覆盖 451 个当前仓库文件、73 个构建文件、48 个本机演示／验证文件和 13 个二进制（含原图标及本轮本机截图）的可提取文本／元数据；实际凭据匹配为 0，9 份依赖清单与锁文件未变，显式下载地址均为已知公开来源。全仓 lint、本轮 37 文件格式及 diff 检查通过；全仓格式仍仅原业务测试文件失败。原目录最后复核仍为干净 `feature-wfj-agnet`／d73ea7a，W5 worktree 保留，本轮临时 3102／3103 无监听。

<a id="agent-w4-w5-delivery"></a>

原文件：`AGENT_W4_W5_DELIVERY.md`。

<a id="agent-w4-w5-delivery--agent-w4w5-本轮交付清单"></a>

## Agent W4／W5 本轮交付清单

2026-10-23 · 合并基线 `51a863e` · `integration/agent-w4-w5`

<a id="agent-w4-w5-delivery--范围与当前结果"></a>

### 范围与当前结果

本轮开始时基线工作区干净，没有需要归入本轮的既有用户修改。用户已完成 W4／W5 合并并授权联调；原 9 处冲突与 23 项接口接入已在合并提交中，不把它们再列为本轮新开发。本轮修改 2 个源码、4 个配套测试、1 个运行清单，并维护下列 6 个文档；没有自行暂存、提交、推送、合并或发布应用。

工程检查、受控 SDK／专用 PG、无演示独立目录与真实模型页面分别登记在 [联合记录](#agent-w4-w5-integration)。真实工具、已有结果追问、普通问题、工具中停止、刷新／切换及重启重连已通过；无演示默认 PG 普通聊天通过真实产品 HTTP，不声称 clean 页面浏览器验通。实际 7 个 Task、9 次模型／3 次工具授权，工具 2 成功／1 取消。公开继续／重试／补充、业务写工具、多实例和 Electron 不在本轮交付范围。

<a id="agent-w4-w5-delivery--本轮通用文件配套提交"></a>

### 本轮通用文件：配套提交

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

<a id="agent-w4-w5-delivery--契约依赖与来源本轮没有新增修改"></a>

### 契约、依赖与来源：本轮没有新增修改

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

<a id="agent-w4-w5-delivery--本机演示文件全部不提交"></a>

### 本机演示文件：全部不提交

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

<a id="agent-w4-w5-delivery--本机数据库与教学材料全部不提交"></a>

### 本机数据库与教学材料：全部不提交

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

<a id="agent-w4-w5-delivery--本机联合证据逐文件不提交"></a>

### 本机联合证据：逐文件不提交

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

<a id="agent-w4-w5-delivery--合入建议与后续边界"></a>

### 合入建议与后续边界

A 的通用修复可配套独立合入已有 W4／W5 合并基线；B 随后的说明提交不引入运行依赖。W5 需要保留并继续维护同一工具调用身份、可等待原生保存、一次性派发、工具过程／outbox 事务与资源快照接口，不另造公开工具 DTO。

只有 W4 的具体 Skill／人员／规则／演示执行器与本机部署工具留在 `.local`；W5 不依赖这些内容运行。后续源码或固定资源变更后重新生成运行身份、发布新快照，再复验旧 head 兼容与单进程启动。

当前遗留：全仓格式检查的既有业务测试文件。无演示默认聊天已走真实产品 HTTP，未做默认 clean 页面浏览器验收。完整 M3／W6、公开继续／重试／补充、业务写工具、多实例／跨主机恢复与 Electron 仍未交付。

最终内容检查覆盖 518 个仓库文件和 50 份本机文本材料：受限内容及已知本机凭据均无泄漏命中；4 个已有图标二进制未改，提取文本／元数据无命中，两份 PNG 已目视检查。无新增外部依赖或来源复制，package／lock／许可记录未变；锁文件下载地址为既有公开来源。没有暂存、提交或推送。

<a id="agent-w4-w5-integration"></a>

原文件：`AGENT_W4_W5_INTEGRATION.md`。

<a id="agent-w4-w5-integration--agent-w4w5-合流记录"></a>

## Agent W4／W5 合流记录

2026-10-23 · `integration/agent-w4-w5` · 用户确认后的联合验证进行中

<a id="agent-w4-w5-integration--本轮范围与验证状态"></a>

### 本轮范围与验证状态

本轮处理用户已经启动的 `feature/agent-w5-persistence` 合并，保留 W4 可信工具／Skill、独立工具过程与页面追溯，同时保留 W5 PostgreSQL、完整原生版本、持久命令／outbox／预算及单机隔离恢复。业务最新 07 验收与 08 入口安排保留，业务 Agent 继续 mock；不修改业务接口、Prisma、业务数据库或业务迁移。

用户最初要求冲突解决后先确认再测试，静态阶段已遵守。用户随后完成合并提交 `51a863e` 并确认开始联调，本轮从干净工作区执行实际检查、必要修复与受控／真实验证。下文的冲突期安排保留为历史，当前结果以末尾“用户确认后的实际验证”与 [本轮交付清单](#agent-w4-w5-delivery) 为准；本轮不自行暂存、提交、推送或发布应用。

[W4 验收记录](#agent-w4-validation)和[W5 验收记录](#agent-w5-validation)保留各自独立分支的真实证据；包括既有工具调用、PG 故障、重启追问与真实 600000ms 计时，均不能转记为合并后通过。新联合证据在本记录单独累计，不据此宣称未执行场景或完整 M3／W6 已通过。

<a id="agent-w4-w5-integration--冲突处理原则"></a>

### 冲突处理原则

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

<a id="agent-w4-w5-integration--四项接口对接"></a>

### 四项接口对接

四项工作已随合并接入；本轮在同一代码上进行类型、SDK／PG 与真实页面验证，结果分项记录在末尾。

| 接口                 | 合流要求与静态核对点                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可信工具／Skill 装配 | PG 宿主使用 `createApp(config, { deployment })`，从 `deployment.resources` 向实际 Pi Session 注入同一冻结资源，并把匹配的 `toolManifest`／`resourceManifestHash` 交给 `AgentPostgresRuntime`；显式 memory 模式可只传 `resources`。PG 启用资源必须提供 `TrustedPiDeployment`。`storage/pi-deployment.ts` 的创建／准备／发布适配器连接固定成员、代码身份及数据库规范化资源摘要。默认启动不扫描 `.local`、用户目录或加载演示包 |
| 一次性派发许可       | `beforeTool` 保存原生 assistant 并授权，`checkToolEligibility` 纯检查可重复；running 投影等待前后复检，`beforeToolDispatch` 真正执行前仅消费一次持久许可。`afterTool` 保存原生 toolResult 后等待终态投影。已用授权失败不退，停止后不再派发                                                                                                                                                                                  |
| 工具过程持久化       | 新增 Agent `0002` 的 `agent_tool_executions` 承载审核后的公开投影，与冻结的 `tool.updated` 同事务提交。工具身份关联真实模型请求 ID、Pi tool_call_id 及 source/result native entry；快照、历史、任务／结果读取与补读使用同一投影。终态和迟到结果不能恢复旧执行，只读工具不生成 Operation                                                                                                                                     |
| 执行配置身份         | `createTrustedPiDeployment`／`prepareTrustedPiDeployment`／`publishTrustedPiDeploymentSnapshot` 核对固定资源与实际成员字节，使用数据库规范化的 `resourceManifestHash`；执行快照 `tool_manifest.host_resources` 保存完整 W4 manifest。生成新的运行清单与新快照，不修改旧快照，HTTP 不自动发布                                                                                                                                |

完整原生 header／entries／leafId 和提交关联仍由 W5 原生仓储负责；公开工具投影不透传原始参数、完整结果、思考、服务端路径或凭据。原生数据捕获、数据库提交、公开终态与实际执行资格分别核对，数据库失败不能伪造成功。

<a id="agent-w4-w5-integration--配置与本机演示边界"></a>

### 配置与本机演示边界

W4 具体工具、Skill、合成人员／规则与专用启动材料仍只位于忽略的 `.local/agent-w4-demo/`，不随合并或通用提交复制。通用源码、shared、默认启动、构建和测试不依赖本机包；仅拉取通用代码不能直接复现完整演示。Skill 使用 `host-preloaded-system-prompt`，完整可信正文进入实际 system prompt；原生自动发现、read／bash 和目录扫描仍关闭。

W5 默认 `AGENT_STORAGE_MODE=postgres`，使用 Agent 自有 PostgreSQL 18 及独立迁移／发布／运行账号；显式开发 `memory` 保留 W3／W4 进程内行为，PG 错误不回退内存。合流后需要重新生成 source／compiled 运行清单、应用 Agent 独立 `0002` 迁移，并用相同资源装配发布对应新执行快照；冲突阶段没有执行生成、迁移或发布；用户确认后已生成新清单、应用 `0001`／`0002` 并发布匹配快照，实际身份见末尾。默认 `publish:agent-config` 只发布默认无工具配置，启用资源须使用可信部署适配器。旧任务仍绑定旧快照，加载旧 head 时比较 `model_config`、`tool_manifest`、资源摘要与 `execution_policy`，不能强换为新工具资源或新 Session 绕过不兼容。默认提示词已与旧 W5 内容静态核对一致；自定义配置缺乏一致性证据时拒绝加载，不据此宣称旧历史联合恢复已经通过。原 W4 本机启动入口不直接适用 PG；本机联合入口需要显式创建资源和 `TrustedPiDeployment` 并使用同一适配器发布／启动，不允许从前端指定模块路径或自动发现。

<a id="agent-w4-w5-integration--本机联合入口与来源"></a>

#### 本机联合入口与来源

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

<a id="agent-w4-w5-integration--新增实现与回归源码的状态"></a>

#### 新增实现与回归源码的状态

本轮新增通用源码 `apps/agent/src/storage/pi-deployment.ts` 与 `apps/agent/src/storage/tool-executions.ts`，分别承接可信资源部署／发布和工具过程持久投影；Agent `0002` 迁移提供 `agent_tool_executions` 载体。新增回归源码 `apps/agent/tests/pi-deployment.test.ts`、`apps/agent/tests/storage-tool-executions.test.ts`，并增强 execution-config、Pi 与 tool-loop 相关测试。源码已合流不代表对应断言已经执行；这些合并接口的联合检查已在用户确认后执行；具体通过、跳过和基线格式失败见末尾，不将原分支历史结果当作本轮执行。

<a id="agent-w4-w5-integration--本轮接口追加文件清单"></a>

### 本轮接口追加文件清单

以下保留原合并阶段相对自动合入结果的 23 项接口调整，已进入用户完成的合并提交；前文 9 个冲突文件不重复列出。表内“未测”是冲突静态阶段的当时记录，当前联合结果见末尾。本轮新修复及建议提交范围单独列在 [交付清单](#agent-w4-w5-delivery)，不把全部已合入文件重复列为新增改动。

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

<a id="agent-w4-w5-integration--合并前提交维护与原覆盖清单历史"></a>

### 合并前提交维护与原覆盖清单（历史）

以下保留用户完成 `51a863e` 前的维护经过；当时未开展功能联调，后续用户已确认执行。原暂存脚本中的 HEAD／MERGE_HEAD 约束不适用于当前已合并状态，不能再次运行旧脚本作为本轮提交入口。

<a id="agent-w4-w5-integration--提交校验维护补充"></a>

#### 提交校验维护补充

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

<a id="agent-w4-w5-integration--用户确认后的实际验证"></a>

### 用户确认后的实际验证

<a id="agent-w4-w5-integration--工程与隔离检查"></a>

#### 工程与隔离检查

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

<a id="agent-w4-w5-integration--本机数据库与配置"></a>

#### 本机数据库与配置

独立 PG18.6 位于 `127.0.0.1:55436`；仅使用新建 Agent 联调／测试库，保留业务库与旧 W5 实例。两库已应用 `0001_agent_baseline` 与 `0002_tool_executions`，各 19 张领域表另加迁移记录表。分权账号与本机凭据仅在忽略目录保存，原模型／身份 `.env` 未改。15 项基础连接／只读 ACL／跨库与错误密码拒绝检查，以及 6 项本机目标防误连检查通过；它们不是完整 Agent 功能测试。

本机演示执行快照为 `faaec12f-6fcf-4d14-a488-adf82d8862b6`，默认无工具快照为 `2227b655-0a0c-488f-a449-abe6d7022eb6`。两者分别绑定各自固定资源身份，不能互换。旧 head 继续核对模型、工具声明、资源摘要和执行策略，不能换配置或新 Session 绕过不兼容。

同一 Agent 数据库仍只允许一个服务进程。本轮第二进程启动真实返回 `AGENT_PROCESS_ALREADY_RUNNING`；安排默认服务验证时先停演示进程，再启动默认入口，之后恢复演示。这个拒绝证据不表示已支持多实例。

<a id="agent-w4-w5-integration--真实模型与页面分项累计"></a>

#### 真实模型与页面（分项累计）

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

<a id="agent-w4-w5-integration--前端同会话快照刷新修复"></a>

### 前端同会话快照刷新修复

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

<a id="agent-w5-d1"></a>

原文件：`AGENT_W5_D1.md`。

<a id="agent-w5-d1--agent-w5-d1-核对记录"></a>

## Agent W5 D1 核对记录

2026-10-22。本文记录 W5 的目标、已核对的接入点和验证状态；不是外部设计的实现快照，也不表示 M3 或 W6 已验收。

<a id="agent-w5-d1--当前基线与差异"></a>

### 当前基线与差异

W3 已具备私有会话、问答任务、冻结命令裁决、可信身份、产品快照与 SSE、停止、进程内预算，以及服务端 URL/Key 模型适配。原实现把会话、Task、Attempt、命令、产品事件和原生 Pi 会话保存在进程内；重启后无法恢复。`AttemptBudget` 使用进程内 Set，同步预占尚不具备 PostgreSQL 的提交确认与执行权保护。W3 证据继续保留于 `AGENT_W3_VALIDATION.md`，不得用其代替 W5 数据库及重启验证。

W5 采用当前 11、13—22、24、26 号设计。正式恢复源是 PostgreSQL 的原生 header、全部 entries、原始追加顺序、active leaf 与 revision；产品聊天、日志、JSONL 均不作为 Pi 上下文来源。完整基线为 18 表、269 字段，不因当前仅启用聊天而删表。只读工具不创建业务 Operation；业务写工具仍未接入。

<a id="agent-w5-d1--w4-与-w5-共用的私有适配接口"></a>

### W4 与 W5 共用的私有适配接口

W4 负责显式只读工具、Skill、工具展示与资源版本；W5 负责捕获、提交、恢复及可靠执行门禁。W5 不依赖演示 Skill 或演示数据，不把原生测试夹具注入真实页面。

- 模型身份在 Pi 请求首次进入受控适配时生成一次：`modelRequestId`；持久预占、发送前复核及用量观察沿用该标识。
- 工具身份为 `sourceNativeEntryId`、`toolCallId`、`toolName`；来源必须是已追加并提交的完整 assistant entry，不能仅用工具名称或当前 leaf 猜测。
- `beforeModel` 等待原生提交及预算预占；`beforeModelDispatch` 再核查停止、期限、owner、generation、活动 Attempt 和 expected head。
- `beforeTool` 等待完整工具调用提交及预算预占；`beforeToolDispatch` 再复核并只消费一次发送资格。工具结果提交后才能发起下一模型请求。
- 工具声明、执行配置和资源版本必须冻结为执行快照；不在恢复时发现本机资源或替换模型、鉴权与路由。
- 公开继续、重试、补充输入仍不开放；内部恢复夹具不等于这些产品命令交付。

本轮优先扩展 Pi 适配私有 TypeScript 接口；共享公开契约若确需变化，须记录来源后通过现有生成器维护，不手改生成文件。

<a id="agent-w5-d1--原生样本与可等待控制点"></a>

### 原生样本与可等待控制点

固定的三个 Pi SDK 均为 1.3.0，源码基线为 `71023aec1546d6d677a65669c5665c0927ce0dd0`。W3 使用 `SessionManager.inMemory`，显式关闭自动压缩、自动重试、缓存预热、资源自动发现、未受控辅助模型及嵌套调用。

底层 `Agent.subscribe` 的异步监听可等待，`AgentSession` 的公开事件订阅不可作为保存屏障。适配器必须在 AgentSession 已追加原生记录之后捕获冻结副本；`beforeToolCall` 与受控 `streamFn` 是模型/工具放行前可等待的复核点。普通异步日志、扩展异常或页面 SSE 不是屏障。恢复先装入同一已提交 revision 的全部原生记录，再显式恢复 leaf（包括 null），然后创建 AgentSession；加载器默认最后一条不能代替 leaf。

样本、SDK 装配追加、分支、多个根、压缩、自定义记录、仅 leaf 变化、null leaf 及工具结果的实际测试证据由 W5 原生往返测试记录。测试尚未执行的能力不得写成已经验证。

<a id="agent-w5-d1--数据库隔离与迁移边界"></a>

### 数据库隔离与迁移边界

Agent 使用独立 PostgreSQL 数据库与 `agent` schema，SQL 对象范围限定于该 schema；与 `apps/server/prisma`、业务迁移和根 `db:*` 命令分开。迁移角色、运行角色与清理权限分离；运行角色不拥有对象、无 DDL/TRUNCATE 权限。测试数据库必须明确为可清理的 Agent 专用环境，不能猜测既有连接用途。

迁移入口和 SQL 资源随 Agent 构建交付；重复迁移应幂等，失败应整事务回滚。HTTP 启动只检查兼容版本，不自动 DDL。缺少专用接库条件时仅完成可审查代码与 DDL，并明确保留真实 PostgreSQL 验证缺口。

W5 使用独立 worktree 与分支；并行端口、模型配置、身份配置和测试连接分开。被忽略的 `.env` 不由 worktree 自动携带，不输出或覆盖凭据，数据库故障不回退内存。

<a id="agent-w5-d1--事务与可靠放行"></a>

### 事务与可靠放行

短事务统一按会话、任务、Pi 会话、Attempt 顺序取得协调锁；不跨模型或网络等待。提交校验当前进程启动身份、generation、活动 Attempt 和预期 head。共享 PostgreSQL 不等于支持安全多实例接管；首期只允许明确单执行进程拓扑，由进程管理确认旧进程已退出后才进行隔离与恢复。页面断线、心跳超时和租约过期不能单独构成接管依据。

输入消费与真实原生输入关联、revision、head 和产品事件同事务提交。每次原生保存先冻结内容与固定 commit key/摘要；同 key 同内容返回原结果，不同内容拒绝。提交不明先查原 key，核实成功不会重新授予旧执行权。

预算随任务执行快照冻结，默认 600000 ms、12 次模型、10 次工具授权。准备、装配、恢复和保存均计时；排队不计，重启不重置。调用前在协调事务内原子预占，更新真实计数、Task 版本和冻结 `task.updated`；失败不退次数。模型 producer key 关联原 model request，工具 producer key 关联 Attempt、原生 assistant entry 和 tool call。提交不明立即请求取消，再核实原 key；未知时不得发送、再增计或换身份。重复核实只能确认消耗，不能获得新的发送许可。

第 N 次可以正常完成，需要第 N+1 次才锁存限制；到期检查优先于次数检查。首因持久锁存后只允许取消、合法原生收尾和保存，不伪造用户 stopping；完成、用户停止与限制在同一协调边界裁决。最终原生状态、Result、最终消息、Task/Attempt 结局、执行权释放与 outbox 必须原子提交后才显示 completed。

产品快照与水位来自同一一致读取，SSE 通知只唤醒数据库补读，不作为事实来源。裁剪不得越过活动 Attempt 或待核实授权的 producer key；事件重复、缺口、游标过旧、换流都按 22 号明确处理，不静默跳号。刷新、查询、SSE 重连和服务重启仅恢复展示。

<a id="agent-w5-d1--验证记录与未完成范围"></a>

### 验证记录与未完成范围

按 A 原生控制点、B 迁移和存储、C 接入、D 故障与竞争、E 浏览器重启和真实模型追问顺序记录结果。受控模型、虚拟时钟、真实时钟受控端点、真实供应商分别记录。真实 600000 ms 是单独显式入口，不加入常规快速单测，不用缩短时钟替代。

本记录建立时仍待后续阶段填写实际数据库、故障、浏览器与模型结果。W5 通过不等于完整 M3/W6、真实工具上下文跨重启或跨模型调优完成。

<a id="agent-w5-d1--预算适配阶段记录"></a>

#### 预算适配阶段记录

2026-10-22，Node.js 24.19.0，独立 PostgreSQL 18 Agent 测试实例（回环 55435）的预算集成 8 项全部通过，总 3021 ms。每组新建隔离记录，不清库，不访问业务数据库。覆盖同身份 20 并发仅一次预占/一个一次性 permit、不同身份并发不超领、模型 11/12/13、工具 9/10/11、已提交原生 assistant 的 tool call 来源、只读工具不产生 Operation、旧 owner/generation/head、预占后停止、COMMIT 成功但确认丢失、提交未知、数据库失败、活动授权事件保留，以及重复 start 不重置 deadline/首因。工具来源组初次被缺少运行版本的测试快照挡住；补齐快照后暴露并修正 NativeStore 先写 revision 后写新 leaf entry 的立即外键顺序，最终 8 项全过。

快速纯策略测试 4 项通过，覆盖 599999/600000/600001 ms、N/N+1、历史未知预算和稳定 producer key 的无歧义身份。它们验证与数据库路径共用的策略函数，不替代 PostgreSQL 事务和实际取消验证。

真实 600000 ms 的单独入口为 `apps/agent/tests/persistent-budget-real-time.ts`；应由显式慢测命令运行。该测试使用真实时钟、本机受控 HTTP 短调用、实际取消与 PostgreSQL 预算/结局，不是供应商模型或 Pi 工具循环验收。实际结果另记 W5 验收记录，不能用脚本存在代替执行证据。

真实慢测已实际通过：2026-10-22 22:29:51.877 至 22:39:52.006（Asia/Shanghai），累计 600129 ms，有限收尾 28 ms。11 次持久模型授权对应 11 次本机受控 HTTP 调用，10 次正常结束，第 11 次实际取消；数据库保存 `duration` 首因、`failed` 结局、11/0 授权计数，原 deadline 不变、无用户停止时间并释放执行权。这是“真实时钟＋受控端点”的预算适配集成证据，未接真实供应商，也不是 Pi 工具循环验收。

<a id="agent-w5-d1--进程隔离与内部恢复适配记录"></a>

#### 进程隔离与内部恢复适配记录

新增私有 `process-identity.ts` 与 `recovery.ts`。执行者身份包含本机 hostname 摘要、PID 与随机进程启动 UUID；内部适配只接受本机原 PID 的 `ESRCH`，并在 C/T/P/A 协调锁内再次复核原完整 owner、generation、head 和进程退出事实。存活/复用 PID、EPERM、其他主机、旧身份格式均不构成隔离证明。数据库锁释放、页面断线、心跳超时不作为证明。

隔离原生 worker 的真实 SIGKILL 测试 3 项全部通过（总 9064 ms）：分别在输入消费前、原生输入和消费标记已提交后强杀测试自己创建的子进程；重建 runtime 后只读查询、快照和 SSE 均没有创建 Pi 会话或新增执行。内部适配原子保留原生 head/entries 与 pending/consumed/I 关联，标记 Task/Attempt `interrupted`，保存进行中消息和任务事件，释放 P 并增加代次；重复核实不再写入，不授予模型/工具许可。未完成目标仍阻止新 Task，公开 continue/retry/provide_input 仍未开放。测试使用隔离原生 worker，不等同于完整 W6 桌面故障恢复。

已锁存预算限制的遗留 Attempt 暂不进入普通 interrupted 适配，明确阻断并要求走相应 failed 收尾核对；跨主机、多实例和 PID 命名空间的接管不在该内部单机适配范围。

<a id="agent-w5-d1--ct07-固定资源元数据闭合补齐"></a>

#### CT07 固定资源元数据闭合补齐

2026-10-23，按当前17／20号设计补齐资源基线。初版只有场景与预算检查，18表／269字段本身没有证明 S/G/F 的成员、摘要、入口及工具绑定闭合；该差异已单独识别并实际修复。

schema 1 将资源摘要规则冻结为 `resource-manifest-v1`：按 `load_order`、`member_key`（数据库 C 排序）排列完整成员数组，逐项包含 member_key、resource_kind、entry_path、load_order、options，以及对应 F 的全部稳定内容；去掉 F.id／created_at，archive_size_bytes 用十进制字符串保留 bigint 精度。对 PostgreSQL 18 规范 JSONB 文本的 UTF-8 字节取 SHA-256。空数组仍是 `[]`，因此与原有 `digest([])` 相同。此规则由发布器与延迟约束共同调用同一组 `agent.resource_manifest_*` SQL 函数；命令和 snapshot 的现有 JCS 规则不变，不把 JSONB 文本摘要称为 RFC8785。

可信内部 `publishResourceSnapshot` 在 SQL 前冻结输入、验证声明并调用显式字节／来源／可取回性 verifier；它不下载安装、扫描资源或开放页面工具。F 的 schema 1 文件清单为 `{files:[{path,size_bytes,sha256,mode,kind:'file',exports?:string[]}]}`，只允许明确的普通相对文件，拒绝越界、反斜线、控制字符、重复路径、未知 artifact 顶层字段和未经验证的链接。实际归档及文件原字节、完整依赖与来源可信性仍须由该受控 verifier 核实，元数据一致不等于已经取得或执行制品。

工具通过 `implementation.member_key/export_name` 指向 extension／business_adapter 成员入口中明确声明的 export，或用非空 `runtime_export` 匹配固定 runtime_manifest.tool_exports。Skill 入口必须是清单中的 SKILL.md；成员 options 的 `requires_members`、`requires_tools`、`requires_files` 必须全部在本快照闭合。隔离原生工具夹具另须明确 `isolated_fixture:true`，并由工具与运行时双方精确声明同一 entry／sha256；禁止 tests/../ 路径和 member/runtime 双绑定，不能借该分支进入真实页面。

S/G/F 的 INSERT／UPDATE／DELETE，以及引用快照的 T/R 变化，在事务末重新读取相关快照的最终状态，验证实际完整成员摘要、入口与实现绑定。S 与全部 G 同一发布事务冻结；普通运行无发布权限，旧配置不能追加成员。重复 hash 仍比较完整 S 正文与实际 G/F 稳定语义，重复 F 逻辑版本仍比较全部不可变内容。部分成员删除不能提交；已无引用的 S/G 整组受控清理可以闭合。实现未使用客户端 SET 标记绕过验证。

独立 PostgreSQL 18.6、Node.js 24.19.0 下，资源发布集成 14 项全部通过，包含：有序往返和同内容重放、缺 G、摘要错、缺入口、缺工具绑定、Skill 三类依赖缺失、隔离夹具 flag／路径／双绑定反例、同 F 版本异内容、同声明 snapshot hash 异正文、部分删除拒绝与整组删除、runtime export 空值、未知 artifact 字段以及字节 verifier 失败。测试曾发现固定的“坏 hash”夹具重复运行冲突，已加入独立随机 fixture_scope；复测通过且未删除既有记录。

本轮真实聊天仍为零资源成员、空工具清单；非空资源元数据发布与数据库约束通过，不表示 W4 资源装配或生产资源加载已经开放。未更新外部设计文档，未把本地实现写回外部目标契约。

<a id="agent-w5-pi"></a>

原文件：`AGENT_W5_PI.md`。

<a id="agent-w5-pi--w5-d1pi-原生状态与可等待控制点"></a>

## W5 D1：Pi 原生状态与可等待控制点

日期：2026-10-22。独立 W5 worktree 基线包含 W3 及四项聊天界面优化。本文只记录本轮 Pi 适配及受控测试证据；数据库事务、真实浏览器、真实模型和 W4 工具联调分别验收。

<a id="agent-w5-pi--当前实现与目标差异"></a>

### 当前实现与目标差异

W3 已使用三项精确 `1.3.0` SDK、原生 `AgentSession` 和内存 `SessionManager`，能捕获 header、完整 entries 和 leaf。W3 没有 PostgreSQL 加载、提交 revision、持久输入消费或持久执行权，原有等待接口尚无数据库实现。产品聊天和日志没有成为恢复来源。

本轮在原适配中加入 `nativeState` 加载及格式校验、独立 R0 原生状态生成、完整原生 JSON 往返和冻结的保存请求。数据库提交器通过下表接口注入；这些接口调用成功本身不代表数据库已经接入。外部 14/17/26 号设计继续作为目标，不能用本文替换其未实现边界。

<a id="agent-w5-pi--实际-sdk-控制点核对"></a>

### 实际 SDK 控制点核对

本机实际执行环境为 Node.js `24.19.0`、pnpm `11.23.0`。三项 Pi SDK 保持精确 `1.3.0`。没有修改依赖源码。

本机安装产物中，`pi-agent-core/dist/agent.js` 的 `processEvents()` 按注册顺序执行 `await listener(event, signal)`，`runAgentLoop()` 等待该函数。`AgentSession` 构造时首先注册内部 handler；内部 handler 在 `message_end` 中完成原生 `appendMessage()` 后才返回。因此，本适配在构造 `AgentSession` 后注册的 **Agent 内核 listener** 能等待真实原生追加后的保存。公开 `AgentSession.subscribe()` 的 `_emit()` 只调用 `l(event)`，不等待 Promise，且公开事件先于原生追加；它不能充当保存屏障。扩展抛错和日志也没有承担保存职责。

这一区别以本次实际安装版本的源码和未完成 Promise 阻塞测试为依据；不能泛化为任意 SDK 版本的订阅器都可等待。升级后必须重新验证。

| 实际控制点                               | 保存与放行边界                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `afterAssembly(state)`                   | 原生加载先明确设置 leaf，再创建 Agent/AgentSession；全部装配变更冻结后等待，成功前不返回可执行会话                      |
| `afterInput(state, { nativeEntryIds })`  | 内核 handler 已追加真实 user entry；用对象身份核对该 entry，直接关联其原生 ID，不按文本或时间猜测；等待后才允许模型路径 |
| `beforeModel(state, { modelRequestId })` | `streamFn` 内等待保存与持久预占，稳定 UUID 在进入门禁前产生                                                             |
| `beforeModelDispatch(identity)`          | 完成可信身份/连接准备后、`streamSimple()` 前再次核查；同一 UUID 进入真实请求头与 observation                            |
| `afterAssistant(state, message)`         | 内核已保存完整 assistant/toolCall，再追加原生用量观察；等待保存后才进入任何工具                                         |
| `beforeTool(state, toolName, identity)`  | SDK 原生 `beforeToolCall` 的可等待 hook；身份含实际 `sourceNativeEntryId`、`toolCallId`、`toolName`                     |
| `beforeToolDispatch(identity)`           | 显式宿主工具 `execute()` 前再次核查；全部工具仍按 allowlist 和完整参数校验                                              |
| `afterTool(state)`                       | 原生 toolResult 已追加；等待保存后才允许下一轮模型                                                                      |
| `prompt()` 返回后捕获                    | 宿主仍须将末尾状态、Result、最终消息、Task/Attempt 结局、释放执行权与 outbox 同事务提交，才能显示 completed             |

每个保存参数在第一次 await 前，按 Pi 原生 JSON 表达复制并深度冻结。SDK 可选 `undefined` 字段按照 Pi 自己的 JSON 序列化语义不占 wire 字段；所有 JSON 可表达的原生扩展字段保留。提交器必须再次冻结 commit_key、摘要、预期 head 和关联事实，重试复用原请求，不能重新捕获已变化的内存。

等待接口拒绝后立即 abort 当前原生循环并锁住会话；后续工具和模型不再放行。装配保存失败直接销毁会话。停止能中断尚未完成的保存等待，迟到回调不能修改 SDK 内部对象；数据库仍需校验 owner/代次/head，阻止迟到提交。PG 故障不得回退内存。

<a id="agent-w5-pi--原生样本及加载边界"></a>

### 原生样本及加载边界

实际 SDK 生成的去敏样本位于 [pi-native-v3.json](../../apps/agent/tests/fixtures/pi-native-v3.json)，生成器夹具位于 [pi-native.ts](../../apps/agent/tests/fixtures/pi-native.ts)。样本共 15 条原生记录、11 种 entry 类型、两个原生根，选中 leaf 不是最后追加记录；含普通消息、完整工具调用/结果、thinking、自定义数据和上下文消息、context edit、usage、label、session info、compaction 和 branch summary。工具只有隔离只读夹具，不装配到真实页面，也不产生 businessOperation。

样本 SHA-256：`81fbd8f6a15660ab36c2e2be20ff73efa8fd4de9ab68da3620f7eec2aca866dc`。

支持 Pi 原生格式 `3`、SDK `1.3.0`、适配运行格式 `tyde-pi-native-v1`。旧/未来格式、重复原生 ID、父链倒置/缺失、缺失 leaf、损坏引用和未知 entry 类型明确拒绝；原生自定义数据/额外字段不剥离。允许多个根、null leaf、仅 leaf 改变、compaction 自引用及原生 branch summary 的 `root` 哨兵。JSONB 调整对象键顺序不构成内容变化。

加载器只接受一次一致读取所得的固定 revision：完整 header、有序 entry 前缀和明确 leaf。使用复制数据调用 `SessionManager.inMemory()`，随后显式 `branch(savedLeaf)` 或 `resetLeaf()`，之后才创建 AgentSession。`Agent` 初始 messages 来自同一原生 projection。加载不会调用模型；运行资源和任务快照的一致性仍由宿主在创建会话前核对，资源缺失不能通过换资源或换 Session 绕过。

<a id="agent-w5-pi--d1-验证证据"></a>

### D1 验证证据

2026-10-22 执行 `node --import tsx --test apps/agent/tests/pi-session.test.ts apps/agent/tests/pi-native-state.test.ts`，最终 33 项全部通过，约 2.78 秒；变更文件 ESLint 通过。这些是实际 SDK＋受控 fetch/只读夹具，未请求真实供应商。

覆盖完整原生字段/追加顺序、分支和 null leaf、多个根、压缩/上下文变化、JSONB 键顺序、R0、版本损坏拒绝、装配失败、输入保存失败及永久锁住、未完成保存 Promise 阻断模型/工具、模型请求 UUID 贯穿派发、工具真实原生来源、重建同一 Session 后已完成会话上下文追问，以及 W3 的取消/迟到响应/用量未知等回归。它不替代 PostgreSQL 事务、崩溃和真实浏览器验证。

核对的安装产物 SHA-256：

| 产物                                           | SHA-256                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `pi-agent-core/dist/agent.js`                  | `163ad28551f1c38b8eb899a5c9dd89cd9d9005fb7dd9c4abeb008ee380e98c51` |
| `pi-agent-core/dist/agent-loop.js`             | `4d56e5352826e0dbe324eedd2b632d19867aff8844d1f010b3cdcd34069da7fb` |
| `pi-coding-agent/dist/core/agent-session.js`   | `d0b4545a5da7fe97aa699269e64e27b37ee2fb5b7985efb1c0a66fc3d1883b52` |
| `pi-coding-agent/dist/core/session-manager.js` | `046b6a1109ac3f0ed893bb85bf0648709362fa926a5da75761216cf2fcf9d926` |

<a id="agent-w5-pi--w4-协作和持久事务交接"></a>

### W4 协作和持久事务交接

W5 只维护原生保存/加载与上述门禁，不依赖演示工具包或 Skill。W4 应继续用显式宿主工具装配；不能绕过 `beforeTool`/`beforeToolDispatch` 执行额外工具或请求。嵌套工具、扩展模型调用和自动压缩当前未开放；若启用必须扩展同一门禁并重新验证。执行快照应冻结工具声明及实现/资源版本身份。只读工具保留原生调用/结果，不伪造业务操作。

存储接入时，R0 与 Conversation/Pi Session 绑定同事务；后续消费、原生 revision/head 和产品/outbox 同事务。模型和工具 HTTP 位于事务外，只有明确提交成功才能派发；确认丢失先核实原 key。运行拓扑、数据库隔离、18 表基线和迁移权限由 W5 主验收记录描述，本文没有声称这些阶段已经通过。

<a id="agent-w5-pi--w5-原生存储与只读夹具联接复验"></a>

### W5 原生存储与只读夹具联接复验

完成持久适配后，native-store.integration.ts 在独立 Agent PostgreSQL 18 测试库验证 7 项：完整原生往返/固定 revision/旧 leaf/null/多个根；同 key 并发只提交一次；摘要包含冻结 effects；旧 owner/代次/head 与跨对象拒绝；输入消费及 outbox 回滚；真实 COMMIT 成功后受控丢失确认的原 key 核实。与 SSE/终局期限竞争 2 项最终合跑 9/9 通过，约 3.59 秒。未使用 ALL DEFERRED，保持 E → R → head/Attempt → effects 的实际约束顺序。

tool-loop.integration.ts 将真实 Pi 1.3.0、PostgreSQL 和独立只读工具夹具联接，1/1 通过，总约 6.45 秒。夹具 execute 开始时查库确认完整 assistant/toolCall 已保存，tool 授权计数为 1 且冻结授权事件绑定准确 source entry/call ID；第二次受控模型 fetch 开始时查库确认完整 toolResult 已保存，model 计数为 2、tool 为 1。完成后重建 runtime，读取历史及订阅均不执行；后续问题的新 Task 保持同一 Pi Session，受控模型上下文含原工具结果，新 Attempt 独立计数。工具声明、参数、只读标记及隔离测试实现 SHA 固定到专用执行快照，整条链路 businessOperation 数量为 0。

该项采用真实 SDK＋真实 PG＋受控 fetch，夹具不会进入真实页面。它不代表 W4 的 Skill/工具包已合并，不代表真实供应商工具调用或实际 W4 工具上下文跨进程重启已验收。真实时钟 600000ms、进程终止、浏览器与供应商结果由主验收记录分别记录。

<a id="agent-w5-review"></a>

原文件：`AGENT_W5_REVIEW.md`。

<a id="agent-w5-review--w5-独立实现复核"></a>

## W5 独立实现复核

日期：2026-10-22。范围为 W5 未提交工作区中的 Pi 原生适配、原生提交器、PostgreSQL runtime、应用装配和异步 API/SSE。基线保留 W3 及四项聊天优化。仅记录能够用具体路径和测试验证的问题；不把未执行的浏览器、真实供应商或 W4 联调写成通过。

<a id="agent-w5-review--已确认并修复的问题"></a>

### 已确认并修复的问题

| 严重度 | 原问题及可复现后果                                                                                                                             | 修复和验证                                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | 原生提交先写引用新 leaf 的 revision，再写 entries，违反立即检查的 leaf FK；首次真实消息就可能整事务失败。输入消费也必须先更新命令，再插关联。  | `native-store.ts` 改为 E → R → head/Attempt → effects；无需 `SET CONSTRAINTS ALL DEFERRED`。真实 PG 原生提交 7 项复验全部通过。                                                                                                                                                    |
| P1     | 保存请求虽然冻结了 effects，事务闭包原来仍使用外部原对象；提交摘要不能可靠约束实际输入消费/终局事实。                                          | 请求在进入第一次 await 前复制并深冻；重算正文 hash；apply 使用冻结 effects。同 key 并发四次仅一次 apply/版本；同 key 变意图与沿用旧 hash 篡改均被拒绝。                                                                                                                            |
| P1     | 原生 COMMIT 确认丢失原来直接抛出，缺少原 key 核实；失败后的重新连接也不能延迟取消。                                                            | 首先同步 failClosed，再销毁连接并查询原 key/hash；旧成功只返回 revision，不产生发送许可。真实 PG 已提交后受控丢弃确认的两种测试通过，无法核实时保留原 key/hash。                                                                                                                   |
| P1     | runtime 的 transaction 原来先等待 ROLLBACK，再调用 failClosed；数据库异常且回滚悬挂时活动执行尚未取消。                                        | 取消移动到任何 rollback await 前。`runtime-failure.test.ts` 用未完成 ROLLBACK Promise 验证，此时 controller 已 aborted。该项为受控数据库替身测试。                                                                                                                                 |
| P1     | 活动 SSE 的换流/游标/历史错误原来只停止内部轮询，HTTP SSE 仍然开着，浏览器无法收到重新取基线指示。                                             | runtime 提供 onError，路由发送 resync_required/对应原因并关闭流；其他错误发送 server_retry 后关闭。真实 PG 换流测试观察到 STREAM_CHANGED，按新流重新订阅不启动 Pi。                                                                                                                |
| P1     | end 已读到期限前的 now 后，Result 插入使用较晚的真实时间；若两步间跨 deadline，delivery guard 拒绝后原实现全局 faulted，跳过可靠 failed 收尾。 | 增加 final_delivery savepoint；仅对已核实的停止/期限竞争转为同事务 stopped/failed；其他授权失败继续拒绝。测试在真实 PG 首次裁决读取后受控等待跨期限，先证实旧实现 guard_agent_delivery 失败；修复后真实 PG 终局断言全部通过，未产生 Result，Task/Attempt 为 failed，owner 已释放。 |
| P1     | 执行快照原来只有静态 runtime 标签、SDK 和 Node 主版本；Agent 源码、锁文件和实际运行产物改变时仍有相同身份。                                    | 增加运行清单生成及同步核验：精确 Node/SDK/native 格式、OS/arch、源码/迁移/shared 契约、依赖锁及三项 SDK 实际代码摘要形成不可变 release digest。source/compiled 使用相同身份，分别核验实际资源；缺失/漂移拒绝启动。定向清单与故障单测 4 项通过。                                    |

<a id="agent-w5-review--本轮证据与边界"></a>

### 本轮证据与边界

所有本记录中的实际测试命令均先显式加入 Node.js 24.19.0 的 PATH；Pi 三项 SDK 继续精确 1.3.0。未修改依赖实现，也未更换现有模型/鉴权配置。

- Pi 原生适配与样本：33 项通过，约 2.78 秒；实际 SDK＋受控 fetch/只读夹具。包括阻塞尚未完成的保存 Promise、完整原生往返、null/旧 leaf、两个根、同 Pi Session 上下文追问。详见 [Pi D1 记录](#agent-w5-pi)。
- 原生 PostgreSQL 提交：`native-store.integration.ts` 7 项通过，约 3.51 秒；删除 ALL DEFERRED 后再次 7 项全部通过。真实 PG18，唯一测试 C/P/T/A；没有清表或业务数据库操作。
- 运行清单与数据库异常取消：`runtime-manifest.test.ts`、`runtime-failure.test.ts` 共 4 项通过，约 2.92 秒；compiled 单测使用明确标注的产物夹具，完整实际 build 由主流程另验。
- 实时 SSE 与 deadline 竞争：`runtime-review.integration.ts` 的 2 项与原生 7 项最终合跑 9/9 全过，约 3.59 秒。采用真实 PG＋受控短等待，不能当成供应商验收或 600000ms 真实计时验收。

复核确认：服务初始化、查询、快照、刷新和 SSE 读取没有调度 Pi 的代码路径；公开 continue/retry/provide_input 仍拒绝；未完成目标阻止偷偷新建 Task。执行预算的旧授权核实不返回新 permit。完成状态由原生末尾、Result、消息、Task/Attempt、执行权和 outbox 同一事务决定。隔离只读工具夹具已通过真实 Pi＋PG 全链路复验（tool-loop.integration.ts 1/1，总约 6.45 秒）：调用/结果各自保存后才执行下一步，预算与准确原生来源匹配，重建 runtime 后原工具结果进入后续问题上下文，Operation 数量为 0。夹具声明和实现 SHA 进入专用快照。W4 尚未合并，该项不是实际 W4 工具/Skill 包的验收证据。

单进程数据库协调锁不是多实例安全接管证明。旧活动尝试在重启后保留未解决状态；不能因数据库连接消失就复活它。进程终止、浏览器/真实模型和 600000ms 实时时钟结果由 W5 主验收记录分别保存。本次审查没有自行提交、推送或发布。

<a id="agent-w5-review--实际数据库连接故障复验"></a>

### 实际数据库连接故障复验

database-outage.integration.ts 1/1 通过，总约 4.67 秒（测试本体约 1.47 秒）。使用真实 Pi＋真实 Agent PG18＋真实回环 HTTP 慢 SSE 受控端点；仅 pg_terminate_backend 本测试新建 runtime 的 guard PID，并以 current_database 与本测试 application_name 双重限定，没有停止 PG 服务或其他连接。

guard error 触发取消，活动 controller 已 aborted，受控端点实际收到 HTTP close，取消发生在 3 秒断言上限内；模型请求总计 1，工具 0，无 Result、completed 或伪 stopped。已提交输入保持 consumed，原生 head 可加载；原 Attempt 保持未决 running。重新创建 runtime 后只读快照、历史和 SSE 补读均不启动执行，HTTP 总计仍为 1。该证据属于实际 PG 连接故障＋受控端点，不属于真实供应商故障验收。

<a id="agent-w5-review--大历史真实-http-补读复验2026-10-23"></a>

### 大历史真实 HTTP 补读复验（2026-10-23）

event-replay.integration.ts 1/1 通过，总约 14.05 秒（测试本体约 10.59 秒）。独立空会话同一事务提交 600 条 conversation.updated 测试事件，无 Task/模型；真实回环 HTTP 客户端从 after=0 连续读取 1…600，ready.observed_head_seq 为 600，逐帧验证公开 Schema、SSE id 与 JSON stream/seq 一致。随后读取 1…128 主动断开，从 after=128 重连补齐 129…600，完整 600 个 event_id 唯一，无 slow_consumer、缺口或跳号，createSession 调用为 0。

该项验证 PG 每批最多 128 帧、内部 after 只推进实际批尾的实现，避免把尚未投递的 head 当作已补读水位。它是实际 PG＋实际 HTTP 的事件读取回归，不涉及模型、供应商或 W4 工具。

<a id="agent-w5-standards-review"></a>

原文件：`AGENT_W5_STANDARDS_REVIEW.md`。

<a id="agent-w5-standards-review--w5-standards--数据设计审查"></a>

## W5 Standards / 数据设计审查

固定点：`d73ea7a45693b59bbf36f5dc4eb9f509185a95d2`。HEAD 无新增提交；审查包括 `git diff d73ea7a` 的工作区修改，以及未跟踪的 storage/runtime/execution、DDL、测试和运行清单文件。未修改业务代码、共享契约或 DDL。

标准来源：仓库 `AGENTS.md`、`docs/API.md` 的 Swagger 标准；外部当前 17 号执行配置、20 号 DDL 和 `data-model/20-DDL索引与约束清单.md`。用户“不自行提交”优先于 implement 技能的默认提交步骤。本报告不重复已修正的 SSE、完成事务和另一审查负责的运行清单问题。

<a id="agent-w5-standards-review--初审发现与闭环"></a>

### 初审发现与闭环

1. **P2，已修复：同快照摘要未核验持久完整内容。** `apps/agent/src/storage/execution-config.ts` 的 `publishExecutionSnapshot` 对冲突直接 `DO NOTHING`，`requireExecutionSnapshot` 只按声明 hash 返回 ID；执行前同样只比声明 hash。17 号 §2.1 要求同摘要登记比较完整规范化内容、不同内容明确冲突。因此一条内容与所声明 hash 不符的既有 S 行可以被当作当前配置绑定，执行配置与持久审计事实不一致。应在发布重放、选取和执行前重算并核对完整 S 语义，不能仅信其 `snapshot_hash`。

2. **P2，已修复：配置快照缺少明确要求的固定策略与凭据身份。** 同文件 `modelExecutionConfig` 未写 API 协议、端点/预设版本及绑定端点的逻辑 `credential_ref`；`executionSnapshot.execution_policy` 仅保存 attempt_limits。17 号 §2.2 要求这些身份及压缩、重试、资源加载和能力规则固定。当前实现把这些规则隐含在进程代码与环境中，不能从 S 本身核对原配置。应记录真实受控固定值和逻辑凭据来源；密钥值仍须排除。

3. **P2，已修复：新增运行信息接口的 Swagger 错误分支缺失。** `apps/agent/src/application.ts` 的 `GET /api/agent/v1/runtime` 仅声明 200，响应对象缺中文 description，也未说明真实 401/503 错误。Node.js 24.19.0 下 `app.inject` 和生成文档核实：匿名请求返回 401 默认 Fastify 错误体，OpenAPI 只有 200。该接口位于统一 Agent 错误处理插件外。应按 `docs/API.md` 标准 §2/§5 补中文对象说明、错误 schema/示例，并明确或统一错误封装。

<a id="agent-w5-standards-review--ct07-追加审查与闭环"></a>

### CT07 追加审查与闭环

4. **P2，已修复：CT07 的非空资源成员、摘要与工具绑定闭合尚未实现。** `migrations/sql/0001/04_guards.sql` 的 G 插入仅检查与 S 同事务；`assert_integrity` 未核验 S.resource_manifest_hash 对应实际 G/F 全集、entry_path 在文件清单存在及工具实现引用闭合。20 号约束清单 CT07 明确要求“成员/摘要/工具闭合；实际字节另验”。数据负责人已独立确认没有其他 validator 覆盖。当前 W5 固定空资源 hash、执行时拒绝非空资源，可保护聊天路径，但不能据此报告完整 CT07 已覆盖。用户要求完整基线，需实现受控资源发布事务和对应事务末闭合验证；若暂时只加非空资源/未知 binding 门禁，必须明确保留此未完成项。

<a id="agent-w5-standards-review--修复复核"></a>

### 修复复核

`requireExecutionSnapshot` 现重算完整 S 语义并与声明摘要比较；发布重放和执行前均调用该核验，schema_version/scene_key 纳入摘要。模型与策略已补 API、逻辑凭据引用、端点/预设版本及禁用隐式能力的明确固定值。

新增 `tests/execution-config.test.ts` 的 4 项测试在 Node.js 24.19.0 全部通过（6145 ms）：相同完整内容返回原 ID、7 个语义字段逐项损坏拒绝、重复发布/同 hash 异内容拒绝，以及策略/凭据身份固定并排除 Key。生成 OpenAPI 与 `app.inject` 复核确认 runtime 接口现有中文响应对象说明、200/401/503 文档及对应错误示例，真实 401 序列化保留约定字段。

CT07 现增加 `resource-publication.ts` 可信发布器及 S/G/F/T/R 的延迟 I/U/D 资源闭合触发器。成员排序与稳定 F 身份采用明确版本化的 resource-manifest-v1：PG18 有序 JSONB 文本 SHA-256，publisher 与数据库共用 SQL 规范化/摘要函数，空集合兼容原摘要；命令和 snapshot 的 JCS 规则不变。具备完整成员摘要、F 文件/入口、工具 member/runtime 导出及 Skill 依赖闭合。隔离 fixture 必须显式声明、双侧完整导出一致、路径无遍历且不夹带其他绑定。

2026-10-23，Node.js 24.19.0 独立复跑资源测试 14/14（含父测试，801 ms）。另以 7 组每例回滚的原始 SQL 探针对照 TypeScript validator：合法 fixture 接受；缺 flag、缺工具侧 exports、路径遍历、歧义绑定、篡改摘要及空 runtime export 均在发布器和延迟 SQL 拒绝。重复执行测试曾暴露固定坏 S 夹具的唯一键冲突，已改为独立 fixture_scope，未清库。

四项发现均已闭环。真实制品字节、来源与可取回性仍由可信 verifier 负责；本次资源测试是明确的合成 metadata fixture，不表示 W4 资源已进入生产或跨重启工具联调完成。未为命名或模块长度等主观气味单独出具交付阻断项。

<a id="agent-w5-validation"></a>

原文件：`AGENT_W5_VALIDATION.md`。

<a id="agent-w5-validation--agent-w5-验收记录"></a>

## Agent W5 验收记录

工作于 2026-10-22 开始，跨日至 2026-10-23。仓库原工作区保持 `feature-wfj-agnet` / `d73ea7a45693b59bbf36f5dc4eb9f509185a95d2`；W5 使用其独立分支 `feature/agent-w5-persistence`，worktree 为原仓库下 `.local/worktrees/agent-w5`。该基线包含 W3 和标题预览、消息时间、次数/耗时、品牌色四项优化。没有提交、推送、合并或发布；原工作区及 W4 工作目录未改动。

<a id="agent-w5-validation--实现范围"></a>

### 实现范围

新增 Agent 自有 PostgreSQL 18 持久运行时、完整 18 表基线、迁移及版本/对象检查、完整 Pi 原生版本仓储、持久命令裁决、冻结 outbox、一致快照、预算预占/核实/一次性放行，以及明确单机进程退出证明的内部 interrupted 适配。HTTP 启动不自动 DDL、发布配置、扫描 pending 输入或启动 Attempt。数据库故障不回退内存。正常完成的末尾原生状态、Result、最终消息、Task/Attempt、执行权释放及 outbox 同事务提交。

保留三个公开 Pi SDK **1.3.0**；公开依赖固定 Kysely **0.29.7**、pg/@types/pg **8.23.1**，来源为公开 npm registry 与官方仓库。业务 Prisma、业务迁移和业务接口没有修改。现有服务端模型/身份配置仅私下复制到忽略的 worktree `.env`，不输出或提交凭据，不更换路由或鉴权。

W4 继续拥有只读演示工具、Skill 与工具展示；W5 不依赖其演示包。共享命令/读取 OpenAPI 源和 generated 文件没有变化。私有 Pi 边界、模型/工具稳定身份和 toolManifest 注入点见 [D1](#agent-w5-d1)、[Pi 记录](#agent-w5-pi)。新增本地部署信息接口 `GET /api/agent/v1/runtime` 有独立中文 Swagger、可校验示例及401/503；客户端明确展示 PG、显式 memory 或未确认模式。

<a id="agent-w5-validation--ad1真实-sdk-样本与等待控制点"></a>

### A：D1、真实 SDK 样本与等待控制点

完整 SDK 原生样本包含15条 entries、11种类型和两个原生根；覆盖普通消息、完整调用/结果、分支、压缩、上下文编辑、自定义记录、旧 leaf、null leaf 和仅 leaf 变化。加载固定同一 revision，显式恢复 leaf 后才创建 AgentSession；装配补记也等待保存。SDK 原生状态格式与运行版本校验失败时阻断，不从产品聊天、日志或 JSONL 拼上下文。

底层 `Agent.subscribe` 的 SDK 内核逐个 await 监听器；公开 AgentSession 事件订阅不等待。真实 SDK 测试用未完成 Promise 验证输入、完整工具调用、工具结果的保存屏障，以及模型/工具发送门禁。异步保存先深拷贝、冻结固定 key/摘要及 effects。完整证据和来源在 [Pi 记录](#agent-w5-pi)。

<a id="agent-w5-validation--b独立数据库迁移与往返"></a>

### B：独立数据库、迁移与往返

本轮新建 PG **18.6** 实例，仅监听回环独立端口 **55435**。`agent_w5_test` 用于隔离集成，`agent_w5_browser_final` 用于最终真实页面验收；`agent_w5_browser` 仅用于早期启动检查，未发送模型请求。它们均非业务库。连接固定 `pg_catalog,agent` search_path，不含 public。独立迁移/发布/运行权限，运行账号非owner，无 DDL/TRUNCATE/不可变历史删除/配置发布权限。

基线为18领域表、269字段、93索引、67外键；仅6条指定FK可延迟且默认立即检查。首次P/R0初始化只延迟FK17，其余正常原生提交按立即FK顺序闭合。迁移单事务、稳定连接和迁移锁；重复运行只核摘要及对象指纹。SQL随构建交付，编译入口已验证可读取5份SQL。详细权限和步骤见 [迁移说明](../../apps/agent/migrations/README.md)。

验证包括原生全字段/原追加顺序/多根/旧叶与空叶、不可变保护、旧owner/generation/head、JSON缺键即时拒绝、accepted/消费/完成事务末检查、失败DDL回滚及非owner权限。基线在专用测试库中曾刷新未发布的开发守卫及测试摘要，未清理活动计时数据；这不是已发布迁移改写或生产升级。

<a id="agent-w5-validation--c命令原生提交事件和预算接入"></a>

### C：命令、原生提交、事件和预算接入

命令沿用可信主体、归属检查与原意图规范化摘要，用户+request_key跨会话去重，原裁决持久冻结。同key同意图并发不新增执行，同key异意图冲突。原生提交同key同内容返回原revision，不同内容拒绝；成功确认丢失先取消再查原key，查到原成功不会重授旧owner或发送许可。输入消费、实际新增原生输入关联、revision/head、消费事件原子提交。

产品投影、水位及完整冻结帧同事务保存；快照按RepeatableRead一致读取，订阅按数据库水位补读，通知不是事实。缺口、换流、游标越界/过旧明确重取基线。默认不启用产品删除/裁剪，活动或待核实授权证据不得被清除。

预算随不可变Task快照冻结为600000ms、12模型/10工具授权；队列不计时，首次开始原子固定started/deadline，准备/保存计时，历史未知不填0。每次调用先原子预占、写Task版本与冻结事件，明确提交后才获得一次性本地permit；发送前再核停止、期限和资格。失败不退计数；重复确认和提交不明不重复授权。N次可正常完成，N+1才拒绝；首因锁存后取消并可靠failed，不伪造stopping。

<a id="agent-w5-validation--d并发故障与进程终止"></a>

### D：并发、故障与进程终止

- 原生提交真实PG7项：完整样本往返、同key四并发只一次apply/revision、摘要/effects冻结、旧资格/原始前缀修改拒绝、事务回滚、真实COMMIT成功后受控丢确认及原key核实。
- 持久预算真实PG8项：同身份20并发仅一次预占/permit、不同身份不超领、11/12/13及9/10/11、实际已保存tool来源、停止竞态、提交不明、数据库失败、授权保留与deadline不重置。快速策略覆盖599999/600000/600001ms。
- 新建隔离worker的真实SIGKILL：输入消费前和后分别强杀；重启查询/快照/SSE没有创建Session或调用。内部恢复要求本机原PID明确ESRCH及完整owner/generation/head匹配；保留原生/输入/预算/deadline，原子interrupted+事件+撤销代次，不提供继续授权。
- 真实PG跨deadline探针：最终裁决读取后受控等待跨期限，Result guard拒绝转为同事务failed，无Result、无假completed，释放owner；已修复保存点收尾及相应事件闭合。
- 真实Pi+PG隔离只读工具闭环：execute内确认完整调用已提交；下一model fetch内确认工具结果已提交；完成后重建runtime，后续上下文包含原工具结果；Operation数为0。夹具不进入页面，不代表W4工具/Skill已合入验收。
- 实际PG连接故障：只精准终止本测试专用guard后端；guard error立即取消，受控HTTP真实close，无额外模型/工具、Result或假completed/stopped。保留未决Attempt；重建runtime只读不执行。未停止PG服务或他人连接。

真实600000ms单独慢测于 **2026-10-22 22:29:51.877—22:39:52.006**（Asia/Shanghai）通过，实测 **600129ms**，有限收尾 **28ms**。11次持久授权/受控HTTP开始，10次完成，第11次实际取消；PG保存duration首因、failed、11/0计数、原deadline及空stop_requested_at，并释放执行权。命令显式使用Node24.19.0绝对路径。此项是**真实时钟＋受控端点**，不是供应商或Pi工具循环验收，不是跨模型调优。

<a id="agent-w5-validation--e真实浏览器与真实模型"></a>

### E：真实浏览器与真实模型

2026-10-23 使用 Playwright 实际控制 Chrome，页面端口35153、Agent端口35152、专用库`agent_w5_browser_final`；服务沿用原`.env`中的模型和开发身份，模型为`deepseek-flash`。只发送两次真实模型请求，没有工具或批量调优。身份仅经一次性回环桥接填入页面内存，未进入命令、快照或记录。

第一轮09:58:48—09:58:49在页面输入验收口令，真实模型回复“已记住”，Task/Attempt completed，1模型/0工具。实际退出PID95028并启动新进程PID95604，刷新后重新输入本机身份，原历史和completed状态恢复；刷新会话、SSE重连及读取后，数据库仍仅1个Attempt/1次模型授权/0工具。

随后用户在同一会话显式追问“刚才让你记住的验收口令是什么？只回复口令。”，第二轮10:01:02—10:01:03正确回复`W5-海岸-7049`。两个Task分别completed、各1模型/0工具，共2个Result；Conversation仍绑定原Pi Session `a1baab41-25ff-47ef-b9b1-037333a2c72d`，revision0→10，8条原生entries。没有由产品消息重建上下文。

还实际启动`dist/main.js`编译入口，并在新标签重新打开同一会话、连接身份和读取两轮历史；再次核对仍2个Attempt、2次模型授权，页面未触发额外执行。PG模式文案、标题预览、消息时间、品牌色和次数/耗时保留，无预算分母。代码源与编译版release identity一致（`sha256:bfe8ce83da865167e9553339606efac4ee1f4632674e44c8817f9a8ee339562e`），编译迁移入口读取全部5份SQL并通过独立兼容检查。

本轮结束保留独立本机预览：页面`http://127.0.0.1:35153`、编译Agent`127.0.0.1:35152`、专用PG`127.0.0.1:55435`。没有使用或终止原3102/3103上的其他进程；本机预览不属于部署或发布。数据库文件位于本worktree的`.local/agent-w5-pg`，均为本轮新建专用数据。

本机证据（均在忽略目录，不含凭据）：`.local/w5-browser-before-restart.txt`、`.local/w5-browser-after-read.txt`、`.local/w5-browser-after-follow-up.txt`、`.local/w5-browser-after-reopen.txt`，截图`.local/output/playwright/w5/first-completed.png`及`restart-context-completed.png`。这是实际供应商聊天验收；前述受控端点、真实时钟、故障和隔离工具夹具分别记录。W4未合入，不宣称真实W4工具上下文跨重启已验。W2/W3既有证据保留。

<a id="agent-w5-validation--最终工程检查"></a>

### 最终工程检查

最终检查实际使用 **Node.js 24.19.0、pnpm 11.23.0**，显式固定 PATH 并核实版本。`pnpm check:agent-contracts`、`pnpm typecheck:agent`、`pnpm typecheck` 与 `pnpm lint` 均通过。

- `pnpm test:agent`：157项，156通过、1跳过；默认无测试库URL时迁移集成跳过，不算数据库验证通过。
- Agent Web：57项全部通过。
- `pnpm test`：业务39个文件、421项全部通过。
- `pnpm test:core`：87项全部通过。
- `pnpm test:agent-db`：真实隔离PG共49项全部通过，包含600条可靠事件的大历史补读；与快速测试中的跳过项分开记录。
- `pnpm build:agent`、`pnpm build:agent-web`：均通过。Agent Web 有大于500kB的Vite chunk提示，退出码为0。

`pnpm format:check` 唯一失败是本轮未修改的基线文件 `apps/server/tests/exam-grading-query.test.ts`；对 `git show HEAD:apps/server/tests/exam-grading-query.test.ts` 的内容运行 Prettier 已确认原基线存在格式差异。W5自身变更文件全部格式检查通过，未修改无关业务文件。W5没有提交、推送、合并或发布。

早期本机沙箱listen EPERM、开发中立即FK写入顺序/资源约束差异与指定版本PATH问题已经单独识别；不把未执行的断言或跳过项算通过。长计时/Pi/独立PG子任务均已核实显式使用Node24.19.0；真实600000ms证据保留在D阶段，不重复执行或改写为供应商验收。

<a id="agent-w5-validation--限制与w6交接"></a>

### 限制与W6交接

W5不开放continue_task/retry_task/provide_input及按钮；stopped/failed/interrupted/waiting_input仍是未完成目标，不能用新Task/Pi绕过。内部新Attempt/恢复工具边界夹具不是公开继续交付。W4尚未合并，不宣称真实演示工具/Skill上下文跨重启通过。正式平台授权、Electron装配、多实例/跨主机接管、生产备份运维及26号跨模型调优不在本轮验收。

单机PID证明不适用于多主机/PID命名空间；存活或复用PID会保守阻断。数据库故障后的未决结束须先核实隔离和已提交事实，不能仅凭锁/超时改写终局。事务末守卫当前完整聚合扫描，大数据量下应做性能评估后保留全部不变量优化。默认不开放产品清理/保留策略。

受限内容检查须使用本机忽略的commit-policy.json；原仓库与文档目录未找到该词表；用户2026-10-23明确要求本轮暂不处理，故不阻塞本轮交付，也不将词表检查写成通过。不输出词表或密钥。所有新增依赖来自公开npm，源码/路径/锁文件/产物仍需最终核对。

依赖与凭据检查：公开registry配置已核对；完整Agent传递依赖树的resolved来源核查没有非公开URL，新增依赖精确固定，三个Pi版本仍为1.3.0。最终对仓库当前文件及Agent/Web/shared构建产物共583个文件（含4个既有二进制文件）做实际服务端凭据值比对，匹配为0；410个公开npm依赖解析来源中非公开来源为0，没有新增或修改二进制提交资源。本机摘要保存在`.local/w5-final-provenance.json`。受限词表按用户本轮明确约定暂不执行。技术依据同时核对 [Kysely 官方安装/类型说明](https://kysely.dev/docs/getting-started)、[pg 官方事务说明](https://node-postgres.com/features/transactions) 和 [PostgreSQL 18 约束触发器说明](https://www.postgresql.org/docs/18/sql-createtrigger.html)；实际通过结果以本地测试为准。
