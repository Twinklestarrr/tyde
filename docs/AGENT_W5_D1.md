# Agent W5 D1 核对记录

2026-10-22。本文记录 W5 的目标、已核对的接入点和验证状态；不是外部设计的实现快照，也不表示 M3 或 W6 已验收。

## 当前基线与差异

W3 已具备私有会话、问答任务、冻结命令裁决、可信身份、产品快照与 SSE、停止、进程内预算，以及服务端 URL/Key 模型适配。原实现把会话、Task、Attempt、命令、产品事件和原生 Pi 会话保存在进程内；重启后无法恢复。`AttemptBudget` 使用进程内 Set，同步预占尚不具备 PostgreSQL 的提交确认与执行权保护。W3 证据继续保留于 `AGENT_W3_VALIDATION.md`，不得用其代替 W5 数据库及重启验证。

W5 采用当前 11、13—22、24、26 号设计。正式恢复源是 PostgreSQL 的原生 header、全部 entries、原始追加顺序、active leaf 与 revision；产品聊天、日志、JSONL 均不作为 Pi 上下文来源。完整基线为 18 表、269 字段，不因当前仅启用聊天而删表。只读工具不创建业务 Operation；业务写工具仍未接入。

## W4 与 W5 共用的私有适配接口

W4 负责显式只读工具、Skill、工具展示与资源版本；W5 负责捕获、提交、恢复及可靠执行门禁。W5 不依赖演示 Skill 或演示数据，不把原生测试夹具注入真实页面。

- 模型身份在 Pi 请求首次进入受控适配时生成一次：`modelRequestId`；持久预占、发送前复核及用量观察沿用该标识。
- 工具身份为 `sourceNativeEntryId`、`toolCallId`、`toolName`；来源必须是已追加并提交的完整 assistant entry，不能仅用工具名称或当前 leaf 猜测。
- `beforeModel` 等待原生提交及预算预占；`beforeModelDispatch` 再核查停止、期限、owner、generation、活动 Attempt 和 expected head。
- `beforeTool` 等待完整工具调用提交及预算预占；`beforeToolDispatch` 再复核并只消费一次发送资格。工具结果提交后才能发起下一模型请求。
- 工具声明、执行配置和资源版本必须冻结为执行快照；不在恢复时发现本机资源或替换模型、鉴权与路由。
- 公开继续、重试、补充输入仍不开放；内部恢复夹具不等于这些产品命令交付。

本轮优先扩展 Pi 适配私有 TypeScript 接口；共享公开契约若确需变化，须记录来源后通过现有生成器维护，不手改生成文件。

## 原生样本与可等待控制点

固定的三个 Pi SDK 均为 1.3.0，源码基线为 `71023aec1546d6d677a65669c5665c0927ce0dd0`。W3 使用 `SessionManager.inMemory`，显式关闭自动压缩、自动重试、缓存预热、资源自动发现、未受控辅助模型及嵌套调用。

底层 `Agent.subscribe` 的异步监听可等待，`AgentSession` 的公开事件订阅不可作为保存屏障。适配器必须在 AgentSession 已追加原生记录之后捕获冻结副本；`beforeToolCall` 与受控 `streamFn` 是模型/工具放行前可等待的复核点。普通异步日志、扩展异常或页面 SSE 不是屏障。恢复先装入同一已提交 revision 的全部原生记录，再显式恢复 leaf（包括 null），然后创建 AgentSession；加载器默认最后一条不能代替 leaf。

样本、SDK 装配追加、分支、多个根、压缩、自定义记录、仅 leaf 变化、null leaf 及工具结果的实际测试证据由 W5 原生往返测试记录。测试尚未执行的能力不得写成已经验证。

## 数据库隔离与迁移边界

Agent 使用独立 PostgreSQL 数据库与 `agent` schema，SQL 对象范围限定于该 schema；与 `apps/server/prisma`、业务迁移和根 `db:*` 命令分开。迁移角色、运行角色与清理权限分离；运行角色不拥有对象、无 DDL/TRUNCATE 权限。测试数据库必须明确为可清理的 Agent 专用环境，不能猜测既有连接用途。

迁移入口和 SQL 资源随 Agent 构建交付；重复迁移应幂等，失败应整事务回滚。HTTP 启动只检查兼容版本，不自动 DDL。缺少专用接库条件时仅完成可审查代码与 DDL，并明确保留真实 PostgreSQL 验证缺口。

W5 使用独立 worktree 与分支；并行端口、模型配置、身份配置和测试连接分开。被忽略的 `.env` 不由 worktree 自动携带，不输出或覆盖凭据，数据库故障不回退内存。

## 事务与可靠放行

