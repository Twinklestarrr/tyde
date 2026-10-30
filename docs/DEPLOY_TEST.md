# 测试环境部署（无 Docker）

本文是生成交付包、配置测试服务及环境验收的操作说明。Web 与 API 可由同一 Fastify 服务提供；跨仓发布保持显式启用，规则见[release 发布](RELEASE_DEPLOYMENT.md)。历史环境快照和迁移批次记录见[后端开发历史](archive/BACKEND_HISTORY.md#deploy-test)。

部署前核对目标环境和备份，按当前代码应用全部已有迁移；专用 `_test` 库的结构或验收结果不能替代开发/部署环境。本文不表示已经完成远程部署。

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
4. 复制 `apps/server/.env.example` 为 `apps/server/.env`，设置权限 0600，并填写下表配置。
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

使用实际发布目标的 Vercel 合并项目，由同一次部署发布 Web 静态资源与 Fastify API。浏览器访问同一个域名的 `/` 和 `/api/v1/*`，不再需要独立 Web 项目的跨项目转发。Electron 继续连接该域名的 API。

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

文档端点随服务启动即可访问，不要求数据库已就绪，也未单独设置登录门槛。需要限制测试文档访问时，在网关对整个 `/api/v1/docs` 路径及其子路径统一设置访问控制。Swagger UI 调试 POST 必须从 `WEB_ORIGINS` 中的同源 HTTPS 页面发起；Cookie 按当前 `COOKIE_SECURE` 配置自动处理。完整说明见 [API 文档说明](backend/API.md)。

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

上传、批量上传、鉴权代理、非敏感签名链接和本人未认领文件删除接口已接入。适配器使用 `ali-oss@6.23.0`，类型依赖 `@types/ali-oss@6.23.3`；保留 SDK V1 签名以兼容旧图片最大有效期。接口及权限边界见 [API](backend/API.md#文件上传凭证与访问)。SDK 参考 [ali-oss 官方说明](https://github.com/ali-sdk/ali-oss#readme)。

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

脚本仅写入随机 `tyde/common/oss-verification/<UUID>.txt` 并在 finally 尝试删除，不枚举或删除既有对象。验证 PUT、HEAD、流式 GET 内容、普通/图片最大有效期外网签名 GET、DELETE、删除后 HEAD=null/GET=404 和重复 DELETE。若清理失败，按输出的对象键人工删除本次对象。SDK 同步异常和下载流中途异常对接口统一脱敏；404 的 NoSuchKey 与 bucket/权限错误区分，其他失败返回503。此脚本通过只代表基础对象操作通过，HTTP 上传/台账/认领及真实失败恢复仍需业务环境验收。2026-10-19 用户本机以外网端点执行此脚本，全部步骤通过且测试对象已删除（当时尚无tyde/前缀）；随后用户启动后端，Agent通过curl调用实际HTTP服务，tyde/前缀下五个文件入口的上传、批量、代理、签名下载、删除及权限拒绝已通过，保留3个测试对象、删除1个供用户查看，路径与证据统一见01记录（历史外部记录：`backend-migration/01-files/todoTask.md`，章节 `完成与交接记录`）。内网端点连通性、真实营业执照认领链路与故障恢复仍未验证。

新增迁移 `20261016010000_uploaded_files` 包含 UploadedFile 台账和 Organization.businessLicenseKey。2026-10-16用户本机已在专用 `_test` 库应用；2026-10-19 Agent启动本地库后复跑34项数据库集成通过（对象存储使用内存适配）。用户已于2026-10-19在开发库 `tyde_outside` 执行 `pnpm db:deploy` 应用文件迁移，解决实测上传P2021/500；部署环境迁移未执行。其他环境部署前须应用全部迁移。集成测试会清表，只能连接 `.env.test` 指定的专用库；确认 APP_ENV=test、库名以 `_test` 结尾、TEST_DATABASE_RESET=true。不要对开发库运行测试。

默认单文件50MiB、总请求100MiB（按原始流统计，含multipart开销）、批量10个；反向代理也须允许相应请求大小。整个请求文件内容在内存中有界缓冲后校验，部署需按并发和内存预算收紧 `.env.example` 的大小/数量配置；Vercel/网关的平台限制独立于应用上限，未做大文件远程验收。当前配置参数统一为字节整数（不接受旧100MB字符串）。

`pnpm db:cleanup` 在存储启用时附加清理到期的 UPLOADED/RELEASED 文件（默认每批100）。与认领共用行锁，成功删除对象后物理删除台账，失败保留供重试；存储关闭时跳过文件清理。该命令尚未部署定时调度。对象存储和数据库不共享事务：对象删除成功但台账提交失败时由下次幂等清理恢复；上传后登记失败会尽力删除对象，若删除也失败，须通过bucket与台账对账回收无记录对象。真实失败恢复/调度仍待环境验证。

已认领项目/考试附件按当前项目、成员和考试来源授权；不能放宽为“任何EXPERT均可读取”。旧普通敏感文件仅要求登录，新接口按台账归属收紧；新旧bucket与对象台账不默认互通。

## 组织到期离职维护（03）

部署审批/退出代码前须向目标库应用迁移`20261019030000_approvals`，专用测试库及开发库均已由用户应用，部署库尚未应用；各环境不自动互通。组织到期PENDING_LEAVE转LEFT由显式维护入口执行，本批未配置任何远程/本地定时任务。

本地在`tyde/`运行 `pnpm --filter @tyde/server organizations:departures`，读取服务端`.env`。后端部署包在`apps/server`运行：

```sh
node --env-file=.env dist/organizations-departures.js
```

生产安装仅含生产依赖，使用上述已编译入口，不依赖开发工具tsx。由部署环境按Asia/Shanghai每天零点调度，并监控进程退出码及failed计数；失败可重跑。命令逐成员独立事务、组织行锁，以拟离职日上海零点记实际leftAt，重复运行不会重复结束关系。发生单条失败时其他成员继续处理，本次失败下次仍可重试；进程failed>0时退出1。

输出processed、failed和pendingProjectCleanup。最后一项是尚待接入项目清退处理器的记录数，不能当成已完成清退；`OrganizationDeparture`只在组织离组事务可靠留痕，未处理前保持PENDING。项目模型/负责人/人员变动/实时事件依赖04/07/12/14，接入后须处理积压及核对已有终态组织关系。不能为消除计数而手工批量标COMPLETED。调度部署前，到期但未执行维护的成员仍处于PENDING_LEAVE并保留参与权限，须纳入环境验收。

## 人员变动维护命令

`pnpm --filter @tyde/server personnel:transfer-results` 补偿已提交的转项考试最终结果；考试结果已保留但消费者事务失败时可重试。该命令读取服务端 `.env` 并写当前环境，重复执行幂等，失败计数非零退出1，不等于专用测试库验证。

`personnel:movement-approvers` 补偿当前人工待办资格，`personnel:movements` 处理到期转项/汰换；部署分别使用 `dist/personnel-movement-approvers.js`、`dist/personnel-movements.js`。组织离职维护先于入项/变动的每日上海零点任务。调度部署与真实目标环境须单独验收，不能手工跳过接单/考试等待节点。完整业务规则见[人员变动](backend/PERSONNEL_MOVEMENTS.md)。
