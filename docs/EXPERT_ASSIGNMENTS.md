# 执行专家接单侧（07）

2026-10-23的08第二批补充：061考试卡片同时排除已交卷及已取消的应试记录，取消后不再开放考试按钮；本人考试轮次由070完成、071取消，其他支线不变。070/071实现及六项待本机复验见[执行专家考试](ENTRANCE_EXAM_CANDIDATE.md)，不重复07已通过验收。

## 2026-10-23真实HTTP验收（最新）

2026-10-23最新07真实HTTP验收通过：运行中的本机后端共228个HTTP请求及1项并发汇总断言通过（229项），覆盖API-061—067全部7种方法/路径；另4条脚本构造/预期修正前记录保留，不计入通过数，未发现业务实现失败。个人/组织/成员接单拒绝、多组织权限、本人项目/详情、负责人集合及兼容入口、真实并发与幂等、拒单补招、Cookie/角色隔离、实际离组失权和个人身份恢复均已验证。本批仅新建6账号/3组织/3项目（6、7、8）及1考试（4，已关闭），既有分类只读；9个新会话已退出并逐一验证401。未直连数据库、未应用迁移、未清库、未改业务代码、未重跑单测/专用库集成；业务Agent继续mock。061—063及067保留部分迁移，064—066已通过本机HTTP但仍待部署/完整兼容；067转项及完整审批/生产/转项真值归10—12，实际投递归14。默认入口仍08，本轮仅验收07，未执行08。

详见[验收报告](EXPERT_ASSIGNMENTS_ACCEPTANCE.md)。下文为实现与前批交接记录，最新验收结论以上述报告为准。

## 2026-10-23 接单写契约（067，当前）

2026-10-23最新07→08交接：用户12:02:17定向运行expert response，本批5项集成全部通过（195跳过，共200项，总6.50秒，测试3.86秒），个人并发/免试、组织主管与成员响应/幂等/离组、拒单补招消费、outbox整事务回滚及笔试轮次/不伪造应试入项已验证。原数据库初始化连接阻塞解除；不是全200项复跑，无需重复本批5项或061/064/065/066及06前批已过项。07全部7个HTTP入口已有代码，061—063及067保留部分迁移，064—066及API-008保留已实现待真实HTTP/部署/完整兼容验收；438单测、最终28定向及类型/ESLint/build前批证据保留。无新迁移，迁移历史未另查；本轮仅同步用户结果与交接，未重跑测试、修改业务代码或操作数据库。默认入口切至08，本轮未执行08；下次从068当前状态与069入场开始，随后070交卷/071取消。067转项双入口及联动归12，完整审批/生产/转项真值归10—12，实际投递归14；业务Agent继续mock，不连接真实服务。

`POST /api/v1/expert-assignments/respond`请求体示例：

```json
{ "assignmentId": 1, "decision": "ACCEPT" }
```

组织首次接单用`{"assignmentId":2,"decision":"ACCEPT","projectOwnerUserIds":["00000000-0000-4000-8000-000000000001"]}`；兼容`projectOwnerUserId`单值，与非空集合二选一，去重后1—20人。个人或成员不能指定负责人。拒绝用`{"assignmentId":3,"decision":"REJECT","rejectReason":"当前暂无可投入人员"}`，原因trim后非空、最多500字符。`assignmentId`和`movementId`必须二选一且为32位正整数；movementId合法请求当前503，不写入数据。assignmentId后续与转项单联动归12，本批不伪造同步成功。

成功响应：`{"code":200,"message":"操作成功","data":{"assignmentId":1,"movementId":null,"status":"ACCEPTED","memberStatus":null,"nextAction":"WAIT_ENTRY_CONFIRMATION","notifiedMemberCount":0}}`。组织成员响应时主体status仍ACCEPTED，memberStatus为ACCEPTED或REJECTED；其他响应memberStatus为null。主体拒绝nextAction=NONE，成员拒绝VIEW_RESULT，组织首次接单MANAGE_PROJECT_MEMBERS，普通个人/成员按笔试返回TAKE_ENTRANCE_EXAM或WAIT_ENTRY_CONFIRMATION；考试/入项写入口由08/10继续。

