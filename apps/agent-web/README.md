# Agent 界面

W3 将 Pi 内存执行接入独立 React／Vite 界面：新建和切换会话、历史分页、自由输入、多轮追问、Markdown 流式输出、停止、错误和断线重连。真实模型只在 `apps/agent` 调用；页面通过 21／22 号契约读取产品投影，不解释模型原始 SSE。

在仓库根目录先切换到 `.nvmrc` 指定的 Node.js 24.19.0，确认 `node --version` 与 `pnpm --version`（11.23.0），再启动：

```sh
pnpm dev:agent
pnpm dev:agent-web
```

服务默认 `http://127.0.0.1:3002`，界面默认 `http://127.0.0.1:3003`。产品请求走 `/agent-api/api/agent/v1/*`，Vite 只去除 `/agent-api` 前缀。需要连接其他服务时，将 `.env.example` 复制为忽略的 `.env.local`，设置 `AGENT_PROXY_TARGET` 并重启 Vite。变量只供 Vite 读取；模型 URL、Key 和模型 ID 留在 Agent 服务配置。

按照 [Agent 服务说明](../agent/README.md) 开启受控的本机开发身份，并在连接页输入该身份的 Bearer 凭据。页面不接受用户 ID 作为授权。身份凭据仅留在当前页面内存，不写 URL、localStorage 或 sessionStorage；刷新后重新输入。连接成功后，URL 中的会话 UUID 用于重新读取原会话，不能替代归属校验。

进入页面后点击“新建会话”，在输入框中自由输入并发送；Enter 换行，⌘／Ctrl + Enter 发送。回答完成后发送下一条问题会创建后续 Task，原生上下文由同一服务端 Pi Session 保留。任务执行期间不插入新正文。停止只针对明确的 Attempt，“停止中”表示已受理，收到结束投影后才显示“已停止”。当前未开放继续、重试和待补充命令；停止、失败或中断留下未完成目标时，应新建会话，不能用新 Task 绕过原目标。

未指定标题的会话以首条受理的用户消息作为标题预览：折叠空白并截取前 80 个 Unicode 码点，自定义标题保留，不额外调用模型。消息右下角显示服务端消息时间，跨日补充日期；尝试统计只显示已用模型请求数、工具执行数和耗时，不展示总额度。耗时按服务端起止时间计算，执行时更新，终态固定，刷新和重连后不重新计时；原有预算保护仍生效。界面浅色配色对齐业务前端的青蓝主色，深色保留同品牌配色。

页面连接先通过认证只读 `GET /api/agent/v1/runtime` 确认服务端存储模式；未确认或读取失败时不进入工作区，也不假称持久化成功。PostgreSQL 模式明确显示重启保留历史，刷新、重新打开和 SSE 重连只恢复展示，不启动 Attempt；已完成会话的后续问题仍由用户显式发送。开发内存模式只在服务端显式选择时展示，并提示服务重启清空历史。读取与事件重连会重新核对模式，模式变更后丢弃旧展示缓存并要求重新连接；PG 故障不回退内存。关闭页面或订阅不会停止服务端任务。W5 不开放继续／重试／补充按钮，Electron 与完整用户恢复流程仍归 W6。

命令响应丢失时，页面保留原请求并按原 request_key 只读核实；查询未命中不证明未执行。仍未确认时，可再次核实或明确选择“原样重发”，始终保留原 key、正文、context 和目标。空会话创建是非幂等 POST，不自动重发，失败后先刷新列表核对。

```sh
pnpm --filter @tyde/agent-web build
pnpm --filter @tyde/agent-web typecheck
pnpm --filter @tyde/agent-web test
pnpm --filter @tyde/agent-web preview
```

预览默认端口 `4003`，提供同样的本地代理。生产构建是 `dist/` 中的静态文件；部署需要将 `/agent-api/*` 反向代理至 Agent 服务并去掉前缀，关闭 SSE 缓冲。Vite 开发代理不会进入构建产物。

- `src/services/agent-client.ts`：集中 HTTP／Bearer／共享校验和受控 fetch SSE，逐帧等待应用，限制解析缓冲和网络块大小。
- `src/services/chat-controller.ts`：会话读取代次、请求去重与原命令核实、有限退避重连；会话切换和重建基线会取消旧读取，过期回包／回调被忽略。
- `src/agent-events/`：完整安装 snapshot 及 H 后订阅，可靠事件按连续序号应用后推进游标；control／delta／心跳不推进。缺口和换流重取快照，不跳号；未知可靠事件明确阻断。
- `src/agent-events/projection.ts`：按实体版本保存覆盖缓存，历史回包不倒退可靠终态；临时文字按 message／attempt／output_stream_id 和连续索引拼接，重连或缺号丢弃临时段，最终消息及不可变结果一次收敛。临时段不会重复追加到最终正文。
- `src/App.tsx`：会话、聊天、消息时间、尝试统计、停止状态和操作摘要展示。操作组件只显示服务端真实产品记录，演示工具在 W4 接入。
- `fixtures/` 与 `tests/`：隔离契约、流分帧、旧回包／旧订阅、命令未知、重复请求、停止与重连测试；夹具不进入真实页面。
- [上游来源与改动记录](upstream/pi-web/SOURCE.md)：固定提交、适配范围、来源摘要；MIT 许可证保留在同目录。

跨应用契约由 `@tyde/shared/agent` 唯一定义，来源与生成规则见 [共享契约说明](../../packages/shared/src/agent/contracts/README.md)。本应用未引入上游 Next API、Pi 执行、JSONL、本地文件、终端、凭据存储或模拟回答。
