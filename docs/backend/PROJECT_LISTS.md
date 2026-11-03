# 项目待办卡片列表

> 本页保留接口契约与历史验证记录。带日期的批次状态、迁移/复验命令和“保持/下次/待复验”安排仅供追溯；当前续做以根目录 [AGENTS.md](../../AGENTS.md) 的最新记录为准。`backend-migration/` 为未随本仓库保存的历史外部任务目录。

> 2026-10-22现行规则：两列表分别要求服务端当前NAVIGATOR/PM角色及创建人/生效任职，独立授权表不再参与；快照与任务受众继续按用户+项目+角色区分，当前会话切换不改其他会话或历史任务身份。详见[统一账号与组织创建](UNIFIED_ACCOUNTS.md)。本轮证据见插队任务（历史外部记录 `backend-migration/priority-unified-accounts/todoTask.md`）。

API-031 `GET /api/v1/projects/list`、API-034 `GET /api/v1/projects/manager/list`已接入代码。无请求参数、无请求体、不分页；按项目updatedAt降序、id降序。它们是当前用户需要处理的待办卡片，不是全部可见项目清单，列表为空不撤销详情权限。统一账号自带三角色，两个入口分别要求服务端当前NAVIGATOR/PM会话及对应真实项目关系，不读取历史独立授权表，不信任User.role或客户端角色声明。

既有286项单测通过；用户2026-10-21 11:04:49回传130项集成全部通过（1文件，总62.15秒，测试51.94秒），第14迁移`20261021000000_project_cards`所需专用库结构及本批列表/来源基础已验证，原数据库阻塞解除；迁移历史未另查。04基础已交接05，本次未实现05。两接口保留部分迁移：列表读取与来源基础已接入，支线真值重算/修复、考试配置及接单写流程仍按05/07/10—14继续接入，不将表存在或单测通过当成业务写流程已迁移。

## 可见规则

只查询未删除PUBLISHED项目。领航员范围为本人createdBy，仅读取本人NAVIGATOR支线；仅RECRUIT_PROJECT_MANAGER主节点或本人支线时推送。策略官范围为本人当前ASSIGNED主策略官/招募协作负责人；同一人兼任时主策略官视角优先，支线固定按本用户+项目+视角读取。

主策略官在PRODUCTION_PLAN、ENTRANCE_EXAM、STANDARD_TRAINING、RECRUIT_EXECUTION_EXPERT四个主节点，或本人PROJECT_MANAGER支线时接收卡片。协作负责人仅在RECRUIT_EXECUTION_EXPERT或EXPERT_RECRUITMENT_RETRY支线接收卡片；其他视角/其他用户快照不生效。COMPLETED是硬终态，存在陈旧支线也隐藏。已替换任职的历史快照不会授予范围；当前角色或任职不符时下一请求403。EXPERT会话不因项目成员或组织身份获得管理列表。

currentNodeCode始终为项目公共主线；历史null在读取时回退“有当前策略官=PRODUCTION_PLAN，无策略官=RECRUIT_PROJECT_MANAGER”，不写回数据库。branchNodeCode单独返回，不覆盖主线。招募节点显示PENDING/待处理/招募策略官；后续显示PROCESSING/处理中/查看项目详情，协作负责人仅查看。NAV省略primaryProjectManager/expertRecruitmentHandler，PM返回两个实际关系布尔值。

## 聚合与旧查询口径

列表在RepeatableRead内校验当前会话角色，并读取主数据与关联。候选卡片一次SQL联查，过滤后只对可见项目批量查询分类与负责人，没有逐项目用户/统计查询。来源失败向外抛错，不吞错返回空数组或默认展示字段。

