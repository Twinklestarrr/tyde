# Agent 服务

独立 Fastify 服务，默认监听 `http://127.0.0.1:3002`。W1 提供健康、Swagger、受控身份和命令摘要基础；W2 增加 Pi 1.3.0 内存执行、MaaS 协议校验及无界面验证入口。W3 增加 `/api/agent/v1/conversations` 下的开发内存 API、任务协调与产品 SSE。健康响应仍只表示 HTTP 进程存活；聊天需要显式身份和服务端模型配置。

在仓库根目录使用 Node.js 24 与 pnpm 11 安装依赖后：

```sh
pnpm --filter @tyde/agent dev
pnpm --filter @tyde/agent test
pnpm --filter @tyde/agent build
pnpm --filter @tyde/agent start
```

配置可通过 shell 注入，或复制 `.env.example` 为本目录 `.env`。`dev` 和 `start` 按需读取该文件，shell 已有变量优先；未配置时使用回环地址和 3002 端口。`NODE_ENV` 仅接受 `development`、`test`、`production`。`AGENT_HOST` 不含协议或端口，`AGENT_PORT` 为 1～65535 的整数。

W1 已提供受控测试身份适配器，默认 `AGENT_AUTH_MODE=disabled`。资源接口通过 `app.agentAccess.authenticate(request)` 取得服务端验证后的用户，再调用 `requireOwnedConversation` 校验可信存储中的会话归属；不存在、已删除或其他用户会话统一返回 404。请求 body、query、Cookie 和自报用户头不能证明身份。会话、命令、快照与 SSE 已复用此边界；SSE 每批发送及存活期间复核身份与归属，身份撤销后关闭。

需要本机开发身份时，显式设置 `AGENT_AUTH_MODE=development`、`AGENT_TEST_USER_ID` 和 `AGENT_TEST_BEARER_TOKEN`。用户标识固定在服务端；凭证须至少 32 字符，可在本机使用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成，存入忽略的 `.env`，请求时放入 `Authorization: Bearer …`。此模式仅允许 `development`／`test` 环境，且 `AGENT_HOST` 必须为字面地址 `127.0.0.1` 或 `::1`；禁止在生产、主机名或其他监听地址启用。不要把测试凭证提交到仓库、放入前端 `VITE_*` 变量或 URL。

平台身份预留 `createApp(config, { identityAdapter })` 服务端注入点，后续由适配器验证真实平台 Bearer 及撤销状态；开发身份与平台适配器不能同时装配。默认未装配时资源身份验证失败关闭，格式合法的 Bearer 因无法验证返回 503；缺失／格式非法的凭证，以及已装配适配器判定无效的凭证返回 401。匿名健康检查和 Swagger 不变。`pnpm --filter @tyde/agent test` 覆盖显式配置、凭证验证、客户端伪造身份、归属／删除隔离、平台撤销及验证异常。

## W3 浏览器聊天与本机身份

先实际核对 `node --version` 为 24.19.0、`pnpm --version` 为 11.23.0；`.nvmrc` 不会自动切换终端，使用相应版本管理器切换后再执行。

保留现有 `apps/agent/.env`，仅补齐缺少的本机身份项。先执行下面命令生成一个新的本机凭据，再填入配置；它与模型 Key 是两种凭据，不互相替代：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```dotenv
NODE_ENV=development
AGENT_HOST=127.0.0.1
AGENT_AUTH_MODE=development
AGENT_TEST_USER_ID=local-agent-user
AGENT_TEST_BEARER_TOKEN=填入刚生成的凭据
```

真实聊天沿用本文件下方说明的服务端 `AGENT_MODEL_BASE_URL`／`AGENT_MODEL_API_KEY`／可选 `AGENT_MODEL_ID`。不要覆盖已有值，不把任何凭据放入 `VITE_*`。在仓库根分别启动 `pnpm dev:agent` 和 `pnpm dev:agent-web`，浏览器打开 `http://127.0.0.1:3003`，在身份框输入刚配置的开发 Bearer，点击连接和新建会话。页面只在内存持有身份凭据，刷新后重新输入，按 URL 会话 ID 从服务恢复展示。

