# Agent W5 验收记录

工作于 2026-10-22 开始，跨日至 2026-10-23。仓库原工作区保持 `feature-wfj-agnet` / `d73ea7a45693b59bbf36f5dc4eb9f509185a95d2`；W5 使用其独立分支 `feature/agent-w5-persistence`，worktree 为原仓库下 `.local/worktrees/agent-w5`。该基线包含 W3 和标题预览、消息时间、次数/耗时、品牌色四项优化。没有提交、推送、合并或发布；原工作区及 W4 工作目录未改动。

## 实现范围

新增 Agent 自有 PostgreSQL 18 持久运行时、完整 18 表基线、迁移及版本/对象检查、完整 Pi 原生版本仓储、持久命令裁决、冻结 outbox、一致快照、预算预占/核实/一次性放行，以及明确单机进程退出证明的内部 interrupted 适配。HTTP 启动不自动 DDL、发布配置、扫描 pending 输入或启动 Attempt。数据库故障不回退内存。正常完成的末尾原生状态、Result、最终消息、Task/Attempt、执行权释放及 outbox 同事务提交。

保留三个公开 Pi SDK **1.3.0**；公开依赖固定 Kysely **0.29.7**、pg/@types/pg **8.23.1**，来源为公开 npm registry 与官方仓库。业务 Prisma、业务迁移和业务接口没有修改。现有服务端模型/身份配置仅私下复制到忽略的 worktree `.env`，不输出或提交凭据，不更换路由或鉴权。

W4 继续拥有只读演示工具、Skill 与工具展示；W5 不依赖其演示包。共享命令/读取 OpenAPI 源和 generated 文件没有变化。私有 Pi 边界、模型/工具稳定身份和 toolManifest 注入点见 [D1](AGENT_W5_D1.md)、[Pi 记录](AGENT_W5_PI.md)。新增本地部署信息接口 `GET /api/agent/v1/runtime` 有独立中文 Swagger、可校验示例及401/503；客户端明确展示 PG、显式 memory 或未确认模式。

## A：D1、真实 SDK 样本与等待控制点

完整 SDK 原生样本包含15条 entries、11种类型和两个原生根；覆盖普通消息、完整调用/结果、分支、压缩、上下文编辑、自定义记录、旧 leaf、null leaf 和仅 leaf 变化。加载固定同一 revision，显式恢复 leaf 后才创建 AgentSession；装配补记也等待保存。SDK 原生状态格式与运行版本校验失败时阻断，不从产品聊天、日志或 JSONL 拼上下文。

底层 `Agent.subscribe` 的 SDK 内核逐个 await 监听器；公开 AgentSession 事件订阅不等待。真实 SDK 测试用未完成 Promise 验证输入、完整工具调用、工具结果的保存屏障，以及模型/工具发送门禁。异步保存先深拷贝、冻结固定 key/摘要及 effects。完整证据和来源在 [Pi 记录](AGENT_W5_PI.md)。

## B：独立数据库、迁移与往返

本轮新建 PG **18.6** 实例，仅监听回环独立端口 **55435**。`agent_w5_test` 用于隔离集成，`agent_w5_browser_final` 用于最终真实页面验收；`agent_w5_browser` 仅用于早期启动检查，未发送模型请求。它们均非业务库。连接固定 `pg_catalog,agent` search_path，不含 public。独立迁移/发布/运行权限，运行账号非owner，无 DDL/TRUNCATE/不可变历史删除/配置发布权限。

基线为18领域表、269字段、93索引、67外键；仅6条指定FK可延迟且默认立即检查。首次P/R0初始化只延迟FK17，其余正常原生提交按立即FK顺序闭合。迁移单事务、稳定连接和迁移锁；重复运行只核摘要及对象指纹。SQL随构建交付，编译入口已验证可读取5份SQL。详细权限和步骤见 [迁移说明](../apps/agent/migrations/README.md)。

验证包括原生全字段/原追加顺序/多根/旧叶与空叶、不可变保护、旧owner/generation/head、JSON缺键即时拒绝、accepted/消费/完成事务末检查、失败DDL回滚及非owner权限。基线在专用测试库中曾刷新未发布的开发守卫及测试摘要，未清理活动计时数据；这不是已发布迁移改写或生产升级。

## C：命令、原生提交、事件和预算接入

命令沿用可信主体、归属检查与原意图规范化摘要，用户+request_key跨会话去重，原裁决持久冻结。同key同意图并发不新增执行，同key异意图冲突。原生提交同key同内容返回原revision，不同内容拒绝；成功确认丢失先取消再查原key，查到原成功不会重授旧owner或发送许可。输入消费、实际新增原生输入关联、revision/head、消费事件原子提交。