当前EXPERT且为被分配本人，或对应组织的正常账号有效成员；组织首次响应须OWNER，已接单组织未兼任负责人的OWNER不能以普通成员再次响应。有效组织关系为ACTIVE/EXIT_APPROVING/PENDING_LEAVE，支持多组织独立鉴权；LEFT及失效账号不授权。负责人SELECTED已视为参与，再响应409；普通成员相同决定幂等保留首次时间/原因，反向决定409；主体重复处理409。400参数错误，401失效会话，403角色/范围无权，404分配/未删除项目不存在，409已处理或结项，503转项未接入。

组织首次接单同步全体有效成员考试/培训轮次，取消被组织待响应身份覆盖的个人旧轮次，成员实际接单后按事实再开放。组织首次接单只初始化选中负责人的SELECTED记录，其他成员动态获得卡片，不预建全员记录。免试成员为PENDING_CONFIRM且joinedAt=null；需笔试不创建实际应试/准入事实。`notifiedMemberCount`仅组织首次成功接单时为正常账号未离组成员数，其他为0，不表示已投递。用户/组织/成员关系/项目/分配按统一锁顺序串行化；业务状态、负责人、参与、免试成员、考试培训轮次、补招快照与PENDING outbox同事务。成员拒绝不改变组织主体状态或生成补招；主体拒绝生成未消费的补招来源，由060一次消费。不修改项目节点/版本，不记接单任务完成计数。

061的canAccept/canReject仅待响应的个人/组织主管/普通成员为true；已参与负责人及已响应成员false，报量按钮仍false。新增Swagger包含中文字段说明、可校验完整示例及实际序列化测试。集成复验命令（在tyde目录现有专用_test库执行）：

```sh
pnpm --filter @tyde/server test:integration -t 'expert response'
```

以下为前批历史记录，当前状态以上文及07任务记录为准。

## 2026-10-23 当前负责人写契约（065/066）

`POST /api/v1/expert-assignments/set-project-owners`和兼容`POST /api/v1/expert-assignments/change-project-owner`已实现待验收。当前EXPERT会话且为该组织有效主管，组织分配必须ACCEPTED。`assignmentId`为32位正整数；`projectOwnerUserIds`完整集合和旧`projectOwnerUserId`二选一，集合去重后1—20个UUID，空集合/null按未提供处理。兼容接口仍支持完整集合，并在Swagger标记deprecated。

```json
{
  "assignmentId": 1,
  "projectOwnerUserIds": [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002"
  ]
}
```

成功返回`{"code":200,"message":"操作成功","data":null}`。400表示参数错误、非ACCEPTED或所选用户不是正常账号/本组织有效成员，401失效会话，403非EXPERT或非对应组织主管，404组织分配/未删除项目不存在。有效成员沿ACTIVE/EXIT_APPROVING/PENDING_LEAVE，支持主管本人、多组织独立范围。重复同集合不重复参与/入项或事件；初次遇到旧单值可补负责人历史。

负责人历史ACTIVE/REMOVED及appointedAt/removedAt保留。唯一负责人填兼容单值，多人null；存在任何历史不回退旧值。新增负责人参与为SELECTED，已有ACCEPTED/SELECTED保留；被拒绝/取消参与恢复SELECTED并清空拒因。免试（含无计划沿旧默认）且本分配/用户无任何成员历史才创建PENDING_CONFIRM普通成员，不制造实际入项时间。需考试不生成免试成员。移除只撤销负责人，不删除/取消已有考试、参与或项目成员。

项目锁串行化同项目写流程，负责人/参与/免试成员/本域考试培训轮次及PENDING outbox同事务；不推进项目共享节点/版本，交接不算任务完成。撤销交接双方陈旧本域考试/培训快照，由读取实时事实计算；跨领域审批/核验/子任务优先级归10—12/04，通知投递归14。

API-008及资料响应的`hasExpertManagementRole`已按当前EXPERT+有效组织主管或已接单组织现任负责人计算。离组/移除/切换会话角色即时失权；删除项目不赋予负责人职责。有历史禁用旧值回退。该展示字段不代替业务鉴权。