- 分类按级别/sortNo/id读取名称快照，三级保持选择顺序；展示三级用顿号连接，回退二级/一级/未分类项目。字典改名不改变快照。个人需求方及创建人/策略官/负责人展示名称实时回填，组织需求方保留快照；停用用户仍按旧SQL显示，不据展示字段授予操作权。
- activeExpertCount沿旧SQL实际COUNT(*)，统计全部ACTIVE项目成员记录，不按用户去重，也不区分projectRole。与旧DTO“普通成员数量”文案不同，仍以SQL为准；策略官任职不写成员表，不能据此计为执行专家。
- projectOwners从ORGANIZATION且ACCEPTED的接单中读取ACTIVE负责人关系。仅某assignment完全没有任何负责人关系行时回退其旧projectOwnerUserId；即使只有REMOVED行也阻止回退。只返回userId/name/avatarUrl，不返回assignmentId。沿旧SQL UNION ALL保留跨assignment重复项，按projectId/userId排序；与旧DTO“按用户去重”文案差异待兼容验收，不擅自加DISTINCT。组织主管本身不自动成为负责人。
- NAV的needAssistGrading为“未删除ACTIVE考试当前版本的MANUAL轮次reviewersJson包含本人userId”。不要求仍有待阅卷记录，也不据此单独推送卡片；需要相关支线快照才能在后续主节点重新推送。PM查询旧SQL没有赋值，沿旧布尔默认false。

## 来源模型和回补

以下为第14迁移时的历史接入范围；后续考试、接单、成员和统一卡片写入口已在对应模块接入，不据本节旧状态安排开发或重跑迁移。

第14迁移新增ProjectRoleNodeSnapshot、ProjectExpertAssignment、ProjectExpertAssignmentOwner、ProjectEntranceExam、EntranceExamGradingRound。新用户/组织为UUID，项目/来源主键为Int；日期时间为Timestamptz、响应上海yyyy-MM-dd HH:mm:ss。快照按projectId/userId/perspective唯一，来源业务ID/时间/优先级与calculatedAt保留，但列表不自行重算、删除陈旧行或发送事件。

上述来源表仅准备读取及持久化基础，本批无写HTTP或造数命令，不自动创建接单、考试、负责人或支线。旧支线刷新器有“候选竞争、判定失败保留原快照、独立事务写入、修复调度”等完整语义，随真实业务来源05—13接入，14接实际通知投递；不能以空解析器删除已有快照。无来源行时返回真实查询空值，与来源查询失败严格区分。

ProjectMember.expertAssignmentId和previousAssignmentId本批补Restrict外键，不改已应用的第13迁移。旧已有悬空来源ID会由数据库拒绝新外键，迁移不伪造或删除来源数据。考试currentVersionId/轮次examVersionId尚待05配置版本表补外键；成员admissionAttemptId仍待08。ProjectExpertAssignment完整接单/替换/容量/组织一致性、负责人任命/离组撤销归07；表可查询不代表这些写流程或授权已经接入。

API-011专家/考试文件授权仍待完整ACCEPTED接单、笔试/准入及组织负责人规则，不因本批接单表存在而放宽。03清退仍需07负责人撤销、12变动终止及14事件，PENDING补偿不标完成；成员写流程继续07/08/10。15物理删除须处理新增Restrict外键和历史保留。

## 验证与续做

本批8项单测覆盖可见性矩阵、空节点/角色范围、参数绑定、聚合与字段裁剪、来源失败传播、完整Swagger示例和实际HTTP。全量286项通过；新增8项集成（总130）覆盖NAV/PM主支线与视角、结项硬终态、快照/实时名/数量/排序、负责人历史回退、阅卷当前版本和授权撤销。Agent 10:49:58运行130项在beforeEach全部P1001（总2.43秒），未进入业务；用户随后回传2026-10-21 11:04:49运行130项全部通过（总62.15秒，测试51.94秒），新增8项数据库业务已验证，第14所需结构就绪，原P1001阻塞解除。本次Agent仅记录用户结果，未重跑、未应用迁移或查询迁移历史。阅卷配置轮次尚无来源外键，测试beforeEach显式清理该表，避免跨用例残留。开发/部署及兼容验收未执行。

专用_test库已通过130项集成；以下保留迁移及复验命令，从tyde/执行：

```sh
cd apps/server
node --env-file=.env.test node_modules/prisma/build/index.js migrate deploy
cd ../..
pnpm test:integration
```

130项集成已通过，基础交接条件已满足，默认入口切到05；本次仅同步文档并停止，未实现05。04全部11个HTTP入口已有代码，API-031/033/034/037部分迁移状态保持，剩余支线、来源写流程、清退、权限和投递按05/07/08/10—15回补，不因这些已归属的后续事项重复执行04。开发/部署、真实联调及兼容验收仍待完成。详细逐接口状态与证据以04记录（历史外部记录 `backend-migration/04-project-foundation/todoTask.md`）为准，续做从05任务（历史外部记录 `backend-migration/05-exam-management/todoTask.md`）开始。