产品投影、水位及完整冻结帧同事务保存；快照按RepeatableRead一致读取，订阅按数据库水位补读，通知不是事实。缺口、换流、游标越界/过旧明确重取基线。默认不启用产品删除/裁剪，活动或待核实授权证据不得被清除。

预算随不可变Task快照冻结为600000ms、12模型/10工具授权；队列不计时，首次开始原子固定started/deadline，准备/保存计时，历史未知不填0。每次调用先原子预占、写Task版本与冻结事件，明确提交后才获得一次性本地permit；发送前再核停止、期限和资格。失败不退计数；重复确认和提交不明不重复授权。N次可正常完成，N+1才拒绝；首因锁存后取消并可靠failed，不伪造stopping。

## D：并发、故障与进程终止

- 原生提交真实PG7项：完整样本往返、同key四并发只一次apply/revision、摘要/effects冻结、旧资格/原始前缀修改拒绝、事务回滚、真实COMMIT成功后受控丢确认及原key核实。
- 持久预算真实PG8项：同身份20并发仅一次预占/permit、不同身份不超领、11/12/13及9/10/11、实际已保存tool来源、停止竞态、提交不明、数据库失败、授权保留与deadline不重置。快速策略覆盖599999/600000/600001ms。
- 新建隔离worker的真实SIGKILL：输入消费前和后分别强杀；重启查询/快照/SSE没有创建Session或调用。内部恢复要求本机原PID明确ESRCH及完整owner/generation/head匹配；保留原生/输入/预算/deadline，原子interrupted+事件+撤销代次，不提供继续授权。
- 真实PG跨deadline探针：最终裁决读取后受控等待跨期限，Result guard拒绝转为同事务failed，无Result、无假completed，释放owner；已修复保存点收尾及相应事件闭合。
- 真实Pi+PG隔离只读工具闭环：execute内确认完整调用已提交；下一model fetch内确认工具结果已提交；完成后重建runtime，后续上下文包含原工具结果；Operation数为0。夹具不进入页面，不代表W4工具/Skill已合入验收。
- 实际PG连接故障：只精准终止本测试专用guard后端；guard error立即取消，受控HTTP真实close，无额外模型/工具、Result或假completed/stopped。保留未决Attempt；重建runtime只读不执行。未停止PG服务或他人连接。

真实600000ms单独慢测于 **2026-10-22 22:29:51.877—22:39:52.006**（Asia/Shanghai）通过，实测 **600129ms**，有限收尾 **28ms**。11次持久授权/受控HTTP开始，10次完成，第11次实际取消；PG保存duration首因、failed、11/0计数、原deadline及空stop_requested_at，并释放执行权。命令显式使用Node24.19.0绝对路径。此项是**真实时钟＋受控端点**，不是供应商或Pi工具循环验收，不是跨模型调优。

## E：真实浏览器与真实模型

2026-10-23 使用 Playwright 实际控制 Chrome，页面端口35153、Agent端口35152、专用库`agent_w5_browser_final`；服务沿用原`.env`中的模型和开发身份，模型为`deepseek-flash`。只发送两次真实模型请求，没有工具或批量调优。身份仅经一次性回环桥接填入页面内存，未进入命令、快照或记录。

第一轮09:58:48—09:58:49在页面输入验收口令，真实模型回复“已记住”，Task/Attempt completed，1模型/0工具。实际退出PID95028并启动新进程PID95604，刷新后重新输入本机身份，原历史和completed状态恢复；刷新会话、SSE重连及读取后，数据库仍仅1个Attempt/1次模型授权/0工具。

随后用户在同一会话显式追问“刚才让你记住的验收口令是什么？只回复口令。”，第二轮10:01:02—10:01:03正确回复`W5-海岸-7049`。两个Task分别completed、各1模型/0工具，共2个Result；Conversation仍绑定原Pi Session `a1baab41-25ff-47ef-b9b1-037333a2c72d`，revision0→10，8条原生entries。没有由产品消息重建上下文。

还实际启动`dist/main.js`编译入口，并在新标签重新打开同一会话、连接身份和读取两轮历史；再次核对仍2个Attempt、2次模型授权，页面未触发额外执行。PG模式文案、标题预览、消息时间、品牌色和次数/耗时保留，无预算分母。代码源与编译版release identity一致（`sha256:bfe8ce83da865167e9553339606efac4ee1f4632674e44c8817f9a8ee339562e`），编译迁移入口读取全部5份SQL并通过独立兼容检查。

