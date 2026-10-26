# 人员日生产、质量与子任务验收

## 2026-10-26本批集成通过（当前）

2026-10-26最新11→12交接：用户10:50:10定向运行production quality acceptance，本批6项集成全部通过（236跳过，共242项，总10.94秒，测试7.00秒）。质量最新汇总/历史/组织隔离与失权/协作只读、混合来源回滚/作业系统保护/并发追加、验收门禁/精确调整/创建人NAV审核、返修轮次/审核竞争/终态锁定及outbox故障整事务回滚已验证。第27迁移所需专用测试库结构已具备，迁移历史未另查，原初始化连接阻塞解除；不是全242项复跑，无需当前专用库再次迁移27或重复本批6项、前两批10项及10/09已过项。11累计16项集成分批通过，086—100全部15种HTTP入口已有代码，保留已实现待真实HTTP/部署/完整兼容验收；520单测及最终16定向/类型/ESLint/Prisma/build前批证据保留。本轮仅同步用户结果与文档，未重跑测试、修改业务代码或操作数据库。默认入口切至12，本轮未执行12；下次从101转项候选及102发起人员变动/TransferStep状态机开始，随后103—106及107转项来源回补，沿用已实现审批/本人申请与接单考试能力。完整跨域卡片/日常报量采集/实际投递仍归04/14，业务Agent继续mock。

下方初次连接失败及复验命令均为历史，本批已经通过，无需重复执行。

2026-10-26，11第三批：API-095—100已接入，088验收事实及动作已补齐；086—100全部15个HTTP入口已有代码，状态为已实现待验收。业务Agent继续mock，本批无业务Agent调用。

## 接口与权限

所有入口保留旧POST方法、字段名、Result包络及会话/来源校验，响应带`Cache-Control: no-store`。Swagger登记中文字段说明、枚举、空值/默认规则及完整可校验示例。

