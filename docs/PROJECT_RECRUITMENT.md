# 项目招募负责人及专家下发

> 2026-10-28第二十九批集成通过：用户11:02:45仅定向recruitment independent progress九项全部通过（363跳过，共372项，总10.30秒，测试6.46秒）。招募下发、招募协作负责人交接及策略官任职对真实培训来源补轮、陈旧考试轮次取消、历史及无关轮次保留、精确卡片来源/事件受众、重复操作轮次幂等与读取无副作用，以及实际业务/独立轮次及卡片/outbox写入后故障整事务回滚已验证，原初始化连接阻塞解除。不是全372项复跑，不重复本批或前二十八批、不重迁移29。63定向单测及类型/静态/后端build保留前批证据，全量单测本批未复跑。本轮仅同步用户结果与文档，未重跑测试、修改业务代码或操作数据库，迁移历史未另查。保持13，下次直接取消/离场及其余写入口的独立轮次与跨域来源/受众；业务Agent保持mock，实际投递归14，不开始14。

以下第二十九批实现及更早记录为历史，以本次集成通过为准。

> 2026-10-28任务13第二十九批：招募下发、招募协作负责人交接及策略官任职在业务/管理轮次写入后、统一卡片仲裁前，同事务同步全项目独立考试/培训轮次，保留原事件受众及历史。63项定向单测、服务端类型、变更ESLint/Prettier及后端包build通过；未重跑全量单测，711全量单测保留前批证据。10:59:04仅定向recruitment independent progress新增9项集成均停在beforeEach，127.0.0.1:5432不可达（363跳过，共372项，总4.21秒，测试391ms），业务断言未执行。保持13，先本机既有专用_test库仅复验本批9项，不重复前二十八批、不重迁移29。无HTTP/schema/迁移/依赖变更，未应用迁移或操作开发/部署库，迁移历史未另查。通过后继续取消/离场及其余写入口的独立轮次与跨域来源/受众；业务Agent保持mock，实际投递归14，不开始14。

> 最新验收与交接：2026-10-22最新06→07交接：用户17:27:30运行修复后的候选定向1项通过（187跳过，共188项，总3.76秒，测试738ms），原显式分页400已解除。结合17:23:41其余3项通过，058—060本批4项已分批全部通过；加053—057前批7项，06累计11项集成分批通过，不是全188项复跑，无需重复。06全部8个HTTP入口已有代码，保留已实现待真实HTTP/OSS、部署及完整兼容验收；413单测及分页修复后14项定向/类型/ESLint/build证据保留。无新迁移，迁移历史未另查；本轮仅同步用户结果与文档交接，未重跑测试、修改业务代码或操作数据库。默认入口切至07，本轮不执行07；下次核对061任务卡片及064—067接单/负责人写流程，062/063保留部分迁移并按需回补，业务Agent继续mock。

以下待复验描述和复验命令均为历史，仅在有新变更需回归时使用；当前无需重复。

API-056—060全部入口已接入，保留已实现待验收；058—060本批4项集成已分批全部通过，候选修复于17:27:30通过；06基础已交接07，真实HTTP/OSS、部署及完整兼容仍待验收。方法及路径统一加`/api/v1`，Swagger提供中文字段、完整示例与错误说明。本批不连接真实业务Agent。

`GET /projects/expert-recruitments/handler-candidates?projectId=3001`只允许当前PM会话且为项目ASSIGNED主策略官查询。创建人、协作负责人和被替换策略官403；项目不存在或逻辑删除404。不限制当前项目节点。无请求体、分页或关键词。

候选来自全部ACTIVE统一账号（自带PM），不按旧User.role、ManagementGrant、账号类型或单数组织筛选，包含主策略官本人。仅返回userId（UUID）、uid、name、avatarUrl（未设置null）、currentProjectCount和currentHandler。姓名规则为昵称(姓名)，缺一项取另一项，全空回退UID；按ASSIGNED主策略官任职数量升序、信用分降序（null末尾）、UUID升序。项目数沿旧SQL不额外过滤项目状态或删除标记。尚未指定时currentHandler全false；冻结候选不展示，不给当前负责人额外置顶。

`POST /projects/expert-recruitment-handler/change`同样仅允许当前主策略官。请求：

```json
{ "projectId": 3001, "handlerUserId": "00000000-0000-4000-8000-000000000002" }
```

项目ID为32位正整数，handlerUserId为ACTIVE候选UUID，允许本人和重复指定，不允许null清空。候选无效400，任职条件更新冲突409。候选无需在自己的会话切换PM。成功响应：

```json
{ "code": 200, "message": "操作成功", "data": null }
```

事务先锁候选用户再锁项目，与材料更新的用户→项目锁顺序一致，重查主策略官任职。负责人更新、管理主线与补招轮次交接、统一卡片仲裁及PENDING outbox同事务，任一步失败全部回滚。原负责人失去该身份的轮次取消，新负责人相应轮次打开；主策略官仍有原资格，不将交接视为完成招募。重复指定不重复打开已有轮次，但仍记录待投递事件。项目节点、版本和表单不变，后续节点不回退。旧策略官关系被替换后，旧会话即时失去操作权限。

