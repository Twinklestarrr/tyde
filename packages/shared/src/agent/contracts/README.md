# Agent 公开契约

这里保存 21（命令）、22（查询与 SSE）设计稿的 OpenAPI 原始快照，以及由这些快照生成的 103 个去重公开 DTO／Schema。设计文档版本为 v0.1，21 机器契约版本为 `1.1.0-design`，22 为 W4 本轮新增的 `1.2.0-w4-design`，公开 `schema_version` 仍为 `1`；每份完整源文件的 SHA-256 随 `agentContractSources` 导出。完整设计契约包含后续阶段能力，不能据此认定所有 HTTP 接口已经实现。

| 源快照                         | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `21-commands.openapi.json`     | `4dab294a8f543623c4efb265ae90b26169b0501c37173d8a574b19d3a747d39b` |
| `22-reads-events.openapi.json` | `48c13a0f325c4141d7e2dbb077463ccbba66d38fcde62b1ded5ebd2af41d54cc` |

2026-10-22 W3 同步自当前未带历史版本后缀的《21 Agent 命令接口契约》《22 Agent 查询与 SSE 接口契约》及其 `contracts/` JSON。相较 W1 的 `1.0.0-design`，路径及 21 请求 Schema 不变；21 补充累计预算与停止竞争语义，22 增加 `AttemptBudgetView`、`AttemptView.budget` 及预算诊断说明。历史冻结投影可以缺少预算或为 `null`；新受控 Attempt 必须返回真实预算，不能把未知计数补成零。W3 只实现进程内累计授权、期限和取消，持久预占、提交不明核实、持久 deadline 与重启恢复仍属 W5。

`generated.ts` 提供普通 TypeBox Schema 和同源 TypeScript 类型；`document.generated.ts` 导出原始 JSON Schema 定义，`operations.generated.ts` 导出同源路径、请求/响应示例及参数，均使用 `#/$defs/` 引用供服务端文档装配复用。`index.ts` 的 `validateAgentContract(name, value)` 是唯一完整校验入口，同时检查结构、互斥分支、字段依赖、Unicode 码点长度、真实日期、日期范围、IANA 时区、bigint 上界、非法孤立代理项，以及预算计数上限和限制原因/时间成对关系。它不改写、补默认值、移除字段或转换类型。不要用 `Value.Check` 替代该入口，TypeBox 内置检查对这些约束的支持不同。

校验器由根开发依赖 Ajv 8.20.0 生成静态 ESM，浏览器运行时没有 Ajv、CommonJS、动态求值或 Node 依赖。它只负责 JSON 载荷及标量语义；归属权限、数据库一致性、跨对象关系、命令幂等、游标顺序及客户端合并仍由各层实现。

更新时先确认设计，再更新 `sources/` 快照，从仓库根目录执行：

```sh
node scripts/generate-agent-contracts.mjs
node scripts/generate-agent-contracts.mjs --check
```

生成过程完全使用仓库内快照，不依赖个人机器上的设计文档路径。源文件与生成文件须一并交付；`--check` 验证来源摘要、类型、Schema 和静态校验器没有漂移。

2026-10-22 W4 本轮新增设计：`ToolExecutionSummary`、`ToolExecutionError`、`ToolUpdatedPayload` 和 `ToolUpdatedFrame`。只读工具过程使用独立 `tool.updated`，不创建业务 `OperationSummary`。公开字段包含 conversation/task/attempt、受控模型派发与 Pi 原生 tool_call_id、真实工具名、版本与状态/时间、可信来源/演示标识、安全摘要及不透明结果 UUID；原生 entry、完整参数/结果、路径及模型思考保留在内部。`validateAgentContract` 同时检查工具运行/终态的结束时间、结果与错误配对，以及结束时间不早于开始时间。

快照、消息历史、任务详情、结果详情新增可选 `tool_executions` 数组；旧冻结投影缺省兼容，新 W4 运行必须返回数组。快照覆盖 focus、messages、pinned_messages、results 对应任务的完整工具投影，与水位 H 一起安装后再消费同一可靠序号流；历史按消息关联 task 覆盖全部工具过程，但不推进可靠游标。刷新、切换与重连只恢复展示，不重派模型或工具。终态按 ID/row_version 收敛，迟到结果不恢复旧执行。

这是对当前外部 22 设计和机器契约的明确 W4 新增修订，21 源文件未修改。公开 `schema_version=1` 保持不变，不新增产品命令；新增可靠事件需要前后端配套升级。旧严格客户端不能消费新字段/事件时按原协议失败关闭，不宣称无条件向后兼容，不允许忽略未知事件或跳号。默认服务不包含具体演示资源或 Skill，示例仅用于契约测试与 Swagger，不能作为页面工具执行来源。