本轮结束保留独立本机预览：页面`http://127.0.0.1:35153`、编译Agent`127.0.0.1:35152`、专用PG`127.0.0.1:55435`。没有使用或终止原3102/3103上的其他进程；本机预览不属于部署或发布。数据库文件位于本worktree的`.local/agent-w5-pg`，均为本轮新建专用数据。

本机证据（均在忽略目录，不含凭据）：`.local/w5-browser-before-restart.txt`、`.local/w5-browser-after-read.txt`、`.local/w5-browser-after-follow-up.txt`、`.local/w5-browser-after-reopen.txt`，截图`.local/output/playwright/w5/first-completed.png`及`restart-context-completed.png`。这是实际供应商聊天验收；前述受控端点、真实时钟、故障和隔离工具夹具分别记录。W4未合入，不宣称真实W4工具上下文跨重启已验。W2/W3既有证据保留。

## 最终工程检查

最终检查实际使用 **Node.js 24.19.0、pnpm 11.23.0**，显式固定 PATH 并核实版本。`pnpm check:agent-contracts`、`pnpm typecheck:agent`、`pnpm typecheck` 与 `pnpm lint` 均通过。

- `pnpm test:agent`：157项，156通过、1跳过；默认无测试库URL时迁移集成跳过，不算数据库验证通过。
- Agent Web：57项全部通过。
- `pnpm test`：业务39个文件、421项全部通过。
- `pnpm test:core`：87项全部通过。
- `pnpm test:agent-db`：真实隔离PG共49项全部通过，包含600条可靠事件的大历史补读；与快速测试中的跳过项分开记录。
- `pnpm build:agent`、`pnpm build:agent-web`：均通过。Agent Web 有大于500kB的Vite chunk提示，退出码为0。

`pnpm format:check` 唯一失败是本轮未修改的基线文件 `apps/server/tests/exam-grading-query.test.ts`；对 `git show HEAD:apps/server/tests/exam-grading-query.test.ts` 的内容运行 Prettier 已确认原基线存在格式差异。W5自身变更文件全部格式检查通过，未修改无关业务文件。W5没有提交、推送、合并或发布。

早期本机沙箱listen EPERM、开发中立即FK写入顺序/资源约束差异与指定版本PATH问题已经单独识别；不把未执行的断言或跳过项算通过。长计时/Pi/独立PG子任务均已核实显式使用Node24.19.0；真实600000ms证据保留在D阶段，不重复执行或改写为供应商验收。

## 限制与W6交接

W5不开放continue_task/retry_task/provide_input及按钮；stopped/failed/interrupted/waiting_input仍是未完成目标，不能用新Task/Pi绕过。内部新Attempt/恢复工具边界夹具不是公开继续交付。W4尚未合并，不宣称真实演示工具/Skill上下文跨重启通过。正式平台授权、Electron装配、多实例/跨主机接管、生产备份运维及26号跨模型调优不在本轮验收。

单机PID证明不适用于多主机/PID命名空间；存活或复用PID会保守阻断。数据库故障后的未决结束须先核实隔离和已提交事实，不能仅凭锁/超时改写终局。事务末守卫当前完整聚合扫描，大数据量下应做性能评估后保留全部不变量优化。默认不开放产品清理/保留策略。

受限内容检查须使用本机忽略的commit-policy.json；原仓库与文档目录未找到该词表；用户2026-10-23明确要求本轮暂不处理，故不阻塞本轮交付，也不将词表检查写成通过。不输出词表或密钥。所有新增依赖来自公开npm，源码/路径/锁文件/产物仍需最终核对。

依赖与凭据检查：公开registry配置已核对；完整Agent传递依赖树的resolved来源核查没有非公开URL，新增依赖精确固定，三个Pi版本仍为1.3.0。最终对仓库当前文件及Agent/Web/shared构建产物共583个文件（含4个既有二进制文件）做实际服务端凭据值比对，匹配为0；410个公开npm依赖解析来源中非公开来源为0，没有新增或修改二进制提交资源。本机摘要保存在`.local/w5-final-provenance.json`。受限词表按用户本轮明确约定暂不执行。技术依据同时核对 [Kysely 官方安装/类型说明](https://kysely.dev/docs/getting-started)、[pg 官方事务说明](https://node-postgres.com/features/transactions) 和 [PostgreSQL 18 约束触发器说明](https://www.postgresql.org/docs/18/sql-createtrigger.html)；实际通过结果以本地测试为准。
