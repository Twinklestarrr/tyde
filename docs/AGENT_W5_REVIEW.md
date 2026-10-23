# W5 独立实现复核

日期：2026-10-22。范围为 W5 未提交工作区中的 Pi 原生适配、原生提交器、PostgreSQL runtime、应用装配和异步 API/SSE。基线保留 W3 及四项聊天优化。仅记录能够用具体路径和测试验证的问题；不把未执行的浏览器、真实供应商或 W4 联调写成通过。

## 已确认并修复的问题

| 严重度 | 原问题及可复现后果                                                                                                                             | 修复和验证                                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | 原生提交先写引用新 leaf 的 revision，再写 entries，违反立即检查的 leaf FK；首次真实消息就可能整事务失败。输入消费也必须先更新命令，再插关联。  | `native-store.ts` 改为 E → R → head/Attempt → effects；无需 `SET CONSTRAINTS ALL DEFERRED`。真实 PG 原生提交 7 项复验全部通过。                                                                                                                                                    |
| P1     | 保存请求虽然冻结了 effects，事务闭包原来仍使用外部原对象；提交摘要不能可靠约束实际输入消费/终局事实。                                          | 请求在进入第一次 await 前复制并深冻；重算正文 hash；apply 使用冻结 effects。同 key 并发四次仅一次 apply/版本；同 key 变意图与沿用旧 hash 篡改均被拒绝。                                                                                                                            |
| P1     | 原生 COMMIT 确认丢失原来直接抛出，缺少原 key 核实；失败后的重新连接也不能延迟取消。                                                            | 首先同步 failClosed，再销毁连接并查询原 key/hash；旧成功只返回 revision，不产生发送许可。真实 PG 已提交后受控丢弃确认的两种测试通过，无法核实时保留原 key/hash。                                                                                                                   |
| P1     | runtime 的 transaction 原来先等待 ROLLBACK，再调用 failClosed；数据库异常且回滚悬挂时活动执行尚未取消。                                        | 取消移动到任何 rollback await 前。`runtime-failure.test.ts` 用未完成 ROLLBACK Promise 验证，此时 controller 已 aborted。该项为受控数据库替身测试。                                                                                                                                 |
| P1     | 活动 SSE 的换流/游标/历史错误原来只停止内部轮询，HTTP SSE 仍然开着，浏览器无法收到重新取基线指示。                                             | runtime 提供 onError，路由发送 resync_required/对应原因并关闭流；其他错误发送 server_retry 后关闭。真实 PG 换流测试观察到 STREAM_CHANGED，按新流重新订阅不启动 Pi。                                                                                                                |
| P1     | end 已读到期限前的 now 后，Result 插入使用较晚的真实时间；若两步间跨 deadline，delivery guard 拒绝后原实现全局 faulted，跳过可靠 failed 收尾。 | 增加 final_delivery savepoint；仅对已核实的停止/期限竞争转为同事务 stopped/failed；其他授权失败继续拒绝。测试在真实 PG 首次裁决读取后受控等待跨期限，先证实旧实现 guard_agent_delivery 失败；修复后真实 PG 终局断言全部通过，未产生 Result，Task/Attempt 为 failed，owner 已释放。 |
| P1     | 执行快照原来只有静态 runtime 标签、SDK 和 Node 主版本；Agent 源码、锁文件和实际运行产物改变时仍有相同身份。                                    | 增加运行清单生成及同步核验：精确 Node/SDK/native 格式、OS/arch、源码/迁移/shared 契约、依赖锁及三项 SDK 实际代码摘要形成不可变 release digest。source/compiled 使用相同身份，分别核验实际资源；缺失/漂移拒绝启动。定向清单与故障单测 4 项通过。                                    |

## 本轮证据与边界

所有本记录中的实际测试命令均先显式加入 Node.js 24.19.0 的 PATH；Pi 三项 SDK 继续精确 1.3.0。未修改依赖实现，也未更换现有模型/鉴权配置。

