# API 与 Swagger 使用说明

> 2026-10-23：07已迁移范围真实HTTP验收229项通过（228请求+1并发汇总），覆盖061—067全部7种方法/路径；本批9会话已退出失效。061—063及067部分迁移、064—066部署/完整兼容遗留继续保留。默认入口08，本轮未执行08。详见[07验收报告](EXPERT_ASSIGNMENTS_ACCEPTANCE.md)。

2026-10-23最新07第三批集成通过：用户11:50:17定向运行负责人替换3项全部通过（192跳过，共195项，总13.14秒，测试2.64秒），已验证多人/并发同集合幂等、兼容单值移除与数据保留、免试待入项、权限/非法目标/未接单/离组、outbox故障整事务回滚、SELECTED恢复、考试轮次及API-008角色/离组/删除项目失权。原数据库初始化阻塞解除；不是全195项复跑，无需重复本批3项、061/064及06已过项。065/066及API-008保留已实现待真实HTTP/部署/完整兼容验收；431单测及类型/ESLint/build前批证据保留。无新迁移，迁移历史未另查；本轮仅同步用户结果和文档，未重跑测试、修改业务代码或操作数据库。保持07，下次直接067个人/主管/成员接单拒绝并接通061按钮；完整生产/审批/转项真值归10—12，062/063按需回补，业务Agent继续mock，不开始08。

2026-10-22最新07第二批集成通过：用户18:09:22定向复验成员进度/负责人历史1项通过（191跳过，共192项，总11.60秒，测试1.12秒），原免试计划夹具P2025已解除；结合18:03:22已通过的来源/多组织权限/身份优先/status筛选1项，本批2项集成分批全部通过，不是全192项复跑，无需重复。061保留部分迁移，064前批通过证据不变；421单测及类型/ESLint/build、修正后18项定向证据保留。无新迁移，迁移历史未另查；本轮仅同步用户结果和文档，未重跑测试、修改业务代码或操作数据库。保持07，下次直接065—067及API-008，061按钮随067接回，完整生产/报量当天撤卡及审批/转项真值归10—12，062/063按需回补；业务Agent继续mock，不开始08。

> 2026-10-22：用户17:27:30候选定向1项通过（187跳过，共188项，总3.76秒），API-059显式分页400已解除。058—060本批4项及06累计11项集成均分批全部通过，不是全188项复跑；06基础交接07，本轮未执行07。真实HTTP/OSS、部署及完整兼容仍保留原接口状态，无新迁移。下方待复验为历史，详见[招募记录](PROJECT_RECRUITMENT.md)。

