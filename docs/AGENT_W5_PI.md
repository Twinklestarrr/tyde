# W5 D1：Pi 原生状态与可等待控制点

日期：2026-10-22。独立 W5 worktree 基线包含 W3 及四项聊天界面优化。本文只记录本轮 Pi 适配及受控测试证据；数据库事务、真实浏览器、真实模型和 W4 工具联调分别验收。

## 当前实现与目标差异

W3 已使用三项精确 `1.3.0` SDK、原生 `AgentSession` 和内存 `SessionManager`，能捕获 header、完整 entries 和 leaf。W3 没有 PostgreSQL 加载、提交 revision、持久输入消费或持久执行权，原有等待接口尚无数据库实现。产品聊天和日志没有成为恢复来源。

本轮在原适配中加入 `nativeState` 加载及格式校验、独立 R0 原生状态生成、完整原生 JSON 往返和冻结的保存请求。数据库提交器通过下表接口注入；这些接口调用成功本身不代表数据库已经接入。外部 14/17/26 号设计继续作为目标，不能用本文替换其未实现边界。

## 实际 SDK 控制点核对

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

## 原生样本及加载边界

实际 SDK 生成的去敏样本位于 [pi-native-v3.json](../apps/agent/tests/fixtures/pi-native-v3.json)，生成器夹具位于 [pi-native.ts](../apps/agent/tests/fixtures/pi-native.ts)。样本共 15 条原生记录、11 种 entry 类型、两个原生根，选中 leaf 不是最后追加记录；含普通消息、完整工具调用/结果、thinking、自定义数据和上下文消息、context edit、usage、label、session info、compaction 和 branch summary。工具只有隔离只读夹具，不装配到真实页面，也不产生 businessOperation。

样本 SHA-256：`81fbd8f6a15660ab36c2e2be20ff73efa8fd4de9ab68da3620f7eec2aca866dc`。

支持 Pi 原生格式 `3`、SDK `1.3.0`、适配运行格式 `tyde-pi-native-v1`。旧/未来格式、重复原生 ID、父链倒置/缺失、缺失 leaf、损坏引用和未知 entry 类型明确拒绝；原生自定义数据/额外字段不剥离。允许多个根、null leaf、仅 leaf 改变、compaction 自引用及原生 branch summary 的 `root` 哨兵。JSONB 调整对象键顺序不构成内容变化。

加载器只接受一次一致读取所得的固定 revision：完整 header、有序 entry 前缀和明确 leaf。使用复制数据调用 `SessionManager.inMemory()`，随后显式 `branch(savedLeaf)` 或 `resetLeaf()`，之后才创建 AgentSession。`Agent` 初始 messages 来自同一原生 projection。加载不会调用模型；运行资源和任务快照的一致性仍由宿主在创建会话前核对，资源缺失不能通过换资源或换 Session 绕过。

## D1 验证证据

2026-10-22 执行 `node --import tsx --test apps/agent/tests/pi-session.test.ts apps/agent/tests/pi-native-state.test.ts`，最终 33 项全部通过，约 2.78 秒；变更文件 ESLint 通过。这些是实际 SDK＋受控 fetch/只读夹具，未请求真实供应商。

覆盖完整原生字段/追加顺序、分支和 null leaf、多个根、压缩/上下文变化、JSONB 键顺序、R0、版本损坏拒绝、装配失败、输入保存失败及永久锁住、未完成保存 Promise 阻断模型/工具、模型请求 UUID 贯穿派发、工具真实原生来源、重建同一 Session 后已完成会话上下文追问，以及 W3 的取消/迟到响应/用量未知等回归。它不替代 PostgreSQL 事务、崩溃和真实浏览器验证。

核对的安装产物 SHA-256：

| 产物                                           | SHA-256                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `pi-agent-core/dist/agent.js`                  | `163ad28551f1c38b8eb899a5c9dd89cd9d9005fb7dd9c4abeb008ee380e98c51` |
| `pi-agent-core/dist/agent-loop.js`             | `4d56e5352826e0dbe324eedd2b632d19867aff8844d1f010b3cdcd34069da7fb` |
| `pi-coding-agent/dist/core/agent-session.js`   | `d0b4545a5da7fe97aa699269e64e27b37ee2fb5b7985efb1c0a66fc3d1883b52` |
| `pi-coding-agent/dist/core/session-manager.js` | `046b6a1109ac3f0ed893bb85bf0648709362fa926a5da75761216cf2fcf9d926` |

## W4 协作和持久事务交接

W5 只维护原生保存/加载与上述门禁，不依赖演示工具包或 Skill。W4 应继续用显式宿主工具装配；不能绕过 `beforeTool`/`beforeToolDispatch` 执行额外工具或请求。嵌套工具、扩展模型调用和自动压缩当前未开放；若启用必须扩展同一门禁并重新验证。执行快照应冻结工具声明及实现/资源版本身份。只读工具保留原生调用/结果，不伪造业务操作。

存储接入时，R0 与 Conversation/Pi Session 绑定同事务；后续消费、原生 revision/head 和产品/outbox 同事务。模型和工具 HTTP 位于事务外，只有明确提交成功才能派发；确认丢失先核实原 key。运行拓扑、数据库隔离、18 表基线和迁移权限由 W5 主验收记录描述，本文没有声称这些阶段已经通过。

## W5 原生存储与只读夹具联接复验

完成持久适配后，native-store.integration.ts 在独立 Agent PostgreSQL 18 测试库验证 7 项：完整原生往返/固定 revision/旧 leaf/null/多个根；同 key 并发只提交一次；摘要包含冻结 effects；旧 owner/代次/head 与跨对象拒绝；输入消费及 outbox 回滚；真实 COMMIT 成功后受控丢失确认的原 key 核实。与 SSE/终局期限竞争 2 项最终合跑 9/9 通过，约 3.59 秒。未使用 ALL DEFERRED，保持 E → R → head/Attempt → effects 的实际约束顺序。

tool-loop.integration.ts 将真实 Pi 1.3.0、PostgreSQL 和独立只读工具夹具联接，1/1 通过，总约 6.45 秒。夹具 execute 开始时查库确认完整 assistant/toolCall 已保存，tool 授权计数为 1 且冻结授权事件绑定准确 source entry/call ID；第二次受控模型 fetch 开始时查库确认完整 toolResult 已保存，model 计数为 2、tool 为 1。完成后重建 runtime，读取历史及订阅均不执行；后续问题的新 Task 保持同一 Pi Session，受控模型上下文含原工具结果，新 Attempt 独立计数。工具声明、参数、只读标记及隔离测试实现 SHA 固定到专用执行快照，整条链路 businessOperation 数量为 0。

该项采用真实 SDK＋真实 PG＋受控 fetch，夹具不会进入真实页面。它不代表 W4 的 Skill/工具包已合并，不代表真实供应商工具调用或实际 W4 工具上下文跨进程重启已验收。真实时钟 600000ms、进程终止、浏览器与供应商结果由主验收记录分别记录。
