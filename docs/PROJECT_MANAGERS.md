# 策略官候选、分配与项目任务基础

> 2026-10-28第二十九批集成通过：用户11:02:45仅定向recruitment independent progress九项全部通过（363跳过，共372项，总10.30秒，测试6.46秒）。招募下发、招募协作负责人交接及策略官任职对真实培训来源补轮、陈旧考试轮次取消、历史及无关轮次保留、精确卡片来源/事件受众、重复操作轮次幂等与读取无副作用，以及实际业务/独立轮次及卡片/outbox写入后故障整事务回滚已验证，原初始化连接阻塞解除。不是全372项复跑，不重复本批或前二十八批、不重迁移29。63定向单测及类型/静态/后端build保留前批证据，全量单测本批未复跑。本轮仅同步用户结果与文档，未重跑测试、修改业务代码或操作数据库，迁移历史未另查。保持13，下次直接取消/离场及其余写入口的独立轮次与跨域来源/受众；业务Agent保持mock，实际投递归14，不开始14。

以下第二十九批实现及更早记录为历史，以本次集成通过为准。

> 2026-10-28任务13第二十九批：招募下发、招募协作负责人交接及策略官任职在业务/管理轮次写入后、统一卡片仲裁前，同事务同步全项目独立考试/培训轮次，保留原事件受众及历史。63项定向单测、服务端类型、变更ESLint/Prettier及后端包build通过；未重跑全量单测，711全量单测保留前批证据。10:59:04仅定向recruitment independent progress新增9项集成均停在beforeEach，127.0.0.1:5432不可达（363跳过，共372项，总4.21秒，测试391ms），业务断言未执行。保持13，先本机既有专用_test库仅复验本批9项，不重复前二十八批、不重迁移29。无HTTP/schema/迁移/依赖变更，未应用迁移或操作开发/部署库，迁移历史未另查。通过后继续取消/离场及其余写入口的独立轮次与跨域来源/受众；业务Agent保持mock，实际投递归14，不开始14。

> 2026-10-22现行规则：当前NAVIGATOR+本人项目招募，候选为全部ACTIVE账号（自带PM），不查询ManagementGrant。任务受众依据ACTIVE账号和实际任职，不因当前会话切换而删除另一角色待办；附件按当前角色及真实任职读取。详见[统一账号与组织创建](UNIFIED_ACCOUNTS.md)。本轮证据见[插队任务](../../backend-migration/priority-unified-accounts/todoTask.md)。

04本批接入API-032 `GET /api/v1/projects/manager-candidates`和API-033 `POST /api/v1/projects/manager-recruitments`。第11个迁移`20261019080000_project_managers`新增策略官任职、任务轮次、事务事件表和User.creditScore。用户2026-10-20回传102项专用库集成全部通过，本批数据库验证阻塞已解除；开发/部署及兼容验收仍待完成。

## 权限与接口

两接口均要求有效会话、独立NAVIGATOR授权，以及本人创建的未删除PUBLISHED项目。其他创建人的项目403，草稿400，不存在或逻辑删除项目404。注册/登录角色仍固定EXPERT，不从User.role、组织身份或客户端角色声明推导管理权限。沿用Cookie/Bearer与来源规则，不新增前端或授权HTTP。

候选查询query为必填projectId（新库32位正整数的文本）及可选keyword（最多100字符，trim后匹配昵称/真实姓名，空白不筛选）。返回全部匹配，不分页：当前匹配策略官置顶CURRENT，其余为RECOMMENDED，按全平台ASSIGNED任职数量升序、信用分降序（null排后）、用户ID升序。LIKE保留%/_通配语义，PG/MySQL大小写及UUID/旧数值排序仍待兼容验收。

推荐人须ACTIVE且持有有效独立PM授权；旧User.role=PM本身不构成合法来源。信用分复用旧schema默认100，新库新增字段的既有用户也按此默认补齐；nullable保留旧空分数含义。本批无信用分写HTTP，也不在候选响应泄露信用分或手机号。currentProjectCount按旧SQL统计ASSIGNED任职记录，不额外过滤关联项目的逻辑删除或生命周期状态，不等于执行专家在项数。

当前策略官按旧查询行为仍可展示，即使其账号已停用或PM授权已撤销；keyword同样过滤当前人。展示不等于仍可操作业务或再次被招募，后端写操作及文件读取分别校验最新资格。

招募body保持projectId、candidateUserId；项目ID为数值，用户ID沿用新库UUID，不能混用旧数值用户ID。完整中文字段说明、枚举、成功/失败示例见Swagger。

## 任职、并发与节点

保存为DIRECT直接指派，无需接受。持有项目行锁时重新验证候选：不能是该项目当前策略官，失效/重复当前人400，不返回虚假幂等成功。首次INITIAL，新建ASSIGNED任职；更换REPLACEMENT，旧任职REPLACED并记录时间，新记录保存previousManagerUserId，不覆盖历史。策略官不写入执行成员表。

部分唯一索引保证每项目最多一条ASSIGNED，历史REPLACED不占名额。首次分配只允许从空节点或RECRUIT_PROJECT_MANAGER条件更新到PRODUCTION_PLAN，不清空表单，不改草稿版本；条件不匹配409并回滚整笔。更换保留当前节点，不额外以节点限制业务，亦不回退或自动创建生产计划。

同一项目不同候选并发按项目锁串行执行，可能先首次分配、后合法更换；相同候选并发只有一笔成功，其余因已是当前策略官400。最终生效人以最新ASSIGNED为准，候选列表不是授权或负载预留。

