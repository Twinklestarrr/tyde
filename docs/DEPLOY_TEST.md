# 测试环境部署（无 Docker）

2026-10-23开发环境更新：用户执行`pnpm --filter @tyde/server db:deploy`，日志确认目标为本机`127.0.0.1:5432/tyde_outside`（public），共发现21个迁移，本次成功应用`20261022020000_auto_grading_callback_digest`，命令报告全部迁移应用成功。随后`pnpm dev:server`完成shared构建和Prisma客户端生成，服务已监听`http://127.0.0.1:3000`。该结果确认开发库第21迁移及服务启动，不代表部署库迁移、health/ready或真实HTTP业务写链路已验收；本轮Agent仅同步用户日志，未运行命令复验、修改业务代码或操作数据库。默认入口仍为08（未开始），先068/069再070/071；07本批5项通过证据保留，无需重复。所有业务Agent继续mock。

2026-10-22第七批最新复验：用户2026-10-22回传16:04:30启动的本批6项集成全部通过（1文件，171跳过，共177项，总6.63秒，测试4.35秒）；并发领取、签名HTTP回调/幂等、失败重试/旧trace拒绝、补偿及不可逆反转回滚、权限/逐题来源、超时和outbox故障整事务回滚已验证。第21迁移所需专用测试库结构已具备，迁移历史未另查；不是全177项复跑。原127.0.0.1:5432初始化连接阻塞解除，无需当前专用库再次迁移21或重复本批6项。 开发/部署库与真实HTTP写链路仍待独立验收；本轮仅同步用户结果，无测试重跑或数据库操作。05基础已交接06，06尚未实施。

2026-10-22第七批（最新）：API-050重试/051补偿/052 HMAC回调已接入，按用户约定只用mock。新增第21迁移`20261022020000_auto_grading_callback_digest`，Agent未应用；上线前目标库须应用21，否则既有record查询也可能缺列。新增可选后端密钥`AUTO_GRADING_HMAC_SECRET`至少32位且与`CODE_HMAC_SECRET`不同，留空回调503；不配置真实Agent地址。382项单测、类型/变更ESLint/后端build通过；新增6项集成曾在初始化连接失败，现用户16:04:30复跑全部通过，原阻塞解除；05基础已交接06，本轮未执行06。

