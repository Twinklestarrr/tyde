# 认证与会话

> 2026-10-22现行规则：统一注册自带NAVIGATOR/PM/EXPERT，登录默认EXPERT，允许提交本机记住的role；API-121切换当前会话，刷新保留角色。独立创建组织API-124即ACTIVE/APPROVED、本人ACTIVE/OWNER；API-008/015返回实际会话角色、三角色和organizations数组。以下早期执行记录中的固定EXPERT、组织注册和独立授权描述仅为历史。详见[统一账号与组织创建](UNIFIED_ACCOUNTS.md)。本轮证据见插队任务（历史外部记录：`backend-migration/priority-unified-accounts/todoTask.md`）。

## 约定与范围

- 旧接口来源：`../tyde-core/src/main/java/com/tyde/platform/module/auth/controller/{AuthController,SmsAuthController}.java`，请求/响应字段来自同模块 `dto/`，用户响应来自 `module/user/dto/UserDTO.java`。
- 保持旧接口名称、路径和字段名；不再要求选择身份。账号注册自带三角色，User.role兼容存储仍为EXPERT，实际角色来自Session.selectedRole；登录role选填、默认EXPERT，不含OPS。
- 当前统一注册；accountType为选填兼容字段且只接受INDIVIDUAL；不再在注册时创建组织，独立创建见POST /organizations。
- 沿用新项目 Fastify + Prisma + PostgreSQL，不复制 Spring/Redis 基础设施；新旧项目数据库和令牌不互通。

## 接口契约

前缀 `/api/v1`；成功 HTTP 200，响应 `{ "code": 200, "message": "操作成功", "data": ... }`。错误同样使用 `code/message/data`，`data` 为 null；常见业务码 400/401/403/404/409/413/500/503，频率限制 4292（HTTP 429，含 `Retry-After`）。

| 方法与路径                  | 请求字段                                                    | 成功 data                |
| --------------------------- | ----------------------------------------------------------- | ------------------------ |
| POST `/auth/sms/send`       | `phone`, `scene`（`login` / `register` / `reset_password`） | 字符串发送提示           |
| POST `/auth/register`       | 见下文                                                      | 用户资料 UserDTO         |
| POST `/auth/login`          | `account`, `password`, 可选 `role`                          | LoginResponse            |
| POST `/auth/sms/login`      | `phone`, `code`, 可选 `role`                                | LoginResponse 或注册指引 |
| POST `/auth/refresh`        | `refreshToken`                                              | 新 LoginResponse         |
| POST `/auth/password/reset` | `phone`, `code`, `newPassword`                              | null                     |
| POST `/auth/logout`         | 无请求体；可携带当前认证凭据                                | null                     |
| GET `/users/me`             | 当前认证凭据                                                | 用户资料 UserDTO         |

注册必填password、confirmPassword、realName、phone；code与registrationToken必须且只能提交一个。accountType可省略且只接受INDIVIDUAL，roles兼容忽略。昵称/身份证/邮箱仍选填，注册不能提交organization或orgPosition。

组织资料移至POST /organizations，name必填，其余字段沿原定义。组织、本人OWNER关系和营业执照认领同事务；创建即ACTIVE/APPROVED，无认证审核。营业执照仍先上传BUSINESS_LICENSE并提交objectKey/uploadToken，已认领文件仅所属组织OWNER/ADMIN可代理读取。

LoginResponse 字段严格使用 `accessToken`、`refreshToken`、`tokenType`（`Bearer`）、`expiresIn`（秒）。注册仅创建账号并返回资料，不自动登录；未注册手机号短信登录返回 HTTP 200 和 `{ status: "registration_required", registrationToken, expiresAt }`，不创建账号或登录会话、不设置登录 Cookie；客户端据此进入资料填写页。注册凭证绑定手机号、10 分钟有效、一次性使用，再次验证同手机号会使旧凭证失效；放弃填写后，下次重新获取登录验证码并验证仍返回注册指引。

UserDTO 使用 `id`、`uid`、`accountType`、`phone`、`nickname`、`realName`、`idCardNo`、`idVerified`、`avatarUrl`、`bio`、`role`、`roles`、`selectedRole`、`hasExpertManagementRole`、`status`、`creditScore`、`lastLoginAt`、`lastLoginIp`、`organization`、`organizations`、`createdAt`、`updatedAt`。手机号和身份证号脱敏。新项目 `id` 仍为 UUID 字符串，时间仍为 ISO 8601；字段名沿用旧项目，不承诺旧数据库主键类型或日期格式兼容。

## 验证码登录后填写资料注册

1. `POST /auth/sms/send` 提交 `{ "phone": "13812345678", "scene": "login" }`。
2. `POST /auth/sms/login` 提交 `{ "phone": "13812345678", "code": "095270" }`。已注册用户返回原 LoginResponse；新手机号返回：

```json
{
  "code": 200,
  "message": "操作成功",
  "data": {
    "status": "registration_required",
    "registrationToken": "ggggggggggggggggggggggggggggggggggggggggggg",
    "expiresAt": "2026-10-16T12:10:00.000Z"
  }
}
```