## 任务轮次与事件

任职、节点、ProjectTaskRound和ProjectEventOutbox在同一事务内提交；轮次/事件写失败必须回滚任职及节点，专用库事务回滚用例已通过。业务事件只记录事实，不发送实时消息。

ProjectTaskRound保存项目/用户/角色/任务类型的一轮：OPEN=待处理、COMPLETED=完成、CANCELLED=取消。OPEN部分唯一，结束轮次不复用。对比事务前后来源与角色范围，在首次处理历史待办时补基线；动作实际移除来源且本人参与才结算完成，权限/任职消失只取消。沿旧招募动作声明，成功的显式操作允许为仍保有范围的操作人补建无来源完成基线。不同角色独立记录，不把固定登录EXPERT当成领航员任务角色。

本批真值采集仅覆盖管理主线：MAIN_RECRUIT_PROJECT_MANAGER、MAIN_PRODUCTION_PLAN、MAIN_ENTRANCE_EXAM、MAIN_STANDARD_TRAINING、MAIN_RECRUIT_EXECUTION_EXPERT。旧卡片规则中领航员只负责招募策略官，主策略官负责四个主节点，协作负责人只负责招募执行专家。主线来源为PROJECT:<项目ID>，当前未实现的考试/培训业务不会因此被视为已实现。

通用reconcile入口接收before/after、操作人角色、明确完成类型、允许无来源完成类型及trackedTypes，调用方必须先锁项目。当前查询/修改只限本批采集的管理主线类型，未采集支线不被错误取消。考试/生产/专家任务来源、完整卡片聚合、组织/成员范围及支线刷新需后续接入；因此API-033保留部分迁移，不能据两个入口存在就宣称整个04完成。

管理授权运维命令不主动扫描全项目轮次；轮次在后续业务对账时根据真值取消失去范围的任务，不承诺撤销授权立即修改所有历史OPEN。每次HTTP和文件读取会实时查询授权，不能用旧OPEN轮次授予访问权限。

ProjectEventOutbox记录PROJECT_TASKS_RECONCILED事实，行UUID是事件标识，operation为project.manager.recruit，payload版本schemaVersion=1，包含projectId、operation、actorUserId、projectAudience及taskChangedRecipients（数组项为userId/role）。项目受众取前后角色范围并集，保留旧负责人以便清除失效视图；任务变化受众来自任务来源或完整范围身份变化。动作失败不留事件，同一当前人重试失败不重复写事件。

事件目前只PENDING，attempts=0、deliveredAt=null；字段nextAttemptAt/attempts为后续重试准备，不代表已实现领取/租约/重试/MQ/WebSocket。14阶段须实现投递与幂等，按旧策略取变化受众与项目受众交集并排除操作人，再产生工作台/项目失效通知。支线和专家受众需在07/12/13及相应业务阶段补充，当前事件不伪造完整受众。

## 项目附件回补

API-011新增独立PM授权的当前ASSIGNED主策略官或招募协作负责人读取：必须同时满足台账CLAIMED、项目ID绑定、附件ACTIVE及项目未删除。更换任职后旧策略官/旧协作负责人不再拥有此范围，撤销PM授权也立即拒绝下一请求；只有PM授权但没有该项目关系仍403。创建人独立NAVIGATOR分支保持，上传者身份不替代业务授权。EXPERT接单/准入及考试附件继续按后续任务回补，API-011仍部分迁移。

## 验证与续做

新表为ProjectManagerRecruitment、ProjectTaskRound、ProjectEventOutbox；User增加nullable creditScore默认100。外键RESTRICT保留任职和任务历史，15物理删除阶段须按审计保留策略处理，不擅自级联删除。迁移不自动授予角色，不复制旧库或创建任职。部分唯一索引只在SQL维护，Prisma模型不能表达。

专用测试库已通过当前102项集成；其他目标环境须先迁移。以下为专用库迁移与复验命令：

```sh
cd apps/server
node --env-file=.env.test node_modules/prisma/build/index.js migrate deploy
cd ../..
pnpm test:integration
```

用户回传2026-10-20 10:35:16运行102项集成全部通过（总41.38秒，测试31.82秒），证明第11所需专用库结构及本批业务已就绪；此前Agent P1001阻塞解除。本次Agent未重跑、未查询迁移历史或应用迁移。既有248项单测通过；开发/部署库迁移应用情况尚未确认，新代码读取新增User字段，须先迁移对应目标库再启动。详细证据和恢复位置只在[04记录](../../backend-migration/04-project-foundation/todoTask.md)维护。

生产计划（API-036/037）已在后续批次接入代码，267项单测通过，用户2026-10-20回传110项专用库集成全部通过，第12所需结构已就绪、迁移历史未另查，见[生产计划](PROJECT_PRODUCTION_PLANS.md)。API-035详情和成员表基础现已接代码（用户2026-10-20回传118项专用库集成全部通过，第13所需结构已就绪，迁移历史未另查），见[项目详情](PROJECT_DETAILS.md)；项目列表/策略官列表（API-031/034）读取已接后续本批代码，用户2026-10-21回传130项集成全部通过，第14所需结构已就绪、迁移历史未另查（部分迁移），见[项目列表](PROJECT_LISTS.md)；来源写流程/重算待后续，以及成员写流程和03清退（计数/筛选已在04回补代码，用户2026-10-21回传122项集成全部通过）。主线任务与事件的扩展在业务接入时补齐，不返回空成功替代未迁移聚合。当前130项集成已通过，04基础已交接05；后续回补仍保留原状态，不重复执行04。