最终431项单测通过（40文件，11:40:36，总26.96秒，maxWorkers=2），服务端类型/变更ESLint/后端build通过。用户11:50:17定向3项集成全部通过（192跳过，共195项，总13.14秒，测试2.64秒）；已验证负责人替换/兼容、免试成员、幂等、权限、回滚、考试轮次与API-008失权。原数据库初始化阻塞解除；以下命令仅留作通过证据，无需重复：

```sh
pnpm --filter @tyde/server test:integration -t 'expert owner replacement'
```

本轮只同步用户结果，未重跑测试或修改业务代码，无新schema/迁移/依赖，迁移历史未另查，未操作开发/部署库；真实HTTP/部署/完整兼容仍待验收。061前批2项、064前批2项及06前批11项已通过，无需重复。保持07，下批067接单/拒绝并接通061按钮，业务Agent继续mock，不开始08。以下2026-10-22记录为历史。

2026-10-22最新07第二批集成通过：用户18:09:22定向复验成员进度/负责人历史1项通过（191跳过，共192项，总11.60秒，测试1.12秒），原免试计划夹具P2025已解除；结合18:03:22已通过的来源/多组织权限/身份优先/status筛选1项，本批2项集成分批全部通过，不是全192项复跑，无需重复。061保留部分迁移，064前批通过证据不变；421单测及类型/ESLint/build、修正后18项定向证据保留。无新迁移，迁移历史未另查；本轮仅同步用户结果和文档，未重跑测试、修改业务代码或操作数据库。保持07，下次直接065—067及API-008，061按钮随067接回，完整生产/报量当天撤卡及审批/转项真值归10—12，062/063按需回补；业务Agent继续mock，不开始08。

当前API-061—063及067部分迁移，API-064—066已实现待验收；067招募三链路已接入，转项响应与联动归12。接口进度和验证唯一记录见[07任务](../../backend-migration/07-expert-assignments/todoTask.md)。

`GET /api/v1/expert-assignments/project-owner-candidates?assignmentId=1`，无请求体。支持受信Cookie或Bearer会话，当前角色必须为EXPERT；assignmentId为1至2147483647的十进制正整数。不存在、个人分配或已删除项目返回404；非分配所属组织有效OWNER返回403；非法参数400，失效会话401。组织未删除，OWNER关系须为ACTIVE/EXIT_APPROVING/PENDING_LEAVE；不按账号类型或单数organizationId推断多组织权限。

返回`code/message/data`，data为数组，字段为`userId/uid/name/avatarUrl/position/projectOwner`。userId为新库UUID，uid为平台UID；name为昵称(真实姓名)，缺失时按已有名称/UID回退；avatarUrl未设置为null；position为OWNER/ADMIN/MEMBER。候选含主管本人，仅ACTIVE账号且尚未完全离组的成员，排除PENDING_ACTIVATION/LEFT；按position和关系ID升序，无结果为空数组。

projectOwner仅在分配ACCEPTED时表示现任负责人：优先ACTIVE负责人关系，只有关系表完全没有历史时才使用projectOwnerUserId。已有REMOVED历史不恢复旧列；已离组/停用负责人不在候选中。查询允许待接单、拒绝及取消状态，此时所有projectOwner为false。读取使用RepeatableRead事务，不写负责人、接单、成员、节点、版本、轮次或通知。

完整中文Swagger及可校验响应示例见`/api/v1/docs/`。原HTTP方法、路径及字段名保留；用户ID沿新库既有UUID契约。组织资料ACTIVE/APPROVED不代替本人组织任职资格。

本批416项单测、类型检查、ESLint及后端build通过。新增2项专用库集成首次因127.0.0.1:5432不可达停在beforeEach；用户17:42:12定向复验2项全部通过（188跳过，共190项，总4.33秒，测试1.44秒），原初始化连接阻塞解除。不是全190项复跑，无需重复本批2项。未增加schema/迁移/依赖，迁移历史未另查；本轮仅同步结果，未重跑测试或操作数据库；业务Agent继续mock。以下为已通过的命令，留作追溯：

