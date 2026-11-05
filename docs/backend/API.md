# API 与 Swagger 使用说明

接口以运行中 Swagger 和[业务文档导航](../README.md#业务接口说明)为入口。统一账号使用真实会话角色；业务权限继续按项目及组织关系校验。旧迁移批次和验收流水见[后端开发历史](../archive/BACKEND_HISTORY.md#api)。

本文带日期的批次结果、迁移/复验命令及“保持/下次”安排只对应当时的记录；当前续做以根目录 [AGENTS.md](../../AGENTS.md) 为准，不能用历史失败或待接入描述覆盖后续实现与验收。

## Swagger 文档标准

后续新增、迁移和修改的后端接口统一遵循本标准。Swagger 必须能让调用方直接理解字段与使用条件；中文说明写进实际 JSON Schema/OpenAPI，TypeScript/Java 注释或独立 Markdown 不能替代它。

1. **接口级说明**：提供中文 `summary` 和 `description`、唯一 `operationId`、业务 `tags`；说明用途、认证方式、前置条件、关键副作用、幂等/重复调用及已知限制。HTTP 方法、路径和字段名保持迁移约定。
2. **每个字段都有中文含义**：请求 body、path/query/header 参数、响应包装和业务数据都要写中文 `description`。对象本身、对象内部字段、数组及数组项递归补齐，不能只写 string/integer 或把字段名翻译成同名英文。无请求体的接口明确说明即可，不编造参数。
3. **取值与业务规则**：枚举逐值解释，例如 `INDIVIDUAL=个人、ORGANIZATION=组织`；说明实际默认行为、格式/长度、数值单位、日期格式/时区、脱敏和 null/空数组的意义。`required` 由实际 schema 声明；条件必填在字段和接口说明写清，例如创建组织必须填写 `name`。不要为了展示默认值给 schema 添加会改变 AJV 入参的 `default`。
4. **枚举可读性**：普通字符串枚举优先输出 `type: string` + `enum`，避免把每个字面量展开为一层 `anyOf`。保留现有合法取值、TypeScript 类型推导和验证语义；只有真实联合结构才使用 `oneOf/anyOf`。
5. **完整示例**：每个有请求体的接口至少一个可通过实际 schema 校验的请求示例；个人/组织等主要分支分别给示例。成功响应提供实际结构示例，失败响应说明 HTTP 状态、业务码、中文原因和必要响应头（例如 `Retry-After` 单位为秒）。示例里的密码、令牌、手机号和证件均为演示值，不能使用环境密钥或真实用户数据。
6. **文档与当前实现一致**：字段未接入、固定值、兼容字段被忽略、暂不支持的分支必须明确说明，不能把规划能力写成已上线。注册兼容字段 `roles` 被忽略，统一账号自带三角色，当前角色由会话决定；文件存储默认关闭。项目及考试附件按当前会话角色和真实管理、接单、准入、考生绑定及组织职责范围授权，范围之外拒绝读取；这些条件需在页面直接可见。
7. **响应 schema 保真**：响应 schema 会影响 Fastify 序列化。给原自由对象补嵌套字段时核验字段与 null 不丢失；文档补充不得暗改校验、字段名、HTTP 状态或业务行为。发现业务差异按迁移任务另外记录。
8. **交付验收**：查看生成的 `/api/v1/docs/json`，检查中文字段说明、嵌套结构、枚举和完整示例确实存在；示例通过实际请求校验；验证响应序列化及现有契约不变。`apps/server/tests/unit/docs.test.ts` 已递归检查当前请求/响应字段的中文说明，并校验示例与枚举、组织响应字段保留；有 path/query/header 或新响应结构时扩展相应检查。不能仅靠 schema 源码有注释就通过验收。

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
| POST `/files/upload`       | multipart：`file` 必填，`bizType/category` 选填       | 可匿名；头像、组织Logo及业务附件必须登录。返回可信元数据、objectKey、一次性 uploadToken；敏感文件 url=null。  |
| POST `/files/upload/batch` | multipart：重复 `files` 字段，`bizType/category` 选填 | 默认最多10个文件，按顺序返回；后续上传失败时前面成功的对象保留，未认领对象过期清理。                          |
| GET `/files/view`          | query：`objectKey` 必填                               | 需登录；安全图片/PDF内联，其余强制下载；no-store, private 与 nosniff。匿名请求403。                           |
| GET `/files/access-url`    | query：`objectKey` 必填，`expireSeconds` 选填         | 需登录；敏感目录或台账一律403。非敏感图片默认2147483647秒，其他默认604800秒；非正数视为默认，最大32位正整数。 |
| DELETE `/files`            | query：`objectKey` 必填                               | 需登录且为本人未认领文件；匿名上传对象、已认领对象和重复删除403。成功data=true。                              |

`bizType` 默认 COMMON，`category` 默认由业务推断；忽略大小写和首尾空白，未知值400。固定业务大类不能被 category 放宽，ANY 仍受已知安全类型白名单。全局单文件默认50MiB、请求100MiB（含multipart边界/字段）、批量10个；图片/JSON10MiB，文档/Excel20MiB，视频/业务附件/ANY50MiB，均可被全局硬上限收紧。文件名、声明MIME和实际内容须一致；拒绝SVG/HTML/脚本及伪装内容；Office ZIP 检查结构和CRC，最多检查200项、解压2MiB，不解包落盘。文件和请求超限413，字段/内容不符400。

敏感文件只通过鉴权代理读取：未认领对象只允许上传者；匿名预上传在组织认领前不能读取（uploadToken不是读取凭据）。已认领营业执照仅所属组织有效关系（ACTIVE/EXIT_APPROVING/PENDING_LEAVE）的 OWNER/ADMIN 可读取，且组织未逻辑删除；不使用用户单组织兼容字段或 hasExpertManagementRole 展示字段授权。

已认领项目附件要求项目未删除、附件ACTIVE、台账CLAIMED及项目绑定一致。当前NAVIGATOR会话限项目创建人，当前PM会话限ASSIGNED主策略官或招募协作负责人；不查询历史独立授权表，任职失效后下一请求拒绝。当前EXPERT会话校验真实接单、组织关系及准入来源：免试时真实已接单个人或有效组织成员可读，需笔试时限有效组织主管/项目负责人或有未删除考试ADMITTED结果的专家。ACTIVE项目成员或上传者身份本身不授予下载权限。

考试附件须绑定未删除考试及项目：当前PM会话按实际任职，当前NAVIGATOR会话按需求方/创建人或历史人工阅卷池授权；EXPERT仅可读取本人绑定试卷题干、本人答案，以及有效已接单组织职责范围的本组织答案，不能读取参考答案。普通接单及转项来源分别核对关联应试与实际组织/成员关系，不借用其他来源。非敏感文件沿用登录后访问规则。只接受新项目存活台账，不接收旧bucket未登记对象；这与旧普通文件“只要登录即可查看”存在收紧差异，完整兼容验收仍按实际记录核对。

历史验证证据：项目附件创建人分支及认领对应92项集成，PM任职分支对应102项，专家来源基础对应137项；这些数字仅代表原批次，见[后端开发历史](../archive/BACKEND_HISTORY.md#api)，不代替当前环境的真实OSS、部署或完整流程验收。

统一账号注册不接收组织资料。登录后以当前EXPERT会话调用 `POST /organizations` 独立创建组织，`businessLicense` 接受 BUSINESS_LICENSE 的 `objectKey/uploadToken`，默认24小时内一次认领（可配置），原文凭证不落库。无记录/类型错误/存储对象缺失或大小不符400，错误凭证403，过期/重复409，存储关闭/不可达503。营业执照认领、组织创建及本人OWNER关系同事务，失败回滚；组织资料中的 `businessLicenseUrl` 保留旧字段名，返回objectKey或null，不是公开URL。

Swagger 提供 multipart 输入、请求/响应/查询字段中文说明和完整 schema 示例，文件代理 200 按实际媒体类型记录二进制响应。文件与注册测试使用专用 PostgreSQL 和内存对象存储；真实 OSS 可通过 `pnpm --filter @tyde/server storage:verify` 独立验证，不能把测试替身结果视为真实存储验收。

示例配置默认 `FILE_STORAGE_PROVIDER=disabled`。启用时仅在后端配置 OSS bucket 与密钥；服务端读写使用 `OSS_ENDPOINT`，客户端下载签名使用 `OSS_PUBLIC_ENDPOINT`，两者按网络环境选择内网或外网端点。新对象显式私有且禁止覆盖。真实存储、营业执照认领及后续业务附件关系需按实际环境验收，步骤见[部署说明](../DEPLOY_TEST.md#文件存储与上传01)。

## 用户资料与昵称（02）

- `GET /users/nickname/check?nickname=小明` 可匿名，无请求体。trim后非空，最多64字符；返回 `nickname/available/suggestion/message`。占用时从1递增推荐，最长64字符（必要时截短原昵称）；最多尝试1000次，耗尽409。查询不预留昵称；注册默认真实姓名生成的昵称同样受唯一约束，重复409且注册事务回滚。新PostgreSQL按大小写敏感精确匹配，旧MySQL排序规则差异待兼容验收。
- `POST /users/me/update` 需本人会话，body所有字段可选：`avatarUrl`（512字符）、`avatarUploadToken`（128字符，关联新头像时条件必填）、`bio`（1000字符）、`idCardNo`（32字符）、`newPassword`、`confirmNewPassword`（64字符）、`roles`（1～3个已知角色）。省略/null保持；头像、简介、未认证身份证传空白可清空，非空值trim，身份证转大写。未知字段400，不能提交目标用户ID、昵称、姓名、邮箱或实名状态。
- 身份证沿用15位或18位格式验证，非完整证件真实性/校验码核验；已认证号码仅可提交同一号码，改号/清空403，重复号码409。`idVerified`从数据库读取，注册默认0，没有自助认证入口。姓名/邮箱继续只在注册入口验证。
- 修改密码时必须成对一致且满足既有强度规则；密码更新与全部Web/桌面会话及刷新令牌撤销同事务，Web/Electron成功清除Cookie。仅修改其他资料不撤销会话。服务端复用登录/重置的手机号锁并在锁内复查会话，拒绝并发中已撤销的凭据。`roles` 是兼容字段：已知角色选择忽略，不改变账号自带三角色或当前会话身份，也不单独触发下线。
- 成功返回完整UserDTO；头像/简介/实名状态读取实际保存值，`role/selectedRole` 来自当前会话，`roles` 返回NAVIGATOR/PM/EXPERT；`hasExpertManagementRole` 仅当前EXPERT会话根据有效组织主管/项目负责人关系计算。`GET /users/me` 使用同一角色与关系规则，不能把资料响应中的展示标志当作业务授权。组织资料按有效多组织关系选择；信用当前返回兼容值100，改密后的presence联动仍归14。
- 头像关联已在插队任务补齐：AVATAR须登录上传，保存资料时传`avatarUrl=objectKey`及`avatarUploadToken=uploadToken`；服务端校验本人归属、类型、凭证、时效和存储对象，认领后保存可展示签名URL。重复保存本人已认领头像可省略凭证；替换/清空释放旧头像供到期清理，资料、认领与释放同事务。历史外部URL/非AVATAR字符串兼容保存，不远程抓取、不自动认领，也不保证外部文件生命周期。敏感文件不能因头像字段而公开。

资料更新请求示例（可在Swagger验证）：

```json
{ "avatarUrl": "https://example.com/avatar.png", "bio": "数据标注专家", "roles": ["EXPERT"] }
```

新增 `20261019010000_user_profile` 迁移，增加头像、简介、实名状态、修改人及昵称唯一索引。部署前先人工检查历史昵称重复；迁移遇到重复会原子回滚，不自动改名。用户已在专用测试库应用且41项集成全部通过；本地运行后端已通过51项HTTP检查，证明新资料字段与昵称冲突保护生效。本轮未执行迁移或查询迁移历史；开发库迁移记录核对、部署及兼容验收仍待完成；最新验收以02任务记录（历史外部记录：`backend-migration/02-user-profile/todoTask.md`）为准。本机专用测试库迁移/复验命令（本轮已由用户成功执行）：

```sh
node scripts/migrate-test-database.mjs
pnpm test:integration
```

脚本仅接受已有 `.env.test` 中 `APP_ENV=test/TEST_DATABASE_RESET=true`、本机且以 `_test` 结尾的库，不创建库、不清表；集成测试会清空该专用库。切勿用开发库替换测试配置。昵称重复可先只读检查 `SELECT "displayName", COUNT(*) FROM "User" GROUP BY "displayName" HAVING COUNT(*) > 1;`，经用户决定后处理存量，不自动改名或删号。

## 组织资料（03首批）

GET `/organizations?orgId=<UUID>`、POST `/organizations/update` 沿用旧路径、方法、字段名和Result。查询允许指定组织的OWNER/ADMIN，关系须为ACTIVE、EXIT_APPROVING或PENDING_LEAVE；编辑只允许ACTIVE的OWNER。权限读取`UserOrgRel`，不使用EXPERT登录身份或用户单组织兼容字段。无关系403；有合格关系但组织不存在/已逻辑删除404。

编辑请求 `{ "orgId": "00000000-0000-4000-8000-000000000002", "description": "新简介", "logoUrl": "https://example.com/logo.png" }`。description最多1000字符、logoUrl最多500字符；未传/null保持原值，trim后空串清空，额外字段400。角色检查与资料更新同事务锁组织行并记uid审计。Logo支持登录后以`bizType=ORG_LOGO`上传图片，创建或更新组织时提交`logoUrl=objectKey`与`logoUploadToken=uploadToken`；验证当前账号上传、凭证、类型和对象后认领，保存并返回可展示URL。组织已认领的图片可重复保存，包括主管交接后的新主管；替换/清空时释放旧图并设置回收时间，认领/释放与组织写入同事务。外部HTTPS地址兼容保留；不远程抓取。响应保留旧组织资料字段，营业执照返回objectKey；认证/运行状态读数据库真实值。完整示例和所有字段说明见Swagger。

新迁移`20261019020000_organization_memberships`已由用户应用专用测试库；155项单测通过，2026-10-19 13:23:17用户本机45项集成全部通过，缺列/缺表阻塞已解除。开发/部署库尚未应用本次迁移，真实运行后端HTTP联调待完成。UUID/ISO UTC时间仍与旧数值ID/本地日期格式不同，待兼容验收。后续成员管理及多组织回补见下节；该段为组织资料批次记录，审批/导入后续已接入，完整进度以03任务（历史外部记录：`backend-migration/03-organizations/todoTask.md`）为准。

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

API-021/024项目副作用尚未接实，保留部分迁移：组织LEFT时同事务写`OrganizationDeparture` PENDING记录（按关系+版本去重），不表示项目成员、负责人、人员变动单或实时事件已清理。04/07/12接处理器并处理积压后才可标COMPLETED；当前不提供清空待补偿记录的捷径。到期PENDING_LEAVE须执行维护命令，每条成员独立事务，重复运行幂等；部署需配置每天上海零点调度，本批未部署。详见[部署说明](../DEPLOY_TEST.md#组织到期离职维护03)。

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

2026-10-21最新验收安排：暂不开始05，先完成插队13项功能测试。311项单测已于15:14:38全量复验通过；用户15:17:51启动的145项数据库集成已全部通过（总69.67秒），第16迁移所需专用库结构已验证。待办表单序列化失败已修复，后续专用库检查明确缺第16迁移。执行步骤与逐项功能验收见[工作台说明](PERSONAL_WORKBENCH.md#历史迁移与验收证据)。

- 最新验证更新：用户2026-10-21回传15:17:51启动的145项集成全部通过（1文件，总69.67秒，测试60.48秒）；第16迁移所需专用测试库结构及新增8项申请/审批/撤回数据库验证已通过，迁移历史未另查。开发/部署库与真实HTTP、OSS、节假日源仍待验收；暂不开始05。 本次仅同步用户结果，未重跑测试或操作数据库。

- 2026-10-21真实HTTP续验：用户启动后端，health/ready 200。已完成48项记录检查，47项符合预期（资料/脱敏/改密全会话撤销、个人排班及幂等、真实OSS头像生命周期/展示、组织与申请权限等），真实节假日查询503尚未验收。Agent不能直连开发库，已准备仅本批账号的排班/项目接单夹具脚本，待用户本机执行后续验申请/审批/撤回/直接变更及非空项目详情；第16开发库迁移历史尚未核对。详细结果见tyde/docs/PERSONAL_WORKBENCH_ACCEPTANCE.md，暂不开始05。

- 2026-10-21最新真实验收：用户prepare-data.mjs执行成功，同事务准备5天排班及1个独立验收项目/组织接单/成员响应，脚本已核对开发库第16迁移完成。累计104项HTTP/OSS检查，103项符合预期；修正提交/主管批准、未来请假批准(autoStatus=null)、直接变更/旧版本409、撤回/重提/拒绝/过期快照、并发撤回与审批一方200另一方409、退出幂等与批准PENDING_LEAVE、本人申请分页/时间/状态/权限、非空本人项目列表/详情/keyword均通过。唯一未通过为真实节假日源503，用户本机Node fetch诊断明确10秒超时，待运行check-calendar.mjs比较源连通性。测试账号/组织数据保留，未改已有用户；暂不交接或开始05。

- 2026-10-21插队交接：本次13项接口实现及本机功能验收完成，保留原接口部署/兼容及跨任务部分迁移状态。用户诊断默认CDN/备用节点/GitHub均8秒超时、未配置代理；已按国办发明电〔2025〕7号及政府转载核对，新增编译随包2026年度日历基线（33个放假日、6个调休上班日），远程失败优先旧缓存、其次该年基线，无可靠年份仍503。运行后端国庆8条、春节11条、三月无安排及2099无可靠数据503四项复验通过，原日历功能阻塞解除；外网连通性本身未恢复。年度首次远程失败回退约10秒，之后24小时缓存；公告调整或新增年份须更新基线。累计108项HTTP/OSS记录（含原1项已修复失败及4项修复复验），最终313项单测通过（25文件，15:48:49启动，总12.90秒），类型/变更ESLint通过；用户此前145项集成通过，本轮无数据库改动、不重复跑集成。默认入口交回05但本轮不执行05；开发库16迁移已核对，部署库与完整兼容、07项目完整动作/11核验真值及03完整项目清退仍原归属。

2026-10-22接单侧API-061：`POST /expert-assignments/my-tasks`已接入且保留部分迁移，请求体`keyword/acceptanceStatus/status`（旧别名），空对象可用；当前EXPERT、本人分配及独立多组织关系鉴权。返回`basicInfo/acceptanceStatus/needWrittenExam/currentNodeCode/branchNodeCode/accessContext/operations`，主线保持项目值。067已开放有效待响应主体的接单/拒单按钮，任务卡报量按钮已在任务13第十五批接实时报量权限；第十四/十六批回补普通接单及转项生效卡当前组织实时核查/修正节点（OUTPUT_DATA_REVIEW/PRODUCTION_TASK）。普通生产待办在本人上海当日已有报量（含零量）后隐藏、次日恢复；实时核查、退回修正及独立培训保留。其他读取/跨域兼容继续留13。完整中文Swagger及示例、边界见[接单侧说明](EXPERT_ASSIGNMENTS.md)。

2026-10-22最新07集成夹具修正：用户18:03:22定向2项，1通过/1失败/190跳过（共192项，总12.58秒）；060来源/多组织权限/身份优先/status筛选已通过，用户本机数据库连接阻塞解除。唯一失败是测试误对未创建的生产计划调用update（P2025），已改为显式创建含全部必填字段的免试计划夹具，业务实现未改。修正后18项定向单测（18:05:03，总2.84秒）及变更ESLint通过；Agent仅复验失败1项仍因自身环境127.0.0.1:5432不可达停在beforeEach，未执行修正后业务断言。仅该1项待用户本机复验，不重复已过1项、064及06；421单测及类型/build前批证据保留。无新迁移、未操作开发/部署库。保持07，复验后065—067及API-008，061—063仍部分迁移，业务Agent继续mock，不开始08。

失败单项复验（tyde目录）：`pnpm --filter @tyde/server test:integration -t 'expert task cards read latest membership progress'`。

2026-10-23接单侧API-067：`POST /expert-assignments/respond`招募个人/组织主管/普通成员三链路已接入，067保留部分迁移（转项响应和联动归12）。061待响应主体按钮已开放，笔试/免试/负责人/成员参与/补招轮次及PENDING事件同事务。438单测、28定向及类型/ESLint/build通过，用户12:02:17定向5项集成全部通过（195跳过，共200项，总6.50秒），原连接阻塞解除；无需重复，默认入口已交接08但本轮未执行。契约、完整示例、状态码和定向复验命令见[接单侧说明](EXPERT_ASSIGNMENTS.md)；真实HTTP/部署/完整兼容待验收。

## 执行专家考试（08）

API-068 `GET /entrance-exams/current`、069 `POST /entrance-exams/enter`、070 `POST /entrance-exams/submit`及071 `POST /entrance-exams/cancel`全部已接入，保留已实现待验收。当前EXPERT及有效原接单/多组织范围；随机入场绑定，交卷请求体最多2MiB（UTF-8字节），单题最多100000字符；一次保存全卷/本人新文件及绑定版本全轮次，首轮PENDING、后续WAITING；MANUAL待办和mock AUTO派发与交卷同事务，取消不保存临时答案且不可重考。已取消记录从考试任务卡片排除。文件代理精确授权本人题干/答案及有效组织职责范围答案，EXPERT不读取参考答案；NAV历史人工池与管理读取对齐。本批六项数据库集成已由用户14:48:54和14:51:55分批全部验证，08累计九项通过，基础已交接09；真实HTTP/OSS、部署及完整兼容仍待回补，不重复已过项；业务Agent继续mock。字段、错误与复验命令见[执行专家考试](ENTRANCE_EXAM_CANDIDATE.md)和生成Swagger，进度唯一来源为根08任务。

2026-10-23本机08验收：251项通过（245 HTTP + 6断言），交卷长度限制已修并真实复验；人工/取消/真实OSS及权限隔离通过。自动mock签名执行仍因专用HMAC未配置待验，部署/完整兼容保留。见[08验收报告](../archive/ACCEPTANCE_HISTORY.md#entrance-exam-candidate-acceptance)，默认开发入口仍09。

## 组织排班管理（API-073—075）

`POST /organizations/schedules`、`PUT /organizations/schedules/batch`及`PUT /organizations/schedules/details/batch`已接入，统一前缀`/api/v1`。仅当前EXPERT会话的目标组织有效主管/管理员；成员/组织采用UUID，写接口要求Idempotency-Key，范围展开和明细最多5000条。同事务保存排班、已有日考勤回算、PENDING事件与幂等回执，保护人工最终状态；079原始事件重放也已接入，实际通知投递仍归14。迁移22/23及历史数据库验证范围见[组织排班后端](ORGANIZATION_SCHEDULES.md)和[工作台打卡](ATTENDANCE_CLOCK.md)，不由专用库结果推断目标环境已迁移。完整中文Swagger与可校验示例随服务提供。

2026-10-23 API-078 `GET /organizations/attendance/clock-context`及079 `POST /organizations/attendance/clock`已接入（已实现待验收）：目标组织本人有效关系/无组织EXPERT、服务端时间判型、按作用域及本人幂等原事件、日考勤重放及PENDING通知同事务，组织/个人排班变更也重放并保护人工结果。新增第23迁移尚未应用；500单测通过，本批5项集成因Agent环境数据库不可达未执行业务断言。真实HTTP/部署/完整兼容待验收，实际投递归14，保持09。字段、边界及专用_test库定向命令见[工作台打卡](ATTENDANCE_CLOCK.md)。

2026-10-23最新09→10交接：用户17:42:57定向运行attendance clock，本批5项集成全部通过（213跳过，共218项，总14.71秒，测试3.62秒）；并发幂等/不可变事件、原始事件重放/人工保护、多组织与个人/离组失权、午夜及跨日重试、日考勤/outbox故障整事务回滚已验证。第23迁移所需专用测试库结构已具备，迁移历史未另查，原初始化连接阻塞解除；不是全218项复跑，无需当前专用库再次迁移23或重复本批5项、073—075前批4项。09全部9种HTTP入口已有代码，保留已实现待真实HTTP/部署/完整兼容验收；500单测、35定向及类型/ESLint/build/Prisma前批证据保留。本轮仅同步用户结果与文档交接，未重跑测试、修改业务代码或操作数据库。默认入口切至10，本轮未执行10；下次从081花名册及082入项决定开始，随后083—085。业务Agent继续mock，实际投递归14。

项目人员管理API-081—085全部5种HTTP入口已有代码，保留已实现待真实HTTP/OSS、调度部署及完整兼容验收。081/082契约见[花名册与入项](PROJECT_PERSONNEL_ENTRY.md)，083—085及附件UUID/一次性凭证契约见[项目考勤与成员表现](PROJECT_PERSONNEL_RECORDS.md)。

2026-10-26最新10→11交接：用户09:49:41定向运行personnel records，本批4项集成全部通过（222跳过，共226项，总14.99秒，测试3.50秒）；考勤开放成员分页/个人与组织关系隔离/逐日筛选、历史表现分页/日期/当前任职及协作只读、附件认领/元数据/离组失权、错误附件整事务回滚及并发认领已验证。第24迁移所需专用测试库结构已具备，迁移历史未另查；原本机初始化连接阻塞解除，不是全226项复跑，无需当前专用库再次迁移24或重复本批4项、081/082前批4项及09。10累计8项集成分批通过，全部5种HTTP入口已有代码，接口保留已实现待真实HTTP/OSS、调度部署及完整兼容验收；507单测及类型/ESLint/Prisma/build前批证据保留。本轮仅同步用户结果与文档，未重跑测试、修改业务代码或操作数据库。默认入口切至11，本轮未执行11；下次先086可指定人员及087/088子任务，再089—094报量，随后095—100质量与验收。业务Agent继续mock，完整跨域卡片/转项审批/实际投递仍归04/12/14。

生产子任务第一批（2026-10-26）：新增POST `/production-tasks/members`、`/create`、`/list`，契约、角色范围、第25迁移和4项定向复验见[生产子任务](PRODUCTION_SUBTASKS.md)。086/087已实现待验收，088部分迁移，报量/验收来源与动作待后续接入；不提供未实现按钮。

11第二批生产报量：API-089—094已接入，088回补本人真实报量及修正来源/动作，验收仍部分迁移；新增第26迁移（未应用），515单测及类型/ESLint/Prisma/build通过。本批6集成在beforeEach因Agent环境数据库不可达未运行业务断言；先专用_test库迁移26并仅定向本批6项。完整契约、权限、512KiB批量上限、事务及复验命令见[生产报量](PRODUCTION_OUTPUT_REPORTS.md)。真实HTTP/部署/完整兼容待验收，业务Agent保持mock。

2026-10-26 10:30:53更新：报量第二批剩余1项通过，结合前5项，本批6项分批全过，不是全236项复跑。无需重复第一批4项或第二批6项，不再迁移当前专用库26；下次直接095—100及088验收事实/动作回补。真实HTTP/部署/完整兼容仍待验收。本轮仅同步文档，未改业务代码、重跑测试或操作数据库。详情见[生产报量](PRODUCTION_OUTPUT_REPORTS.md)。

## 11第三批：质量与子任务验收（2026-10-26）

新增API-095—100六个POST入口，088验收事实及SUBMIT_ACCEPTANCE/ACCEPT/REJECT动作已补齐；质量保存512KiB请求上限、追加历史/最新汇总、当前组织职责/协作只读、主策略官提交及项目创建人NAV审核已实现。新增第27迁移，Agent未应用；520单测及类型/ESLint/Prisma/build通过，本批6项集成受初始化连接阻塞未执行业务断言。正式接口均保留已实现待真实HTTP/部署/完整兼容验收。字段、范围和仅本批复验命令见[质量与验收](PRODUCTION_QUALITY.md)。

11第三批集成更新（2026-10-26）：用户10:50:10本批6项全部通过（236跳过，共242项，总10.94秒，测试7.00秒），不是全242项复跑；第27所需专用库结构已具备，迁移历史未另查，原初始化连接阻塞解除。11累计16项集成分批通过，086—100仍保留已实现待真实HTTP/部署/完整兼容验收。默认入口已交接12，本轮只同步结果与文档，未重跑测试、修改业务代码或操作数据库。

12第一批（2026-10-26）：API-101 `POST /api/v1/project-personnel/movements/target-projects`已接入，当前主策略官及EXPERT有效主管/负责人范围，协作负责人不可用；来源组织已接单交集、目标任一开放身份排除、个人成员无候选及分页保持旧契约。中文Swagger与序列化已验证，3项专用库集成因初始化连接不可达尚未执行断言；无新迁移，102—106仍未迁移。字段及本批复验见[人员变动](PERSONNEL_MOVEMENTS.md)。

12第一批集成更新（2026-10-26）：用户11:26:32定向运行personnel transfer targets，3项全部通过（242跳过，共245项，总5.34秒，测试2.75秒），原初始化连接阻塞解除，非全量复跑。101保留已实现待真实HTTP/部署/完整兼容验收，无新迁移，无需重复本批或11通过项。保持12，下次直接102及TransferStep持久化/接单考试联动。本轮仅同步结果与文档，未重跑测试或操作数据库。

12第二批（2026-10-26）：API-102 `POST /api/v1/project-personnel/movements/create`创建与完整节点快照已接入，保留部分迁移；汰换待生效、转项仅激活首节点，不伪造本人接单、目标考试或最终入项。组织退出待办列表限定自身三类业务，处理接口继续拒绝转项。第28迁移未应用；528单测和类型/ESLint/Prisma/build通过，新增4项集成仅初始化连接失败，未执行业务断言。接单/考试消费、103—106/到期生效及107/07聚合待续。字段和专用库复验见[人员变动](PERSONNEL_MOVEMENTS.md)。

12第二批集成更新（2026-10-26）：用户11:40:28定向4项全过（245跳过，共249项，总7.35秒，测试3.80秒）。102创建/完整节点快照数据库断言已验证；第28迁移所需专用库结构已具备，迁移历史未另查，无需当前专用库再迁移28或重复本批/101/11通过项。102仍部分迁移，下次直接接单/目标考试消费与103—106/到期生效，再107/07回补；真实HTTP/部署/完整兼容待验收。本轮仅同步用户结果与文档。

12第三批（2026-10-26）：067已开放movementId本人转项响应；068—071接独立PROJECT_MEMBER_TRANSFER应试来源，最终录取/淘汰及取消提交后独立消费，失败可显式补偿；新增105撤回及106人工节点处理。等待节点不能人工跳过；不伪造目标接单、应试结果或入项。102/106保留部分迁移：当前待办负责人同步与到期生效尚未接入，103/104未迁移，107/07来源待回补。第29迁移未应用，535单测及收尾59定向/类型/ESLint/Prisma/build通过；新增6项集成分两次均停在初始化连接失败，业务断言未执行。只需本机专用_test库更新29并定向本批6项，不重复前批创建/候选/11集成。字段及复验见[人员变动第三批](PERSONNEL_MOVEMENTS.md#第三批业务入口)。以上旧批次“转项未接入/503”等描述为历史，以本段为准。

2026-10-26最新12第三批状态约束修复：用户12:04:38定向六项全部失败（249跳过，共255项，总8.50秒，测试5.62秒），数据库初始化阻塞已解除；共同失败点为转项节点写入CANCELLED，违反既有ApprovalNode_status_check（仅接受CANCELED）。已修正下一节点候选刷新、ANY同组候选关闭和终止/撤回三处写入，未改schema/迁移或放宽约束。新增直接读取真实迁移约束的回归，修复前复现失败；修复后12:05:57转项/创建/OpenAPI定向21项通过（3文件，总3.38秒），服务端类型、变更ESLint及后端包build通过；未全量复跑当前538项，前批535项全量及收尾定向证据保留。Agent12:06:07仅复验本批六项仍停在beforeEach，127.0.0.1:5432不可达（249跳过，共255项，总4.39秒，测试580ms），修复后数据库断言待用户本机复验。本机专用库已执行到业务写入，第29迁移所需结构已具备，迁移历史未另查；当前专用库无需再次迁移29。保持12，仅复验personnel transfer progression六项，不重复创建/候选或11通过项；通过后103/104、当前负责人同步、到期生效及107/07。未操作开发/部署库，业务Agent继续mock。

2026-10-26最新12第三批集成通过：用户14:16:05定向运行personnel transfer progression，本批6项全部通过（249跳过，共255项，总19.89秒，测试7.28秒）。真实接单/独立目标考试及五步推进、取消/拒绝恢复与撤回、并发终态/旧版本冲突、负责人和本人离组失权、outbox整事务回滚及考试结果已提交后消费者失败/显式补偿幂等已验证。原ApprovalNode_status_check的CANCELLED误写冲突已解除；第29迁移所需专用库结构具备，迁移历史未另查，不是全255项复跑，无需当前专用库再次迁移29或重复本批六项、前批创建/候选及11通过项。102/106仍部分迁移，105仍待真实HTTP/部署/完整兼容验收；535项全量及收尾59/9和修复后21项定向/类型/ESLint/build前批证据保留。本轮仅同步用户结果与文档，未重跑测试、修改业务代码或操作数据库。保持12，下次直接103/104查询、已激活待办负责人动态同步、当天审批完成即时生效/未来到期生效，再107/07来源及旧assignmentId转项响应兼容回补；业务Agent继续mock，不得人工跳过等待节点。

## 人员变动读取（12第四批）

API-103 `POST /project-personnel/movements/list` 和API-104 `POST /project-personnel/movements/detail` 已实现待真实HTTP/部署/完整兼容验收。列表按projectId、可选movementId/memberId、movementTypes/statuses、keyword、createdStartAt/createdEndAt及current/size筛选；详情必须projectId/memberId，取原项目该成员最新一条。保持Cookie/Bearer、Result包装及no-store；用户/组织/节点ID按本系统UUID，项目/成员/变动ID为正整数。管理范围合并本人及合法历史审批参与范围，协作负责人只读；allowedActions重新核对当前业务资格，等待节点不能人工跳过。返回流程版本、节点最后动作、独立考试结果及上海时间，不返回答案或内部表单。完整字段、边界、示例和复验命令见[人员变动](PERSONNEL_MOVEMENTS.md#第四批读取与复验)。

## 人员变动负责人同步与生效（12第五批）

102当天汰换创建即生效；106转项最终批准后，日期已到则原成员离项、目标成员入项与审批/outbox同事务，否则保留WAITING_EFFECTIVE，由到期命令推进。effectiveAt为预计日期上海零点。负责人替换与主策略官交接会同步当前人工节点、流程版本、审计及轮次；其他关系失效可显式补偿，读取不写入。请求/响应字段与路径不变，Swagger描述已同步。102/106仍部分迁移：107/07转项来源、个人转入资格及旧assignmentId兼容待回补；真实HTTP/部署/完整兼容未验收。用户2026-10-26 15:45:19定向6项集成全部通过（258跳过，共264项，总14.99秒，测试10.97秒），原初始化连接阻塞解除；不是全264项复跑。549单测及收尾47定向前批证据保留。本轮仅同步文档，不重跑或操作数据库；下次107/07来源及旧assignmentId兼容。命令和复验见[第五批说明](PERSONNEL_MOVEMENTS.md#第五批负责人同步与生效)。

2026-10-26任务12第六批：本人申请响应新增nullable的transfer真实变动单对象；061卡片新增movementId及sourceBizType/sourceBizId，转项assignmentId为null；062转入项目同样返回movementId与nullable assignmentId；063详情查询assignmentId/movementId二选一。067旧assignmentId匹配当前唯一转项并同事务推进，目标免试计划不跳过转项考试。中文说明、完整示例及序列化定向通过；数据库集成和真实HTTP验收状态见[人员变动](PERSONNEL_MOVEMENTS.md#第六批真实来源与兼容)。

## 子任务看板进度（13第四批）

API-111 `POST /projects/workbench/board/subtasks`已实现待验收，请求仅`projectId`正整数，返回Result数组，无子任务为空数组。当前会话NAV/PM为全项目，EXPERT限可管理组织；只查已发布未删除项目。进度来自真实累计报量，组织指定模式按人数折算，返回计划起止日期、应完成量、百分比及上海日期风险；待验收/已验收抑制风险。中文Swagger、完整示例、权限/算术与序列化单测已通过，数据库新增三项仍待本机复验。完整口径和命令见[项目看板第四批](../archive/BACKEND_HISTORY.md#project-workbench--子任务交付进度第四批2026-10-27当前)。无迁移，保持13，之后112—114。

## 风险预警（13第五批）

API-112 `POST /projects/workbench/board/risks`已实现待验收。请求仅`projectId`正整数，Result返回`viewScope`及`project/subtasks/members`三张独立卡片，每卡`pendingCount/urgentCount/items`；item包含code/severity/targetId/targetName/message/overdueDays。沿用111实时权限及组织口径；项目按截止时刻、子任务复用真实进度，人员只在生产节点按当日报量/最新质量累计加权/当前阶段阈值计算，NAV人员固定空。607单测、类型/ESLint/后端build前批通过；用户10:47:39两项、10:58:06剩余一项分批通过，本批三项集成已全部通过，真实HTTP/部署/完整兼容仍待验收。无迁移，完整口径及命令见[项目看板第五批](../archive/BACKEND_HISTORY.md#project-workbench--风险预警第五批2026-10-27当前)。下次直接113/114，业务Agent继续mock。

API-113 `POST /projects/workbench/board/trends`已实现待验收。请求`{ "projectId":3001, "metric":"CPD", "startDate":"2026-10-26", "endDate":"2026-10-27" }`，metric枚举QUANTITY/ACCURACY/CPD，日期正序且含首尾不超过366天。响应Result.data为metric/viewScope/dates/series；series项含memberId/userId(UUID)/displayName/quantityUnit/values。范围复用111，NAV曲线为空；数量缺日0，正确率按每笔报量最新质检的当日抽检加权、无抽检null，CPD向前6天补零按7自然日固定除7；后两项四舍五入两位。613单测/类型/ESLint/后端build通过，用户11:07:13三项专用库集成全部通过，真实HTTP/部署/完整兼容待验收，无迁移。完整口径及本机命令见[项目看板第六批](../archive/BACKEND_HISTORY.md#project-workbench--人员趋势第六批2026-10-27当前)。

## 组织概览（13第七批）

API-114 `GET /organizations/overview?orgId=<UUID>`已实现待验收。orgId必填，指定组织参与状态主管/管理员可读，不按当前会话业务角色限制；响应Result.data为orgId、memberTotal、activeProjectMemberTotal、todayScheduledTotal、todayPresentTotal、pendingApprovalTotal，均为非负整数，无记录0。统计真实组织成员关系、ACTIVE项目成员关系条数、上海今日ACTIVE/WORK排班、最终PRESENT考勤及当前用户本人且节点/流程均PENDING的审批；只读RepeatableRead，不执行补偿或重算。完整中文Swagger与可校验示例已接入；615项全量单测、类型/变更ESLint/Prettier及后端build通过。用户11:28:59第一项、11:30:44剩余两项分批通过，114三项专用库集成已全部通过；组织夹具阻塞解除，统计实现与契约未改，真实HTTP/部署/完整兼容仍待验收。无迁移，权限、旧SQL差异与验证命令见[组织概览](PROJECT_WORKBENCH.md#组织概览)。

### 任务13第九批内部卡片事件（2026-10-27）

HTTP方法、路径、请求/响应与Swagger契约均未变化。入项保存、建子任务、报量非静默写入和验收原outbox的payload追加`cardChangedRecipients`数组，元素为`{userId, role}`，role为`NAVIGATOR`或`PM`；空数组表示本次重算没有管理卡片实质变化。该字段包含新增、移除及替换卡片来源的旧/新受众，按账号/角色去重，只重算calculatedAt不会产生受众。它不表示所有任务类型或EXPERT来源受众已完整采集。报量核准仍静默重算，不新建事件；PENDING事实实际投递归14。无schema或迁移变化，验证与剩余接入见任务13第九批记录。

任务13第十二批内部事件补充：人员变动创建/审批推进/撤回/结果消费与候选同步、策略官任职/组织项目负责人交接及定时入项的既有outbox事件追加`cardChangedRecipients`（按用户/角色去重，新增/替换/恢复/撤卡均可出现）。负责人命令在业务与轮次全部更新后计算完整变化，由原负责人事件携带；同事务审批候选同步事件不重复携带。HTTP方法/请求/响应不变，无新增事件类型或实际投递。完整范围、验证与遗留见[项目看板第十二批](../archive/BACKEND_HISTORY.md#project-workbench--第十二批审批与负责人卡片事件2026-10-27当前)。
