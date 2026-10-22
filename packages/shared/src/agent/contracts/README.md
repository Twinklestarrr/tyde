# Agent 公开契约

这里保存 21（命令）、22（查询与 SSE）设计稿的 OpenAPI 原始快照，以及由这些快照生成的 99 个去重公开 DTO／Schema。设计文档版本为 v0.1，机器契约版本为 `1.1.0-design`，公开 `schema_version` 仍为 `1`；每份完整源文件的 SHA-256 随 `agentContractSources` 导出。完整设计契约包含后续阶段能力，不能据此认定所有 HTTP 接口已经实现。

| 源快照                         | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `21-commands.openapi.json`     | `4dab294a8f543623c4efb265ae90b26169b0501c37173d8a574b19d3a747d39b` |
| `22-reads-events.openapi.json` | `33bccd277ca3999a7420a0e9eb4ab56309b9e8241ac7bd55e13809009bd31702` |

2026-10-22 W3 同步自当前未带历史版本后缀的《21 Agent 命令接口契约》《22 Agent 查询与 SSE 接口契约》及其 `contracts/` JSON。相较 W1 的 `1.0.0-design`，路径及 21 请求 Schema 不变；21 补充累计预算与停止竞争语义，22 增加 `AttemptBudgetView`、`AttemptView.budget` 及预算诊断说明。历史冻结投影可以缺少预算或为 `null`；新受控 Attempt 必须返回真实预算，不能把未知计数补成零。W3 只实现进程内累计授权、期限和取消，持久预占、提交不明核实、持久 deadline 与重启恢复仍属 W5。

`generated.ts` 提供普通 TypeBox Schema 和同源 TypeScript 类型；`document.generated.ts` 导出原始 JSON Schema 定义，`operations.generated.ts` 导出同源路径、请求/响应示例及参数，均使用 `#/$defs/` 引用供服务端文档装配复用。`index.ts` 的 `validateAgentContract(name, value)` 是唯一完整校验入口，同时检查结构、互斥分支、字段依赖、Unicode 码点长度、真实日期、日期范围、IANA 时区、bigint 上界、非法孤立代理项，以及预算计数上限和限制原因/时间成对关系。它不改写、补默认值、移除字段或转换类型。不要用 `Value.Check` 替代该入口，TypeBox 内置检查对这些约束的支持不同。

校验器由根开发依赖 Ajv 8.20.0 生成静态 ESM，浏览器运行时没有 Ajv、CommonJS、动态求值或 Node 依赖。它只负责 JSON 载荷及标量语义；归属权限、数据库一致性、跨对象关系、命令幂等、游标顺序及客户端合并仍由各层实现。

更新时先确认设计，再更新 `sources/` 快照，从仓库根目录执行：

```sh
node scripts/generate-agent-contracts.mjs
node scripts/generate-agent-contracts.mjs --check
```

生成过程完全使用仓库内快照，不依赖个人机器上的设计文档路径。源文件与生成文件须一并交付；`--check` 验证来源摘要、类型、Schema 和静态校验器没有漂移。
