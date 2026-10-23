# 工作台打卡与原始事件重放（API-078/079）

2026-10-23最新09→10交接：用户17:42:57定向运行attendance clock，本批5项集成全部通过（213跳过，共218项，总14.71秒，测试3.62秒）；并发幂等/不可变事件、原始事件重放/人工保护、多组织与个人/离组失权、午夜及跨日重试、日考勤/outbox故障整事务回滚已验证。第23迁移所需专用测试库结构已具备，迁移历史未另查，原初始化连接阻塞解除；不是全218项复跑，无需当前专用库再次迁移23或重复本批5项、073—075前批4项。09全部9种HTTP入口已有代码，保留已实现待真实HTTP/部署/完整兼容验收；500单测、35定向及类型/ESLint/build/Prisma前批证据保留。本轮仅同步用户结果与文档交接，未重跑测试、修改业务代码或操作数据库。默认入口切至10，本轮未执行10；下次从081花名册及082入项决定开始，随后083—085。业务Agent继续mock，实际投递归14。

2026-10-23代码已接入，状态为已实现待真实HTTP/部署/完整兼容验收。基础已交接10；业务Agent继续mock，通知实际投递归14。本批没有修改客户端或旧后端。

## 接口和兼容规则

- `GET /api/v1/organizations/attendance/clock-context`：可选`orgId/timezone`，仅查本人当前自然日有效排班及事件，不创建日考勤。
- `POST /api/v1/organizations/attendance/clock`：必填`Idempotency-Key`（trim后非空，原文最长128字符）；请求可选`orgId/clockType/timezone/sourceRef/extJson`。不接受客户端时间、日期、用户或成员ID。响应保留旧`eventId/eventNo/orgId/memberId/userId/clockType/clockAt/timezone/sourceType/dailyAttendance`。

传orgId时，当前用户须为该目标组织ACTIVE/EXIT_APPROVING/PENDING_LEAVE有效成员，沿旧接口不额外限制当前会话角色；组织不存在404，非有效关系403。省略或null表示个人作用域，须当前EXPERT且无有效组织；统一账号accountType不参与判定。组织和个人及不同组织间隔离；离组后即使已有事件也不能用幂等重试越权。

`timezone`省略、空白或null默认Asia/Shanghai，非法IANA时区400。沿旧实现使用请求时区的服务端当前自然日，排班时间为墙上时间，不将排班timezone再次换算；同一日切换时区不拆分日考勤，事件保留各自原时区和墙上时间。`occurredAt`额外保存真实UTC瞬时，供审计，不以该瞬时跨日归并。调用方应固定使用同一工作时区，不应把timezone当作补打日期。`clockAt`输出`YYYY-MM-DD HH:mm:ss.SSS`，上下文时间不含毫秒。

首次WORK打卡在班次中点之前为CLOCK_IN，中点及以后为CLOCK_OUT；已有任意卡后始终CLOCK_OUT，可多次点击更新末下班时间。无排班/REST允许留痕，首卡CLOCK_IN、后续CLOCK_OUT；WORK残缺、跨天或结束不晚于开始禁用。可选clockType只检测页面预期，类型变化409；不改变服务端判型。

同作用域、本人和幂等键确定唯一eventNo；重试返回原事件及其原归属日的最新日考勤，不追加事件、版本或通知。沿旧规则只检查非null预期类型与原事件是否一致，其余元数据不改写；新键代表新的真实点击。跨日重试仍返回旧事件。sourceRef只追踪，extJson可为JSON值，禁止提交凭证。

## 事务、重放和迁移

组织写事务按组织→用户加锁，个人按用户加锁，复查当前权限；事件、日考勤版本更新和PENDING outbox同事务，失败全部回滚且幂等键可重用。`AttendanceClockEvent`保存作用域、真实成员来源、事件归属日期、类型、墙上时间/UTC瞬时/时区、来源扩展及审计；数据库外键和CHECK保护来源/作用域/日期，触发器拒绝UPDATE/DELETE，专用测试库仍可TRUNCATE。

重算取归属日事件的最早CLOCK_IN和最晚CLOCK_OUT；缺卡按已有维度判定，跨度/迟到/早退分钟向下取整，缺卡或反向跨度为0；不生成REVIEW_REQUIRED。人工finalStatus、备注、修正人/时间和调整审计保持。073—075及076补排/覆盖已有日考勤同样重放事件，不伪造无打卡日考勤。迁移前完全没有原始事件的历史日考勤仍保留既有首末快照；有事件时以事件为准，不把派生快照伪装成新事件。

新增第23迁移`20261023020000_attendance_clock_events`，并允许AttendanceEventOutbox.orgId为null以支持个人通知，payload含本人userId。Agent未应用迁移，未操作开发/部署库。事件固定WORKBENCH_CLICK，通知status=PENDING、delivery=NOT_EXECUTED；没有投递器。

## 本批验证与用户本机续验

- 500项单测通过（45文件，17:38:00启动，总23.15秒）；35项打卡/排班/工作台/OpenAPI定向通过（17:37:34，总3.57秒）。中文字段说明、完整示例校验及HTTP序列化已覆盖。
- 服务端typecheck、变更ESLint、后端包build及Prisma validate通过。临时扩大到历史集成测试文件的类型检查仍有既有post辅助函数的InjectPayload/响应推导等错误，未将其作为标准服务端类型检查通过证据；临时配置已移除。
- 新增5项集成17:37:58执行，均在beforeEach因Agent环境`127.0.0.1:5432`不可达失败（213跳过，共218项，总6.62秒，测试589ms），业务断言未执行。覆盖并发幂等/不可变约束、真实事件重放/人工保护、多组织/个人/离组、午夜与跨日重试、日考勤/outbox故障整事务回滚，该首次阻塞已由用户17:42:57定向5项全通过解除。

以下保留原复验命令供其他环境参考。当前专用测试库第23迁移所需结构及本批5项已验证，无需再次执行；集成测试会清空专用库，不能指向开发或部署库：

```sh
pnpm db:deploy:test
pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t 'attendance clock:'
```

073—075前批4项通过证据保留，不要求重跑；以上不是全218项复跑。真实HTTP、开发/部署迁移及完整兼容仍待验收；基础已交接10，本轮未执行10。