3. 前端判断 `data.status === "registration_required"`，展示表单并暂存手机号/凭证；凭证仅用于注册，不能作为登录令牌。填写后向 `POST /auth/register` 提交：

```json
{
  "accountType": "INDIVIDUAL",
  "phone": "13812345678",
  "registrationToken": "ggggggggggggggggggggggggggggggggggggggggggg",
  "realName": "小明",
  "password": "Password123",
  "confirmPassword": "Password123"
}
```

示例凭证不可实际使用，需替换为本次返回的真实值。密码/确认密码与真实姓名校验保留，账号类型不再必填，不在注册提交组织资料。`code` 和 `registrationToken` 必须且只能提交一个；原 `scene=register` 验证码注册仍保留。凭证消费和统一用户创建在同一事务内，业务失败回滚，可修正表单重试；过期/错误/手机号不匹配/已消费凭证返回 HTTP 400。注册成功仍只返回用户资料，不自动登录，随后可用注册密码登录或重新获取登录验证码。Web/Electron 已按该流程接入注册与登录，页面功能范围见[功能清单](../IMPLEMENTED_FEATURES.md)。

复用既有 `RegistrationGrant` 表，无新增数据库迁移；摘要增加 `sms-registration:` 用途隔离，历史旧流程凭证不能用于此入口。过期凭证沿用现有认证清理命令。

## 安全与实现入口

- `packages/shared/src/auth.ts`：新增请求 schema 与兼容 DTO。原 `index.ts` 中的前端 DTO 暂时保留，新增导出不会改变前端现有类型。
- `auth.routes.ts`：路由、Cookie、客户端类型、来源校验。
- `auth.service.ts`：场景化验证码、注册、密码/短信登录、刷新、重置、资料查询及退出。`authenticate(token, client)` 统一验证会话有效期、撤销状态、客户端及账号状态，返回服务端身份（userId/uid/sessionId/role/clientType）；与 me 共用校验，不提供管理权限，调用方仍须验证业务权限和数据范围。
- `password.ts`：Node 内置 scrypt、独立随机盐和恒定时间摘要比较；不存储明文密码。
- `auth.schema.ts`：Swagger 元数据和响应序列化。
- `application.ts`：认证错误的 Result 包装、敏感字段日志脱敏。
- `prisma/schema.prisma` 和 `20261016000000_legacy_auth/migration.sql`：持久化字段和迁移。

用户已确认暂用开发/测试 mock 短信，固定字符串验证码 `095270`，有效期 5 分钟；真实短信未接入，现有配置继续禁止 mock 生产启动。验证码按 `phone + scene` 隔离；发送冷却和发送限流跨场景共用，错误次数持久化，成功消费一次。注册、验证码消费、重置密码及刷新使用事务和手机号 advisory lock。

令牌仍采用新项目的随机不透明值，数据库只存摘要，默认有效 30 天；并非旧项目 JWT。刷新后原访问/刷新令牌对失效；重置密码撤销全部会话；普通退出撤销当前会话。当前实现允许 Web/桌面及同客户端多个会话并存；单账号踢号、退出范围、刷新重放强制下线等兼容策略仍待用户确认，不能视为已验收。角色切换现已接入API-121，刷新保留当前角色。

Web 和 Electron 页面均使用 HttpOnly 会话 Cookie；浏览器来源须精确位于 `WEB_ORIGINS` 或 `DESKTOP_ORIGINS`。普通 Web 保持 SameSite=Lax，可信桌面来源使用 SameSite=None+Secure；服务端支持凭据 CORS、OPTIONS 预检，允许审批/导入所需的 `Idempotency-Key`，并暴露 Retry-After 与 Content-Disposition。页面写请求声明 `X-Tyde-Client: web`，GET/HEAD 省略自定义头；刷新令牌仅保留在适配器内存，IPC 只返回公开 API 源。非浏览器 API 继续支持 `X-Tyde-Client: desktop` 与 Bearer，并禁止 Origin、Cookie 和 sec-fetch-*；无浏览器头、Cookie 和客户端声明的调试请求自动按 Bearer 处理。

## 联调与数据库

先在目标环境配置数据库，并在部署代码前运行 `pnpm db:deploy`。迁移保留已有账号/会话，补充 `uid`、`realName` 和默认执行专家角色。旧验证码流程创建的账号没有密码，可走短信登录或重置密码设置密码。

示例：

```json
{ "phone": "13812345678", "scene": "register" }
```

```json
{
  "accountType": "INDIVIDUAL",
  "phone": "13812345678",
  "code": "095270",
  "password": "Password123",
  "confirmPassword": "Password123",
  "realName": "小明"
}
```

```json
{ "account": "13812345678", "password": "Password123" }
```

API 客户端登录后使用 `Authorization: Bearer <accessToken>` 调用 `/users/me`。

Web/Electron 通过共享客户端与平台适配访问上述真实接口，浏览器与桌面页面均使用 Cookie 会话；IPC 仅提供公开运行配置。

早期认证迁移、数据库故障与验证数字见[后端开发历史](../archive/BACKEND_HISTORY.md#auth-backend)；当前角色及组织创建规则见[统一账号](UNIFIED_ACCOUNTS.md)。
