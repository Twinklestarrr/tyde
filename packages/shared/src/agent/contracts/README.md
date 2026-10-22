# Agent 公开契约

这里保存 21（命令）、22（查询与 SSE）设计稿的 OpenAPI 原始快照，以及由这些快照生成的 98 个去重公开 DTO／Schema。设计文档版本为 v0.1，机器契约版本为 `1.0.0-design`；每份完整源文件的 SHA-256 随 `agentContractSources` 导出。它们是 W1 的实现基线，不表示这些 HTTP 接口已经实现。

| 源快照                         | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `21-commands.openapi.json`     | `911d2f4b8071bce4fb58877d04635870a5f1fe68da1f28fc3e193306fc44ce02` |
| `22-reads-events.openapi.json` | `0b07ca461bf9ef28718b636dae6b1bd88054441b0076c3aa437f9be6c6dd099d` |

`generated.ts` 提供普通 TypeBox Schema 和同源 TypeScript 类型；`index.ts` 的 `validateAgentContract(name, value)` 是唯一完整校验入口，同时检查结构、互斥分支、字段依赖、Unicode 码点长度、真实日期、日期范围、IANA 时区、bigint 上界和非法孤立代理项。它不改写、补默认值、移除字段或转换类型。不要用 `Value.Check` 替代该入口，TypeBox 内置检查对这些约束的支持不同。

校验器由根开发依赖 Ajv 8.20.0 生成静态 ESM，浏览器运行时没有 Ajv、CommonJS、动态求值或 Node 依赖。它只负责 JSON 载荷及标量语义；归属权限、数据库一致性、跨对象关系、命令幂等、游标顺序及客户端合并仍由各层实现。

更新时先确认设计，再更新 `sources/` 快照，从仓库根目录执行：

```sh
node scripts/generate-agent-contracts.mjs
node scripts/generate-agent-contracts.mjs --check
```

生成过程完全使用仓库内快照，不依赖个人机器上的设计文档路径。源文件与生成文件须一并交付；`--check` 验证来源摘要、类型、Schema 和静态校验器没有漂移。