```sh
pnpm --filter @tyde/server test:integration -t 'expert owner candidates'
```

仅使用现有允许重置的专用_test库；本批无需新迁移，不重复本批2项及06前批11项集成。064真实HTTP/部署/完整兼容仍待验收，当前保持07，下次直接061及065—067。

## API-061 任务卡片（部分迁移）

`POST /api/v1/expert-assignments/my-tasks`，必填JSON请求体，可传`{}`。可选`keyword`（最多100字符，trim后按项目名/需求方名称创建快照模糊匹配）、`acceptanceStatus`及旧别名`status`。状态取PENDING_ACCEPTANCE/ACCEPTED/REJECTED/CANCELLED/REPLACED，null或省略不筛选；两状态同时非null且不一致400。拒绝、取消、替换并非待办，按这些状态筛选得到空数组。

当前会话EXPERT，个人仅本人；组织未接单仅有效主管，已接单允许ACTIVE/EXIT_APPROVING/PENDING_LEAVE成员。已接单组织的主管/负责人/未拒绝成员身份优先个人；成员拒绝/取消或离组后恢复个人任务，多组织分别计算。返回分配下发时间和ID倒序，无结果空数组。负责人集合以ACTIVE关系为准；有REMOVED历史不回退旧单值，唯一负责人时才填旧单值响应字段。

返回code/message/data，data数组中每项包含assignmentId、basicInfo、acceptanceStatus、needWrittenExam、currentNodeCode、branchNodeCode、accessContext、operations。basicInfo保留旧字段及完整分类/负责人集合，时间为上海`yyyy-MM-dd HH:mm:ss`，用户和组织ID为新库UUID。currentNodeCode始终项目主线；普通成员branchNodeCode按最新成员关系的实际入项/培训重算，未入项/终态不沿用旧培训。无成员且需考试、本人未交卷时展示考试支线；负责人还要求实际ACTIVE考试的当前版本报名未截止。交卷后无考试待办，结项硬撤卡，未配置考试的负责人保留管理卡片。

接口读取RepeatableRead事务，不推进节点/版本/轮次、生成成员或写快照。067未接入前canAccept/canReject=false；11未接入前canReportOutput=false。完整生产能力、当天已报量后撤卡、主管审批/确认入项/子任务/核验和转项待办来源竞争由10—12接回；本批不沿用这些旧快照，不宣称完整卡片兼容已完成。061的接单按钮随067开发接通并复测。Swagger请求和响应均有完整中文说明与可校验示例。

本批421项单测、类型/ESLint/后端build通过；新增2项集成17:51:10均在beforeEach因127.0.0.1:5432不可达，业务断言未执行，190跳过，共192项。无新schema/迁移/依赖，未操作开发/部署库。仅复验本批命令（在tyde目录、使用现有允许重置的专用_test库）：

```sh
pnpm --filter @tyde/server test:integration -t 'expert task cards'
```

064及06前批通过项不重跑。真实HTTP/部署/完整兼容仍待验收，当前保持07，下次065—067及API-008。

2026-10-22最新07集成夹具修正：用户18:03:22定向2项，1通过/1失败/190跳过（共192项，总12.58秒）；060来源/多组织权限/身份优先/status筛选已通过，用户本机数据库连接阻塞解除。唯一失败是测试误对未创建的生产计划调用update（P2025），已改为显式创建含全部必填字段的免试计划夹具，业务实现未改。修正后18项定向单测（18:05:03，总2.84秒）及变更ESLint通过；Agent仅复验失败1项仍因自身环境127.0.0.1:5432不可达停在beforeEach，未执行修正后业务断言。仅该1项待用户本机复验，不重复已过1项、064及06；421单测及类型/build前批证据保留。无新迁移、未操作开发/部署库。保持07，复验后065—067及API-008，061—063仍部分迁移，业务Agent继续mock，不开始08。

失败单项复验（tyde目录）：`pnpm --filter @tyde/server test:integration -t 'expert task cards read latest membership progress'`。
