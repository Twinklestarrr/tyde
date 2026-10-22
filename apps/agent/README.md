# Agent 服务

独立 Fastify 服务，默认监听 `http://127.0.0.1:3002`。W1 提供健康、Swagger、受控身份和命令摘要基础；W2 增加 Pi 1.3.0 内存执行、MaaS 协议校验及无界面验证入口。当前 HTTP 接口仍只有 `GET /health/live` 和 `/api/v1/docs/`，健康响应只表示 HTTP 进程存活，不代表 MaaS 已验通或产品任务可执行。

在仓库根目录使用 Node.js 24 与 pnpm 11 安装依赖后：

```sh
pnpm --filter @tyde/agent dev
pnpm --filter @tyde/agent test
pnpm --filter @tyde/agent build
pnpm --filter @tyde/agent start
```

配置可通过 shell 注入，或复制 `.env.example` 为本目录 `.env`。`dev` 和 `start` 按需读取该文件，shell 已有变量优先；未配置时使用回环地址和 3002 端口。`NODE_ENV` 仅接受 `development`、`test`、`production`。`AGENT_HOST` 不含协议或端口，`AGENT_PORT` 为 1～65535 的整数。

W1 已提供受控测试身份适配器，默认 `AGENT_AUTH_MODE=disabled`。后续资源接口通过 `app.agentAccess.authenticate(request)` 取得服务端验证后的用户，再调用 `requireOwnedConversation` 校验可信存储中的会话归属；不存在、已删除或其他用户会话统一返回 404。请求 body、query、Cookie 和自报用户头不能证明身份。当前对话／命令资源路由仍未实现，适配器由隔离测试路由验证，不新增模拟成功的业务接口。

需要本机开发身份时，显式设置 `AGENT_AUTH_MODE=development`、`AGENT_TEST_USER_ID` 和 `AGENT_TEST_BEARER_TOKEN`。用户标识固定在服务端；凭证须至少 32 字符，可在本机使用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成，存入忽略的 `.env`，请求时放入 `Authorization: Bearer …`。此模式仅允许 `development`／`test` 环境，且 `AGENT_HOST` 必须为字面地址 `127.0.0.1` 或 `::1`；禁止在生产、主机名或其他监听地址启用。不要把测试凭证提交到仓库、放入前端 `VITE_*` 变量或 URL。

平台身份预留 `createApp(config, { identityAdapter })` 服务端注入点，后续由适配器验证真实平台 Bearer 及撤销状态；开发身份与平台适配器不能同时装配。默认未装配时资源身份验证失败关闭，格式合法的 Bearer 因无法验证返回 503；缺失／格式非法的凭证，以及已装配适配器判定无效的凭证返回 401。匿名健康检查和 Swagger 不变。`pnpm --filter @tyde/agent test` 覆盖显式配置、凭证验证、客户端伪造身份、归属／删除隔离、平台撤销及验证异常。

## W2 Pi 与模型接入

模型主入口采用服务端 URL 与 Key，复用 Pi 内置的 `openai-completions` 适配、上下文和工具循环。默认官方 DeepSeek，其他兼容地址显式配置模型 ID。24 号平台转发作为独立可选路径保留，主入口无需平台身份模块、路由版本或委托头。该落点遵循本轮最新确认的简化接入方式，外部设计文档未据此改写；两条路径均不自动切换供应商、模型或鉴权方式。

公开 npm 依赖 `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai` 均精确锁定 `1.3.0`；设计核对的上游源码提交为 `71023aec1546d6d677a65669c5665c0927ce0dd0`，没有使用 pi-web 的 1.2.0 或 main。SDK 直接依赖集中在 `src/pi/`；`src/maas/` 校验最终请求及模型流；`src/cli/model-smoke.ts` 是主验收入口，`src/cli/smoke.ts` 验可选平台契约。

### URL 与 Key 本地验收

使用 Node.js 24、pnpm 11，从 `.env.example` 准备忽略的 `apps/agent/.env`，已有文件保留原配置。默认官方 DeepSeek 只需 URL 与实际 Key：

```dotenv
AGENT_MODEL_BASE_URL=https://api.deepseek.com/v1
AGENT_MODEL_API_KEY=
```

把实际 Key 填在等号后。Key 仅在服务端读取，不写源码、前端 `VITE_*` 变量、shared 契约或安装包；shell 已有变量优先。仅官方 DeepSeek 地址可使用 `DEEPSEEK_API_KEY` 别名，显式 `AGENT_MODEL_API_KEY` 优先；自定义地址必须明确配置自己的 `AGENT_MODEL_API_KEY`。