`src/runtime/memory-runtime.ts` 维护同进程会话、命令裁决、输入消费、产品投影和最多 10000 条冻结事件；`src/api/` 负责严格 JSON、身份、Swagger、SSE 串行发送与有界背压。开发模式只支持 `business_query` 的 `start_task` 和 `stop_attempt`，其他命令及 `scheduling_draft` 返回 422，页面不开放。普通问答完成后追问创建新 Task，同一 Conversation 懒绑定且固定复用一个 Pi Session；停止或失败目标不能靠新 Task 绕过，可另开会话。

未指定标题的会话在首条用户输入受理时生成标题预览：折叠空白、保留前 80 个 Unicode 码点，不覆盖自定义标题，也不额外调用模型。列表、概况、快照与会话更新事件使用同一标题。页面使用服务端消息时间展示右下角时间（跨日带日期），使用 Attempt 起止时间计算耗时；模型请求／工具执行只展示已用次数，隐藏总额度不改变下方预算保护。页面配色与业务前端品牌保持一致；继续／重试仍未开放。

| 路径（均在 `/api/agent/v1` 下）                                                              | 能力                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `POST/GET /conversations`                                                                    | 创建空会话（不自动重试）、当前用户列表与签名分页 |
| `GET /conversations/{id}`、`/{id}/snapshot`                                                  | 概况、一致产品快照与水位 H                       |
| `GET /conversations/{id}/messages`、`/{id}/tasks/{task_id}`、`/{id}/results/{result_id}`     | 历史、任务与不可变结果                           |
| `POST /conversations/{id}/commands`、`GET /conversations/{id}/commands/by-key/{request_key}` | 原 key 幂等裁决与只读核实                        |
| `GET /conversations/{id}/events?stream_id=…&after_seq=…`                                     | H 之后顺序补读；control／delta／心跳不推进游标   |

每个 Attempt 默认 600000ms、12 次模型发送授权、10 次工具执行授权。放行前原子预占、失败不退、同 key 重放不重置；期限与停止、完成共用同步裁决，最终发送前再次检查资格，单请求超时受剩余时长限制。用量缺失依然是 null，与次数预算和费用分开。虚拟时钟覆盖边界；本轮不表示 26 号的正式持久预占、持久 deadline、恢复保护或真实十分钟落库验收已完成。

停止的 202 只确认受理，任务先显示 stopping，执行收敛才显示 stopped。断开 SSE、切换、刷新均不停止或启动任务。服务进程退出后全部会话、幂等记录和旧游标失效，404 会提示新建会话；不使用 JSONL 或数据库兜底。

## W2 Pi 与模型接入

模型主入口采用服务端 URL 与 Key，复用 Pi 内置的 `openai-completions` 适配、上下文和工具循环。默认官方 DeepSeek，其他兼容地址显式配置模型 ID。24 号平台转发作为独立可选路径保留，主入口无需平台身份模块、路由版本或委托头。当前 24 号设计已明确 URL／Key 是长期主入口，专用平台鉴权和路由握手属于可选扩展；两条路径均不自动切换供应商、模型或鉴权方式。

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

其他 OpenAI 兼容服务使用自己的 URL、Key、模型 ID；base URL 不包含 `/chat/completions`。后续普通平台代理也沿用这一配置方式，不要求 24 号专用身份／路由头。格式兼容仍需实际验证，错误会明确返回，不自行猜模型、删除不支持参数重试或回退到默认 DeepSeek。当前同时提供无界面命令和 W3 浏览器验收；正式部署的授权、持久化和运维仍须按对应工作包落实。直连不发送平台委托／路由头，也不伪造平台响应身份。24 号专用契约验收使用下方独立入口。

### 执行与资源边界