短事务统一按会话、任务、Pi 会话、Attempt 顺序取得协调锁；不跨模型或网络等待。提交校验当前进程启动身份、generation、活动 Attempt 和预期 head。共享 PostgreSQL 不等于支持安全多实例接管；首期只允许明确单执行进程拓扑，由进程管理确认旧进程已退出后才进行隔离与恢复。页面断线、心跳超时和租约过期不能单独构成接管依据。

输入消费与真实原生输入关联、revision、head 和产品事件同事务提交。每次原生保存先冻结内容与固定 commit key/摘要；同 key 同内容返回原结果，不同内容拒绝。提交不明先查原 key，核实成功不会重新授予旧执行权。

预算随任务执行快照冻结，默认 600000 ms、12 次模型、10 次工具授权。准备、装配、恢复和保存均计时；排队不计，重启不重置。调用前在协调事务内原子预占，更新真实计数、Task 版本和冻结 `task.updated`；失败不退次数。模型 producer key 关联原 model request，工具 producer key 关联 Attempt、原生 assistant entry 和 tool call。提交不明立即请求取消，再核实原 key；未知时不得发送、再增计或换身份。重复核实只能确认消耗，不能获得新的发送许可。

第 N 次可以正常完成，需要第 N+1 次才锁存限制；到期检查优先于次数检查。首因持久锁存后只允许取消、合法原生收尾和保存，不伪造用户 stopping；完成、用户停止与限制在同一协调边界裁决。最终原生状态、Result、最终消息、Task/Attempt 结局、执行权释放与 outbox 必须原子提交后才显示 completed。

产品快照与水位来自同一一致读取，SSE 通知只唤醒数据库补读，不作为事实来源。裁剪不得越过活动 Attempt 或待核实授权的 producer key；事件重复、缺口、游标过旧、换流都按 22 号明确处理，不静默跳号。刷新、查询、SSE 重连和服务重启仅恢复展示。

## 验证记录与未完成范围

按 A 原生控制点、B 迁移和存储、C 接入、D 故障与竞争、E 浏览器重启和真实模型追问顺序记录结果。受控模型、虚拟时钟、真实时钟受控端点、真实供应商分别记录。真实 600000 ms 是单独显式入口，不加入常规快速单测，不用缩短时钟替代。

本记录建立时仍待后续阶段填写实际数据库、故障、浏览器与模型结果。W5 通过不等于完整 M3/W6、真实工具上下文跨重启或跨模型调优完成。

### 预算适配阶段记录

2026-10-22，Node.js 24.19.0，独立 PostgreSQL 18 Agent 测试实例（回环 55435）的预算集成 8 项全部通过，总 3021 ms。每组新建隔离记录，不清库，不访问业务数据库。覆盖同身份 20 并发仅一次预占/一个一次性 permit、不同身份并发不超领、模型 11/12/13、工具 9/10/11、已提交原生 assistant 的 tool call 来源、只读工具不产生 Operation、旧 owner/generation/head、预占后停止、COMMIT 成功但确认丢失、提交未知、数据库失败、活动授权事件保留，以及重复 start 不重置 deadline/首因。工具来源组初次被缺少运行版本的测试快照挡住；补齐快照后暴露并修正 NativeStore 先写 revision 后写新 leaf entry 的立即外键顺序，最终 8 项全过。

快速纯策略测试 4 项通过，覆盖 599999/600000/600001 ms、N/N+1、历史未知预算和稳定 producer key 的无歧义身份。它们验证与数据库路径共用的策略函数，不替代 PostgreSQL 事务和实际取消验证。

真实 600000 ms 的单独入口为 `apps/agent/tests/persistent-budget-real-time.ts`；应由显式慢测命令运行。该测试使用真实时钟、本机受控 HTTP 短调用、实际取消与 PostgreSQL 预算/结局，不是供应商模型或 Pi 工具循环验收。实际结果另记 W5 验收记录，不能用脚本存在代替执行证据。

真实慢测已实际通过：2026-10-22 22:29:51.877 至 22:39:52.006（Asia/Shanghai），累计 600129 ms，有限收尾 28 ms。11 次持久模型授权对应 11 次本机受控 HTTP 调用，10 次正常结束，第 11 次实际取消；数据库保存 `duration` 首因、`failed` 结局、11/0 授权计数，原 deadline 不变、无用户停止时间并释放执行权。这是“真实时钟＋受控端点”的预算适配集成证据，未接真实供应商，也不是 Pi 工具循环验收。

### 进程隔离与内部恢复适配记录

新增私有 `process-identity.ts` 与 `recovery.ts`。执行者身份包含本机 hostname 摘要、PID 与随机进程启动 UUID；内部适配只接受本机原 PID 的 `ESRCH`，并在 C/T/P/A 协调锁内再次复核原完整 owner、generation、head 和进程退出事实。存活/复用 PID、EPERM、其他主机、旧身份格式均不构成隔离证明。数据库锁释放、页面断线、心跳超时不作为证明。