> 2026-10-22分页修复：API-059的current/size按URL十进制文本校验，由路由显式转换，缺省1/20；避免全局coerceTypes=false时显式分页400。用户本批4项集成3通过1失败，修复后仅候选1项待本机复验；14项定向单测及服务端类型/变更ESLint/后端build通过，详见[最新记录](PROJECT_RECRUITMENT.md#2026-10-22分页修复最新)。

> 2026-10-22第四批：API-058 GET `/projects/expert-recruitments/detail`、059 GET `/projects/expert-recruitments/candidates`、060 POST `/projects/expert-recruitments/submit`已接入。当前PM主策略官或招募负责人，独立个人/多组织候选，项目锁下批量追加、拒单追溯/轮次/本域快照/PENDING outbox同事务。无新迁移；新增4项集成初始化不可达，业务断言未执行。完整字段/示例及本机复验命令见[专家招募](PROJECT_RECRUITMENT.md#api-0580602026-10-22第四批优先于上方未接入历史)，下方058—060尚未接入为前批历史。

> 2026-10-22：API-056 GET `/projects/expert-recruitments/handler-candidates`和057 POST `/projects/expert-recruitment-handler/change`已接入。仅当前PM主策略官，全部ACTIVE统一账号候选（含本人），允许重复指定，负责人/管理轮次/outbox同事务，不推进节点/版本。用户17:00:34复测新增2项集成全过（182跳过，共184项，总4.07秒），原初始化阻塞解除；真实HTTP/部署/兼容仍待验收，058—060尚未接入。见[招募负责人](PROJECT_RECRUITMENT.md)。

> 2026-10-22最新集成结果：用户16:47:26附件定向1项复验通过（181跳过，总2.74秒），结合16:44:41其余4项，标准材料053—055新增5项集成分批全部通过，原状态断言阻塞解除。不是全182项复跑，真实HTTP/OSS、部署及完整兼容仍待验收。无新迁移，本轮仅同步结果。见[标准材料验收](PROJECT_STANDARD_MATERIALS.md)。

> 2026-10-22集成更新：用户16:44:41复测标准材料5项集成4通过，仅附件移除状态断言误写失败；已改为现行RELEASED及到期回收契约，修正后该1项待本机复验。055两项确认/回滚集成已通过，原初始化连接阻塞解除；未改业务实现或数据库。见[标准材料验收](PROJECT_STANDARD_MATERIALS.md)。

> 2026-10-22：API-055 POST `/projects/standard-materials/confirm-read?projectId=3001`已接入，当前EXPERT且具备读取资格的ACTIVE已实际入项普通成员可确认；项目负责人403。首次时间、本人培训轮次和个人履约快照同事务，重复确认幂等并刷新陈旧快照；不修改共享节点/版本。396单测及类型/ESLint/build通过，2项新集成因数据库初始化不可达未执行断言，保留待验收。见[项目标准材料](PROJECT_STANDARD_MATERIALS.md)。

> 2026-10-22：新增API-053 GET `/projects/standard-materials/detail`和API-054 POST `/projects/standard-materials/update`，保持原字段及数据权限。正文/链接至少一项，附件替换与项目/主线轮次同事务；055于后续第二批接入。契约与验证边界见[项目标准材料](PROJECT_STANDARD_MATERIALS.md)。

> 2026-10-22现行规则：新增POST /organizations（API-124）与POST /auth/switch-role（API-121）。统一注册不接受organization/orgPosition，accountType选填且只接受INDIVIDUAL；账号自带三角色，当前会话角色控制已开发管理接口，数据范围仍逐业务校验。Organization创建即APPROVED/ACTIVE，允许多组织；完整请求/响应见Swagger及新契约。详见[统一账号与组织创建](UNIFIED_ACCOUNTS.md)。本轮证据见[插队任务](../../backend-migration/priority-unified-accounts/todoTask.md)。

运行 `pnpm dev:server` 后访问 `http://127.0.0.1:3000/api/v1/docs/`。OpenAPI JSON/YAML 分别位于 `/api/v1/docs/json` 和 `/api/v1/docs/yaml`；文档读取不依赖数据库。

认证后端已迁移到下表的接口路径与字段，注册和登录固定为执行专家 `EXPERT`，不要求选择身份。完整字段、联调示例、迁移说明和已知依赖见 [认证后端上下文](AUTH_BACKEND.md)。

当前 Web/Electron 使用 Tailwind CSS、shadcn/ui 与 TanStack Router，开发和生产均通过平台适配调用下列真实认证接口。发码成功后保留后端 data 提示字符串，并展示与服务端 mock 共用的 `@tyde/shared` 常量 `MOCK_SMS_CODE`（当前为 `095270`）；页面不另行定义测试码，提示已含该验证码时不重复追加，失败或限流时不显示测试码，验证码有效期和校验仍由后端决定。后端发码成功只返回“验证码已发送，请注意查收”，响应不另设验证码或重发间隔字段，限流倒计时来自 HTTP 429 的 `Retry-After`。后端短信目前仍为开发/测试 mock，接入真实短信时须同步移除固定测试码提示。

短信登录按后端返回区分已有账号和注册指引；注册凭证仅存内存，个人资料提交后返回密码登录。Web 与 Electron 均由页面通过平台适配器 fetch 真实接口，使用 HttpOnly Cookie；刷新令牌只留在适配器内存，不进入持久化存储。Electron IPC 仅返回已校验的公开 API 源，不转发业务 HTTP 或保管登录令牌。注册返回用户资料，不自动创建会话；退出 HTTP 200 后清除客户端会话状态。

执行 `pnpm dev:web` 后可通过 `http://127.0.0.1:3001/api/v1/docs/` 访问同源文档；`API_PROXY_TARGET` 指向 HTTPS 后端时使用 `https://localhost:3001/api/v1/docs/`。部署包及 Vercel 由同一个 Fastify 服务托管 Web 与 API，数据库状态以 `/api/v1/health/ready` 为准。

| 方法与路径（前缀 `/api/v1`）                                     | 用途                                             |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| POST `/auth/sms/send`                                            | 按 `scene` 发送验证码                            |
| POST `/auth/register`                                            | 注册并返回用户资料                               |
| POST `/auth/login`                                               | 手机号 / 邮箱 / uid + 密码登录                   |
| POST `/auth/sms/login`                                           | 手机号 + 验证码登录或返回注册指引                |
| POST `/auth/refresh`                                             | 轮换访问和刷新令牌                               |
| POST `/auth/password/reset`                                      | 验证码重置密码并全端下线                         |
| POST `/auth/logout`                                              | 撤销当前会话                                     |
| GET `/users/me`                                                  | 当前用户资料                                     |
| GET `/users/nickname/check`                                      | 匿名昵称可用性与推荐昵称                         |
| POST `/users/me/update`                                          | 本人资料更新、改密并全端下线                     |
| GET `/organizations`                                             | 指定组织资料（主管/管理员）                      |
| POST `/organizations/update`                                     | 组织简介与Logo部分更新（主管）                   |
| POST `/organizations/members`                                    | 组织人员分页列表（项目分支待接入）               |
| POST `/organizations/members/update`                             | 编辑成员及版本条件更新                           |
| POST `/organizations/members/position`                           | 组织角色变更与主管转让                           |
| POST `/organizations/members/exit-requests`                      | 本人退出申请或合法代操作退出                     |
| POST `/organizations/approvals/pending`                          | 本人组织待办                                     |
| POST `/organizations/approvals/records`                          | 已处理节点记录                                   |
| POST `/organizations/approvals/process`                          | 双版本审批处理                                   |
| GET `/organizations/member-imports/template`                     | 成员XLSX模板，登录后下载                         |
| POST `/organizations/member-imports/generate`                    | 全量校验并原子导入成员                           |
| POST `/entrance-exams/detail`                                    | 当前版本编辑配置（PM项目只读/NAV历史人工阅卷）   |
| GET `/entrance-exams/management`                                 | 管理页卡片及已交卷统计                           |
| POST `/entrance-exams/close`                                     | 当前PM主策略官关闭考试                           |
| POST `/entrance-exams/roster`                                    | 应试花名册及真实逐轮成绩，需第18迁移             |
| GET `/entrance-exams/import/template`                            | 试卷v1模板下载（独立PM，EXCEL/TXT/REDOC）        |
| POST `/entrance-exams/import/parse`                              | 文件解析与附件预检（远程文档未接入）             |
| POST `/entrance-exams/publish`                                   | 当前PM发布准入考试V1及认领附件                   |
| PUT `/entrance-exams/edit`                                       | 当前PM校验预期版本并发布新配置版本               |
| GET `/entrance-exams/reviewers`                                  | 当前生效PM查询项目阅卷候选                       |
| GET `/projects/manager-candidates`                               | 本人项目策略官候选（NAVIGATOR）                  |
| POST `/projects/manager-recruitments`                            | 直接招募或更换策略官（NAVIGATOR）                |
| GET `/projects/production-plan`                                  | 查询生产计划（当前PM主策略官/协作负责人）        |
| POST `/projects/production-plan/confirm`                         | 确认生产计划（仅当前主策略官，projectId在query） |
| GET `/projects/{projectId}`                                      | 已发布项目详情（实际创建人/任职/在项成员范围）   |
| GET `/projects/list`                                             | 领航员本人待办卡片（独立NAVIGATOR）              |
| GET `/projects/manager/list`                                     | 当前主策略官/协作负责人待办卡片（独立PM）        |
| GET `/projects/draft/current`                                    | 本人唯一草稿查询                                 |
| POST `/projects/create`                                          | 保存完整草稿或校验并发布项目                     |
| GET `/project-categories`                                        | 项目分类字典（独立NAVIGATOR授权）                |
| GET `/project-requesters/{requesterType}/{requesterId}/backfill` | 本人需求方回填（独立NAVIGATOR授权）              |
| GET `/health/live`                                               | 存活状态                                         |
| GET `/health/ready`                                              | 数据库就绪状态                                   |

认证成功统一 HTTP 200，使用 `{code: 200, message: "操作成功", data: ...}`。登录 data 包含 `accessToken/refreshToken/tokenType/expiresIn`，注册返回 UserDTO，退出与重置返回 null。失败使用 `code/message/data`，限流 HTTP 429 携带 `Retry-After`。健康检查保留原 `status` 结构。

Swagger 的 Try it out 会真实执行注册、登录、重置和退出。Web 页面来源须加入 `WEB_ORIGINS`，Electron 安装包页面来源在 `DESKTOP_ORIGINS`（默认仅 `tyde-app://app`）；开发页面须按实际端口追加精确回环 HTTP(S) 源，例如 `http://127.0.0.1:5174`。桌面列表拒绝通配、`null`、路径和任意远程来源。Web/Electron 登录均自动建立 HttpOnly Cookie，`COOKIE_SECURE=true` 时 Cookie 名为 `__Host-tyde_session`，否则为 `tyde_session`。

普通 Web Cookie 保持 `SameSite=Lax` 与原 `COOKIE_SECURE` 配置；精确匹配 `DESKTOP_ORIGINS` 的页面使用 `SameSite=None; Secure`，正式后端须通过 HTTPS 访问。Electron 的 Chromium 按可信后端源使用独立持久 session 保存 Cookie，页面 fetch 使用 `credentials: include`。写请求使用 `X-Tyde-Client: web`；GET/HEAD 省略自定义客户端头，沿用 Cookie 认证，避免多余跨源预检。服务端仅对精确可信来源返回凭据 CORS，OPTIONS 允许 GET/HEAD/POST/DELETE 及 `Content-Type`、`X-Tyde-Client`、`Idempotency-Key`，暴露 `Retry-After` 与下载文件名头 `Content-Disposition` 供限流处理，不放行任意请求头。

非浏览器 API 客户端保留 Bearer 认证及可选的 `X-Tyde-Client: desktop`；此传输禁止 Origin、Cookie 或 sec-fetch-*。Electron 页面不使用这套 Bearer 传输，Cookie 与 Authorization 不能混用。

```sh
curl http://127.0.0.1:3000/api/v1/users/me \
  -H 'Authorization: Bearer <accessToken>'
```

维护入口：请求 schema 与 DTO 在 `packages/shared/src/auth.ts`；响应与路由元数据在 `apps/server/src/modules/auth/auth.schema.ts`；Swagger 插件注册在 `apps/server/src/docs.ts`，须先于业务路由。新增接口维护唯一 operationId、summary、tags、请求与响应 schema；响应 schema 会影响实际序列化，必须验证字段完整性。

管理接口已开始接入本后端：管理授权独立维护，注册/登录及用户资料角色仍固定EXPERT。已接入项目分类、需求方回填（第8迁移、80项专用库集成通过），并新增草稿/发布实现及第9迁移；用户回传18:18:48运行92项集成全部通过，第9/10专用库结构已就绪，台账业务ID的UUID/数值文本兼容及附件修复验证通过；候选/招募已接入本批代码，已通过102项专用库集成（用户2026-10-20回传），迁移历史未另查；API-031/034项目列表读取已接入（部分迁移），用户2026-10-21回传130项集成全部通过，第14所需专用库结构已就绪，迁移历史未另查，286项单测通过；支线重算/修复、来源写流程和实时投递仍待05—14，见[项目列表](PROJECT_LISTS.md)；API-035详情和成员表基础已接入本批代码，独立NAV创建人/PM当前任职或ACTIVE MEMBER，管理范围优先，用户2026-10-20回传118项专用库集成全部通过，第13所需结构已就绪，迁移历史未另查，274项单测通过，见[项目详情](PROJECT_DETAILS.md)；生产计划GET `/projects/production-plan`和POST `/projects/production-plan/confirm`已接入，两者projectId均在query，主策略官确认、协作负责人只读，用户2026-10-20回传110项专用库集成全部通过，第12所需结构已就绪，迁移历史未另查，见[生产计划](PROJECT_PRODUCTION_PLANS.md)。候选/任职/任务轮次和待投递事件范围见[策略官与任务基础](PROJECT_MANAGERS.md)。草稿/发布按旧代码实际只要求有效登录和本人范围，完整快照/必填校验差异、附件事务和创建人文件权限见[项目草稿与发布](PROJECT_CREATION.md)。授权维护、接口约束及数据库验证限制见[管理授权与项目基础接口](MANAGEMENT_ACCESS.md)。

准入考试已接模板、候选、文件解析、发布/编辑、编辑详情、管理页、关闭及花名册；花名册真实逐轮成绩需第18迁移，所需专用库结构及该分支已由用户2026-10-22复跑162项集成全通过验证；开发/部署仍未验收。权限、统计/分页语义及未接入分支见[考试基础](ENTRANCE_EXAM_MANAGEMENT.md)。远程文档/XLS内嵌图形、准入情况与阅卷写链路仍待后续，不把配置或读取可用当作阅卷完成。

## Swagger 文档标准

后续新增、迁移和修改的后端接口统一遵循本标准。Swagger 必须能让调用方直接理解字段与使用条件；中文说明写进实际 JSON Schema/OpenAPI，TypeScript/Java 注释或独立 Markdown 不能替代它。

1. **接口级说明**：提供中文 `summary` 和 `description`、唯一 `operationId`、业务 `tags`；说明用途、认证方式、前置条件、关键副作用、幂等/重复调用及已知限制。HTTP 方法、路径和字段名保持迁移约定。
2. **每个字段都有中文含义**：请求 body、path/query/header 参数、响应包装和业务数据都要写中文 `description`。对象本身、对象内部字段、数组及数组项递归补齐，不能只写 string/integer 或把字段名翻译成同名英文。无请求体的接口明确说明即可，不编造参数。
3. **取值与业务规则**：枚举逐值解释，例如 `INDIVIDUAL=个人、ORGANIZATION=组织`；说明实际默认行为、格式/长度、数值单位、日期格式/时区、脱敏和 null/空数组的意义。`required` 由实际 schema 声明；条件必填在字段和接口说明写清，例如组织账号必须填写 `organization.name`。不要为了展示默认值给 schema 添加会改变 AJV 入参的 `default`。
4. **枚举可读性**：普通字符串枚举优先输出 `type: string` + `enum`，避免把每个字面量展开为一层 `anyOf`。保留现有合法取值、TypeScript 类型推导和验证语义；只有真实联合结构才使用 `oneOf/anyOf`。
5. **完整示例**：每个有请求体的接口至少一个可通过实际 schema 校验的请求示例；个人/组织等主要分支分别给示例。成功响应提供实际结构示例，失败响应说明 HTTP 状态、业务码、中文原因和必要响应头（例如 `Retry-After` 单位为秒）。示例里的密码、令牌、手机号和证件均为演示值，不能使用环境密钥或真实用户数据。
6. **文档与当前实现一致**：字段未接入、固定值、兼容字段被忽略、暂不支持的分支必须明确说明，不能把规划能力写成已上线。注册 `roles` 可省略且固定 EXPERT、文件存储默认关闭、文件附件按当前真实管理/接单/准入关系授权，考试附件考生与组织职责等未接分支保持403；这些限制需在页面直接可见。
7. **响应 schema 保真**：响应 schema 会影响 Fastify 序列化。给原自由对象补嵌套字段时核验字段与 null 不丢失；文档补充不得暗改校验、字段名、HTTP 状态或业务行为。发现业务差异按迁移任务另外记录。
8. **交付验收**：查看生成的 `/api/v1/docs/json`，检查中文字段说明、嵌套结构、枚举和完整示例确实存在；示例通过实际请求校验；验证响应序列化及现有契约不变。`apps/server/tests/docs.test.ts` 已递归检查当前请求/响应字段的中文说明，并校验示例与枚举、组织响应字段保留；有 path/query/header 或新响应结构时扩展相应检查。不能仅靠 schema 源码有注释就通过验收。

TypeBox 示例：

```ts
const body = Type.Object(
  {
    phone: Type.String({
      pattern: '^1[3-9][0-9]{9}$',
      description: '中国大陆手机号，11 位数字，不含 +86。',
      examples: ['13812345678'],
    }),
  },
  {
    additionalProperties: false,
    description: '请求用途、前置条件和关键限制。',
    examples: [{ phone: '13812345678' }],
  },
);
```

请求标准入口 `packages/shared/src/auth.ts`，响应与错误说明范例 `apps/server/src/modules/auth/auth.schema.ts`。字段说明修改与接口代码一同交付，不要求调用方另找字段中文对照表。

## 文件上传、凭证与访问

OSS 物理主目录为配置的 `OSS_BUCKET` 下的 `tyde/`。API 与台账的 `objectKey` 使用该目录内的相对业务键，例如 `business-license/...`；客户端原样传入，不自行添加 `tyde/` 或 bucket 名。签名 URL 会包含物理前缀。

以下路径均加 `/api/v1`，沿用 `{code,message,data}`，失败 data=null；`GET /files/view` 成功时直接返回文件字节，不用 JSON 包装。

| 方法与路径                 | 字段                                                  | 身份与结果                                                                                                    |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| POST `/files/upload`       | multipart：`file` 必填，`bizType/category` 选填       | 可匿名；项目/考试附件必须登录。返回可信元数据、objectKey、一次性 uploadToken；敏感文件 url=null。             |
| POST `/files/upload/batch` | multipart：重复 `files` 字段，`bizType/category` 选填 | 默认最多10个文件，按顺序返回；后续上传失败时前面成功的对象保留，未认领对象过期清理。                          |
| GET `/files/view`          | query：`objectKey` 必填                               | 需登录；安全图片/PDF内联，其余强制下载；no-store, private 与 nosniff。匿名请求403。                           |
| GET `/files/access-url`    | query：`objectKey` 必填，`expireSeconds` 选填         | 需登录；敏感目录或台账一律403。非敏感图片默认2147483647秒，其他默认604800秒；非正数视为默认，最大32位正整数。 |
| DELETE `/files`            | query：`objectKey` 必填                               | 需登录且为本人未认领文件；匿名上传对象、已认领对象和重复删除403。成功data=true。                              |

`bizType` 默认 COMMON，`category` 默认由业务推断；忽略大小写和首尾空白，未知值400。固定业务大类不能被 category 放宽，ANY 仍受已知安全类型白名单。全局单文件默认50MiB、请求100MiB（含multipart边界/字段）、批量10个；图片/JSON10MiB，文档/Excel20MiB，视频/业务附件/ANY50MiB，均可被全局硬上限收紧。文件名、声明MIME和实际内容须一致；拒绝SVG/HTML/脚本及伪装内容；Office ZIP 检查结构和CRC，最多检查200项、解压2MiB，不解包落盘。文件和请求超限413，字段/内容不符400。

敏感文件只通过鉴权代理读取：未认领对象只允许上传者；匿名预上传在组织认领前不能读取（uploadToken不是读取凭据）。已认领营业执照仅所属组织有效关系（ACTIVE/EXIT_APPROVING/PENDING_LEAVE）的 OWNER/ADMIN 可读取，且组织未逻辑删除；不使用用户单组织兼容字段或 hasExpertManagementRole 展示字段授权。**已认领项目附件先前已接具有独立NAVIGATOR授权的项目创建人读取，并要求项目未删除、附件ACTIVE和台账绑定一致；第9/10专用库结构已就绪，该分支及附件认领已通过92项集成，真实OSS及部署验收仍待完成。本批另接入独立PM授权且当前ASSIGNED的主策略官/协作负责人读取代码（102项专用库集成已通过），更换任职/撤销授权即失效；插队任务已接专家项目附件读取代码：免试时真实已接单个人/有效组织成员可读，需笔试时限有效组织主管/项目负责人或有未删除考试ADMITTED结果的专家。ACTIVE项目成员本身不放行；新事实表需第15迁移，所需专用库结构及数据库分支已由137项集成通过验证，迁移历史未另查；考试附件管理读取本批接入独立PM当前主策略官/协作负责人及独立NAVIGATOR需求方/创建人，须绑定未删除考试和项目；08已补本人绑定卷题干/答案及有效已接单组织主管/负责人本组织答案范围，EXPERT不能读取参考答案；转项文件仍由12补齐，不能视为完整项目/考试流程。** 非敏感文件沿用登录后访问规则。只接受新项目存活台账，不接收旧bucket未登记对象；这与旧普通文件“只要登录即可查看”存在收紧差异，尚未作为完整兼容验收通过。

组织注册的 `organization.businessLicense` 接受 BUSINESS_LICENSE 的 `objectKey/uploadToken`，默认24小时内一次认领（可配置），原文凭证不落库。无记录/类型错误/存储对象缺失或大小不符400，错误凭证403，过期/重复409，存储关闭/不可达503。认领、验证码消费、组织与用户创建同事务，失败回滚；`organization.businessLicenseUrl` 保留旧字段名，返回objectKey或null，不是公开URL。

Swagger 提供 multipart 输入、请求/响应/查询字段中文说明和完整 schema 示例，文件代理 200 按实际媒体类型记录二进制响应。文件与注册测试使用专用 PostgreSQL 和内存对象存储；真实 OSS 可通过 `pnpm --filter @tyde/server storage:verify` 独立验证，不能把测试替身结果视为真实存储验收。

示例配置默认 `FILE_STORAGE_PROVIDER=disabled`。启用时仅在后端配置 OSS bucket 与密钥；服务端读写使用 `OSS_ENDPOINT`，客户端下载签名使用 `OSS_PUBLIC_ENDPOINT`，两者按网络环境选择内网或外网端点。新对象显式私有且禁止覆盖。真实存储、营业执照认领及后续业务附件关系需按实际环境验收，步骤见[部署说明](DEPLOY_TEST.md#文件存储与上传01)。

## 用户资料与昵称（02）

- `GET /users/nickname/check?nickname=小明` 可匿名，无请求体。trim后非空，最多64字符；返回 `nickname/available/suggestion/message`。占用时从1递增推荐，最长64字符（必要时截短原昵称）；最多尝试1000次，耗尽409。查询不预留昵称；注册默认真实姓名生成的昵称同样受唯一约束，重复409且注册事务回滚。新PostgreSQL按大小写敏感精确匹配，旧MySQL排序规则差异待兼容验收。
- `POST /users/me/update` 需本人会话，body所有字段可选：`avatarUrl`（512字符）、`avatarUploadToken`（128字符，关联新头像时条件必填）、`bio`（1000字符）、`idCardNo`（32字符）、`newPassword`、`confirmNewPassword`（64字符）、`roles`（1～3个已知角色）。省略/null保持；头像、简介、未认证身份证传空白可清空，非空值trim，身份证转大写。未知字段400，不能提交目标用户ID、昵称、姓名、邮箱或实名状态。
- 身份证沿用15位或18位格式验证，非完整证件真实性/校验码核验；已认证号码仅可提交同一号码，改号/清空403，重复号码409。`idVerified`从数据库读取，注册默认0，没有自助认证入口。姓名/邮箱继续只在注册入口验证。
- 密码必须成对一致且满足既有强度规则；资料更新与全部Web/桌面会话及刷新令牌撤销同事务，Web/Electron成功清除Cookie。服务端复用登录/重置的手机号锁并在锁内复查会话，拒绝并发中已撤销的凭据。角色兼容字段沿用固定EXPERT规则：已知角色选择忽略，不授予其他角色，不单独触发下线。
- 成功返回完整UserDTO；头像/简介/实名状态读取实际保存值。沿用旧更新服务回读语义，更新响应 `selectedRole=null/hasExpertManagementRole=false`；后续 `GET /users/me` 按当前会话返回EXPERT。组织资料已切多组织有效关系选择，OWNER职责已接实，项目负责人分支已由07接入待验收，信用仍待后续任务回补；改密后presence置离线待14。
- 头像关联已在插队任务补齐：AVATAR须登录上传，保存资料时传`avatarUrl=objectKey`及`avatarUploadToken=uploadToken`；服务端校验本人归属、类型、凭证、时效和存储对象，认领后保存可展示签名URL。重复保存本人已认领头像可省略凭证；替换/清空释放旧头像供到期清理，资料、认领与释放同事务。历史外部URL/非AVATAR字符串兼容保存，不远程抓取、不自动认领，也不保证外部文件生命周期。敏感文件不能因头像字段而公开。

资料更新请求示例（可在Swagger验证）：

```json
{ "avatarUrl": "https://example.com/avatar.png", "bio": "数据标注专家", "roles": ["EXPERT"] }
```

新增 `20261019010000_user_profile` 迁移，增加头像、简介、实名状态、修改人及昵称唯一索引。部署前先人工检查历史昵称重复；迁移遇到重复会原子回滚，不自动改名。用户已在专用测试库应用且41项集成全部通过；本地运行后端已通过51项HTTP检查，证明新资料字段与昵称冲突保护生效。本轮未执行迁移或查询迁移历史；开发库迁移记录核对、部署及兼容验收仍待完成；最新验收以[02任务记录](../../backend-migration/02-user-profile/todoTask.md)为准。本机专用测试库迁移/复验命令（本轮已由用户成功执行）：

```sh
node scripts/migrate-test-database.mjs
pnpm test:integration
```

脚本仅接受已有 `.env.test` 中 `APP_ENV=test/TEST_DATABASE_RESET=true`、本机且以 `_test` 结尾的库，不创建库、不清表；集成测试会清空该专用库。切勿用开发库替换测试配置。昵称重复可先只读检查 `SELECT "displayName", COUNT(*) FROM "User" GROUP BY "displayName" HAVING COUNT(*) > 1;`，经用户决定后处理存量，不自动改名或删号。

## 组织资料（03首批）

GET `/organizations?orgId=<UUID>`、POST `/organizations/update` 沿用旧路径、方法、字段名和Result。查询允许指定组织的OWNER/ADMIN，关系须为ACTIVE、EXIT_APPROVING或PENDING_LEAVE；编辑只允许ACTIVE的OWNER。权限读取`UserOrgRel`，不使用EXPERT登录身份或用户单组织兼容字段。无关系403；有合格关系但组织不存在/已逻辑删除404。

编辑请求 `{ "orgId": "00000000-0000-4000-8000-000000000002", "description": "新简介", "logoUrl": "logos/example.png" }`。description最多1000字符、logoUrl最多500字符；未传/null保持原值，trim后空串清空，额外字段400。角色检查与资料更新同事务锁组织行并记uid审计。Logo只存地址，不做文件认领或归属校验。响应保留旧组织资料字段，营业执照返回objectKey；认证/运行状态读数据库真实值。完整示例和所有字段说明见Swagger。

新迁移`20261019020000_organization_memberships`已由用户应用专用测试库；155项单测通过，2026-10-19 13:23:17用户本机45项集成全部通过，缺列/缺表阻塞已解除。开发/部署库尚未应用本次迁移，真实运行后端HTTP联调待完成。UUID/ISO UTC时间仍与旧数值ID/本地日期格式不同，待兼容验收。后续成员管理及多组织回补见下节；该段为组织资料批次记录，审批/导入后续已接入，完整进度以[03任务](../../backend-migration/03-organizations/todoTask.md)为准。

## 组织成员（03成员管理批次）

POST `/organizations/members` 请求必填orgId（UUID），可选keyword、joinedStartDate/joinedEndDate、leftStartDate/leftEndDate、employmentType、position、joinStatus、projectId、current/size；默认第1页、每页20，最多100。keyword去首尾空白，包含匹配真实姓名/UID，仅完整手机号精确匹配；不按昵称检索。日期`yyyy-MM-dd`按上海自然日闭区间；起点晚于终点或非法日期400。旧Controller说明与实际SQL对已离组成员范围矛盾，当前遵循SQL：未传joinStatus包含所有状态，可显式筛选LEFT/REMOVED。响应是total/pages/current/size/records，空结果pages=0、records=[]；手机号脱敏，不暴露用户敏感字段。

04本批已接回API-018计数/筛选代码：`activeProjectCount`为本条`userOrgRelId`下ACTIVE项目成员记录数，无记录0；沿旧SQL COUNT(*)不按项目去重、不按项目角色/项目状态/删除过滤，不受projectId筛选影响，同用户其他组织/个人项目不计入。`projectId`恢复JSON数值类型（新库32位整数，非UUID），省略/null不筛选；按同一组织关系下ACTIVE记录精确筛选，0/负数/不存在ID空页，字符串/小数/超32位范围400。筛选在分页前生效，当前页批量聚合，与分页共用RepeatableRead快照。API-018改为已实现待验收，278项单测通过，用户2026-10-21回传122项集成全部通过（总54.60秒），原测试库阻塞解除，无新增迁移，依赖既有第13结构。旧64位ID/数值字符串隐式转换的兼容仍待验收。排序规则/大小写及UUID、ISO UTC响应日期仍待旧接口兼容验收。

POST `/organizations/members/update` 必填orgId、memberId（组织关系ID）、versionNo；joinedAt/employmentType至少一项非null，null/未传保持。joinedAt沿用旧`yyyy-MM-dd HH:mm:ss`按上海解释，不得为未来；FULL_TIME=全职、PART_TIME=兼职。主管可编辑全部目标，管理员仅普通成员/自己；目标不额外限制关系状态（沿旧Service）。操作人须处于ACTIVE/EXIT_APPROVING/PENDING_LEAVE；组织锁内实时检查权限和版本，成功版本+1并记uid审计，冲突409。

POST `/organizations/members/position` 必填orgId、memberId、position（OWNER/ADMIN/MEMBER）。目标须ACTIVE；主管可调整/转让，不能直接降低自己角色；转让时原主管变ADMIN。管理员仅可调整普通成员或自己的ADMIN/MEMBER，不能设OWNER。最多5名有效管理员，包含PENDING/PENDING_ACTIVATION/ACTIVE/EXIT_APPROVING/PENDING_LEAVE；转给现有ADMIN一增一减，不额外占名额。同角色幂等不改版本/时间；实际变更版本+1，主管转让两条关系同事务更新。

认证组织资料及营业执照授权已切成员关系，陈旧`User.organizationId/orgPosition`不授予权限。本人资料从有效、未删除组织中选OWNER优先/最早入组（null日期排后）。`hasExpertManagementRole`当前EXPERT下按有效多组织主管或已接单组织现任负责人关系计算；负责人须仍在对应组织，历史关系禁用旧单值回退，删除项目不计入。ADMIN本身不代表该职责；该标志不作为业务接口授权凭据。

180项单测及52项真实PostgreSQL集成通过（含并发角色/版本/名额、权限即时失效），对象存储使用内存替身；本批无新迁移，未执行开发/部署或真实OSS/运行中HTTP联调。审批内核及退出流程进展见下节；导入和首次激活仍在03后续批次。

## 组织退出与审批（03审批批次）

POST `/organizations/members/exit-requests` 必填`Idempotency-Key`（trim非空、最长128字符），请求orgId、reason（trim非空、最长1000字符）、plannedLeaveDate（上海当天或未来，yyyy-MM-dd）；memberId可选，不传/null为本人。主管须先转让，不能直接退出；普通成员只可操作自己；管理员只可代普通成员；主管可代非主管。本人退出创建PENDING流程、当前ACTIVE主管单待办、EXIT_APPROVING成员及SUBMIT日志；代操作当天LEFT、未来PENDING_LEAVE，流程APPROVED但无待办。组织、申请人、key相同复用流程，不比较新payload；日期/原因仍先校验。重取时flowStatus是当前流程状态，joinStatus是初始表单快照，不保证等于成员实时状态（沿旧Service）。

POST `/organizations/approvals/pending` 请求orgId，可选businessType/current/size（默认1/20，最大100）；参与状态主管/管理员可查询，但结果仅当前用户的PENDING节点且流程PENDING，按申请时间升序。POST `/organizations/approvals/records` 同样按组织授权，按已处理节点分页而非工单；同工单多节点多条，代操作无节点不会出现在此列表。支持businessType、status、startAt/endAt（上海`yyyy-MM-dd HH:mm:ss`、闭区间、起点不得晚于终点）。取最后一条节点动作，人员名称优先当前昵称(姓名)，缺失回退快照；SYSTEM动作保持SYSTEM。

POST `/organizations/approvals/process` 必填orgId、flowNo、nodeId、nodeVersionNo、flowVersionNo、action（APPROVE/REJECT），actionComment最长1000字符，驳回时trim后非空。仅当前组织主管且为节点实际审批人可处理ORG_MEMBER_EXIT，组织→流程→节点加锁；双版本或预期成员状态冲突409，跨组织/非审批人403，节点错配400，坏表单500且不提交任何变更。通过时未来日期PENDING_LEAVE、当天/逾期LEFT；驳回恢复ACTIVE并清空拟离职日。节点、流程、成员、动作日志同事务。主管转让不自动转派已有节点，旧待办可能暂不可处理；本批保持旧规则，后续策略需明确。

新迁移`20261019030000_approvals`已由用户应用专用测试库，开发/部署库未应用。审批定义/配置种子保留旧ROLE(OWNER/ADMIN)配置，但当前退出业务仍使用内置OWNER单节点；不会据种子放宽审批权限。旧processId/configId=0以新UUID模型null表示内置。通用条件表达式、多审批人执行器、配置管理HTTP未新增，后续12按其业务接入节点推进。

API-021/024项目副作用尚未接实，保留部分迁移：组织LEFT时同事务写`OrganizationDeparture` PENDING记录（按关系+版本去重），不表示项目成员、负责人、人员变动单或实时事件已清理。04/07/12接处理器并处理积压后才可标COMPLETED；当前不提供清空待补偿记录的捷径。到期PENDING_LEAVE须执行维护命令，每条成员独立事务，重复运行幂等；部署需配置每天上海零点调度，本批未部署。详见[部署说明](DEPLOY_TEST.md#组织到期离职维护03)。

本批190项单测、63项专用PostgreSQL集成及Swagger完整示例/中文字段/序列化检查通过。尚未完成开发/部署库、真实运行后端HTTP及兼容验收；UUID、ISO UTC响应时间沿用新项目现状。模板/导入与首次激活进展见下节。

## 成员导入及首次登录激活（03导入批次）

GET `/organizations/member-imports/template` 仅需有效登录，不要求组织管理身份或orgId；直接返回XLSX字节与下载头，无Result包装。首行为填写说明、次行为姓名/手机号/人员属性/组织内角色/入组时间；前三列必填。Accept-Language主语言以en开头时使用旧英文表头和提示，其余默认中文；SheetJS CE默认视觉样式与旧POI不完全相同，未承诺颜色/红星号/冻结窗格一致。

POST `/organizations/member-imports/generate` 使用multipart/form-data及必填Idempotency-Key（trim非空、最多128字符）；orgId可在查询参数或表单提供，memberText也可使用两种来源，同名不同值400。文件沿旧字段`csvFile`，支持XLS/XLSX及严格UTF-8 CSV；非空文件优先，文件错误不降级读文本，空文件可回退非空文本。textIgnored如实说明是否忽略文本。最多1个文件、2个文本字段；文件/文本当前最多50MiB（配置可更严格），总请求沿files配置；XLSX声明解压总量最多100MiB/1024项，不接受ZIP64/多卷，物理工作表范围最多10万行，拒绝公式/错误单元格且不求值。

文本支持中英文逗号；CSV文件只接受英文逗号，均支持双引号、转义双引号和字段内换行；空行/说明行忽略，首个固定表头可保留。列依次为姓名、手机号、人员属性、可选组织角色、可选yyyy-MM-dd入组日；姓名Unicode字母及常见英文名分隔符最多64字符，手机号大陆11位。全职/兼职或Full-time/Part-time；管理员/成员或Administrator/Member，空角色默认成员；空日期取上海上传当日零点。角色枚举代码FULL_TIME/ADMIN不能代替这些导入显示值，不允许导入主管。

先聚合全部格式、批内重复及已有关系错误；任一行错误HTTP400、code=400、data保留sourceType/textIgnored/totalCount/validCount/invalidCount/createdCount/rowErrors/members/createdAt，且不创建任何账号/关系；rowNo从去说明/表头后的数据行1开始，0为全局错误，手机号回显脱敏。无错误才原子导入，createdCount包括新建、复用已有账号及重新入组。新账号个人EXPERT、无默认密码，关系PENDING_ACTIVATION；已有账号无有效组织关系才直接ACTIVE，保留原账号类型、资料、密码及用户状态；历史LEFT/REMOVED关系复用ID、清空离组数据、版本+1。PENDING/PENDING_ACTIVATION/ACTIVE/EXIT_APPROVING/PENDING_LEAVE任一有效组织关系均阻止重复导入/跨组织占用。管理员上限5名，含待激活。

组织和操作人隔离的幂等结果保存24小时：同键不同实际来源/忽略文本标志/有效内容409，处理中409，完成后回放首次结果（包括完整行错误）；回滚不留回执，修改校验失败输入需新键或等24小时。数据库事务级占位替代旧Redis的15分钟PROCESSING锁，崩溃随事务释放；回执和成员提交同事务，不保存文件、文本或手机号清单原文。db:cleanup会清理过期回执。注册/导入/登录共用手机号锁；导入按手机号升序→组织锁，登录按手机号→组织ID升序激活，避免跨组织死锁。

首次密码或SMS登录成功前，事务内激活该用户所有待激活关系，版本+1及uid审计；激活失败回滚验证码消费/关系变更，不签发令牌、不更新最近登录。重复登录幂等，刷新和重置密码本身不激活；新账号可先SMS登录，或重置后用密码登录。API-002/008继续读取真实多组织关系，角色仍固定EXPERT。

依赖已由用户安装，固定为[SheetJS官方Node安装文档](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)列出的0.20.3 tarball，并保留锁文件integrity。新增迁移`20261019040000_member_imports`已由用户应用专用测试库；既有203项单测通过（本次未重跑），2026-10-19 16:26:59由Agent复跑74项数据库集成全部通过（总23.77秒），覆盖导入、首次激活及注入失败回滚。默认入口已交接04；开发库全部7个迁移也已由用户应用，重启后41项业务HTTP复测全部符合预期（含组织注册200），完整证据见03记录；部署、每日调度及兼容回补保留原归属，接口状态不因专用库验证而提升为完整验收。

## 个人中心、本人项目与排班考勤

2026-10-22接单侧新增API-064：`GET /expert-assignments/project-owner-candidates?assignmentId=1`，当前EXPERT且为分配所属组织有效主管可查，含正常账号的在组/退出审批中/待离职候选及当前负责人标记。支持多组织，历史负责人关系禁用旧列回退；纯读取。完整契约与本机定向复验见[接单侧说明](EXPERT_ASSIGNMENTS.md)。061—063保持部分迁移；065/066已实现待验收，067招募响应已接入，转项归12回补。负责人写契约及复验见接单侧说明。

插队任务的9个新增HTTP入口已接入，头像生命周期已补；请假/修正申请、主管审批生效及本人撤回本轮已接入；新增流程需第16迁移并单独验收。具体请求、权限、版本、依赖及迁移步骤见[个人中心与工作台后端](PERSONAL_WORKBENCH.md)，完整Schema与示例在Swagger。前批单测299项、本轮311项通过；用户2026-10-21回传14:12:47启动的137项集成全部通过（1文件，总77.59秒，测试66.39秒）；第15迁移所需专用库结构及本批业务已验证，原数据库连接阻塞解除，迁移历史未另查。开发/部署库迁移及真实OSS/日历源联调仍待验收。

2026-10-21最新验收安排：暂不开始05，先完成插队13项功能测试。311项单测已于15:14:38全量复验通过；用户15:17:51启动的145项数据库集成已全部通过（总69.67秒），第16迁移所需专用库结构已验证。待办表单序列化失败已修复，后续专用库检查明确缺第16迁移。执行步骤与逐项功能验收见[工作台说明](PERSONAL_WORKBENCH.md#全功能验收顺序)。

- 最新验证更新：用户2026-10-21回传15:17:51启动的145项集成全部通过（1文件，总69.67秒，测试60.48秒）；第16迁移所需专用测试库结构及新增8项申请/审批/撤回数据库验证已通过，迁移历史未另查。开发/部署库与真实HTTP、OSS、节假日源仍待验收；暂不开始05。 本次仅同步用户结果，未重跑测试或操作数据库。

- 2026-10-21真实HTTP续验：用户启动后端，health/ready 200。已完成48项记录检查，47项符合预期（资料/脱敏/改密全会话撤销、个人排班及幂等、真实OSS头像生命周期/展示、组织与申请权限等），真实节假日查询503尚未验收。Agent不能直连开发库，已准备仅本批账号的排班/项目接单夹具脚本，待用户本机执行后续验申请/审批/撤回/直接变更及非空项目详情；第16开发库迁移历史尚未核对。详细结果见tyde/docs/PERSONAL_WORKBENCH_ACCEPTANCE.md，暂不开始05。

- 2026-10-21最新真实验收：用户prepare-data.mjs执行成功，同事务准备5天排班及1个独立验收项目/组织接单/成员响应，脚本已核对开发库第16迁移完成。累计104项HTTP/OSS检查，103项符合预期；修正提交/主管批准、未来请假批准(autoStatus=null)、直接变更/旧版本409、撤回/重提/拒绝/过期快照、并发撤回与审批一方200另一方409、退出幂等与批准PENDING_LEAVE、本人申请分页/时间/状态/权限、非空本人项目列表/详情/keyword均通过。唯一未通过为真实节假日源503，用户本机Node fetch诊断明确10秒超时，待运行check-calendar.mjs比较源连通性。测试账号/组织数据保留，未改已有用户；暂不交接或开始05。

- 2026-10-21插队交接：本次13项接口实现及本机功能验收完成，保留原接口部署/兼容及跨任务部分迁移状态。用户诊断默认CDN/备用节点/GitHub均8秒超时、未配置代理；已按国办发明电〔2025〕7号及政府转载核对，新增编译随包2026年度日历基线（33个放假日、6个调休上班日），远程失败优先旧缓存、其次该年基线，无可靠年份仍503。运行后端国庆8条、春节11条、三月无安排及2099无可靠数据503四项复验通过，原日历功能阻塞解除；外网连通性本身未恢复。年度首次远程失败回退约10秒，之后24小时缓存；公告调整或新增年份须更新基线。累计108项HTTP/OSS记录（含原1项已修复失败及4项修复复验），最终313项单测通过（25文件，15:48:49启动，总12.90秒），类型/变更ESLint通过；用户此前145项集成通过，本轮无数据库改动、不重复跑集成。默认入口交回05但本轮不执行05；开发库16迁移已核对，部署库与完整兼容、07项目完整动作/11核验真值及03完整项目清退仍原归属。

2026-10-22接单侧API-061：`POST /expert-assignments/my-tasks`已接入且保留部分迁移，请求体`keyword/acceptanceStatus/status`（旧别名），空对象可用；当前EXPERT、本人分配及独立多组织关系鉴权。返回`basicInfo/acceptanceStatus/needWrittenExam/currentNodeCode/branchNodeCode/accessContext/operations`，主线保持项目值。067已开放有效待响应主体的接单/拒单按钮，11未接入前报量按钮false；生产/报量当天撤卡及审批/转项真值归10—12回补。完整中文Swagger及示例、边界见[接单侧说明](EXPERT_ASSIGNMENTS.md)。

2026-10-22最新07集成夹具修正：用户18:03:22定向2项，1通过/1失败/190跳过（共192项，总12.58秒）；060来源/多组织权限/身份优先/status筛选已通过，用户本机数据库连接阻塞解除。唯一失败是测试误对未创建的生产计划调用update（P2025），已改为显式创建含全部必填字段的免试计划夹具，业务实现未改。修正后18项定向单测（18:05:03，总2.84秒）及变更ESLint通过；Agent仅复验失败1项仍因自身环境127.0.0.1:5432不可达停在beforeEach，未执行修正后业务断言。仅该1项待用户本机复验，不重复已过1项、064及06；421单测及类型/build前批证据保留。无新迁移、未操作开发/部署库。保持07，复验后065—067及API-008，061—063仍部分迁移，业务Agent继续mock，不开始08。

失败单项复验（tyde目录）：`pnpm --filter @tyde/server test:integration -t 'expert task cards read latest membership progress'`。

2026-10-23接单侧API-067：`POST /expert-assignments/respond`招募个人/组织主管/普通成员三链路已接入，067保留部分迁移（转项响应和联动归12）。061待响应主体按钮已开放，笔试/免试/负责人/成员参与/补招轮次及PENDING事件同事务。438单测、28定向及类型/ESLint/build通过，用户12:02:17定向5项集成全部通过（195跳过，共200项，总6.50秒），原连接阻塞解除；无需重复，默认入口已交接08但本轮未执行。契约、完整示例、状态码和定向复验命令见[接单侧说明](EXPERT_ASSIGNMENTS.md)；真实HTTP/部署/完整兼容待验收。

## 执行专家考试（08）

API-068 `GET /entrance-exams/current`、069 `POST /entrance-exams/enter`、070 `POST /entrance-exams/submit`及071 `POST /entrance-exams/cancel`全部已接入，保留已实现待验收。当前EXPERT及有效原接单/多组织范围；随机入场绑定，交卷请求体最多2MiB（UTF-8字节），单题最多100000字符；一次保存全卷/本人新文件及绑定版本全轮次，首轮PENDING、后续WAITING；MANUAL待办和mock AUTO派发与交卷同事务，取消不保存临时答案且不可重考。已取消记录从考试任务卡片排除。文件代理精确授权本人题干/答案及有效组织职责范围答案，EXPERT不读取参考答案；NAV历史人工池与管理读取对齐。本批六项数据库集成已由用户14:48:54和14:51:55分批全部验证，08累计九项通过，基础已交接09；真实HTTP/OSS、部署及完整兼容仍待回补，不重复已过项；业务Agent继续mock。字段、错误与复验命令见[执行专家考试](ENTRANCE_EXAM_CANDIDATE.md)和生成Swagger，进度唯一来源为根08任务。

2026-10-23本机08验收：251项通过（245 HTTP + 6断言），交卷长度限制已修并真实复验；人工/取消/真实OSS及权限隔离通过。自动mock签名执行仍因专用HMAC未配置待验，部署/完整兼容保留。见[08验收报告](ENTRANCE_EXAM_CANDIDATE_ACCEPTANCE.md)，默认开发入口仍09。

## 组织排班管理（API-073—075）

`POST /organizations/schedules`、`PUT /organizations/schedules/batch`及`PUT /organizations/schedules/details/batch`已接入，统一前缀`/api/v1`。仅当前EXPERT会话的目标组织有效主管/管理员；成员/组织采用UUID，写接口要求Idempotency-Key，范围展开和明细最多5000条。同事务保存排班、已有日考勤回算、PENDING事件与幂等回执，保护人工最终状态；079原始事件重放及14实际投递待接。需第22迁移，尚待数据库/真实HTTP验收。字段、限制及复验命令见[组织排班后端](ORGANIZATION_SCHEDULES.md)，完整中文Swagger与可校验示例随服务提供。

2026-10-23 API-078 `GET /organizations/attendance/clock-context`及079 `POST /organizations/attendance/clock`已接入（已实现待验收）：目标组织本人有效关系/无组织EXPERT、服务端时间判型、按作用域及本人幂等原事件、日考勤重放及PENDING通知同事务，组织/个人排班变更也重放并保护人工结果。新增第23迁移尚未应用；500单测通过，本批5项集成因Agent环境数据库不可达未执行业务断言。真实HTTP/部署/完整兼容待验收，实际投递归14，保持09。字段、边界及专用_test库定向命令见[工作台打卡](ATTENDANCE_CLOCK.md)。

2026-10-23最新09→10交接：用户17:42:57定向运行attendance clock，本批5项集成全部通过（213跳过，共218项，总14.71秒，测试3.62秒）；并发幂等/不可变事件、原始事件重放/人工保护、多组织与个人/离组失权、午夜及跨日重试、日考勤/outbox故障整事务回滚已验证。第23迁移所需专用测试库结构已具备，迁移历史未另查，原初始化连接阻塞解除；不是全218项复跑，无需当前专用库再次迁移23或重复本批5项、073—075前批4项。09全部9种HTTP入口已有代码，保留已实现待真实HTTP/部署/完整兼容验收；500单测、35定向及类型/ESLint/build/Prisma前批证据保留。本轮仅同步用户结果与文档交接，未重跑测试、修改业务代码或操作数据库。默认入口切至10，本轮未执行10；下次从081花名册及082入项决定开始，随后083—085。业务Agent继续mock，实际投递归14。

项目人员管理API-081—085全部5种HTTP入口已有代码，保留已实现待真实HTTP/OSS、调度部署及完整兼容验收。081/082契约见[花名册与入项](PROJECT_PERSONNEL_ENTRY.md)，083—085及附件UUID/一次性凭证契约见[项目考勤与成员表现](PROJECT_PERSONNEL_RECORDS.md)。

2026-10-26最新10→11交接：用户09:49:41定向运行personnel records，本批4项集成全部通过（222跳过，共226项，总14.99秒，测试3.50秒）；考勤开放成员分页/个人与组织关系隔离/逐日筛选、历史表现分页/日期/当前任职及协作只读、附件认领/元数据/离组失权、错误附件整事务回滚及并发认领已验证。第24迁移所需专用测试库结构已具备，迁移历史未另查；原本机初始化连接阻塞解除，不是全226项复跑，无需当前专用库再次迁移24或重复本批4项、081/082前批4项及09。10累计8项集成分批通过，全部5种HTTP入口已有代码，接口保留已实现待真实HTTP/OSS、调度部署及完整兼容验收；507单测及类型/ESLint/Prisma/build前批证据保留。本轮仅同步用户结果与文档，未重跑测试、修改业务代码或操作数据库。默认入口切至11，本轮未执行11；下次先086可指定人员及087/088子任务，再089—094报量，随后095—100质量与验收。业务Agent继续mock，完整跨域卡片/转项审批/实际投递仍归04/12/14。

生产子任务第一批（2026-10-26）：新增POST `/production-tasks/members`、`/create`、`/list`，契约、角色范围、第25迁移和4项定向复验见[生产子任务](PRODUCTION_SUBTASKS.md)。086/087已实现待验收，088部分迁移，报量/验收来源与动作待后续接入；不提供未实现按钮。

11第二批生产报量：API-089—094已接入，088回补本人真实报量及修正来源/动作，验收仍部分迁移；新增第26迁移（未应用），515单测及类型/ESLint/Prisma/build通过。本批6集成在beforeEach因Agent环境数据库不可达未运行业务断言；先专用_test库迁移26并仅定向本批6项。完整契约、权限、512KiB批量上限、事务及复验命令见[生产报量](PRODUCTION_OUTPUT_REPORTS.md)。真实HTTP/部署/完整兼容待验收，业务Agent保持mock。

2026-10-26 10:30:53更新：报量第二批剩余1项通过，结合前5项，本批6项分批全过，不是全236项复跑。无需重复第一批4项或第二批6项，不再迁移当前专用库26；下次直接095—100及088验收事实/动作回补。真实HTTP/部署/完整兼容仍待验收。本轮仅同步文档，未改业务代码、重跑测试或操作数据库。详情见[生产报量](PRODUCTION_OUTPUT_REPORTS.md)。


## 11第三批：质量与子任务验收（2026-10-26）

新增API-095—100六个POST入口，088验收事实及SUBMIT_ACCEPTANCE/ACCEPT/REJECT动作已补齐；质量保存512KiB请求上限、追加历史/最新汇总、当前组织职责/协作只读、主策略官提交及项目创建人NAV审核已实现。新增第27迁移，Agent未应用；520单测及类型/ESLint/Prisma/build通过，本批6项集成受初始化连接阻塞未执行业务断言。正式接口均保留已实现待真实HTTP/部署/完整兼容验收。字段、范围和仅本批复验命令见[质量与验收](PRODUCTION_QUALITY_ACCEPTANCE.md)。


11第三批集成更新（2026-10-26）：用户10:50:10本批6项全部通过（236跳过，共242项，总10.94秒，测试7.00秒），不是全242项复跑；第27所需专用库结构已具备，迁移历史未另查，原初始化连接阻塞解除。11累计16项集成分批通过，086—100仍保留已实现待真实HTTP/部署/完整兼容验收。默认入口已交接12，本轮只同步结果与文档，未重跑测试、修改业务代码或操作数据库。