官方 DeepSeek 默认模型 `deepseek-flash`，当前对应 DeepSeek-V4.1-Flash-1017；请求显式关闭思考，保持文字流式验收。公开接口的模型清单给出上下文 `1048576`、最大输出 `393216`，冒烟默认只用 `1024` 输出预算，不读取个人 Pi 配置或静态价格来声明实际费用。依据见 [官方接入说明](https://api-docs.deepseek.com/)、[模型元数据](https://api-docs.deepseek.com/api/list-models/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

| 环境变量                                                                                                                                                                   | 使用方式                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `AGENT_MODEL_BASE_URL`                                                                                                                                                     | OpenAI 兼容 base URL，默认 `https://api.deepseek.com/v1`，Pi 追加 `/chat/completions` |
| `AGENT_MODEL_API_KEY`                                                                                                                                                      | 对应服务的实际 Bearer Key；仅官方 DeepSeek 地址可使用 `DEEPSEEK_API_KEY` 别名         |
| `AGENT_MODEL_ID`                                                                                                                                                           | 官方 DeepSeek 可省略，默认 `deepseek-flash`；其他地址必须提供模型 ID                  |
| `AGENT_MODEL_CONTEXT_WINDOW`、`AGENT_MODEL_MAX_TOKENS`                                                                                                                     | 可选本地上下文／输出预算；其他地址默认上下文 `32768`，不代表已验证容量                |
| `AGENT_MODEL_CONNECT_TIMEOUT_MS`、`AGENT_MODEL_HEADERS_TIMEOUT_MS`、`AGENT_MODEL_FIRST_PROGRESS_TIMEOUT_MS`、`AGENT_MODEL_IDLE_TIMEOUT_MS`、`AGENT_MODEL_TOTAL_TIMEOUT_MS` | 可选正整数毫秒预算，默认值见下方执行边界                                              |

从仓库根目录执行，无需先启动 HTTP 服务、页面或数据库：

```sh
pnpm --filter @tyde/agent smoke:model --check-config
pnpm --filter @tyde/agent smoke:model
pnpm --filter @tyde/agent smoke:model --stop-after-ms 2000
```

配置检查不发送模型请求。默认冒烟发起两轮真实调用，用随机口令核对上下文召回，边接收边显示临时文字，再输出结构化结局。停止计时从 prompt 开始，只有收到模型文字、读取中的 HTTP 200 流被取消且本地结局为 stopped 才通过；尚无文字或模型已完成时提示调整停止时机。SIGINT／SIGTERM 请求停止；不将停止后的迟到输出当正常结果。

其他 OpenAI 兼容服务使用自己的 URL、Key、模型 ID；base URL 不包含 `/chat/completions`。后续普通平台代理也沿用这一配置方式，不要求 24 号专用身份／路由头。格式兼容仍需实际验证，错误会明确返回，不自行猜模型、删除不支持参数重试或回退到默认 DeepSeek。当前通过无界面命令验收，页面接入在 W3；正式部署的授权、持久化和运维仍须按对应工作包落实。直连不发送平台委托／路由头，也不伪造平台响应身份。24 号专用契约验收使用下方独立入口。

### 执行与资源边界

会话、设置、认证存储和资源加载器均显式使用内存实现；默认不构造内置终端／文件工具，不自动发现本机 Skills、Extensions、Packages、提示词或凭据。自动故障重试、压缩、摘要及预热路径关闭。工具必须显式注入白名单和参数校验，本阶段无真实业务写工具，也未交付 W4 演示工具／Skill。

模型流与 22 号产品 SSE 分开，不提供产品事件游标。合法 finish 与完整 `[DONE]`、没有先前错误以及相应 profile 的参数、身份和用量检查共同决定本轮成功；断流、残缺事件、错误后 DONE 和多工具调用均失败关闭。只有完整参数校验通过后工具才可放行，首期每轮至多一个工具；主入口目前只验文字对话，不装配业务工具。

停止会撤销本次执行资格并传播 AbortSignal，迟到文字不恢复旧执行，停止后不放行下一轮模型／工具。停止或失败前已接受的文字保留为原生 aborted／error 事实；结构化结果的 text 仅用于完整成功回答，失败片段不成为交付结果或可执行工具。授权解析与执行屏障的等待同样可取消并有准备时限。模型超时分为独立建连、响应头、首个有效进展、进展空闲和总预算；默认分别为 3、15、60、45、180 秒，上限为 300 秒。受控 HTTP 传输使用精确锁定的 Undici，单次请求独立持有并释放连接资源，不安装重试或重定向拦截器；平台取消传播及供应商实际停止、计费行为仍须真实联调。

独立用量观察只记录实际响应；缺失统计的计数为 null，费用始终未知，不把 Pi 默认 0 或静态估算当作账单。原生状态快照与可等待执行关口留在适配边界内，尚未验证 PostgreSQL 保存屏障、重启恢复、持久幂等或可靠业务写入。内存结果随进程退出丢失，不能作为产品持久完成的确认。Agent 迁移预留在 [migrations](migrations/README.md)，本阶段不建表、不运行迁移，也不修改业务 Prisma。

### 可选平台转发验收

`smoke:maas` 单独验 24 号 `chat-sse-v1` 平台契约，固定路径 `/internal/agent-maas/v1/chat/completions`，base URL 必须停在 `/internal/agent-maas/v1`。它不读取主入口 URL／Key 来补齐缺失平台配置，也不因失败切换到直连。先向平台核实地址、模型映射、路由版本、compat、上下文／输出上限、服务凭据及可信原用户来源，再填写本目录 `.env` 的可选 `AGENT_MAAS_*` 项。

| 环境变量                                                                                                                                                              | 内容                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `AGENT_MAAS_BASE_URL`                                                                                                                                                 | 已核实平台 HTTPS 地址，路径为 `/internal/agent-maas/v1`；HTTP 仅限回环隔离测试 |
| `AGENT_MAAS_MODEL_ID`、`AGENT_MAAS_ACTUAL_MODEL_IDS`                                                                                                                  | 固定请求模型，以及允许响应 model 的非空、不重复 JSON 字符串数组                |
| `AGENT_MAAS_ROUTE_VERSION`                                                                                                                                            | 平台认可的固定路由版本                                                         |
| `AGENT_MAAS_SERVICE_TOKEN`                                                                                                                                            | 平台服务 Bearer 凭据，上游 Key 由平台持有                                      |
| `AGENT_MAAS_CONTEXT_WINDOW`、`AGENT_MAAS_MAX_TOKENS`                                                                                                                  | 正整数限制，输出不超过上下文或契约上限                                         |
| `AGENT_MAAS_COMPAT`                                                                                                                                                   | 完整 compat JSON，不由供应商名称猜测或提供通用默认值                           |
| `AGENT_MAAS_IDENTITY_MODULE`                                                                                                                                          | 显式服务端 JS 模块绝对路径，导出异步 `resolveIdentity()`                       |
| `AGENT_MAAS_CONNECT_TIMEOUT_MS`、`AGENT_MAAS_HEADERS_TIMEOUT_MS`、`AGENT_MAAS_FIRST_PROGRESS_TIMEOUT_MS`、`AGENT_MAAS_IDLE_TIMEOUT_MS`、`AGENT_MAAS_TOTAL_TIMEOUT_MS` | 可选正整数毫秒预算，默认值见上文                                               |

compat 必须明确 `supportsStore`、`supportsDeveloperRole`、`supportsReasoningEffort` 三个布尔值、`maxTokensField`（`max_tokens` 或 `max_completion_tokens`）、`supportsUsageInStreaming=true`、`supportsFinishReason=true`、`thinkingFormat`（`openai`／`zai`／`qwen`）。当前 W2 不发送 sampling 或 reasoning 扩展参数；这些兼容值仍需与真实路由一起验收，格式通过不代表模型能力已验证。

身份模块属于可信服务端装配代码，导出 `resolveIdentity(signal?: AbortSignal)`，必须核验真实平台授权、撤销和稳定原主体来源，返回 `{ platformSubjectRef, serviceToken? }`；可选 serviceToken 用于当前服务凭据续期。模块应把取消信号传给授权请求并清理自己的连接、定时器等资源。每次实际模型调用重新验证，主体变化时阻断。不要在模块中用开发测试用户、硬编码 subject 或客户端自报字段伪造委托。W1 的开发测试身份不能替代 MaaS 服务鉴权。模块路径、凭据和身份结果均不得放进前端、shared 浏览器契约或安装包。

从仓库根目录运行：

```sh
pnpm --filter @tyde/agent smoke:maas --check-config
pnpm --filter @tyde/agent smoke:maas
pnpm --filter @tyde/agent smoke:maas --stop-after-ms 2000
```

`--check-config` 加载配置并调用身份模块，随后退出；不会发送模型请求，也不表示平台路由已通过。模块加载、首次授权和会话装配共用一个准备预算，取配置的总预算；超时或 SIGINT／SIGTERM 以非零状态退出，迟到解析不会启动模型请求。独立 CLI 在结局输出和本地 Session 清理后最多再保留 1 秒退出窗口，防止身份模块遗留活动句柄；作为库使用的适配器不会退出服务进程。默认冒烟发起两轮真实模型请求，用随机口令验证原生上下文连续性，输出临时流式文字和结构化结果。停止计时从 prompt 开始；仅已收到真实文字、HTTP 200 的模型流取消且本地结果为 stopped 时通过。停止发生在准备阶段、尚无文字进展或远端已完成时均失败，提示调整停止时机，不能据此宣称执行中流式停止已验通。执行中的 SIGINT／SIGTERM 请求本地停止。命令失败不回退为模拟回答。

隔离测试使用受控本机接口替身核对 SDK 真实路径、请求／响应、停止和故障。使用方尚未提供实际模型 Key，真实模型验收待配置后执行；平台转发另行按平台条件验收。HTTP 产品会话／任务／查询／SSE、页面发送、正式平台身份适配和 PostgreSQL 仍待后续工作包。页面当前只展示健康状态与草稿，真实聊天使用 `smoke:model`。

协作边界及后续工作见 [Agent 开发说明](../../docs/AGENT_DEVELOPMENT.md)。