隔离原生 worker 的真实 SIGKILL 测试 3 项全部通过（总 9064 ms）：分别在输入消费前、原生输入和消费标记已提交后强杀测试自己创建的子进程；重建 runtime 后只读查询、快照和 SSE 均没有创建 Pi 会话或新增执行。内部适配原子保留原生 head/entries 与 pending/consumed/I 关联，标记 Task/Attempt `interrupted`，保存进行中消息和任务事件，释放 P 并增加代次；重复核实不再写入，不授予模型/工具许可。未完成目标仍阻止新 Task，公开 continue/retry/provide_input 仍未开放。测试使用隔离原生 worker，不等同于完整 W6 桌面故障恢复。

已锁存预算限制的遗留 Attempt 暂不进入普通 interrupted 适配，明确阻断并要求走相应 failed 收尾核对；跨主机、多实例和 PID 命名空间的接管不在该内部单机适配范围。

### CT07 固定资源元数据闭合补齐

2026-10-23，按当前17／20号设计补齐资源基线。初版只有场景与预算检查，18表／269字段本身没有证明 S/G/F 的成员、摘要、入口及工具绑定闭合；该差异已单独识别并实际修复。

schema 1 将资源摘要规则冻结为 `resource-manifest-v1`：按 `load_order`、`member_key`（数据库 C 排序）排列完整成员数组，逐项包含 member_key、resource_kind、entry_path、load_order、options，以及对应 F 的全部稳定内容；去掉 F.id／created_at，archive_size_bytes 用十进制字符串保留 bigint 精度。对 PostgreSQL 18 规范 JSONB 文本的 UTF-8 字节取 SHA-256。空数组仍是 `[]`，因此与原有 `digest([])` 相同。此规则由发布器与延迟约束共同调用同一组 `agent.resource_manifest_*` SQL 函数；命令和 snapshot 的现有 JCS 规则不变，不把 JSONB 文本摘要称为 RFC8785。

可信内部 `publishResourceSnapshot` 在 SQL 前冻结输入、验证声明并调用显式字节／来源／可取回性 verifier；它不下载安装、扫描资源或开放页面工具。F 的 schema 1 文件清单为 `{files:[{path,size_bytes,sha256,mode,kind:'file',exports?:string[]}]}`，只允许明确的普通相对文件，拒绝越界、反斜线、控制字符、重复路径、未知 artifact 顶层字段和未经验证的链接。实际归档及文件原字节、完整依赖与来源可信性仍须由该受控 verifier 核实，元数据一致不等于已经取得或执行制品。

工具通过 `implementation.member_key/export_name` 指向 extension／business_adapter 成员入口中明确声明的 export，或用非空 `runtime_export` 匹配固定 runtime_manifest.tool_exports。Skill 入口必须是清单中的 SKILL.md；成员 options 的 `requires_members`、`requires_tools`、`requires_files` 必须全部在本快照闭合。隔离原生工具夹具另须明确 `isolated_fixture:true`，并由工具与运行时双方精确声明同一 entry／sha256；禁止 tests/../ 路径和 member/runtime 双绑定，不能借该分支进入真实页面。

S/G/F 的 INSERT／UPDATE／DELETE，以及引用快照的 T/R 变化，在事务末重新读取相关快照的最终状态，验证实际完整成员摘要、入口与实现绑定。S 与全部 G 同一发布事务冻结；普通运行无发布权限，旧配置不能追加成员。重复 hash 仍比较完整 S 正文与实际 G/F 稳定语义，重复 F 逻辑版本仍比较全部不可变内容。部分成员删除不能提交；已无引用的 S/G 整组受控清理可以闭合。实现未使用客户端 SET 标记绕过验证。

独立 PostgreSQL 18.6、Node.js 24.19.0 下，资源发布集成 14 项全部通过，包含：有序往返和同内容重放、缺 G、摘要错、缺入口、缺工具绑定、Skill 三类依赖缺失、隔离夹具 flag／路径／双绑定反例、同 F 版本异内容、同声明 snapshot hash 异正文、部分删除拒绝与整组删除、runtime export 空值、未知 artifact 字段以及字节 verifier 失败。测试曾发现固定的“坏 hash”夹具重复运行冲突，已加入独立随机 fixture_scope；复测通过且未删除既有记录。

本轮真实聊天仍为零资源成员、空工具清单；非空资源元数据发布与数据库约束通过，不表示 W4 资源装配或生产资源加载已经开放。未更新外部设计文档，未把本地实现写回外部目标契约。