本批已通过，无需重复；以下仅为需要时复查命令，在`tyde/`先运行`pnpm db:deploy:test`（读取`.env.test`，仅部署迁移、不清库），再运行`pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t 'auto grading'`（会清空专用_test库，177项中仅本批6项、171跳过）。无需重做049已过5项或040/048；开发/部署库独立确认后才应用全部待执行迁移，Agent本批未操作。mock执行命令、签名规范与超时行为见[考试基础第七批](ENTRANCE_EXAM_MANAGEMENT.md#自动阅卷重试与补偿api-050052第七批)。CLI仅按指定记录显式运行，不启动后台任务或调用真实Agent；与本地后端使用相同专用密钥，不能以开发库运行集成测试。以下“050—052尚未实现/无新迁移”均为前批历史。

2026-10-22第六批人工阅卷：新增API-049主链路（部分迁移），没有新增迁移、依赖或环境变量；沿用已具备第20结构的专用测试库。367项单测及类型/变更ESLint/后端build通过；用户2026-10-22回传15:37:53定向集成5项全部通过（1文件，166跳过，总13.17秒，测试4.10秒），本批人工提交并发、轮次推进/裁决、准入成员、逐题来源与事务回滚数据库断言已验证，原初始化连接阻塞解除；本次不是全171项复跑，迁移历史未另查，本批无新迁移。无需重复本批5项，不要求重迁18—20或重跑040/048。下一AUTO只持久化provider=mock/NOT_EXECUTED派发事实，尚无执行器；050—052及专用HMAC回调未实现，不配置或联调真实Agent。保持05，不开始06；跨领域支线/转项消费/实际投递分别待04/12/14回补。

2026-10-22用户明确约定：所有业务Agent相关功能先使用mock，不连接真实Agent服务、不进行真实Agent联调。后续自动阅卷派发/执行/回调先由可控mock覆盖成功、失败和重试等场景，Swagger及验收记录明确模拟来源；业务权限、逐题来源、事务/轮次、专用HMAC、时间/重放/幂等仍须按本地接口验证。此约定不表示未开发接口已有实现，不将预置读取夹具当成真实交卷或阅卷执行。 当前无需配置真实Agent服务地址/密钥以开展本地模拟；049—052尚未开发，不能据此认定mock执行能力已经上线。用户本轮开发库20迁移已成功应用，服务已启动，040/048本批168项真实HTTP记录已全部通过（16种方法/路径，非空读取和权限回收已验证），见[验收记录](EXAM_READ_ACCEPTANCE.md)。以下“开发库未应用/未验证”为此前记录，部署环境仍需单独确认。

2026-10-22考试阅卷详情新增第20迁移`20261022010000_entrance_exam_grading_details`（逐题答案/判卷及同试卷、同考生、同题来源约束），Agent未应用迁移；用户13:16:29定向3项集成全部通过（163跳过，总4.64秒），专用库所需结构及来源/删除保护已验证，原断言阻塞解除，迁移历史未另查。当前专用库无需再次迁移20或重复验收，按需复查命令为`pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t 'grading detail'`（3项，集成会清专用库）。开发/部署库单独确认目标后运行`pnpm db:deploy`，不清理现有数据；不要对开发库运行集成测试。353项单测及后端build已通过，本批3项数据库复验及040/048的168项真实HTTP已通过，部署验收尚未完成，详情见[05任务记录](../../backend-migration/05-exam-management/todoTask.md)。以下19迁移已验证/无需重复的记录只适用于原批次，不代表20迁移已应用。

当前运行服务验收：2026-10-22统一账号真实HTTP验收完成：255项检查全部通过（254个HTTP请求+1项并发汇总断言，覆盖46种方法/路径）。统一注册/三角色、会话隔离、Cookie/来源、多组织创建/导入/管理权限、刷新/退出/改密、真实OSS证照与项目/考试附件均通过；项目发布→策略官任职→生产计划→考试导入/发布/版本编辑/关闭及更换策略官后的权限回收均通过。用户仅补本批3个分类，未修改已有用户或清库、未应用迁移。未接远程文档503为预期能力边界，部署/前端联调及未开发考生/阅卷写入口仍待原任务回补。默认恢复05的040/048—052，本轮不执行05或06。 见[验收记录](UNIFIED_ACCOUNTS_ACCEPTANCE.md)。下方未验证开发HTTP系前批历史结论，以本条为最新；部署目标仍须单独核对迁移。

> 2026-10-22现行规则：本轮新增第19迁移20261022000000_unified_accounts，须先迁移后启动后端。专用测试库使用pnpm db:deploy:test后pnpm test:integration；前者强制读取.env.test并检查_test库名、APP_ENV=test和TEST_DATABASE_RESET=true，只应用迁移；后者会清表。开发/部署库单独核对目标再运行pnpm db:deploy，不自动清理。原18迁移及162项旧集成结果不作为本批验收。详见[统一账号与组织创建](UNIFIED_ACCOUNTS.md)。本轮证据见[插队任务](../../backend-migration/priority-unified-accounts/todoTask.md)。

本批343单测、41项定向及typecheck/build/ESLint为前批证据。用户2026-10-22回传10:28:08启动的161项集成全部通过（1文件，总82.14秒，测试79.27秒）。第19迁移所需专用测试库结构、统一账号三角色、多组织创建及并发唯一性、证照/成员/策略官事件/生产计划嵌套写入回滚已验证，原两项故障注入测试主体失败解除；迁移历史未另查；该161项结果回传时开发HTTP/OSS尚未验证，后续本次255项真实验收已通过，部署库/前端联调仍未验证。 当前专用库无需再次迁移或重跑161项；开发/部署仍需独立核对目标。统一账号插队基础已交回05，本轮只同步记录、未重跑测试或操作数据库。平台适配类型前批通过，Web依赖/页面类型问题仍保留。

阿里云 Linux 使用包含 Web 的后端包部署，Vercel 使用同一套合并构建。具体 ECS/RDS、CPU、域名和证书申请完成后填写。部署包可先在 Mac 本地生成；不能把 Mac 的 node_modules 复制到 Linux。

## 生成产物

```sh
pnpm install --frozen-lockfile
pnpm package:server
# 仅在需要独立静态站点交付时另行执行：
# pnpm package:web
```

`artifacts/tyde-server-0.1.0.tar.gz` 包含编译后的后端、Web 静态资源（`apps/server/public`）、共享包、迁移、原始 lockfile 与部署模板，不含秘密、数据库或开发机运行依赖。阿里云部署只需这个包，不需要另传 Web 包。可选的 `artifacts/tyde-web-0.1.0.tar.gz` 仍用于独立静态站点交付。旁边 `.sha256` 用于校验。安装依赖时仍需目标机网络；此交付不是无网络全离线镜像。

## 后端

1. 准备 Node 24、pnpm 11.23.0、PostgreSQL 18（或兼容版本），创建独立测试数据库与仅用于项目的用户。
2. 解压后端包到 `/opt/tyde`（示例路径）；以非 root 用户管理运行进程。
3. 在该目录执行 `pnpm install --prod --filter @tyde/server... --frozen-lockfile`。
4. 复制 `apps/server/.env.example` 为 `.env`，设置权限 0600，并填写下表配置。
5. 执行 `pnpm --filter @tyde/server db:generate`，在目标 OS 生成 Prisma 引擎。
6. 执行 `pnpm --filter @tyde/server db:deploy`，应用提交的迁移。变更已有环境前先备份，不执行 `migrate reset` 或 `db push`。
7. 在 `apps/server` 执行 `node --env-file=.env dist/main.js` 验证启动，然后使用 `deploy/tyde.service.example` 配置 systemd。该进程同时提供 Web 与 API，Web 资源路径相对于编译模块解析，不依赖启动工作目录。
8. 使用 `deploy/nginx-server.conf.example` 配置 HTTPS，把全部路径代理至 `127.0.0.1:3000`。无需独立静态站点目录；保留 `/api/v1` 前缀。页面域名须加入 `WEB_ORIGINS`。
9. 验证 HTTPS 根路径登录页、JS/CSS、live / ready、Swagger，以及登录、刷新恢复和退出。缺少页面时检查是否使用完整后端包，不要只复制 `dist`。

| 配置             | 测试环境设置                                                                |
| ---------------- | --------------------------------------------------------------------------- |
| APP_ENV          | `test`（允许显式 mock；production 会拒绝启动）                              |
| NODE_ENV         | 进程使用 `production`，与 APP_ENV 区分                                      |
| HOST / PORT      | 默认 `127.0.0.1` / `3000`，同机 Nginx 代理                                  |
| DATABASE_URL     | 测试库真实连接串，密码中的特殊符号需 URL 编码                               |
| SMS_PROVIDER     | `mock`                                                                      |
| CODE_HMAC_SECRET | 至少 32 个随机字符；例如本机 Node crypto 生成后安全填入                     |
| WEB_ORIGINS      | 真实 `https://测试域名`，不带路径和结尾斜线；多个以逗号分隔                 |
| DESKTOP_ORIGINS  | 默认 `tyde-app://app`；桌面开发需加入完整回环源，如 `http://127.0.0.1:5174` |
| COOKIE_SECURE    | `true`                                                                      |
| TRUST_PROXY      | 同机 Nginx 时 `127.0.0.1/32,::1/128`，其他拓扑按可信代理地址填写            |
| LOG_LEVEL        | `info`                                                                      |

Prisma CLI 放在服务端生产依赖中用于迁移和目标平台生成；不得为缩小包而移除必需 CLI 后继续声称可部署。`pnpm-workspace.yaml` 的生产允许脚本与依赖覆盖需一同保留。

## Vercel 前后端合并部署

保留现有后端 Vercel 项目（`tyde-outside-server`），由同一次部署发布 Web 静态资源与 Fastify API。浏览器访问同一个域名的 `/` 和 `/api/v1/*`，不再需要独立 Web 项目的跨项目转发。Electron 继续连接该域名的 API。

### 一次性项目设置

在现有后端项目的 Settings 中确认以下设置；代码无法代替控制台修改 Root Directory、Git 关联或环境变量。

| 设置                                                                 | 值                                              |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| Git Repository / Production Branch                                   | 关联本仓库与实际发布分支，保持 Git 自动部署开启 |
| Root Directory                                                       | `apps/server`                                   |
| Include source files outside of the Root Directory in the Build Step | 开启；构建需要 `apps/web`、`packages/` 与根配置 |
| Node.js Version                                                      | `24.x`                                          |
| Framework Preset                                                     | `Fastify`                                       |
| Output Directory                                                     | 关闭 Override，使用 Fastify 默认值              |
| Skip deployment / Skip unaffected projects                           | 关闭，确保仅修改 Web 也会触发合并部署           |

`apps/server/vercel.json` 随代码指定 Install Command 为 `pnpm install --frozen-lockfile`，Build Command 为 `pnpm --dir ../.. build:vercel`，并用 `outputDirectory: null` 恢复框架默认输出设置。控制台 Output Directory 同样建议关闭 Override，不显式指定 `public` 或 `dist`：Fastify 构建器会在显式输出目录中寻找后端入口，而 `public` 仅包含前端资源，会导致入口检测失败。页面资源通过文件追踪随 Function 一起打包，`src/app.ts` 注册与阿里云相同的静态托管。不要依赖 Fastify preset 自动发布构建后才生成的 `public` 目录。清理旧的构建覆盖配置，部署日志应执行上述合并命令，而不是旧的 `pnpm run build`。`ignoreCommand: exit 1` 表示继续构建，避免旧的 Ignored Build Step 只检查后端变更；它不能代替关闭控制台的 Skip unaffected projects。

安装需保留开发依赖，不要使用 `--prod`。完整仓库可访问选项见 [Vercel Monorepos FAQ](https://vercel.com/docs/monorepos/monorepo-faq)，构建跳过机制见 [Vercel Monorepos](https://vercel.com/docs/monorepos)。

### 构建与请求路由

在仓库根目录可执行与 Vercel 相同的构建：

```sh
pnpm build:vercel
```

`build:vercel` 调用与阿里云交付相同的 `pnpm build:server`。该命令先编译 shared、platform、检查 Web 类型，再让 Vite 将 Web 输出到 `apps/server/public`；随后编译 shared、生成 Prisma Client、编译后端。Vite 每次清理专用输出目录，避免旧资源残留。该目录已从 Git、ESLint 和 Prettier 检查中忽略，只提交源码、锁文件与构建配置。普通 `pnpm build:web` 仍输出 `apps/web/dist`，供 Electron 与独立 Web 交付使用。

Node 服务端的网络响应使用现有 `undici-types` 显式类型。日历服务不再依赖全局 `typeof fetch` 推断响应：当构建环境注入不完整 Web 全局声明时，Node 的全局 `Response` 可能缺少 `ok`/`text()`，即使普通后端 `tsc` 通过，平台后续类型检查仍会报TS2339。这里只导入类型，运行时继续使用 Node 原生 fetch，不新增运行时依赖或放宽编译检查。回归命令：`pnpm --filter @tyde/server exec vitest run tests/holiday-fetch-types.test.ts tests/personal-workbench.test.ts`，其中编译用例通过内存中的部分 Web 全局声明复现平台环境，不修改实际全局类型。

2026-10-21构建修复验证：上述11项定向测试、服务端typecheck、变更ESLint及`pnpm --filter @tyde/server build`通过。Agent本机`pnpm build:vercel`在Web阶段因既有安装目录缺少已声明的前端依赖失败，未完成本机全链构建；用户日志的Web阶段已成功。未执行线上Vercel构建或部署，修复后的平台复验仍需重新触发部署。本次无数据库改动，不应用第17迁移、不重跑数据库集成。

Vercel 通过 `src/app.ts` 默认导出的 HTTP server 提供页面和 API，入口注册 `registerWeb` 托管 `public`。`web.ts` 直接枚举固定的 Web 目录，使文件追踪包含 HTML 与动态命名的 JS/CSS。根路径直接返回首页，不依赖 `/` 的平台重写；页面采用 HashRouter，无需全路径 SPA fallback，未知 API 不会变成 HTML 页面。入口 HTML 每次使用前重新验证缓存，Vite 带内容摘要的 `/assets/*` 资源允许长期缓存。Fastify 部署入口约束见 [Vercel Fastify 文档](https://vercel.com/docs/frameworks/backend/fastify)。

2026-10-26 页面更新排查：`pnpm build:vercel` 完整通过；`https://aact.pw` 的 HTML、JS、CSS 与本地当前源码构建逐字节一致。线上 HTML 的修改时间固定为 `2018-10-20T01:46:40Z`，原静态插件按文件大小和修改时间计算 ETag；不同版本 HTML 长度相同时可产生同一验证器，导致浏览器收到 304 后保留旧资源引用。`/`、`/index.html` 现改为显式返回 HTML 正文，不发送 ETag/Last-Modified，也不按旧条件请求返回 304；带摘要资源继续长期缓存。修复需重新部署才在线上生效。回归命令：`pnpm --filter @tyde/server exec vitest run tests/web.test.ts`。未修改数据库、执行迁移或发布部署。

```text
同一个 Vercel 项目、同一个域名
  /、/index.html、/assets/* → Fastify Function 提供 Web
  /api/v1/*               → Fastify Function 提供 API
```

阿里云的独立入口 `src/main.ts` 与 Vercel 的 `src/app.ts` 均在 API 装配后注册 `src/web.ts`，托管同一个 `public` 目录。本地未构建 Web 时 `pnpm dev:server` 可仅启动 API；存在构建产物时也能访问根路径页面。

### 环境变量与迁移

沿用后端数据库与密钥配置，设置 `APP_ENV=test`、`SMS_PROVIDER=mock`、`COOKIE_SECURE=true`。`WEB_ORIGINS` 必须包含用户实际访问页面的完整 HTTPS 源，例如 `https://tyde-outside-server.vercel.app`；如使用 `https://aact.pw` 等自定义域名，也须逐个加入。保留仍在使用的 HTTPS 本地开发源，多个地址以逗号分隔，不带路径或结尾斜线。

Preview 部署要进行登录联调时，也需显式允许其实际源地址；不自动放行任意 Preview 域名。环境变量变化后重新部署。当前 `APP_ENV=production` 会被配置校验拒绝，Vercel 的 Production 发布环境仍使用上述测试业务配置。

数据库必须能从 Vercel 访问，发布前对目标库执行已有迁移。合并构建不执行数据库迁移，也不将后端 `.env` 复制到 Web 产物；后端密钥不得改为 `VITE_*` 环境变量。

### 切换与验收

1. 提交并 push 源码到发布分支，确认现有后端项目自动执行合并构建。
2. 访问后端固定域名 `/`，确认显示登录页，浏览器 Network 中 JS/CSS 成功加载，API 请求访问同域 `/api/v1/*`。
3. 验证 `/api/v1/health/live`、`/api/v1/health/ready`、`/api/v1/docs/` 与 `/api/v1/docs/json`。ready 必须成功；未知 `/api/v1/not-found` 应返回 404，不能返回 Web HTML。
4. 验证验证码登录、新用户注册、刷新恢复、退出；验证 Electron 仍可登录并恢复会话。
5. 再提交一次仅修改 Web 源码的变更，确认也能触发后端项目自动部署并更新页面。
6. 如需保留原 Web 自定义域名，先迁移至合并项目并更新 `WEB_ORIGINS`、验证登录；完成后再由项目管理员下架原独立 Web 项目。原 `*.vercel.app` 项目域名不能当作自定义域名直接迁移。

`apps/web/vercel.json` 是原独立 Web 项目的过渡配置，合并项目不会读取它；在旧项目下架前保留，便于切换期间继续使用。现有 Web 会话 Cookie 属于原域名，改用后端域名后通常需要重新登录。

## Web 与 HTTPS

默认的阿里云合并部署使用 `deploy/nginx-server.conf.example`：Nginx 终止 HTTPS，所有请求转发给同一个 Fastify 服务。入口 HTML 重新验证缓存，`/assets/*` 使用长期缓存；缺失页面或 API 返回 404，不做全路径 HTML 回退。

如果需要分开交付，仍可使用原独立静态站点方式：把 Web 包的 `web/` 内容部署到 Nginx 静态根目录，按实际域名、证书和目录修改 `nginx.conf.example`。保留 `/api/` 路径转发至后端，不剥离 `/api/v1`。Web 使用 hash 路由，无需 history fallback。

```sh
nginx -t
# 配置校验通过后由运维加载 Nginx 配置
curl --fail https://test.example.com/api/v1/health/live
curl --fail https://test.example.com/api/v1/health/ready
```

HTTPS 环境的网页与桌面连接同一域名：合并部署中页面和 API 均由同一后端提供，桌面页面直接 fetch 该域名 `/api/v1`，IPC 仅返回公开运行配置。后端须部署桌面来源/CORS/Cookie 适配，精确放行 `DESKTOP_ORIGINS`，不得使用通配 CORS；审批/导入预检允许 `Idempotency-Key`，模板下载暴露 `Content-Disposition`；桌面 Cookie 为 SameSite=None+Secure，普通 Web 保持原策略。旧主进程 Bearer 会话不迁移，升级后需重新登录。仅开放必要网络入口，数据库不对测试人员电脑直接暴露。

## Swagger 文档验收

部署后访问 `https://真实测试域名/api/v1/docs/`；现有 `/api/` 代理会同时转发 UI、静态资源和 OpenAPI JSON/YAML，无需增加独立代理路径。插件为 Swagger 页面设置 CSP；保留响应头并确认浏览器控制台没有资源加载错误。

```sh
curl --fail https://test.example.com/api/v1/docs/json
curl --fail https://test.example.com/api/v1/docs/yaml
```

文档端点随服务启动即可访问，不要求数据库已就绪，也未单独设置登录门槛。需要限制测试文档访问时，在网关对整个 `/api/v1/docs` 路径及其子路径统一设置访问控制。Swagger UI 调试 POST 必须从 `WEB_ORIGINS` 中的同源 HTTPS 页面发起；Cookie 按当前 `COOKIE_SECURE` 配置自动处理。完整说明见 [API 文档说明](API.md)。

## 桌面分发

桌面安装包默认连接 `https://aact.pw`，本地开发仍默认连接本机后端。

Mac：`pnpm package:mac`；Windows：`pnpm package:win`。

打包时仍可设置 `TYDE_API_BASE_URL` 覆盖默认地址；例如本地联调包使用 `TYDE_API_BASE_URL=http://127.0.0.1:3000 pnpm package:mac`，Windows PowerShell 先设置 `$env:TYDE_API_BASE_URL='http://127.0.0.1:3000'`，再运行 `pnpm package:win`。

运行 `node scripts/checksums.mjs release`，把安装包、SHA256SUMS 和 `docs/INSTALL_TRIAL.md` 一起交付。没有测试环境时可以打本地包检查安装和页面，但跨电脑完整登录需先有可达后端。

## 验收与更新

- Web 和两种桌面系统分别验证新账号注册、老账号登录、重启恢复、退出和网络失败。
- live 成功、ready 失败表示服务进程存活但数据库未就绪，不能当作部署成功。
- 日志通过 systemd journal 或进程 stdout 查看；请求编号用于关联错误，不记录请求体、验证码或会话令牌。
- 试用期间可执行 `pnpm db:cleanup` 清理过期记录；此源码命令需要开发依赖。部署包直接运行 `node --env-file=.env dist/cleanup.js`（在 apps/server 目录）。
- 更新前备份数据库与当前版本，应用迁移再切换服务；回退前检查迁移兼容性，不能承诺任意数据库变更可直接回滚。

所有 example 域名、目录和配置均为占位；本文不表示已完成阿里云部署。

### 文件存储与上传（01）

上传、批量上传、鉴权代理、非敏感签名链接和本人未认领文件删除接口已接入。适配器使用 `ali-oss@6.23.0`，类型依赖 `@types/ali-oss@6.23.3`；保留 SDK V1 签名以兼容旧图片最大有效期。接口及权限边界见 [API](API.md#文件上传凭证与访问)。SDK 参考 [ali-oss 官方说明](https://github.com/ali-sdk/ali-oss#readme)。

2026-10-19 用户明确指定使用上海区域 bucket `lsh-oss-agi-tool-platform`。本地后端 `.env` 已配置，密钥仅留在被 Git 忽略的后端环境文件；其他部署环境须单独注入，示例仍默认 `FILE_STORAGE_PROVIDER=disabled`。本次授权使用指定 bucket 不代表旧台账与新库互通，也不修改 bucket 设置或既有对象。新上传对象显式 `private`，并设置禁止覆盖同名对象；RAM 凭据须允许相应对象上传、读取和删除。

- `FILE_STORAGE_PROVIDER=oss`：启用存储。
- `OSS_ENDPOINT=https://oss-cn-shanghai-internal.aliyuncs.com`：后端读写端点，适用于具备上海 OSS 内网连通性的阿里云环境；本机/Vercel 使用 `https://oss-cn-shanghai.aliyuncs.com`，不会自动降级或切换网络。
- `OSS_PUBLIC_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com`：非敏感文件签名链接端点。省略时从读写端点推导同区域外网端点，禁止内网或不同区域端点；不支持自定义 CNAME。两个端点均接受省略 `https://` 的主机名，但拒绝 HTTP、bucket 子域、路径、查询、用户信息。
- 项目物理主目录固定为 `lsh-oss-agi-tool-platform/tyde/`；OSS适配器对上传、HEAD、流读取、签名和删除统一添加 `tyde/`。例如业务键 `common/2026/10/19/<UUID>.png` 对应OSS键 `tyde/common/2026/10/19/<UUID>.png`。API和台账保留相对业务键，客户端原样传入，不自行添加前缀；本次未搬迁既有根目录对象，也不回退访问根目录对象。
- `OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`：仅供后端使用，不配置到 Web/Electron。不要将实际密钥或签名链接写入文档和日志。

从 `tyde/` 执行独立存储验证（不连接数据库）：

```bash
# 本机用外网端点；shell 环境变量优先于后端 .env。
OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com pnpm --filter @tyde/server storage:verify
# 阿里云同区域环境直接使用 .env 的内网配置。
pnpm --filter @tyde/server storage:verify
```

脚本仅写入随机 `tyde/common/oss-verification/<UUID>.txt` 并在 finally 尝试删除，不枚举或删除既有对象。验证 PUT、HEAD、流式 GET 内容、普通/图片最大有效期外网签名 GET、DELETE、删除后 HEAD=null/GET=404 和重复 DELETE。若清理失败，按输出的对象键人工删除本次对象。SDK 同步异常和下载流中途异常对接口统一脱敏；404 的 NoSuchKey 与 bucket/权限错误区分，其他失败返回503。此脚本通过只代表基础对象操作通过，HTTP 上传/台账/认领及真实失败恢复仍需业务环境验收。2026-10-19 用户本机以外网端点执行此脚本，全部步骤通过且测试对象已删除（当时尚无tyde/前缀）；随后用户启动后端，Agent通过curl调用实际HTTP服务，tyde/前缀下五个文件入口的上传、批量、代理、签名下载、删除及权限拒绝已通过，保留3个测试对象、删除1个供用户查看，路径与证据统一见[01记录](../../backend-migration/01-files/todoTask.md#完成与交接记录)。内网端点连通性、真实营业执照认领链路与故障恢复仍未验证。

新增迁移 `20261016010000_uploaded_files` 包含 UploadedFile 台账和 Organization.businessLicenseKey。2026-10-16用户本机已在专用 `_test` 库应用；2026-10-19 Agent启动本地库后复跑34项数据库集成通过（对象存储使用内存适配）。用户已于2026-10-19在开发库 `tyde_outside` 执行 `pnpm db:deploy` 应用文件迁移，解决实测上传P2021/500；部署环境迁移未执行。其他环境部署前须应用全部迁移。集成测试会清表，只能连接 `.env.test` 指定的专用库；确认 APP_ENV=test、库名以 `_test` 结尾、TEST_DATABASE_RESET=true。不要对开发库运行测试。

默认单文件50MiB、总请求100MiB（按原始流统计，含multipart开销）、批量10个；反向代理也须允许相应请求大小。整个请求文件内容在内存中有界缓冲后校验，部署需按并发和内存预算收紧 `.env.example` 的大小/数量配置；Vercel/网关的平台限制独立于应用上限，未做大文件远程验收。当前配置参数统一为字节整数（不接受旧100MB字符串）。

`pnpm db:cleanup` 在存储启用时附加清理到期的 UPLOADED/RELEASED 文件（默认每批100）。与认领共用行锁，成功删除对象后物理删除台账，失败保留供重试；存储关闭时跳过文件清理。该命令尚未部署定时调度。对象存储和数据库不共享事务：对象删除成功但台账提交失败时由下次幂等清理恢复；上传后登记失败会尽力删除对象，若删除也失败，须通过bucket与台账对账回收无记录对象。真实失败恢复/调度仍待环境验证。

已认领项目/考试附件读取暂返回403，须在对应业务迁移中接实真实关系授权；不能放宽为“任何EXPERT均可读取”。旧普通敏感文件仅要求登录，新接口按台账归属收紧；新旧bucket与对象台账不默认互通。

## 本地组织注册500：开发库缺少组织列

若本地PostgreSQL日志出现`column "verifyStatus" of relation "Organization" does not exist`，说明开发库尚未应用`20261019020000_organization_memberships`。在`tyde/`执行：

```sh
pnpm db:deploy
```

该命令读取服务端`.env`并应用目标库所有待执行的已有迁移，不会运行清表测试；`.env.test`中的迁移成功不能替代开发库迁移。完成后重新请求注册、登录及组织接口。`prisma generate`只生成客户端；服务正常监听或`/health/ready`返回200也不代表业务表结构完整。若Agent执行迁移报P1001而本机服务能连接数据库，由用户在本机终端执行上述命令并回传结果，再复测HTTP；不通过重置库或删除迁移历史处理。

2026-10-19此故障已在开发库解决：用户成功应用全部7个迁移并重启服务，Agent完成41项业务HTTP复测，组织注册/登录及成员、审批、导入激活均符合预期。此结果不代表部署库已迁移或旧接口兼容差异已验收，详细记录见[03任务](../../backend-migration/03-organizations/todoTask.md)。

## 组织到期离职维护（03）

部署审批/退出代码前须向目标库应用迁移`20261019030000_approvals`，专用测试库及开发库均已由用户应用，部署库尚未应用；各环境不自动互通。组织到期PENDING_LEAVE转LEFT由显式维护入口执行，本批未配置任何远程/本地定时任务。

本地在`tyde/`运行 `pnpm --filter @tyde/server organizations:departures`，读取服务端`.env`。后端部署包在`apps/server`运行：

```sh
node --env-file=.env dist/organizations-departures.js
```

生产安装仅含生产依赖，使用上述已编译入口，不依赖开发工具tsx。由部署环境按Asia/Shanghai每天零点调度，并监控进程退出码及failed计数；失败可重跑。命令逐成员独立事务、组织行锁，以拟离职日上海零点记实际leftAt，重复运行不会重复结束关系。发生单条失败时其他成员继续处理，本次失败下次仍可重试；进程failed>0时退出1。

输出processed、failed和pendingProjectCleanup。最后一项是尚待接入项目清退处理器的记录数，不能当成已完成清退；`OrganizationDeparture`只在组织离组事务可靠留痕，未处理前保持PENDING。项目模型/负责人/人员变动/实时事件依赖04/07/12/14，接入后须处理积压及核对已有终态组织关系。不能为消除计数而手工批量标COMPLETED。调度部署前，到期但未执行维护的成员仍处于PENDING_LEAVE并保留参与权限，须纳入环境验收。

## 成员导入依赖与幂等表（03）

本批增加SheetJS官方0.20.3 tarball生产依赖，已由用户安装并更新pnpm-lock；构建/部署沿锁文件安装。新增迁移20261019040000_member_imports须先应用，创建MemberImportReceipt，未迁移时导入及新版数据库集成会缺表；用户已在专用测试库成功应用全部7个迁移，2026-10-19 16:26:59 Agent复跑74项集成全部通过（总23.77秒），既有203项单测通过（本次未重跑）。用户随后已在开发库tyde_outside应用全部7个迁移，部署库尚待迁移；专用测试库结果不能作为部署通过依据；03基础能力已交接04。

MemberImportReceipt与账号/关系同事务保存24小时幂等结果；处理中用事务级锁，崩溃自动释放，不依赖Redis。既有db:cleanup入口已加入过期回执清理。新账号不产生默认密码；激活失败不发令牌，完整验证记录留在03任务。项目清退补偿和到期离职每日调度要求保持上一节，不因导入接入视为已完成。

### 05考试版本来源结构（2026-10-21第一批）

新增第17迁移`20261021030000_entrance_exam_versions`，配置版本/试卷/题目及既有考试/轮次/应试来源外键。尚未应用任何数据库；319项单测通过，149项集成144通过、5项缺新表失败。先由维护者在本机专用库运行`node scripts/migrate-test-database.mjs`，再运行`pnpm test:integration`；开发/部署库另行确认目标后执行`pnpm db:deploy`。迁移遇到孤立引用/重复轮次会整批回滚，不清数据或生成虚假版本。详细只读前检、契约和未实现能力见[考试基础](ENTRANCE_EXAM_MANAGEMENT.md)。本批无新环境变量或依赖，未构建/发布；导入解析、配置发布/编辑和Agent阅卷仍未接入。

2026-10-21最新05集成更新：用户2026-10-21 17:10:14回传148/149通过，唯一失败为RESTRICT删除错误类型断言；Agent改为核对具体应试版本外键并完整比对版本、试卷、应试记录未变。17:13:41复跑149项集成全部通过（1文件，总74.16秒，测试71.29秒），原缺表及测试断言阻塞均解除。第17迁移所需专用库结构已验证，迁移历史未另查；Agent未应用数据库迁移，开发/部署库仍未验证。该记录更新此前“第17迁移未应用”的历史状态。详细状态以根05任务记录为准，继续05，不交接06。

### 05导入与发布/编辑（2026-10-21第二批）

新增文件解析、发布与新版本编辑，回补考试附件管理代理读取；复用已具备的第17迁移结构，本批无新增迁移/环境变量/依赖。331单测及156项PostgreSQL+内存存储集成通过，未操作开发/部署库或验收真实OSS/远程文档。当前专用测试库无需重复迁移；其他环境仍须先应用全部既有迁移。远程文档入口未配置合法来源时503，XLS内嵌图片/旧式对象400提示转XLSX；不会因配置发布成功模拟Agent派发或阅卷完成。大小边界、文件授权、事务及后续范围见[考试基础](ENTRANCE_EXAM_MANAGEMENT.md)，逐项状态以根05记录为准。

### 05管理读取、关闭与逐轮成绩来源（2026-10-21第三批）

新增044—047入口，花名册真实成绩依赖第18迁移`20261021040000_entrance_exam_grading_records`。用户2026-10-22 09:16:49复跑162项集成全部通过（1文件，总78.84秒，测试68.19秒），第18迁移所需专用测试库结构、花名册真实逐轮成绩及来源约束已验证，原缺表阻塞解除；迁移历史未另查，开发/部署库仍未验证。339单测/类型/ESLint为前批证据，本次仅同步用户结果、未重跑或操作数据库。当前专用库无需再次迁移；其他尚未迁移环境按既有说明应用全部迁移后验证。本机专用库迁移使用`node scripts/migrate-test-database.mjs`，集成使用`pnpm test:integration`，仅允许`.env.test`指定本机_test库，集成会清表，不能指向开发库。第18只新增逐轮执行/汇总表及同版本复合外键/唯一键/状态分值约束，不生成阅卷任务或结果。本批未构建或部署，真实OSS/远程文档和完整兼容未验收。详情见[考试基础](ENTRANCE_EXAM_MANAGEMENT.md)及根05记录。

### 转项考试结果补偿（12）

第三批新增第29迁移`20261026050000_transfer_results`，包含转项应试外键/唯一来源及拒绝、撤回时间。Agent未应用任何库；本机专用_test库由维护者运行`pnpm db:deploy:test`，再仅运行`pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t 'personnel transfer progression'`。本批6项集成在Agent环境均因127.0.0.1:5432不可达停于beforeEach，断言待本机复验；不重复前批创建4项、候选3项或11已过集成。开发/部署库升级和真实HTTP仍待独立验收。

阅卷或取消提交后会单独消费真实转项最终结果。消费者事务失败时，考试结果仍保留、转项继续等待；维护者可在确认运行环境后执行`pnpm --filter @tyde/server personnel:transfer-results`。命令读取`apps/server/.env`，按每条变动独立事务补偿，输出completed/skipped/failed，失败退出码1，重复运行幂等。该命令会写当前环境业务状态，不等于_test专用库测试；Agent本批未运行或部署周期调度。无需新增环境变量/依赖，Agent阅卷保持mock，outbox仍PENDING，实际投递归14。该命令不实现到期生效；102/106及103/104、107/07遗留见[人员变动](PERSONNEL_MOVEMENTS.md#第三批验证与续做)。

2026-10-26最新12第三批状态约束修复：用户12:04:38定向六项全部失败（249跳过，共255项，总8.50秒，测试5.62秒），数据库初始化阻塞已解除；共同失败点为转项节点写入CANCELLED，违反既有ApprovalNode_status_check（仅接受CANCELED）。已修正下一节点候选刷新、ANY同组候选关闭和终止/撤回三处写入，未改schema/迁移或放宽约束。新增直接读取真实迁移约束的回归，修复前复现失败；修复后12:05:57转项/创建/OpenAPI定向21项通过（3文件，总3.38秒），服务端类型、变更ESLint及后端包build通过；未全量复跑当前538项，前批535项全量及收尾定向证据保留。Agent12:06:07仅复验本批六项仍停在beforeEach，127.0.0.1:5432不可达（249跳过，共255项，总4.39秒，测试580ms），修复后数据库断言待用户本机复验。本机专用库已执行到业务写入，第29迁移所需结构已具备，迁移历史未另查；当前专用库无需再次迁移29。保持12，仅复验personnel transfer progression六项，不重复创建/候选或11通过项；通过后103/104、当前负责人同步、到期生效及107/07。未操作开发/部署库，业务Agent继续mock。

2026-10-26最新12第三批集成通过：用户14:16:05定向运行personnel transfer progression，本批6项全部通过（249跳过，共255项，总19.89秒，测试7.28秒）。真实接单/独立目标考试及五步推进、取消/拒绝恢复与撤回、并发终态/旧版本冲突、负责人和本人离组失权、outbox整事务回滚及考试结果已提交后消费者失败/显式补偿幂等已验证。原ApprovalNode_status_check的CANCELLED误写冲突已解除；第29迁移所需专用库结构具备，迁移历史未另查，不是全255项复跑，无需当前专用库再次迁移29或重复本批六项、前批创建/候选及11通过项。102/106仍部分迁移，105仍待真实HTTP/部署/完整兼容验收；535项全量及收尾59/9和修复后21项定向/类型/ESLint/build前批证据保留。本轮仅同步用户结果与文档，未重跑测试、修改业务代码或操作数据库。保持12，下次直接103/104查询、已激活待办负责人动态同步、当天审批完成即时生效/未来到期生效，再107/07来源及旧assignmentId转项响应兼容回补；业务Agent继续mock，不得人工跳过等待节点。

### 人员变动生效及审批人同步（12第五批）

新增显式命令`pnpm --filter @tyde/server personnel:movement-approvers`（当前人工待办资格补偿）和`pnpm --filter @tyde/server personnel:movements`（到期转项/汰换），部署分别用`dist/personnel-movement-approvers.js`和`dist/personnel-movements.js`。未新增迁移或依赖，未运行开发/部署库命令，未部署定时任务。到期扫描失败计数非零时进程退出1，单条失败不会中止其他记录；恢复资格后重试，重复执行不会重复创建目标成员。组织离职应先于入项/变动的每日上海零点任务执行。交接时当前候选在原业务事务内同步，其他资格变更通过显式补偿处理。用户2026-10-26 15:45:19定向六项新增专用库集成全部通过（258跳过，共264项，总14.99秒，测试10.97秒），原初始化连接阻塞解除；不是全264项复跑，无需重迁移29或重复本批六项。真实HTTP/部署与调度验收仍待完成；复验命令与行为边界见[第五批说明](PERSONNEL_MOVEMENTS.md#第五批负责人同步与生效)。
