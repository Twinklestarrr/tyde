# 项目考勤与成员表现（10第二批）

API-083—085均已实现待验收，HTTP方法、路径及旧字段名保持。用户、组织及上传台账ID沿新后端使用UUID；项目、项目成员及表现记录ID为32位正整数。业务Agent继续mock；10基础已交接11，本次仅同步验收结果，未执行11。

- `POST /api/v1/project-personnel/attendance/list`：必填`projectId`、`month`（1900年起YYYY-MM）。支持keyword、organizationIds、attendanceStatuses及current/size，默认1/20，最多100。先按开放成员状态及职责组织筛选分页，之后批量读取当月真实排班和日考勤。组织按成员具体userOrgRelId/orgId/userId匹配，个人按PERSONAL匹配，互不混用；不因读取创建或重算数据。考勤状态只过滤逐日行及汇总，成员总数不变，无匹配行仍返回成员及零汇总。
- `POST /api/v1/project-personnel/performance/list`：必填projectId/memberId，可选recordDateStart/recordDateEnd（含端点、起始不晚于结束）、current/size。允许查询已离项历史成员，按recordDate和ID倒序。返回旧字段performanceId/recordDate/content/attachmentIds/recordedByName/createdAt，额外返回attachments的fileId/objectKey/fileName，供文件代理读取；不返回上传凭证。
- `POST /api/v1/project-personnel/performance/create`：必填projectId/memberId/recordDate/content。日期不晚于上海当天，正文原文最多2000字且去空白后非空；不以当前在项状态阻断历史记录。每次成功请求新增一条，无请求幂等承诺。没有旧实现未声明的项目节点、轮次、outbox或通知副作用。

当前会话PM主策略官可读写全项目，招募协作负责人只读。EXPERT须为有效组织关系下已接单组织的主管或当前项目负责人，按职责组织集合隔离；普通成员、管理员和NAVIGATOR不能读取。任职撤销、实际离组、负责人撤销、项目删除后失权。成员表现允许历史成员，不将历史读写与重新入项资格混淆。

考勤保留旧Mapper口径：scheduledCount为筛选后排班行数（包含休息或取消行），迟到且早退分别计入lateCount/earlyLeaveCount；不补齐无排班日期，无最终状态返回null。排班/打卡时间是排班当地墙上时间，打卡保留毫秒；createdAt为上海时间。个人排班读取是基于09现有数据的补齐，旧SQL仅有组织关系关联。日考勤按作用域/本人/组织关系/日期匹配，不要求scheduleId非空。

附件流程：登录后调用现有文件上传，bizType=`MEMBER_PERFORMANCE_ATTACHMENT`。上传响应新增`fileId`（台账UUID），沿用objectKey/uploadToken等字段。创建表现时提交`attachmentIds: [fileId]`及`attachmentUploadTokens: {"fileId": "uploadToken"}`；最多10个，ID去重并排序。只允许本人未过期且未认领的专用类型文件，校验凭证、OSS对象存在和大小。记录与全部附件认领同事务，任一文件失败整体回滚；同一文件并发认领仅一次成功。成功后通过现有`GET /api/v1/files/view?objectKey=...`鉴权代理读取；原上传者不再单凭owner身份放行，按表现所属具体成员的当前人员管理权限判断。

新增第24迁移`20261023030000_member_performance`，新增ProjectMemberPerformance、成员/项目/用户复合外键、正文/附件数量检查及分页索引。不更改既有成员状态或考勤数据。第24迁移所需专用库结构已由用户2026-10-26四项集成通过验证，迁移历史未另查；Agent未应用迁移或操作开发/部署数据库，无新增依赖。

验证：2026-10-23 18:48:01全量507项单测通过（47文件，总18.58秒）；服务端类型检查、变更ESLint、Prisma validate及后端包build通过。最初Agent环境127.0.0.1:5432不可达，业务断言未执行；用户2026-10-26 09:49:41定向本批4项集成全部通过（222跳过，共226项，总14.99秒，测试3.50秒），原本机初始化阻塞解除。考勤分页/个人与组织隔离/逐日过滤、历史表现/日期/权限、附件认领/元数据/失权及整事务回滚/并发已验证，不是全226项复跑。

结合081/082前批4项，10累计8项集成分批通过。无需当前专用库再次迁移24或重复本批/前批及09。默认入口切至11，本次未执行11；真实HTTP/OSS、调度部署及完整兼容仍待验收，完整跨域卡片/转项审批/实际投递仍归04/12/14。Agent本轮仅同步结果和文档，未重跑测试或操作数据库。

仅保留以下本批定位命令供将来相关变更回归使用，无需现在重跑：

```sh
pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t 'personnel records:'
```