| POST路径（前缀/api/v1）                         | 请求与行为                                                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/project-personnel/production/list`            | projectId，reportDateStart/End（分别默认上海当天，首尾含当天，最多31天），keyword、accountTypes、organizationIds（UUID）、dataSources、current/size。按成员及日期分页，日期倒序、成员ID升序。                   |
| `/project-personnel/production/quality/context` | projectId、memberId、reportDate；报量ID升序、质量ID倒序，平铺全部历史。无质量的报量保留一条质量字段为null的明细，无报量返回空items。                                                                            |
| `/project-personnel/production/quality/save`    | projectId、memberId、reportDate、1—100条items（outputReportId、inspectedQuantity、qualifiedQuantity、unqualifiedReason）。每次均追加，可在一批中多次填写同一报量；整批成功或全部回滚。请求上限512KiB，超限413。 |
| `/production-tasks/acceptance/context`          | projectId、subtaskId；仅当前主策略官或招募协作可读，协作canSubmit固定false，EXPERT及NAV无弹窗读取权限。                                                                                                         |
| `/production-tasks/acceptance/submit`           | projectId、subtaskId、actualQuantity、actualDeliveryDate、quantityAdjustmentRemark；仅当前主策略官提交。                                                                                                        |
| `/production-tasks/acceptance/review`           | projectId、subtaskId、decision（ACCEPT/REJECT）、rejectReason；仅本人创建项目的NAVIGATOR审核，不向PM或EXPERT开放。                                                                                              |

日生产/质量读取：当前主策略官全项目，招募协作负责人只读；EXPERT须为当前有效组织主管或该接单项目负责人，仅限职责组织。普通成员不能用本人报量权限取得人员管理或质检权限。个人来源与组织来源按成员来源隔离；筛选组织与权限组织取交集。离组、职责撤销后重新请求立即失权。

质量保存同样按管理写权限校验，不限成员当前在项状态，历史成员仍可在职责范围内填报。抽检数必须正数，合格数非负且不大于抽检数，最多26位整数和4位小数；不合格原因可空、最多1000字。关联报量须匹配项目、成员和日期。子任务已ACCEPTED拒绝409；最新质量来源WORK_SYSTEM拒绝403，并将弹窗所有历史行editable置false。作业系统采集尚未接入，WORK_SYSTEM仅保留来源及人工保护契约。

## 汇总与验收事实

- 人员日生产计算全部核查状态的报量；同一报量仅使用最新质量记录，避免历史累加。准确率为合格数/抽检数×100，保留2位小数，未抽检为null。7日CPD是该日及之前6天全部来源报量总和/7，保留2位小数；来源筛选仅限制当日产量及最新质量汇总。备注去空去重按报量ID合并；质量条数/人工历史标志及7日CPD不受来源筛选影响，与旧SQL一致。
- 精确运算和数据库数量使用Decimal；响应沿用JSON数字，大数回读存在JavaScript数字舍入限制。组织ID/用户ID沿当前后端UUID契约，成员/项目/任务/质量ID为正整数。
- 验收上下文实时汇总核准数量与待核查/退回条数。至少一条VERIFIED且没有任何PENDING/RETURNED方满足数据条件；只有项目未结项、当前主策略官、任务为IN_PROGRESS或REWORK_REQUIRED时canSubmit=true。
- 提交在锁内重新计算全任务数据，不信任弹窗旧值。实际交付量正数，实际日期不得早于上海当天。实际量与核准合计不同必须有非空调整备注（最多1000字）；相同强制清空。保存reportedQuantity核准总量快照、实际量/日期、提交人/时间，清空上一轮审核人/时间/原因。
- 首次提交进入PENDING_ACCEPTANCE，acceptanceRound=1；驳回进入REWORK_REQUIRED，必须有非空原因（最多500字），主策略官再次提交时轮次+1。通过进入ACCEPTED终态，通过禁止携带非空原因。状态不符和竞争后的重复操作409，不重复写事件。
- 核准报量始终锁定，返修不重新开放报量。未验收时可追加质量，ACCEPTED后禁止。验收不改项目共享节点或versionNo，不自动结项。
- 088返回最近提交/审核的实际日期、数量、核准总量、调整备注、操作人名称、时间及驳回原因；未发生为null。当前主策略官在可写任务数据满足时提供SUBMIT_ACCEPTANCE，否则CHECK_DATA；项目创建人NAV在待验收时提供ACCEPT/REJECT，进行中/返修时提示等待策略官。协作只读无动作；EXPERT保持原报量修正范围。

## 事务、卡片与范围

共用用户→组织→组织关系→项目锁，与报量、任职/成员变更串行；质量再锁日报量行，验收在项目锁内检查状态。质量混合无效来源整批回滚。验收事实、SUBTASK_ACCEPTANCE / SUBTASK_REWORK_REVIEW / SUBTASK_REWORK_SUBMIT轮次、本领域快照及PROJECT_SUBTASK_CHANGED的PENDING outbox同事务。首轮领航员优先级80，返修策略官85，复验领航员90；仅清除SUBTASK来源的本域快照，保留其他来源及更高优先级快照。

完整跨域卡片重新采集/任职替换后全领域重算、日常报量当天撤卡仍归04，转项审批归12，实际事件投递归14。本批没有后台定时器或真实外部服务联调。

## 迁移与验证

新增第27迁移`20261026030000_production_quality_acceptance`：ProjectSubtask增加验收轮次和提交/审核快照；ProjectOutputQuality追加历史，RESTRICT日报量外键、来源/数量数据库检查及报量ID/质量ID索引。前批状态阻塞夹具补充新约束要求的提交事实，业务断言不变。Agent未应用迁移，未操作开发或部署库。

- 520单测通过（50文件，2026-10-26 10:42:20，总20.25秒）；收尾精度与512KiB回归后16项生产/报量/质量验收/OpenAPI定向通过（10:48:46，总3.66秒）。
- 服务端typecheck、变更ESLint、Prisma schema校验和后端包build通过。质量汇总采用独立64位有效精度的Decimal，避免默认20位有效精度截断26位整数及4位小数，已补边界回归。
- 新增6项集成10:42:18运行，全部在beforeEach因Agent环境127.0.0.1:5432不可达停止（236跳过，共242项，总7.42秒，测试420ms），业务断言未执行。不称数据库集成通过，不重复前批10项及10/09已通过项。
- 未执行真实网络HTTP/部署/完整兼容验收；注入式HTTP测试验证路由契约，不替代真实HTTP验收。

本机从`tyde/`运行，只对明确允许重置的`.env.test`专用_test库更新第27迁移并复验本批6项：

```sh
pnpm db:deploy:test
pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t 'production quality acceptance'
```

测试会清空专用测试库，禁止指向开发或部署库。当前专用库26已具备的证据保留，不要求重迁移26或复跑前两批10项。保持11，本批6项通过后再交接12；真实HTTP/部署/完整兼容及跨任务遗留仍原归属。