- Pi 原生适配与样本：33 项通过，约 2.78 秒；实际 SDK＋受控 fetch/只读夹具。包括阻塞尚未完成的保存 Promise、完整原生往返、null/旧 leaf、两个根、同 Pi Session 上下文追问。详见 [Pi D1 记录](./AGENT_W5_PI.md)。
- 原生 PostgreSQL 提交：`native-store.integration.ts` 7 项通过，约 3.51 秒；删除 ALL DEFERRED 后再次 7 项全部通过。真实 PG18，唯一测试 C/P/T/A；没有清表或业务数据库操作。
- 运行清单与数据库异常取消：`runtime-manifest.test.ts`、`runtime-failure.test.ts` 共 4 项通过，约 2.92 秒；compiled 单测使用明确标注的产物夹具，完整实际 build 由主流程另验。
- 实时 SSE 与 deadline 竞争：`runtime-review.integration.ts` 的 2 项与原生 7 项最终合跑 9/9 全过，约 3.59 秒。采用真实 PG＋受控短等待，不能当成供应商验收或 600000ms 真实计时验收。

复核确认：服务初始化、查询、快照、刷新和 SSE 读取没有调度 Pi 的代码路径；公开 continue/retry/provide_input 仍拒绝；未完成目标阻止偷偷新建 Task。执行预算的旧授权核实不返回新 permit。完成状态由原生末尾、Result、消息、Task/Attempt、执行权和 outbox 同一事务决定。隔离只读工具夹具已通过真实 Pi＋PG 全链路复验（tool-loop.integration.ts 1/1，总约 6.45 秒）：调用/结果各自保存后才执行下一步，预算与准确原生来源匹配，重建 runtime 后原工具结果进入后续问题上下文，Operation 数量为 0。夹具声明和实现 SHA 进入专用快照。W4 尚未合并，该项不是实际 W4 工具/Skill 包的验收证据。

单进程数据库协调锁不是多实例安全接管证明。旧活动尝试在重启后保留未解决状态；不能因数据库连接消失就复活它。进程终止、浏览器/真实模型和 600000ms 实时时钟结果由 W5 主验收记录分别保存。本次审查没有自行提交、推送或发布。

## 实际数据库连接故障复验

database-outage.integration.ts 1/1 通过，总约 4.67 秒（测试本体约 1.47 秒）。使用真实 Pi＋真实 Agent PG18＋真实回环 HTTP 慢 SSE 受控端点；仅 pg_terminate_backend 本测试新建 runtime 的 guard PID，并以 current_database 与本测试 application_name 双重限定，没有停止 PG 服务或其他连接。

guard error 触发取消，活动 controller 已 aborted，受控端点实际收到 HTTP close，取消发生在 3 秒断言上限内；模型请求总计 1，工具 0，无 Result、completed 或伪 stopped。已提交输入保持 consumed，原生 head 可加载；原 Attempt 保持未决 running。重新创建 runtime 后只读快照、历史和 SSE 补读均不启动执行，HTTP 总计仍为 1。该证据属于实际 PG 连接故障＋受控端点，不属于真实供应商故障验收。

## 大历史真实 HTTP 补读复验（2026-10-23）

event-replay.integration.ts 1/1 通过，总约 14.05 秒（测试本体约 10.59 秒）。独立空会话同一事务提交 600 条 conversation.updated 测试事件，无 Task/模型；真实回环 HTTP 客户端从 after=0 连续读取 1…600，ready.observed_head_seq 为 600，逐帧验证公开 Schema、SSE id 与 JSON stream/seq 一致。随后读取 1…128 主动断开，从 after=128 重连补齐 129…600，完整 600 个 event_id 唯一，无 slow_consumer、缺口或跳号，createSession 调用为 0。

该项验证 PG 每批最多 128 帧、内部 after 只推进实际批尾的实现，避免把尚未投递的 head 当作已补读水位。它是实际 PG＋实际 HTTP 的事件读取回归，不涉及模型、供应商或 W4 工具。
