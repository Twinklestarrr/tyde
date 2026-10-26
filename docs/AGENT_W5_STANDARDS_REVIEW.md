# W5 Standards / 数据设计审查

固定点：`d73ea7a45693b59bbf36f5dc4eb9f509185a95d2`。HEAD 无新增提交；审查包括 `git diff d73ea7a` 的工作区修改，以及未跟踪的 storage/runtime/execution、DDL、测试和运行清单文件。未修改业务代码、共享契约或 DDL。

标准来源：仓库 `AGENTS.md`、`docs/API.md` 的 Swagger 标准；外部当前 17 号执行配置、20 号 DDL 和 `data-model/20-DDL索引与约束清单.md`。用户“不自行提交”优先于 implement 技能的默认提交步骤。本报告不重复已修正的 SSE、完成事务和另一审查负责的运行清单问题。

## 初审发现与闭环

1. **P2，已修复：同快照摘要未核验持久完整内容。** `apps/agent/src/storage/execution-config.ts` 的 `publishExecutionSnapshot` 对冲突直接 `DO NOTHING`，`requireExecutionSnapshot` 只按声明 hash 返回 ID；执行前同样只比声明 hash。17 号 §2.1 要求同摘要登记比较完整规范化内容、不同内容明确冲突。因此一条内容与所声明 hash 不符的既有 S 行可以被当作当前配置绑定，执行配置与持久审计事实不一致。应在发布重放、选取和执行前重算并核对完整 S 语义，不能仅信其 `snapshot_hash`。

2. **P2，已修复：配置快照缺少明确要求的固定策略与凭据身份。** 同文件 `modelExecutionConfig` 未写 API 协议、端点/预设版本及绑定端点的逻辑 `credential_ref`；`executionSnapshot.execution_policy` 仅保存 attempt_limits。17 号 §2.2 要求这些身份及压缩、重试、资源加载和能力规则固定。当前实现把这些规则隐含在进程代码与环境中，不能从 S 本身核对原配置。应记录真实受控固定值和逻辑凭据来源；密钥值仍须排除。

3. **P2，已修复：新增运行信息接口的 Swagger 错误分支缺失。** `apps/agent/src/application.ts` 的 `GET /api/agent/v1/runtime` 仅声明 200，响应对象缺中文 description，也未说明真实 401/503 错误。Node.js 24.19.0 下 `app.inject` 和生成文档核实：匿名请求返回 401 默认 Fastify 错误体，OpenAPI 只有 200。该接口位于统一 Agent 错误处理插件外。应按 `docs/API.md` 标准 §2/§5 补中文对象说明、错误 schema/示例，并明确或统一错误封装。

## CT07 追加审查与闭环

4. **P2，已修复：CT07 的非空资源成员、摘要与工具绑定闭合尚未实现。** `migrations/sql/0001/04_guards.sql` 的 G 插入仅检查与 S 同事务；`assert_integrity` 未核验 S.resource_manifest_hash 对应实际 G/F 全集、entry_path 在文件清单存在及工具实现引用闭合。20 号约束清单 CT07 明确要求“成员/摘要/工具闭合；实际字节另验”。数据负责人已独立确认没有其他 validator 覆盖。当前 W5 固定空资源 hash、执行时拒绝非空资源，可保护聊天路径，但不能据此报告完整 CT07 已覆盖。用户要求完整基线，需实现受控资源发布事务和对应事务末闭合验证；若暂时只加非空资源/未知 binding 门禁，必须明确保留此未完成项。

## 修复复核

`requireExecutionSnapshot` 现重算完整 S 语义并与声明摘要比较；发布重放和执行前均调用该核验，schema_version/scene_key 纳入摘要。模型与策略已补 API、逻辑凭据引用、端点/预设版本及禁用隐式能力的明确固定值。

新增 `tests/execution-config.test.ts` 的 4 项测试在 Node.js 24.19.0 全部通过（6145 ms）：相同完整内容返回原 ID、7 个语义字段逐项损坏拒绝、重复发布/同 hash 异内容拒绝，以及策略/凭据身份固定并排除 Key。生成 OpenAPI 与 `app.inject` 复核确认 runtime 接口现有中文响应对象说明、200/401/503 文档及对应错误示例，真实 401 序列化保留约定字段。

CT07 现增加 `resource-publication.ts` 可信发布器及 S/G/F/T/R 的延迟 I/U/D 资源闭合触发器。成员排序与稳定 F 身份采用明确版本化的 resource-manifest-v1：PG18 有序 JSONB 文本 SHA-256，publisher 与数据库共用 SQL 规范化/摘要函数，空集合兼容原摘要；命令和 snapshot 的 JCS 规则不变。具备完整成员摘要、F 文件/入口、工具 member/runtime 导出及 Skill 依赖闭合。隔离 fixture 必须显式声明、双侧完整导出一致、路径无遍历且不夹带其他绑定。

2026-10-23，Node.js 24.19.0 独立复跑资源测试 14/14（含父测试，801 ms）。另以 7 组每例回滚的原始 SQL 探针对照 TypeScript validator：合法 fixture 接受；缺 flag、缺工具侧 exports、路径遍历、歧义绑定、篡改摘要及空 runtime export 均在发布器和延迟 SQL 拒绝。重复执行测试曾暴露固定坏 S 夹具的唯一键冲突，已改为独立 fixture_scope，未清库。

四项发现均已闭环。真实制品字节、来源与可取回性仍由可信 verifier 负责；本次资源测试是明确的合成 metadata fixture，不表示 W4 资源已进入生产或跨重启工具联调完成。未为命名或模块长度等主观气味单独出具交付阻断项。
