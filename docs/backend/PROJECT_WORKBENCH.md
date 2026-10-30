# 项目看板与任务统计

本文说明 API-108—114 的现行读取口径、卡片仲裁和独立轮次。完整逐批证据保留在[后端开发历史](../archive/BACKEND_HISTORY.md#project-workbench)。

## 验收状态与剩余工作

最近业务验收状态沿用 2026-10-28 的任务13记录：前46批定向结果保留；第四十七—四十八批新增人员异动三个人工审批节点的同意/驳回/撤回 HTTP 18项和生产计划补录 HTTP 4项，共22项，均停在 `beforeEach` 的 `127.0.0.1:5432` 连接失败，业务断言未执行，不计通过。本次文档整理未重新运行业务验证。

- 保持任务13、业务 Agent mock，不开始14或实际事件投递。
- 仅待既有专用 `_test` 库恢复后执行新增22项；前46批不复跑，不重迁移29。
- 开发/部署环境、浏览器自动携带 Cookie 及 SameSite/Secure、HTTPS、Electron 和完整兼容尚待验收。Node 客户端显式携带真实登录 Cookie 不等于浏览器策略通过。
- 当前没有项目结项/删除合法写命令；终态夹具不能代替真实命令验收。既有分类数据提交/发布限制保留。

新增专项的选择条件为 `workbench movement approval HTTP|workbench plan lifecycle HTTP`；仅用于既有专用测试库，不初始化数据库、不代替目标环境迁移。

## 基础详情

`POST /api/v1/projects/workbench/board/project-detail`，请求示例：

```json
{ "projectId": 3001 }
```

使用既有Cookie或Bearer会话，当前角色只取服务端会话；不接受通过请求字段指定角色或扩大组织范围。成功响应沿用`{code:200,message:"操作成功",data:{...}}`。完整字段和可校验示例见Swagger，返回项目基础字段、当前个人需求方名称、分类名称快照、发布时间和关闭时间，不返回附件、内部JSON、生产指标或审批信息。响应项目主键名为`projectId`，不使用项目详情接口的`id`。时间为上海`yyyy-MM-dd HH:mm:ss`，未发生为null；未选择一级/二级分类为null，三级分类为有序数组。

| 当前角色  | 必须同时满足的实际关系                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| NAVIGATOR | 项目创建人UID为本人                                                                                                                   |
| PM        | 本人是PENDING_ACCEPTANCE/ASSIGNED候选策略官，或ASSIGNED招募协作负责人                                                                 |
| EXPERT    | 组织未删除，本人具有ACTIVE/EXIT_APPROVING/PENDING_LEAVE组织关系，且该组织在本项目已ACCEPTED接单；本人为组织主管或本接单有效项目负责人 |

负责人关系表存在任何记录（包括REMOVED）时禁止回退旧`projectOwnerUserId`；仅完全无关系行时允许旧单负责人回退。普通组织成员、个人接单者、其他组织主管和当前角色不符的账号均不因此获得权限，离组立即失权。同账号在其他会话中激活的角色不会改变当前会话视角。

项目不存在、已逻辑删除或关系不符均403。沿用旧Mapper，不限制项目发布状态：合法关系可以读取DRAFT和PUBLISHED项目。项目结项由`currentNodeCode=COMPLETED`及`closedAt`表达，项目status没有CLOSED枚举。本接口不推进节点、对账任务轮次或写outbox；关系、分类及名称在同一RepeatableRead事务快照读取。

旧Controller说明称项目负责人可读待接单项目，但旧Mapper明确要求ACCEPTED；本批按SQL实际行为保留限制，不扩大权限。新库`requesterId`沿用现行UUID用户ID适配，历史组织需求方取名称快照；个人需求方取实时昵称(姓名)，缺一取另一项，全空回退名称快照。旧库ID及令牌不与新库互通。

## 任务轮次与阶段统计

`GET /api/v1/projects/workbench/statistics?mode=TASK`，`mode`必填且区分大小写，只接受TASK/BOARD。沿用Cookie/Bearer会话和Result结构；只返回所选模式字段，不填另一模式的null字段。当前无数据均返回0。

```json
{
  "code": 200,
  "message": "操作成功",
  "data": {
    "mode": "TASK",
    "pendingTaskCount": 3,
    "completedTaskCount": 2,
    "involvedProjectCount": 1
  }
}
```

```json
{
  "code": 200,
  "message": "操作成功",
  "data": {
    "mode": "BOARD",
    "totalProjectCount": 10,
    "startupProjectCount": 2,
    "assemblyProjectCount": 3,
    "productionProjectCount": 4
  }
}
```

TASK范围为已发布未删除项目中当前角色的真实关系：创建人、在任PM/协作人、已接单组织的有效主管/负责人/已响应成员、已接个人及有资格的转入人员、历史人工阅卷参与人。BOARD只取创建人、在任PM/协作人、已接单组织有效主管/负责人；不采用108的待接受PM范围。当前会话角色独立，多组织按实际项目关系过滤；普通成员/个人可以有TASK数据同时BOARD全0，空管理范围返回0而非403。失权立即回收，旧负责人回退仍要求完全无负责人关系行。

待处理数量按项目和任务类型去重，同类多个来源计1；涉及项目数只统计真实待办项目。复用管理主线/补招、阅卷/自动阅卷失败待重试、入项确认、报量核查、首次创建子任务、验收和返修来源；审批以当前有效审批人及已激活人工阶段计算，接单/考试等待不能当成人工审批。个人考试和实际入项后的未确认培训另行读取；按旧口径，负责人仅可入场的有效考试才产生考试任务，普通成员已存在成员关系时以其最新入项进度为准。首次验收和返修复验合并成SUBTASK_ACCEPTANCE；日常生产报量和退回修正属于PRODUCTION_TASK履约，不计待办。来源查询失败向外报错，不吞错填0。

已完成数量只取当前可见项目、本人和当前角色下每种任务的最新轮次：按ID倒序先去重，再判断COMPLETED及finishedAt处于上海当天`[00:00,次日00:00)`；新OPEN/CANCELLED、昨日或次日完成均不算。已有真实待办时不把尚未对账的旧COMPLETED误计为本轮已完成；新来源可直接显示待办，不要求预先存在OPEN行，不为统计补造历史完成轮次。合并验收类型的最新轮次同样按ID选取。

BOARD总数包含已结项项目；启动阶段为RECRUIT_PROJECT_MANAGER/PRODUCTION_PLAN/ENTRANCE_EXAM/STANDARD_TRAINING，组装阶段为RECRUIT_EXECUTION_EXPERT，生产阶段要求PRODUCTION_TASK且至少存在一条同项目子任务关联报量。不限制报量核准状态或数量；项目级报量不算，多个子任务/报量不放大项目数。null、结项及其他主节点只计总数，故阶段之和可小于总数。聚合通过数据库count/关系过滤完成。

所有读取在同一个RepeatableRead事务快照完成；不锁业务行、不修改轮次/节点/版本/卡片，不写outbox。复用各域只读采集器，按已过滤项目读取来源；尚未进行大范围性能或部署环境验收。业务Agent继续mock，本接口不触发实际投递。请求模式缺失/错误400，未登录401，非法角色或来源403；异常状态冲突409，基础设施或内部故障按既有错误处理返回500/503。

## 看板项目列表

`POST /api/v1/projects/workbench/board/projects`，请求`{"current":1,"size":20,"keyword":null}`，返回Result分页`total/pages/current/size/records`。空对象默认第1页、每页20条，size范围1—100，current为1—2147483647，keyword最多128字符，null/空白不筛选。按项目名称或需求方名称快照包含搜索；个人需求方展示实时昵称(姓名)，因此新昵称不自动成为搜索条件。按发布时间倒序（null最后）、ID倒序，数据库先权限和关键词过滤再分页，不按接单数放大项目总数。

只查已发布且未删除项目，含结项。NAVIGATOR限本人创建，PM限当前ASSIGNED主策略官/招募协作负责人；待接受PM不授权。EXPERT限未删除组织中有效主管或有效项目负责人、且组织已接单，多组织独立过滤，离组立即失权；有任何负责人关系行（包括REMOVED）时禁止回退旧单负责人。EXPERT空页仍查询实时管理身份：有效主管或仍管理未删除项目的已接单负责人可返回空页，普通成员、个人接单者无管理身份为403；NAVIGATOR/PM空范围返回空页。不能使用登录时缓存的hasExpertManagementRole替代实时查询。

卡片保留旧字段：projectId、assignmentId、deadline、projectNo、projectName、requesterName、needWrittenExam、currentNodeCode/currentNodeName、progressQuantity/targetQuantity/progressPercent和quantityUnit。仅PM返回primaryProjectManager/expertRecruitmentHandler两个当前关系标志，其他角色省略；assignmentId仅EXPERT返回本人实际可管理已接单分配中最大ID，其他角色null。多个可管理组织仍只返回一个项目。

列表进度始终取全项目口径：当前页全部子任务actualQuantity之和/项目创建量级，空值为0，不使用reportedQuantity、报量核准、组织成员报量或接单目标量级。百分比使用高精度十进制计算后四舍五入两位，不限制100%上限；分母小于等于0为0，JSON沿用数值契约。无生产计划needWrittenExam=false。历史主节点null时，有ASSIGNED策略官回退PRODUCTION_PLAN，否则RECRUIT_PROJECT_MANAGER，只读不回写。时间为上海yyyy-MM-dd HH:mm:ss，未配置deadline为null。

代码入口`project-board-projects.ts`；ProjectBoardService.projects在同一RepeatableRead事务内读取总数、页记录、当前页交付量和可管理接单ID。不修改版本、节点、轮次、卡片或outbox，无新schema、迁移、依赖，未操作开发/部署库，无需重迁移29。

## 子任务交付进度

API-111 `POST /api/v1/projects/workbench/board/subtasks`已实现；请求`{"projectId":3001}`，成功返回Result包装的数组，没有分页，按交付日期、子任务ID升序。只读同一RepeatableRead事务，无子任务返回[]。已核对旧Controller、ProjectBoardDetailRequest、ProjectBoardSubtaskItem、resolveAccess/loadSubtasks/applySubtaskDisplay及selectSubtaskProgress SQL。

权限同110的具体项目范围：仅已发布未删除项目；当前NAVIGATOR为创建人，PM为ASSIGNED主策略官或招募协作负责人（待接受不授权），EXPERT为已接单组织当前有效主管/负责人，组织关系须有效。多组织按实际可管理组织合并；普通成员、个人接单、失权、删除或不存在项目为403。有任何负责人关系行（包括REMOVED）不回退旧单负责人。

输出保留subtaskId/subtaskNo/subtaskName、status/statusName、distributionMode、plannedStartDate、expectedDeliveryDate、reportedQuantity、targetQuantity、progressPercent、quantityUnit、expectedQuantityToDate、progressLowRisk、overdueRisk。状态为IN_PROGRESS进行中、PENDING_ACCEPTANCE待验收、REWORK_REQUIRED驳回返修、ACCEPTED已验收；分发为POOL或DESIGNATED，日期为yyyy-MM-dd。

累计报量直接汇总ProjectOutputReport.quantity，不按日期或核查状态筛选，不使用子任务reportedQuantity/actualQuantity。全项目视角取全部日报量和子任务预期交付量；组织任务池取可管理组织报量、全任务预期量；组织指定模式取组织报量/组织指定人数、预期量/全部指定人数。指定关系按成员ID唯一，离项历史仍计入。指定人数为0时相应数值0；组织只展示存在本组织指定或报量的子任务（包括零报量记录），空组织范围禁止退化成全项目。

百分比按报量/目标*100四舍五入两位，不封顶100%；目标非正数为0。计划从createdAt上海日期到交付日含首尾均摊，今天前/后按0到目标截断，应完成量四舍五入4位，结束早于开始或目标非正数为null。低进度风险用未舍入值严格比较；逾期从上海今天到达交付日即触发。待验收/已验收不触发两风险。运算用高精度十进制，JSON沿用数值契约。

入口`project-board-subtasks.ts`、`ProjectBoardService.subtasks`及既有project-foundation路由/中文project-board.schema；先过滤权限与可见子任务，再批量汇总报量/全部及组织指定人数。无schema/迁移/依赖变更，未应用迁移或操作开发/部署库，迁移历史未另查，不重迁移29。

## 风险预警

API-112 `POST /api/v1/projects/workbench/board/risks`已实现；请求`{"projectId":3001}`，返回Result包装的`viewScope/project/subtasks/members`。每张卡为`pendingCount/urgentCount/items`，计数按风险条数，同一对象可有多风险，空卡片计数0且items=[]。风险项为code/severity/targetId/targetName/message/overdueDays，非逾期天数null，项目历史名称缺失允许null。NAV/PM为FULL_PROJECT，EXPERT为ORGANIZATION。

已核对旧Controller、ProjectBoardDetailRequest、ProjectBoardRiskResponse、risks/loadMembers/applyMemberRisk及selectMemberMetrics/selectMemberThreshold SQL。权限复用111：仅已发布未删除项目，当前创建人/在任PM/协作人/实际已接单组织主管或负责人；多组织合并、离组即时失权、存在负责人关系行不回退旧单。NAV人员卡固定空；PM全项目成员，EXPERT仅可管理组织实际成员，不以账号当前角色或组织当前在组身份剔除尚未离项人员。

项目卡仅项目自身截止时刻严格早于现在且主节点非COMPLETED，等于截止时刻不触发。逾期天数按上海自然日，不足一天为0。子任务复用111真实报量、组织指定人均和计划口径，先按交付日/ID列出全部逾期，再按同序列出低进度；待验收/已验收抑制风险。同一任务两种风险分别计数，不累计到项目卡。紧急只包含PROJECT_OVERDUE/SUBTASK_OVERDUE，其余WARNING。

人员只在主节点PRODUCTION_TASK计算，ACTIVE/PENDING_EXIT/PENDING_TRANSFER纳入，从成员基表保留当天零报量人员。效率为上海当日报量合计严格低于CPD；累计质量为所有日期每笔报量最新ID质量记录的合格合计/抽检合计*100，四舍五入两位后严格比较，不平均各条百分数。日报量不按核查状态过滤，项目级/子任务级均参与；无抽检不触发质量风险。命中当前上海日期的最小sequenceNo阶段提供CPD/准确率；未命中回退主计划CPD，质量阈值null，不能借用其他阶段准确率；无计划不造默认阈值。人员按成员ID、效率再质量排序，名称取实时昵称(姓名)，缺失回退昵称/姓名/UID。

入口`project-board-risks.ts`在数据库参数化聚合、每笔报量LATERAL取最新质量；`project-board-subtasks.ts`抽取共用权限及已授权范围内子任务读取，111响应与口径保持。ProjectBoardService.risks采用单个只读RepeatableRead快照，不改节点/轮次/版本/卡片/outbox。路由及完整中文Swagger在既有project-foundation.routes/project-board.schema。无schema、迁移或依赖变更，未应用迁移或操作开发/部署库，迁移历史未另查，业务Agent保持mock。

## 人员趋势

API-113 `POST /api/v1/projects/workbench/board/trends`已实现。核对旧Controller→ProjectBoardTrendRequest/Response→trends→selectMemberDaily SQL。请求四字段均必填：`projectId`、`metric`（QUANTITY/ACCURACY/CPD）、`startDate`及`endDate`（有效yyyy-MM-dd，包含首尾，正序且最多366天）。返回Result包装的metric/viewScope/dates/series，日期连续升序，曲线按成员ID升序，每条含memberId/userId/displayName/quantityUnit/values；新系统userId为UUID。支持闰日、跨月/年，非法日期及过大范围400。

范围复用111实时权限：仅已发布未删除项目；NAV当前创建人、PM在任或协作、EXPERT实际已接单组织有效主管/负责人，多组织并集，离组立即失权；不回退已有负责人关系行的旧负责人。NAV返回完整日期轴、空series。其余当前ACTIVE/PENDING_EXIT/PENDING_TRANSFER实际成员保留，无报量也有曲线；LEFT等不展示；同用户不同成员身份不合并，EXPERT排除个人接单身份。不限生产节点。

数据库先按授权项目及组织成员过滤，再按日期批量聚合项目级及子任务级报量，不按核查状态过滤；每笔报量LATERAL按质量ID倒序取最新一条，避免历史质检放大量级。QUANTITY为当日合计，缺日补0。ACCURACY为当日最新质检合格合计/抽检合计*100，高精度计算后四舍五入两位；无抽检为null，合格0为0。CPD向前额外查询6天，近7自然日报量补零后固定除7，四舍五入两位，不用工作日或阶段阈值作分母。quantityUnit取项目当前值，名称实时昵称(姓名)，缺失回退已有昵称/姓名/UID。数量沿现有JSON数值契约。

入口`apps/server/src/modules/projects/project-board-trends.ts`；`ProjectBoardService.trends`在同一只读RepeatableRead事务中鉴权和读取，既有project-foundation路由装配，`project-board.schema.ts`提供完整中文Swagger及可校验示例。无schema/迁移/依赖变更，不改节点、轮次、版本、卡片或outbox，未应用迁移、未操作开发/部署库；迁移历史未另查。

## 组织概览

`GET /api/v1/organizations/overview?orgId=<UUID>`保留旧方法、路径和字段。响应Result.data包含orgId和五个非负整数：memberTotal、activeProjectMemberTotal、todayScheduledTotal、todayPresentTotal、pendingApprovalTotal；无记录返回0。

- 组织权限复用现有资料服务：显式orgId，当前用户在该组织为OWNER或ADMIN，关系状态ACTIVE/EXIT_APPROVING/PENDING_LEAVE；不限定当前会话业务角色，不使用用户表旧组织指针授权。先关系403，再不存在/逻辑删除404；不另按冻结/解散状态限制读取，沿旧服务。
- memberTotal计待激活、在组、退出审批中、待离职关系，不计待审核及已离组/移除。
- activeProjectMemberTotal按UserOrgRel关联组织统计ACTIVE项目成员条数，不按人数去重、不额外过滤项目状态/删除、角色或组织成员状态；个人项目关系不计入。
- 今日为上海自然日，数据库Date列用对应日期UTC午夜查询，不依赖数据库时区。排班仅ACTIVE且WORK；出勤仅finalStatus=PRESENT，允许手工修正结果覆盖自动状态，不用打卡次数替代，不额外过滤组织成员状态。
- pendingApprovalTotal只计当前用户且节点/流程均PENDING、流程applicantOrgId为指定组织，不按业务类型筛选；WAITING及其他审批人/组织不计入。

入口`OrganizationService.overview`，复用organization.routes.ts认证、来源校验和Cache-Control:no-store；organization.schema.ts提供完整中文请求、响应和示例。五项计数与权限读取在同一RepeatableRead事务，仅查询，不重算考勤、不生效离组、不刷新卡片或写轮次/outbox。旧SQL的CURRENT_DATE明确采用上海业务日期；UUID与旧数值ID兼容仍待验收。

## 内部卡片与独立轮次

`project-management-card-snapshot.ts` 在真实业务事务内采集完整来源，按支线优先级、业务时间和稳定ID选择卡片。管理及 EXPERT 组织主管、项目负责人、成员、个人视角均参与；权限按各视角真实项目/组织关系校验，已有负责人历史行时不回退旧字段，人工审批只认当前有效审批人。候选采集失败向上传播，不用陈旧快照或零值兜底。

卡片只决定展示胜者。考试、培训及其他任务轮次按独立来源同步，不因高优先级卡片隐藏而取消有效轮次；来源失效只取消，重新出现另开轮，保留历史完成记录。普通考试以当前合法来源及绑定版本/试卷/答题窗口判断，关闭报名或编辑配置不终止仍合法的旧卷答题；转项使用精确变动来源并分别维护原、目标项目。

负责人交接、接单响应、材料更新/确认、考试配置/入场/交卷/取消、人工及 mock 阅卷结果、招募下发/负责人接回、入项、人员异动、生产计划、子任务、报量及验收写入口，均在原业务事务内同步业务及对应独立考试/培训轮次，并在真实来源就绪后统一仲裁。精确来源、受众和回滚的验收范围按历史分批证据及上方待完成事项判断。

原有非静默事件携带 `cardChangedRecipients`，按节点、来源类型/ID和真实业务时间的变化计算，包括替换、恢复、清除和失权；同用户同角色去重，NAV/PM/EXPERT分别保留。仅 `calculatedAt` 变化不产生受众。报量核准、材料更新/确认、生产计划补录、考试配置及入场继续沿原静默契约，不额外创建事件；实际投递属于任务14。

API-061 的报量核查/退回修正实时读取合法报量来源。普通生产待办按本人上海当天报量隐藏，零报量和全部审核状态均计入，次日恢复；独立培训、核查和修正不被该门禁吞掉。`canReportOutput` 由当前成员与报量权限计算，组织主管身份本身不授予代报权限。

所有看板、任务列表、统计和详情读取保持只读，不为展示修复卡片、创建轮次或发送事件。写入中的轮次、卡片、业务事实和原 outbox 共用事务，失败一起回滚；重复命令沿原幂等或冲突门禁处理。
