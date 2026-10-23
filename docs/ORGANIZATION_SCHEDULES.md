# 组织排班后端

API-073—075已接入，保留已实现待验收。072/076/077/080及考勤申请沿用已有实现；078/079打卡上下文、写入与原始事件重放尚未接入。业务Agent继续mock，组织排班不调用业务Agent。

## 接口与权限

统一前缀`/api/v1`，沿用`code/message/data`响应。当前会话须为EXPERT，且在请求`orgId`对应的有效组织关系中为OWNER或ADMIN；ACTIVE、EXIT_APPROVING、PENDING_LEAVE视为参与中。不使用用户资料中的单组织指针，也不借用另一组织主管身份。删除组织404，普通成员、无目标组织管理关系或切换其他角色403。幂等重放仍校验当前管理权限。

- `POST /organizations/schedules`：必填`orgId`（UUID）、`month`（YYYY-MM）。可选`keyword/employmentType/joinStatus/position/projectId/current/size`，字段名保持旧契约，关系与用户主键采用新库UUID。默认人员页码1、每页20（最大100）；默认列出待激活和参与中成员。姓名、昵称、UID、成员及用户UUID模糊匹配，手机号完整匹配，上海入组时间支持文本匹配；项目筛选仅认ACTIVE项目成员关系。返回`month/total/pages/current/size/members`，成员包含`memberId/userId/realName/nickname/joinStatus/canSchedule/summary/days`；补齐整月，不在读取时生成日考勤。
- `PUT /organizations/schedules/batch`：必填`orgId/memberIds/startDate/endDate/dayType/overwrite`，可选`weekdays/startTime/endTime/timezone`。成员去重最多500项；日期包含首尾、最多366天，展开最多5000条（超过400，需分批）。星期1至7；省略/null/空数组默认周一至周五。按星期过滤后排除法定放假日，调休工作日仍须匹配weekdays；没有可排日期400。日历使用已有可靠源/缓存/2026基线，无可靠数据503。
- `PUT /organizations/schedules/details/batch`：必填`orgId/schedules/overwrite`，可选默认`timezone`。每条明细必填`memberId/scheduleDate/dayType`，可选`startTime/endTime/timezone`；明细时区覆盖默认值。最多5000条、500个不同成员，不可重复成员日期，不自动过滤节假日。

两种写接口均要求`Idempotency-Key`（1至128字符）。WORK须同日有效`HH:mm[:ss]`起止时间且结束更晚；REST不能提供班次时间。IANA时区省略/null/空白默认Asia/Shanghai，班次存本地墙钟时间并配合timezone解释。目标须为指定组织参与中成员，含主管和管理员；待激活、已离组或跨组织目标400，整批回滚。

结果为`batchNo/createdCount/updatedCount/skippedCount/conflicts`，冲突条目含`memberId/scheduleDate/scheduleId/versionNo`。`overwrite=false`仅跳过已有排班；true覆盖、恢复ACTIVE并递增版本。幂等键按组织、操作者及BATCH/DETAIL隔离；标准化参数相同回放首次结果，参数变化409。已存在回执的范围排班不再请求日历源。

## 事务和事件边界

组织行锁串行化写入及管理关系变化，排班版本条件更新、已有日考勤回算、PENDING事件和幂等回执同事务提交；失败不会留下排班或占用幂等键。不制造新日考勤和人工修正审计。079本批已接原始事件重放：有事件时以同作用域/本人/归属日事件为准；迁移前完全无事件的历史记录保留首末快照。更新期望班次、自动状态、分钟统计、计算时间与版本；人工修正的最终状态、备注及审计保持。见[工作台打卡](ATTENDANCE_CLOCK.md)，第23迁移所需专用库结构及打卡本批5项集成已由用户17:42:57验证通过，基础已交接10。

新增`OrganizationScheduleReceipt`与`AttendanceEventOutbox`，事件含批次、操作者和受影响用户，状态PENDING、delivery=NOT_EXECUTED。没有后台投递器，实际消费/通知由14实现，不能称实时通知已验收。

实现入口为`modules/attendance/organization-schedule.domain/service/schema.ts`，由已有`attendance.routes.ts`装配并复用HolidayCalendarService及月历计算函数。完整字段描述和可校验请求/响应示例见运行服务Swagger。

## 迁移及验收

第22迁移`20261023010000_organization_schedules`所需专用测试库结构已由本批4项集成分批通过验证，迁移历史未另查。无需当前专用库再次迁移或重跑已过项。Agent未应用迁移、未直连开发/部署库；专用库结果不代表开发/部署库已迁移。

2026-10-23最新09第一批集成通过：用户17:28:01定向复验剩余筛选/权限1项通过（212跳过，共213项，总3.85秒，测试1.07秒），结合17:25:34已通过3项，073—075本批4项集成分批全部通过，不是全213项复跑。原expertiseTags夹具遗漏已解除；并发幂等/覆盖、筛选月历/目标组织权限/离组失权、已有日考勤重算与人工结果保护、回执/outbox故障整事务回滚均已验证。第22迁移所需专用库结构已具备，迁移历史未另查，无需当前专用库再次迁移或重复本批4项。488单测、35项及修正后13项定向、类型/变更ESLint/build前批证据保留；本轮仅同步用户结果，未重跑测试、修改业务代码或操作数据库。保持09，下次直接078/079打卡上下文、写入与原始事件重放，072/076/077/080按需核对不重做；073—075保留已实现待真实HTTP/部署/完整兼容验收。业务Agent继续mock，实际投递归14，不开始10。

原测试夹具创建异组织时遗漏非空数组`expertiseTags`，已补`expertiseTags: []`，业务实现/schema未改；17:25:34原批3通过/1失败，17:28:01仅复验失败1项通过，二者合并为本批4项全部通过。488项单测（44文件，17:14:44，总16.40秒）、35项定向（17:13:58，总4.25秒）、修正后13项定向（17:26:38，总3.52秒）、服务端类型/变更ESLint/后端build及Prisma校验为前批证据，本轮未重跑。
