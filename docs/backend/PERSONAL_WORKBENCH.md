# 个人中心与工作台后端

本人资料返回三角色、实际会话角色及全部有效组织摘要；个人排班/专家入口按真实会话EXPERT校验，目标组织管理按具体关系。组织创建即生效，无认证等待；加入其他组织不影响创建自己的多个组织。账号规则见[统一账号与组织创建](UNIFIED_ACCOUNTS.md)，历史真实HTTP结果见[验收记录](../archive/ACCEPTANCE_HISTORY.md#personal-workbench-acceptance)。

本文涵盖资料、头像、本人申请、排班考勤和本人项目读取。所有路径加`/api/v1`，除文件内容代理外使用`{code,message,data}`；中文字段Schema与完整示例以`/api/v1/docs/`为准。

| 接口                                        | 当前行为与边界                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /users/me`                             | 沿用本人资料、手机号/身份证脱敏、三角色/实际会话角色及有效组织摘要；项目负责人展示能力、信用等既有回补仍保留                                    |
| `POST /users/me/update`                     | 本人资料、头像关联/清空、实名证件保护；改密撤销全部会话，不保留当前会话                                                                         |
| `POST /files/upload`                        | AVATAR必须登录；multipart file、bizType=AVATAR；上传响应仍是objectKey/uploadToken/url等原字段                                                   |
| `POST /organizations/members/exit-requests` | 复用既有退出/主管审批；Idempotency-Key必填；项目侧生效与清退规则见人员异动说明                                                                  |
| `POST /users/me/applications`               | 强制本人申请范围；默认ORG_MEMBER_EXIT，显式businessType:null查全类型；支持status/startAt/endAt/current/size。返回真实审批记录，不生成申请       |
| `GET /organizations/attendance`             | month=YYYY-MM、可选orgId；组织成员必须指定有效组织，无组织EXPERT不传；整月每天一项、汇总和permissions                                           |
| `GET /organizations/calendar/holidays`      | month、可选orgId；登录即可查询，orgId不影响日历结果；仅特殊节假日与调休，普通周末不列入                                                         |
| `PUT /users/me/schedules/batch`             | 仅无有效组织EXPERT本人；schedules[]、overwrite必填，可选timezone，Idempotency-Key必填                                                           |
| `POST /organizations/attendance/apply`      | MEMBER/ADMIN本人申请，orgId/attendanceDate/applicationType/finalStatus/reason/versionNo；LEAVE条件必填leaveStartAt/leaveEndAt；由主管审批后生效 |
| `POST /organizations/attendance/withdraw`   | applicationId（UUID）、flowVersionNo；仅本人PENDING考勤申请可撤回，离组后仍可撤回，不改变考勤                                                   |
| `POST /organizations/attendance/update`     | 有效组织OWNER/ADMIN直接修正已有日考勤；orgId/dailyId/finalStatus/versionNo，manualRemark可选；普通成员403，未来日期400                          |
| `GET /expert-assignments/my-projects`       | 仅本人已接单个人分配或组织普通成员ACCEPTED/SELECTED响应；关键字匹配项目、需求方、准入状态与节点                                                 |
| `GET /expert-assignments/detail`            | assignmentId；保留projectDetail/productionPlan，增加assignmentId、项目主线currentNodeCode和availableOperations；详情当前仅VIEW_DETAIL           |

## 头像调用链

1. 登录后以`bizType=AVATAR`上传图片，保留响应的`objectKey`和`uploadToken`。
2. 保存资料示例：`{"avatarUrl":"avatar/2026/10/21/example.png","avatarUploadToken":"上传返回的凭证"}`。头像类型、本人归属、凭证/过期、对象存在/大小全部校验，成功存储服务端签发的展示URL。
3. 保存响应或后续`GET /users/me`的avatarUrl可直接展示；重复保存本人已认领头像不要求再次消费凭证。返回的服务端同源上传URL也可被识别关联，但新客户端优先使用objectKey。
4. `{"avatarUrl":""}`清空；省略或null保持。单独提交avatarUploadToken为400。旧头像释放后到期由既有`db:cleanup`清理，事务回滚时认领/释放/资料一并回滚。

历史外部URL/非AVATAR字符串继续兼容，不远程抓取、不自动认领，也不授予敏感文件读取权限。AVATAR从可匿名上传收紧为登录上传，是为保存时校验本人归属而补齐的业务约束。真实OSS上传/认领/替换/清空/URL展示已通过本机HTTP验收。

## 申请、排班与考勤

本人申请默认每页20、current=1，size最大100；时间为`yyyy-MM-dd HH:mm:ss`，Asia/Shanghai，包含两端。按appliedAt降序、同时间ID降序。返回applicationId（UUID）、flowVersionNo等字段；历史表单保留原始JSON，非法计划离开日期仅将便捷字段置null。未知businessType返回空结果，不扩大查询人范围。新增ATTENDANCE_LEAVE（请假）、ATTENDANCE_CORRECTION（考勤修正）已接提交入口，沿同一真实审批表聚合；查询全部类型仍须显式传businessType:null。

本人排班最多366条，不限制过去/未来日期；每条scheduleDate、dayType=WORK/REST。WORK要求startTime/endTime（HH:mm或HH:mm:ss），结束须晚于开始；REST不能提供时间。timezone缺省/null/空白默认Asia/Shanghai，须有效IANA时区。重复日期400。overwrite=false跳过已有班次并返回conflicts；true覆盖并增加版本。标准化后相同本人/key/参数返回原结果；同键不同参数409。用户行锁串行化个人排班，回执和班次同事务落库；重放仍重新检查无组织资格。

月历查询不创建日考勤。过去的ACTIVE工作排班没有日考勤时展示ABSENT，当天/未来为PENDING_ATTENDANCE；休息为REST，无排班为UNSCHEDULED；已有日考勤finalStatus优先。迟到且早退同时计入两项汇总。保留日考勤的打卡/复核字段；打卡写入与原始事件规则见[考勤打卡](ATTENDANCE_CLOCK.md)，实际实时通知投递仍归任务14。

`permissions.canBatchSchedule`只在独立作用域true，`canDirectUpdate`按有效OWNER/ADMIN计算，实际写入还检查指定组织/日考勤/日期/版本。`canApply`表示MEMBER/ADMIN可提交本人申请，`canWithdraw`表示该月存在本人待审申请；每日days新增application及permissions，返回申请主键、流程版本、申请类型/状态/目标状态与可撤回标记，以及canApplyLeave/canApplyCorrection/canWithdraw/canDirectUpdate。无申请时application=null，不能把流程版本当成日考勤版本。

直接修正沿旧Service允许有效OWNER/ADMIN操作组织已有日考勤，不额外收紧为仅主管本人；普通成员必须走申请审批。只允许PRESENT/LATE/EARLY_LEAVE/LATE_EARLY/LEAVE/ABSENT/REST。使用manualRemark，不接收reason替代字段；版本不匹配409，锁组织及日考勤，修正前后快照与审计同事务追加，autoStatus不覆盖。

节假日源为公开的`NateScarlet/holiday-cn`年度JSON，通过jsDelivr读取；进程内缓存24小时，同年并发请求合并，10秒超时，校验年份/日期/重复项/类型。失败先回退已有校验缓存，再回退随包2026官方年度基线；无该年缓存/基线时503，不把周末或空数组伪装成成功数据。缓存最多16个年份，无Redis依赖；多进程各自缓存。真实环境已确认外网源超时；2026随包回退已实测通过。

## 本人项目与附件

保留旧“我的项目”口径：主管/项目负责人不属于组织普通成员列表；组织整体ACCEPTED后，本人成员响应必须ACCEPTED或SELECTED。有效组织身份优先于同项目个人身份，普通成员未响应时也优先组织身份，REJECTED/CANCELLED或离组后个人身份可恢复。每项目保留最新有效分配。无需笔试/尚无计划时needWrittenExam=false；有应试事实时按通过、待阅卷、已进入未通过、未进入的优先级聚合，需笔试且未通过时返回ENTRANCE_EXAM。

通过/免试后读取本人最新ProjectMember的实际履约事实及角色支线快照；已入项且确认培训才展示PRODUCTION_TASK，否则按旧my-projects规则回退STANDARD_TRAINING，该展示回退不等于授予入项或培训操作。该本人项目列表不沿用可能失效的OUTPUT_DATA_REVIEW快照；任务卡的实时核查、修正和报量门禁见[执行专家接单](EXPERT_ASSIGNMENTS.md)及[项目工作台](PROJECT_WORKBENCH.md)。

详情的个人分配仅本人可读；组织分配ACCEPTED时有效组织成员可读，其余状态只限有效主管。只读生产要求的总量级/作业人数/质检人数取分配值，CPD、人群和阶段取已确认计划，不返回管理确认人/扩展JSON等。本详情响应的availableOperations仍只有VIEW_DETAIL；接单、考试、培训和生产动作分别走各自入口并重新鉴权，不因详情节点展示而放行。相关规则见[执行专家接单](EXPERT_ASSIGNMENTS.md)、[考生考试](ENTRANCE_EXAM_CANDIDATE.md)、[标准材料](PROJECT_STANDARD_MATERIALS.md)和[生产报量](PRODUCTION_OUTPUT_REPORTS.md)。

项目附件继续校验台账CLAIMED、业务绑定、ACTIVE附件及未删除项目。在现有NAVIGATOR/PM规则之外，接回旧标准材料SQL的专家资格：必须存在真实ACCEPTED接单来源；免试时分配个人/有效组织成员可读，需笔试时有效组织主管、当前项目负责人或有未删除考试ADMITTED结果的专家可读。不凭ACTIVE项目成员或上传者身份放行。考试附件规则见[考试管理](ENTRANCE_EXAM_MANAGEMENT.md)和[考生考试](ENTRANCE_EXAM_CANDIDATE.md)。

## 申请与审批契约

沿用组织单主管审批机制：有效MEMBER/ADMIN提交本人申请，由提交时有效主管作为实际节点审批人，且处理时仍须是组织主管，禁止自审；OWNER本人沿用获授权的直接变更入口，无组织专家无组织审批人，不开放组织申请。管理员已有直接变更资格保持不变。主管转让不自动转派既有待办，沿原审批规则。

提交示例：

```json
{
  "orgId": "00000000-0000-4000-8000-000000000002",
  "attendanceDate": "2099-01-01",
  "applicationType": "LEAVE",
  "finalStatus": "LEAVE",
  "reason": "个人事务",
  "versionNo": null,
  "leaveStartAt": "2099-01-01 09:00:00",
  "leaveEndAt": "2099-01-01 12:00:00"
}
```

- `versionNo`必填，取月历的`dailyVersionNo`，无日考勤显式传null；可选dailyId用于额外核对，不能传排班版本替代日考勤版本。提交时服务端保存当前排班ID/版本，审批前再次检查。
- `applicationType=LEAVE`只能请求`finalStatus=LEAVE`，须已有ACTIVE工作排班且时段位于班次内，时间格式`yyyy-MM-dd HH:mm:ss`按排班timezone解释，结束晚于开始且同一天；多天请按天提交。请假可历史/当天/未来，部分时段也将日级考勤标记LEAVE，月汇总按一天计，不拆分当日状态。
- `applicationType=CORRECTION`仅当天/历史，目标为PRESENT/LATE/EARLY_LEAVE/LATE_EARLY/ABSENT/REST，不能以该类型绕过请假时段校验；leaveStartAt/leaveEndAt必须省略或null。已有日考勤或ACTIVE工作排班才能申请。尚无日考勤时批准后新建结果，保留排班来源和期望时间，不制造打卡事实。
- 同一组织/本人/日期只能有一条待审考勤申请，LEAVE/CORRECTION互斥，重复409。提交只写ApprovalFlow/Node/ActionLog，不修改日考勤；已请假当天不能重复提交请假。
- 审批使用既有`POST /organizations/approvals/process`，从pending查询获取flowNo/nodeId/flowVersionNo/nodeVersionNo。只有当前有效主管且为该节点实际审批人可以处理；APPROVE复查申请人关系、排班和日考勤快照，变化返回409，整笔不生效；REJECT必须说明意见，不写日考勤，可关闭已过期申请。
- 批准在同事务内更新/创建OrgAttendanceDaily（manualOverride=true）、追加OrgAttendanceAdjustment、推进节点/流程及动作日志，保存afterData。旧autoStatus和打卡事实不覆盖；未来请假autoStatus为null，不能伪造未来缺勤。返回实际dailyId/dailyVersionNo/adjustmentId及推进后的flowVersionNo，考勤分支joinStatus/plannedLeaveDate为null。
- 撤回只允许本人PENDING考勤流程，组织→流程→节点统一锁顺序，审批/撤回仅一方成功，另一方409；节点置CANCELED，流程置WITHDRAWN并追加WITHDRAW动作，不改日考勤。撤回或驳回后可按当前版本重提；终态不允许再次撤回。退出组织等其他业务不能通过此接口撤回。本人离组后仍可撤回自己待审申请，但不恢复组织关系。

## 2026日历离线回退与维护

`holiday-calendar.data.ts`依据国办发明电〔2025〕7号逐项整理，不复制远程服务实现。来源为[国务院通知](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)，已与[政府网站转载](https://www.beijing.gov.cn/fuwu/bmfw/sy/jrts/202511/t20251104_4258838.html)及原年度数据交叉核对；核对日2026-10-21。全年33个公布放假日、6个调休上班日；全国安排不含地方民族节日，普通周末不生成条目。

数据通过TS编译随服务包含，不依赖启动时下载、工作目录、额外JSON复制或数据库种子。在线校验成功优先使用远程数据；超时/非法数据先回退既有缓存，再使用本年随包基线并缓存24小时。首次断网等待最多约10秒，缓存期内后续请求不访问外网。基线目前仅2026，其他年份无可用数据仍503；未来公告发布或调整后，维护者更新此文件、来源注释和全年/关键调休测试，再部署。未公布年份不复制上一年度，不用空数组掩盖数据缺失。API路径、请求和响应字段不变；Swagger已描述回退与年份边界。

## 历史迁移与验收证据

以下记录对应2026-10-21实现批次；旧测试命令、迁移步骤和“暂不开始05”等交接安排已经结束，不作为当前续做指令。当前任务位置以根`AGENTS.md`为准，业务Agent保持mock。

- 第15迁移`20261021010000_personal_workbench`新增OrgMemberSchedule、OrgAttendanceDaily、OrgAttendanceAdjustment、PersonalScheduleReceipt、ProjectExpertAssignmentMember、EntranceExamAttempt，补ProjectMember.admissionAttemptId及组织排班成员复合外键，并约束PERSONAL作用域、组织成员和班次日期/时间。迁移以BEGIN/COMMIT执行；历史非空admissionAttemptId须核对真实来源，不能清空或伪造考试以绕过外键。该迁移当时仅保留examVersionId/paperId标量，后续考试迁移已补版本/试卷复合外键；考试写流程不由查询接口创建。
- 第16迁移`20261021020000_attendance_applications`将OrgAttendanceDaily.autoStatus/finalStatus及OrgAttendanceAdjustment.beforeStatus改为可空，不回填或重写历史数据。Agent当时尝试连接专用库遇P1001，后由用户完成第16结构及新增8项申请/审批/撤回集成验证；开发库第16迁移也已在当批夹具中核对。其他环境须独立核对，不能从当批结果推断部署库就绪。
- 第15基线：14:12:47启动的137项集成全部通过（总77.59秒，测试66.39秒）；299项单测（24文件）、typecheck、ESLint、格式及Swagger通过。此前130项是旧04基线，137项不能代替新增申请流程验证；原12:07:21连接失败已解除。
- 申请流程：15:01:40的311项单测通过（25文件，总10.12秒），含12项新增测试；首次集成在待办表单序列化失败，修复后25项定向通过。15:14:38完整311项复验通过（总11.23秒）；用户15:17:51的145项集成全部通过（总69.67秒，测试60.48秒），先前缺第16迁移的阻塞解除，迁移历史未另查。
- 真实HTTP/OSS：从104项记录中103项符合预期、日历源503，补2026随包基线后累计108项记录，包含原1项失败及4项修复复验。国庆8条、春节11条、三月无安排、2099无可靠年份503四项复验通过。最终15:48:49的313项单测通过（25文件，总12.90秒），typecheck及ESLint通过；当批未重跑145项集成或操作数据库。真实外网源仍超时，随包回退通过不代表外网恢复。

完整批次过程、隔离数据和已结束准备脚本见[历史验收记录](../archive/ACCEPTANCE_HISTORY.md#personal-workbench-acceptance)。原外部任务路径为`../../backend-migration/priority-unified-accounts/todoTask.md`，不在当前仓库内。该批次未提交或发布；数据库集成的存储替身不替代真实OSS，模拟日历源不替代外网联调，限定接口验收不代表完整兼容或其他业务动作全部完成。