13第十九批已接真实补招来源、补招轮次交接及统一卡片仲裁：变更后恢复各视角真实优先级来源，清理失权卡片，原事件携带cardChangedRecipients。重复指定没有可见变化时卡片受众为空；独立领域轮次保留。新增3项数据库集成待专用_test库复验，670单测、类型/静态/build已通过。实际通知投递归14，PENDING不代表已通知。本段只说明056/057职责；060负责追加待接单分配，07负责执行专家接单待办写流程。

## 验证与本机复验

用户2026-10-22于17:00:34启动的本批2项集成全部通过（182跳过，共184项，总4.07秒，测试1.69秒）。上述权限/候选SQL、并发重复指定/轮次交接/不推进节点、替换失权及outbox故障回滚数据库断言已验证，原连接初始化阻塞解除。不是全184项复跑；无需重复本批2项或053—055前批5项。无新迁移，迁移历史未另查。此次仅同步用户结果，未重跑测试或操作数据库；真实HTTP/部署/完整兼容仍待验收。

本批6项定向单测通过；Swagger漏登两条路径修正后，与文档测试合计9项通过。类型、变更ESLint和后端build通过。最终全量402项单测通过（36文件，16:54:21，总14.02秒）。

复测前历史：新增2项数据库集成覆盖当前PM权限/候选SQL、并发重复指定/轮次唯一/不推进节点、替换后失权及outbox故障整事务回滚。Agent运行时均停在beforeEach，127.0.0.1:5432不可达，182跳过，共184项，未执行业务断言。首次命令多传`--`误触全184项，亦全部在初始化失败，不撤销前批通过证据。未应用迁移或操作开发/部署库，无新schema/依赖；真实HTTP/部署/完整兼容待验收。

以下命令仅供后续需要复验时使用，当前无需重跑。在tyde目录运行（仅`.env.test`专用且库名以`_test`结尾的数据库，会清表）：

```sh
pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t '^recruitment handler '
```

第三批历史续做位置为058—060；当前058—060已接入，先复验下方第四批4项集成。无需新增迁移或重做前批7项。唯一逐接口状态和验收记录见[06任务](../../backend-migration/06-training-recruitment/todoTask.md)。

## API-058—060（2026-10-22第四批，优先于上方未接入历史）

三个入口均已接入，保留已实现待验收。仅当前PM会话且为本项目最新ASSIGNED主策略官或招募环节负责人可操作；创建人、无关账号、被替换策略官及随旧任职失效的负责人403，逻辑删除/不存在项目404。节点仅展示，不作为操作门槛；包括已进入后续节点的继续招募。

- `GET /projects/expert-recruitments/detail?projectId=3001`：返回项目量级/单位/共享节点、primaryManager、handler、currentOperatorRole、canChangeHandler和summary。兼任优先PRIMARY_MANAGER，只有主策略官可更换负责人。待接单+已接单计入有效数及已分配量级；拒单只计历史数；剩余量级最低0，项目量级缺失按0，旧分配量级缺失不计入。Decimal汇总后转JSON数值，不串接浮点求和。
- `GET /projects/expert-recruitments/candidates?projectId=3001&subjectType=ORGANIZATION&current=1&size=20`：subjectType可省略同时查询INDIVIDUAL与ORGANIZATION；keyword最多100字符，trim后按姓名/昵称/组织名称/UID字面子串匹配，空白不筛选。current默认1，size默认20、最大100。数据库筛选、排序、计数与分页，返回records/total/current/size/pages，无结果或越界records为空。
- `POST /projects/expert-recruitments/submit`：追加1—100项，成功data固定null。字段及完整示例见下；批量全成或全败，不更新或删除历史分配。

候选与提交复查共用同一资格SQL。统一ACTIVE账号可作为个人（不查旧User.role/accountType/organizationId）；存在PENDING_ACTIVATION组织关系的导入用户不可个人接单。有效组织必须ACTIVE且未删除，并有ACTIVE账号的有效OWNER（ACTIVE/EXIT_APPROVING/PENDING_LEAVE）。同一账号可同时以个人和多个主管组织出现，主体由subjectType+subjectId明确指定。项目创建人、主策略官、招募负责人及他们担任有效主管的组织均排除；不把普通成员关系当主管资格。多主管异常历史数据选择最早有效主管展示，但排除检查覆盖全部有效主管。组织关键词可匹配任一有效正常主管的UID。

有分配的候选置顶，再按组织优先、主体UUID升序；分配取当前项目最大ID。未招募availableAction=RECRUIT，最近分配已拒绝=RECRUIT_AGAIN，待接单/已接单/已更换REPLACED=NONE。写前重新查全部有效分配，候选动作不是授权。历史拒单已被其他主体补招后，原主体仍可普通追加，但不能再次消费相同来源。