会话、设置、认证存储和资源加载器均显式使用内存实现；默认不构造内置终端／文件工具，不自动发现本机 Skills、Extensions、Packages、提示词或凭据。自动故障重试、压缩、摘要及预热路径关闭。W4 提供受控宿主注入接口；具体演示工具、Skill 和数据仅留本机 `.local/agent-w4-demo/`，默认入口不加载，通用代码不依赖它们。无真实业务写工具。

模型流与 22 号产品 SSE 分开；产品事件游标由协调器独立维护，不透传模型 SSE。合法 finish 与完整 `[DONE]`、没有先前错误以及相应 profile 的参数、身份和用量检查共同决定本轮成功；断流、残缺事件、错误后 DONE 和多工具调用均失败关闭。完整原始参数须通过 schema 及宿主验证，未知字段、类型转换、越界均不放行；每轮至多一个工具，顺序执行。工具失败锁住 Pi 会话，不当作可恢复错误。

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

隔离测试使用受控本机接口替身核对 SDK 真实路径、请求／响应、停止和故障。用户已提供 DeepSeek Flash 的 W2 真实两轮召回、流式与本地停止通过日志；DeepSeek V4 Pro 仅配置检查，可选平台路径尚未真实联调。W3 页面已接通同一模型入口，真实浏览器结果见 [W3 验证记录](../../docs/AGENT_W3_VALIDATION.md)。正式平台身份与 PostgreSQL 仍待后续工作包。

协作边界及后续工作见 [Agent 开发说明](../../docs/AGENT_DEVELOPMENT.md)。

## W4 受控宿主装配与追溯

`createApp(config, { resources })` 接受 `freezePiResources` 生成的可信冻结资源，默认 `main.ts` 不装配资源，也不读 `.local/`。宿主显式提供已读取的固定文本、预期 SHA-256、逻辑版本、工具声明与数据／代码资产身份。加载顺序为基础提示词 → Skill 正文 → 非提示词资产；所有摘要先校验，缺失或不符立即拒绝。工具声明摘要覆盖名称、描述、schema、时限及公开元数据。执行期间不重新读资源，同一 Pi Session 的配置固定。

Skill 采用 `host-preloaded-system-prompt`：将已校验的固定正文放入实际 system prompt。Pi 1.3.0 的 `getSkills` 仍为空，`expandPromptTemplates:false` 保持，不宣称自动发现或原生按需读取已验通；不开放 read、bash、目录扫描或页面指定服务器路径。

显式工具保留完整原生调用及结果，`modelRequestId` 在授权／HTTP／用量记录／工具关联中一致，`toolCallId` 用于授权去重及阻止重复执行。`PiMemoryBarriers` 和运行时的 `saveNativeState`／`beforeDispatch` 为可等待保存和最终派发门禁；拒绝后阻断后续模型／工具，失败不退授权。`PiNativeState.configuration` 捕获模型声明、资源 manifest、工具声明与配置摘要，不含 Key 或身份凭据；这是服务端捕获信封，原生 header／entries／leafId 不变。

工具局部超时默认 30 秒，显式上限不超过 300 秒；Attempt deadline 单独锁存并通过同一取消信号生效。停止前后与异步保存后均复检资格。用户停止、预算取消、工具超时和执行失败分开；不协作的迟到结果不能恢复执行。普通工具异常会锁住本次 Pi 会话，继续／重试仍未开放。

产品只返回 `tool_executions` 安全投影和 `tool.updated` 可靠事件，不返回原始参数、SDK 事件、完整结果、服务端路径或思考，不生成业务 Operation。快照、历史、任务和结果读取均关联真实调用；刷新／重连只补展示。旧冻结读取可缺少可选数组，新服务始终返回数组；未知可靠事件仍失败关闭。

本机演示包在 `.local/agent-w4-demo/`，不提交。仅拉取通用代码不能直接复现该演示，普通聊天、测试和构建完全不依赖它。已具备本机包时先运行 `pnpm build:agent` 和 `pnpm build:agent-web`，再按包内 README 显式启动，使用独立 3102／3103；原 `.env` 仅由进程读取，不复制到 worktree。实际证据及 W5 协作见 [W4 验收记录](../../docs/AGENT_W4_VALIDATION.md)。