```json
{
  "projectId": 3001,
  "assignments": [
    {
      "subjectType": "ORGANIZATION",
      "subjectId": "00000000-0000-4000-8000-000000000004",
      "productionRequirement": 100.1234,
      "operatorHeadcount": 10,
      "inspectorHeadcount": 2,
      "sourceRejectedAssignmentId": 12
    }
  ]
}
```

subjectId为新库用户/组织UUID；projectId和拒单来源为32位正整数，新旧ID不互通。productionRequirement至少0.0001，最多16位整数及4位小数；operatorHeadcount必填正整数，inspectorHeadcount缺省/null表示无需质检，填写须正整数。沿旧实现不增加项目总量上限，可超量分配，详情剩余量级钳制为0。来源可省略/null表示普通追加；补招来源必须为本项目尚无replacement的REJECTED分配，可更换主体，只通过previousAssignmentId追溯。无效资格/重复同批主体/重复来源/非本项目或已消费来源400；同主体已有PENDING_ACCEPTANCE或ACCEPTED返回409。

提交锁真实用户、组织及组织关系，再锁项目，锁后重查任职、资格、来源与有效分配；同项目并发重复下发仅一方成功。追加PENDING_ACCEPTANCE事实，不生成已接单/负责人/入项/考试/培训完成数据。首次按旧生命周期单向补进PERSONNEL_MANAGEMENT；后续节点不回退，不递增versionNo。分配、节点、管理主线/本域EXPERT_RECRUITMENT_RETRY轮次、拒单快照修复和EXPERT_ASSIGNMENTS_CREATED outbox同事务，失败整体回滚。拒单待办只归当前独立负责人，否则主策略官；仅消费的来源消失，其他未处理拒单保留。快照只修本域，不覆盖其他领域支线；完整竞争/卡片重算仍归04，任职变更的跨领域支线交接亦归04。

outbox仅持久化assignmentIds、项目及管理任务受众，保持PENDING；14负责按真实个人/组织主管解析通知并实际投递，不能把PENDING视为通知成功。07继续接单写入口与执行专家待办轮次，08继续考试闭环，01/07/08继续文件及培训权限联调。本批未调用任何真实业务Agent。

实现入口：project-recruitment.service.ts、project-recruitment-candidates.ts、project-recruitment-snapshot.ts及project-recruitment.schema.ts，由现有项目路由/application装配，无新依赖、schema或迁移。Swagger覆盖中文嵌套字段、枚举、空值及完整请求/响应示例，实际Fastify注入验证响应序列化。

本批新增4项集成首次运行于17:13:17，4失败、184跳过（共188项，总5.73秒），全部在beforeEach因127.0.0.1:5432不可达，业务断言未执行；不能据此宣称SQL/并发/事务已验收，不撤销前批7项通过证据。未应用迁移或操作开发/部署库。保持06，先在本机tyde目录仅复验下列4项（命令只连接允许清表的.env.test专用_test库，会清表；无需新增迁移）：

```sh
pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t '^expert recruitment '
```

覆盖真实统一候选/多组织/待激活/关键词/分页/权限、并发重复/下发/汇总/节点/任职失效、拒单跨项目/单次消费/历史/轮次/快照及批量失败/outbox故障回滚。真实HTTP、OSS、部署与完整兼容仍待验收，下一步以[06唯一任务记录](../../backend-migration/06-training-recruitment/todoTask.md)为准。

本批最终验证：413项单测全部通过（37文件，17:17:16，总11.64秒），含11项新增招募单测；服务端类型、变更ESLint及后端build通过。此前412项全过为补充快照用例前记录；数据库4项仍待上述本机复验。

## 2026-10-22分页修复（最新）

用户17:23:41复验本批4项，3通过、1失败（184跳过，共188项，总13.39秒，测试2.61秒）。并发下发/节点/失权、拒单来源/轮次/快照及批量/outbox回滚通过，本机初始化阻塞解除；候选显式分页请求被400拒绝。根因是全局关闭自动类型转换，原current/size误声明integer。现按URL十进制文本接收，在路由显式转换：current为32位正整数、size为1—100，缺省1/20；权限及候选SQL不变，Swagger查询示例同步为文本。补有效分页HTTP回归及错误边界，集成失败时直接展示状态码/响应体。

14项定向单测（17:25:15，总2.55秒）及服务端类型/变更ESLint/后端build通过，前批413单测证据保留。Agent17:25:08仅复验该1项仍停在beforeEach初始化不可达（187跳过，共188项，总2.68秒），修复后数据库断言尚未执行。保持06，无新迁移，不重复已过3项及前批7项；在tyde目录仅复验以下1项（仅.env.test允许清表的专用_test库，会清表）：

```sh
pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t '^expert recruitment candidates '
```
