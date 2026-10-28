# 准入考试配置与导入基础

2026-10-22第六批：API-049人工提交主链路已接入，保留部分迁移；367项单测、类型/ESLint/后端build通过。用户2026-10-22回传15:37:53定向集成5项全部通过（1文件，166跳过，总13.17秒，测试4.10秒），本批人工提交并发、轮次推进/裁决、准入成员、逐题来源与事务回滚数据库断言已验证，原初始化连接阻塞解除；本次不是全171项复跑，迁移历史未另查，本批无新迁移。无新迁移，不重做040/048。当前保持05，直接续做050—052，不重复本批5项。下一AUTO仅持久化mock待派发事实，不代表执行；跨领域卡片重算、转项消费、实际投递仍待原归属回补。

2026-10-22用户明确约定：所有业务Agent相关功能先使用mock，不连接真实Agent服务、不进行真实Agent联调。后续自动阅卷派发/执行/回调先由可控mock覆盖成功、失败和重试等场景，Swagger及验收记录明确模拟来源；业务权限、逐题来源、事务/轮次、专用HMAC、时间/重放/幂等仍须按本地接口验证。此约定不表示未开发接口已有实现，不将预置读取夹具当成真实交卷或阅卷执行。

当前040/048本批168项真实HTTP记录全部通过（16种方法/路径），非空读取/历史版本/组织范围与权限回收均已验证；开发库20迁移已由用户成功应用并经本批用户夹具核对，部署库另行验证。详见[读取验收记录](EXAM_READ_ACCEPTANCE.md)。

2026-10-22最新05第五批：API-048 POST /entrance-exams/grading/detail已接入，按当前PM任职或NAVIGATOR历史人工阅卷资格读取考生绑定版本/试卷、真实答案及所选轮次逐题判定，允许CLOSED考试。353项单测（32文件，13:05:26启动，总9.92秒）、类型/ESLint/后端build通过。新增第20迁移20261022010000_entrance_exam_grading_details（答案/逐题判卷及来源外键），Agent未应用迁移；用户2026-10-22回传13:16:29定向集成3项全部通过（1文件，163跳过，总4.64秒，测试2.24秒），第20迁移所需专用库结构、真实阅卷详情及逐题来源约束/删除保护均已验证，原RESTRICT错误类型断言阻塞解除；本次不是全166项复跑，迁移历史未另查，无需当前专用库再次迁移20。040前批2项集成全过仍有效。保持05，下一批049—052，不执行06；以下第四批及插队交接为历史。

2026-10-22第四批：新增API-040准入情况查询；348项单测、类型/ESLint/后端build通过，用户12:01:20启动的本批2项数据库集成全部通过（161跳过，总5.71秒），原连接阻塞解除，无新增迁移。当前续做048—052；以下此前“准入情况待实现”仅为历史。

> 2026-10-22现行规则：已开发考试接口改用当前PM或NAVIGATOR会话角色+项目/历史人工轮次资格，不读独立授权。MANUAL配置阅卷人必须ACTIVE，自带三角色，不要求独立授予；当前角色和实际阅卷提交资格须分别校验。统一账号插队批次未新增040/048—052；第四/五批已接入040和048，049人工主链路已接入（部分迁移），050—052仍未实现，回调仍须专用HMAC。详见[统一账号与组织创建](UNIFIED_ACCOUNTS.md)。本轮证据见[插队任务](../../backend-migration/priority-unified-accounts/todoTask.md)。

2026-10-21第三批：新增编辑配置详情、管理页、关闭和花名册；逐轮成绩模型及第18迁移已准备。339单测为前批通过证据；用户2026-10-22复跑162项集成全过，第18所需专用库结构已验证、历史未另查，原缺表阻塞解除。当前保持05，下次从准入情况及阅卷继续；远程文档/XLS内嵌图片、准入情况及阅卷写链路仍待实现。逐接口状态和证据唯一维护在[05任务记录](../../backend-migration/05-exam-management/todoTask.md)。

## HTTP契约

所有入口均需有效会话。模板要求当前PM角色；导入、发布、编辑、关闭还须已发布项目的当前生效主策略官，招募协作负责人不能写。详情、管理页、花名册及阅卷详情允许当前PM主策略官/协作负责人，或当前NAVIGATOR且在该项目任一未删除考试的历史MANUAL轮次中；历史版本和已关闭考试人工池仍参与只读判定。NAV仅为需求方/创建人不等于阅卷资格，角色本身不授予项目权限。API-040另允许EXPERT已接单组织的主管/有效项目负责人查授权组织，见下文。统一注册自带NAVIGATOR/PM/EXPERT，登录默认EXPERT，当前会话单角色，不读取客户端角色声明或独立管理授权。Web使用Cookie并校验来源，桌面及普通API客户端使用Bearer，不混用。全部响应no-store。

| 方法与路径（统一加`/api/v1`）         | 参数与行为                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /entrance-exams/import/template` | 必填query `type=EXCEL\|TXT\|REDOC`；返回XLSX、UTF-8制表文本、XML字节，无Result包装；文件名`entrance-exam-import-v1.xlsx/txt/xml`，无需projectId。   |
| `POST /entrance-exams/import/parse`   | multipart；必填projectId可用query或表单，同名冲突拒绝。file与非空redocUrl二选一。attachmentRefs为可选JSON数组part，每项name/objectKey/uploadToken。 |
| `GET /entrance-exams/reviewers`       | query projectId为32位正整数；keyword可选，按姓名/昵称/UID去空白后不分大小写包含匹配，不解释通配符。                                                 |
| `POST /entrance-exams/publish`        | JSON完整配置，不保存草稿；确认生产计划且needWrittenExam=true，ACTIVE数不超过maxActiveExamCount（原默认1）。发布V1。                                 |
| `PUT /entrance-exams/edit`            | JSON完整配置加examId和expectedCurrentVersionId；ACTIVE考试，预期版本一致才新增下一版本并原子切换。                                                  |
| `POST /entrance-exams/detail`         | JSON projectId/examId；仅ACTIVE考试，读取当前版本全部试卷/题目/轮次，不混入旧版。CLOSED返回400，当前版本异常500。                                   |
| `GET /entrance-exams/management`      | query projectId，返回未删除考试卡片、已交卷统计及生产计划上限下的操作按钮。                                                                         |
| `POST /entrance-exams/close`          | JSON projectId/examId，可选closeReason最多500字符；重复/并发关闭409。                                                                               |
| `POST /entrance-exams/roster`         | JSON projectId/examId，可选keyword/finalResult/current/size；读取真实应试和逐轮成绩，不创建任务。                                                   |
| `POST /entrance-exams/grading/detail` | JSON projectId/examId/attemptId，可选roundNo省略/null取1；读取实际绑定试卷及所选轮次逐题判卷。                                                      |

候选范围固定为项目需求方、当前策略官本人，保持顺序并去重，只返回ACTIVE账号，最多两项。`{userId,uid,name,avatarUrl}`不含手机号；userId为新库UUID，不能混用旧数值ID。name缺失时逐级回退，avatarUrl未设为null。保存MANUAL阅卷配置沿旧服务规则，允许配置状态有效且有独立NAVIGATOR或PM授权的其他用户，不限候选两人；保存为发布时的userId/uid/name快照。这不表示普通登录即可手动提交阅卷。

## 文件解析

支持XLS/XLSX与UTF-8 TXT：固定模板、简化表头别名、逐题文本、多卷、尾部题目分值/选必答标签、行内或独立参考答案；支持分钟/小时和上海截止日期（纯日期补23:59:59）。文字转义为HTML并以`<br/>`保留换行。题干和答案各需文字或附件至少一项。全部手动题分值且各卷合计相同时，合计覆盖导入满分；否则保留原配置满分，缺失为null，发布时再完整校验。未导入的裁决规则为null，gradingRounds为空数组，需补充后保存。

XLSX支持单元格锚定内嵌图片，绑定到实际题干/答案或对应附件列。先完成格式、图片类型与全部引用凭证预检，再预上传图片。XLS的空绘图容器不视为图片，实际OfficeArt图片/旧式对象明确400，提示另存为XLSX；不静默丢弃。外部图片关系、公式和合并单元格拒绝。远程文档服务未配置，redocUrl分支503且不访问输入URL；XML模板下载不等于远程读取能力。

边界：来源10MiB，TXT及累计题目文字100万字符；XLSX在读取前校验ZIP实际解压32MiB、1000条目及CRC；最多20卷×200题，单次100附件、每题每类20个，总附件50MiB。图片单个10MiB。源文件不入库。multipart请求总上限10MiB+256KiB，attachmentRefs字段128KiB；发布/编辑JSON体2MiB。

引用名去首尾空白后唯一，以`|`分隔；附件凭证须本人、ENTRANCE_EXAM_ATTACHMENT、UPLOADED且未过期，同一文件不重复引用。解析不消费token、不创建考试；返回的元数据来自台账。图片预上传失败时此前成功对象按原文件生命周期到期清理，不伪造业务保存成功。

## 发布与编辑事务

完整配置字段为projectId、examName、durationMinutes、registrationDeadline、fullScore、passScore、decisionRule、tieBreakRule、papers、gradingRounds；嵌套请求与完整示例见实际Swagger。时间为上海`yyyy-MM-dd HH:mm:ss`，截止须晚于当前时间，durationMinutes省略/null不限时。分值正数、最多两位小数、上限99999999.99；每卷分值合计必须等于满分，及格线不超满分。AUTO按全卷题数均分并向下取两位，末题承接尾差；MANUAL使用填写值，混合配置也必须精确合计。

轮次最多20：AUTO工具编码/名称必填，不能配阅卷人；MANUAL至少一名有效阅卷人且不能配工具。裁决默认MAJORITY，多数原则偶数轮必须STRICT（从严）或LENIENT（从宽）；MANUAL_PRIORITY至少一手动轮，其他场景平局规则保存null。工具配置递归拒绝secret/password/apikey/accesstoken/token（忽略大小写和下划线/横线），密钥只能放后端受信配置。AUTO本批仅保存非敏感配置/工具附件，不派发、不模拟阅卷。

项目行锁串行化发布和编辑，生产计划锁及ACTIVE上限校验防并发超限，同项目未删除考试名不重复（含已关闭考试）。名称按数据库精确匹配，大小写兼容待验收。重复发布不自动幂等，同名409或数量上限400。编辑校验当前版本，旧版本和已经进入的考生绑定不变；旧预期版本409。

考试、版本、试卷、题目、轮次、附件认领和管理主线待办同事务，失败全部回滚。新增文件用objectKey/uploadToken，编辑保留旧文件用objectKey/uploadedFileId（二者互斥），只允许同考试已认领文件。元数据不信任客户端，存储快照使用uploadedFileId/fileName/objectKey/extension/contentType/fileSize/fileHash，不持久化uploadToken。同版本不重复引用同一文件；旧版本附件不释放。

首次发布单向推进主节点到STANDARD_TRAINING，后续节点不回退；管理主线结算复用现有轮次，不投递实时事件。阅卷支线真值重算/刷新仍待后续阅卷来源，既有快照不会被空解析结果清掉。成功返回`{examId,examNo,projectId,examName,status,currentVersionId,versionNo,publishedAt}`，status固定ACTIVE。

文件API-011已接考试附件管理读取：CLAIMED台账绑定未删除考试/项目；独立PM当前主策略官/协作负责人，或独立NAVIGATOR项目需求方/创建人可读。上传者身份不能替代已认领后的业务授权；未认领仅本人预览。考生与已接单组织职责分支仍待07/08，未接分支403，不凭ACTIVE项目成员放行。

失败沿旧Result `{code:HTTP状态,message:中文原因,data:null}`：400参数/配置不合法或数量达上限；401未登录；403来源/角色/归属不符；404项目/考试不存在；409名称、版本、文件状态冲突；413大小/数量超限；503远程未接入或服务不可用。Swagger包含请求/响应、嵌套中文含义、默认/null/枚举及完整可校验示例。

## 详情、统计、关闭和花名册

详情按当前配置版本的试卷/题号/轮次序号升序返回。题目附件保持原快照字段`uploadedFileId/fileName/objectKey/extension/contentType/fileSize/fileHash`，不改名为保存请求中的size，不注入uploadToken。工具配置复制后拆出顶层files；剩余空对象返回null，非对象历史JSON原样保留。阅卷人仅在响应副本刷新当前显示名，UID/用户ID/未知字段及数据库快照不改。null/格式异常历史JSON保真，不能用空数组隐藏坏数据。

管理卡片按createdAt倒序、同时间按ID倒序，保留CLOSED卡片、排除deleted。examineeCount只计submittedAt非空记录，admittedCount只计其中finalResult=ADMITTED的考试通过记录；不代表已确认入项人数，也不按用户去重。通过率乘100并HALF_UP保留两位小数，无已交卷为0。缺计划时needWrittenExam=false、maxActiveExamCount=1；只有当前PM主策略官且需笔试/未满上限时canCreateExam=true。只读用户固定false，禁用原因沿旧“阅卷人仅可查看考试信息”。截止时间过期不自动关闭考试。

关闭与发布/编辑按项目→考试锁顺序串行化，关闭人/时间/原因及管理主线待办同事务；原因去首尾空白，省略/null/空白存null。并发两次关闭一方200、另一方409，重复409。关闭不删除/释放旧版本、试卷、题目、附件或应试，不回退项目节点、不发送实时事件，编辑详情和保存编辑随后400；管理页和花名册仍可只读。考生进入/交卷仍由08实现，本批不宣称该写流程可用。

花名册默认current=1、size=20，null等同省略；小于1按1，size超过100按100。参数须安全整数，分页偏移溢出返回400，超范围页返回空records并保留total/pages。按应试createdAt倒序、同时间ID倒序。keyword去首尾空白后按应试姓名/UID/组织名快照匹配，保留LIKE的%/_通配语义；展示名取实时用户昵称(姓名)，不改快照。finalResult省略/null不筛选，包含未进入/未交卷记录；非空只查已交卷。未交卷响应finalResult=null，已交卷PENDING=待最终阅卷、ADMITTED=考试通过、ELIMINATED=未通过。

roundScores只返回该应试实际存在的逐轮记录，按gradingRoundId升序，读取考生绑定的版本而非当前版本；无记录为空数组。分数0保留，未出分为null；每轮ADMITTED/ELIMINATED只代表该轮票，不累加成考试结果，也不在读取时重算finalResult。新表缺失会报错，不伪造空成绩。

配置里的NAV阅卷资格不扩大文件代理权限。文件API-011仍按独立PM当前主策略官/协作负责人或独立NAV需求方/创建人；其他配置阅卷人可能可读配置但无附件下载权限，沿旧文件服务边界保留。考生和已接单组织职责仍归07/08。

## 结构、验证和部署

第17迁移已提供配置版本/试卷/题目和考试/轮次/应试来源，所需专用库结构由前批156项全过证实，历史未另查。本批第18迁移`20261021040000_entrance_exam_grading_records`新增逐轮执行/汇总来源：attemptId+gradingRoundId唯一，examVersionId通过复合外键确保应试与轮次同一版本，未进入/未绑定版本不能挂成绩，reviewerUserId引用真实用户。限制状态WAITING/PENDING/PROCESSING/COMPLETED/FAILED、非负分值、轮次结果ADMITTED/ELIMINATED/null。只建结构，不生成阅卷任务或结论；答案/逐题结果/派发/回调后续接入。

第三批339项单测全过（29文件，2026-10-21 17:57:55，总12.51秒），服务端类型和变更ESLint通过。用户2026-10-22 09:16:49复跑162项集成全部通过（1文件，总78.84秒，测试68.19秒），第18迁移所需专用测试库结构、花名册真实逐轮成绩及来源约束已验证，原缺表阻塞解除；迁移历史未另查，开发/部署库仍未验证。第三批新增6项数据库验证已全部通过，包括实际旧版本成绩/筛选及来源唯一键/外键/分值约束。本次仅同步回传结果，未重跑测试或操作数据库；无新增依赖或锁变化。

其他尚未应用迁移的本机专用测试环境，由维护者在tyde执行（当前专用库已就绪，无需重复迁移）：

```sh
node scripts/migrate-test-database.mjs
pnpm test:integration
```

当前专用库第18所需结构已验证；Agent未应用迁移，迁移历史未另查。迁移脚本仅允许`.env.test`指定且允许清空的本机`_test`库，不读取开发连接，本身不清表；集成会清表。开发/部署库另外确认目标后按既有说明应用`pnpm db:deploy`，不要将测试指向开发库。迁移事务失败整批回滚，不清空来源或生成虚假版本。第18只新增空记录表和约束，不回填成绩。

162项全通过后，下一批从040准入情况及048—052阅卷继续。HMAC、时间/重放/结果幂等、失败重试补偿和阅卷支线须沿旧规则单独实现。完整ID/时间/JSON/排序/大小写/模板样式兼容及真实外部依赖验收仍保留。

## 项目准入情况（API-040）

`GET /api/v1/entrance-exams/admissions?projectId=3001&current=1&size=20`，无请求体。可选`keyword`匹配应试快照的姓名/UID/组织名；可选`admissionStatus`取`PENDING`（待阅卷）、`PENDING_ENTRY`（考试通过待准入）、`ADMITTED`（实际已入项）、`ENTRY_DECLINED`（已放弃入项）、`ELIMINATED`（淘汰）。页码从1开始、页大小1—100，省略分别为1和20；越界返回400。响应为Result包装的`current/size/total/pages/records`，详见Swagger完整个人/组织示例。

当前PM须为项目生效主策略官或招募协作负责人，NAVIGATOR须为历史人工轮次配置阅卷人；EXPERT须管理本项目已ACCEPTED接单的组织，只能查这些组织的记录。主管关系允许ACTIVE/EXIT_APPROVING/PENDING_LEAVE；普通成员或只有个人应试资格不允许。项目负责人表存在任何历史记录时不再回退旧负责人字段；角色和组织身份本身不能取代已接单项目范围。

仅返回未删除考试的已交卷记录，包含关闭考试，跨考试按交卷时间/ID倒序。考试名取实际应试版本，姓名取实时用户资料，组织名仍为应试快照；人员属性取应试绑定组织成员关系。待阅卷/淘汰结果优先于入项事实，考试通过后以拒绝状态优先、joinedAt非空判实际入项；后来离项仍有joinedAt时沿旧SQL显示已准入。过滤、计数及分页在同一RepeatableRead只读事务完成，不修改准入结论或创建阅卷任务。

本批没有迁移或外部依赖。用户12:01:20启动的新增2项数据库验证已全部通过（161项跳过，总5.71秒）；本批独立真实HTTP已通过，部署及完整大小写兼容仍待验收；本机专用库复跑方式、逐接口状态和下一批阅卷边界以[05任务记录](../../backend-migration/05-exam-management/todoTask.md)为准。

## 考生阅卷详情（API-048）

`POST /api/v1/entrance-exams/grading/detail`，完整请求示例：

```json
{ "projectId": 3001, "examId": 5001, "attemptId": 11001, "roundNo": 1 }
```

当前PM主策略官/协作负责人或项目历史人工阅卷池中的当前NAVIGATOR可读，EXPERT不能凭本人应试或组织管理身份读取。允许CLOSED考试。绑定版本和试卷缺失表示尚未进入，返回400；应试/考试归属错404，轮次不存在400，绑定配置损坏500。未交卷亦可读，整体finalResult返回存储值，不置null。

响应包含考生显示资料、绑定版本的passScore、gradingStatus/finalResult、全部rounds、selectedRound和questions。rounds按序返回真实配置，缺执行记录时gradingRecordId/status/score/roundResult/conclusionSummary/errorMessage均null；不自动创建记录。questions仅实际分配试卷，带题干/参考答案及附件、考生答案及附件、answeredFlag、所选轮次correctness/gradingOpinion；缺答案为null/false，缺逐题记录correctness=null，与有记录但待判的PENDING区分。0分保留，快照未知字段保留，读取不改变考试/答卷/记录。中文字段和完整响应示例见Swagger。

第20迁移`20261022010000_entrance_exam_grading_details`新增答案和逐题判卷空表及来源约束：Answer必须提供实际绑定paperId；Item必须提供与record/answer一致的attemptId和questionId；唯一键阻止重复答案/同轮逐题项，RESTRICT保护来源，correctness仅PENDING/CORRECT/INCORRECT。此处是内部持久化字段，不添加到现有HTTP请求。后续08交卷须同时遵守这些约束，049—052处理真实逐题任务；当前未开放这些写入口。

Agent未应用迁移；用户13:16:29复跑新增3项数据库验证全部通过（163跳过，总4.64秒，测试2.24秒），原RESTRICT断言已修正并验证具体外键与删除后完整事实不变。当前专用库第20所需结构及来源/删除保护已验证，迁移历史未另查，无需再次迁移或重复本批验收。以下为需要时复查命令（在`tyde/`）：

```sh
pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t 'grading detail'
# 若需全量回归（当前166项）：pnpm test:integration
```

其他尚未迁移的测试环境使用`pnpm db:deploy:test`，迁移只读取受保护的`.env.test`专用_test库且不清库；集成测试会清空专用测试数据。开发/部署库另行核对目标后按部署说明迁移；第18/19及040此前通过证据保持。答案附件只返回快照，文件代理另行校验已有业务资格，本批不扩大下载范围。040/048本批真实HTTP已通过；本轮未新增OSS文件或扩展下载资格，部署及完整兼容仍待验收。

## 人工阅卷提交（API-049，第六批）

`POST /api/v1/entrance-exams/grading/manual` 保持旧字段：projectId、examId、attemptId、gradingRecordId、可选conclusionSummary（最多5000字）及items（1—500项questionId、correctness、可选gradingOpinion）。correctness只能CORRECT/INCORRECT；意见最多5000字，空白转null。Swagger包含递归中文字段说明及完整可校验示例。

有效登录三角色账号均需在该应试绑定版本的本轮MANUAL池内，EXPERT也不因当前角色被额外阻止；项目PM/协作负责人/详情读取权限本身不授予提交资格。已关闭考试和历史版本可提交。应试须已交卷且前面每轮COMPLETED；本轮只允许PENDING/PROCESSING，COMPLETED重复409，其他状态400。考试/应试/记录错误归属404，无本轮资格403。

同事务按项目→应试→判卷记录锁定，完整核对实际paper、全部题目及答案/逐题来源；Decimal仅累加CORRECT题分数，与绑定版本passScore比较。不会补造缺失答案/逐题任务。一次锁定本轮，只激活紧接下一轮WAITING；全部轮次完成才按绑定版本MAJORITY/MANUAL_PRIORITY及平票规则裁决，记录票数解释。人工优先也须等AUTO完成，不把不同轮次分数相加。成功响应返回attemptId、gradingRecordId、recordStatus、score、roundResult、gradingStatus、finalResult。

普通EXPERT_ORDER准入后重查实际接单与考生归属，有效接单创建唯一admissionAttemptId的PENDING_CONFIRM成员（joinedAt=null）；失效接单保留考试结论但不创建席位；来源缺失或错配整事务回滚。转项来源仅记录EXAM_RESULT_DECIDED事实，不创建普通待入项成员，审批消费归12。阅卷待办轮次及本域快照同步；保留其他领域已有快照，跨领域完整优先级选择仍待04回补。

下一轮AUTO只写PENDING及ProjectEventOutbox中的EXAM_AUTO_DISPATCH_REQUESTED，payload明确provider=mock、executionStatus=NOT_EXECUTED。第六批当时尚未接入mock执行器和050—052；第七批现已接入显式mock执行及上述入口，详见下方最新契约，仍不调用真实Agent。EXAM_RESULT_DECIDED、EXAM_REVIEW_QUEUE_CHANGED、MEMBER_ENTRY_CONFIRMATION_REQUIRED也仅持久化，实际投递归14；不能作为通知送达/转项审批推进证据。人工链路、这些事实、成员和待办共用事务。

本批新增14项单测，最终367项单测通过（33文件，15:31:18，总11.34秒），类型/变更ESLint/后端build通过。用户2026-10-22回传15:37:53定向集成5项全部通过（1文件，166跳过，总13.17秒，测试4.10秒），本批人工提交并发、轮次推进/裁决、准入成员、逐题来源与事务回滚数据库断言已验证，原初始化连接阻塞解除；本次不是全171项复跑，迁移历史未另查，本批无新迁移。本批已通过，不重复要求验收；本批无新迁移，开发/部署库和真实HTTP写入口仍未验收。逐接口状态与续做以[05任务记录](../../backend-migration/05-exam-management/todoTask.md)为准。

## 自动阅卷、重试与补偿（API-050—052，第七批）

2026-10-22：三个入口及中文Swagger已接入，按本轮约定仅mock；用户16:04:30复跑新增6项数据库验证全部通过（171跳过，总6.63秒，测试4.35秒），第21所需专用库结构具备，迁移历史未另查；不代表真实Agent联调或真实HTTP交卷验收。

| 方法与路径（均加/api/v1）                                | 请求字段                                                                                                                      | 权限与状态                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| POST /entrance-exams/grading/retry                       | projectId/examId/gradingRecordId                                                                                              | 当前PM生效主策略官；已交卷AUTO、前轮全部完成且FAILED |
| POST /entrance-exams/grading/auto/compensate             | projectId/examId/gradingRecordId/items/summary?/compensationReason?                                                           | 当前PM生效主策略官；FAILED或COMPLETED的AUTO          |
| POST /integrations/agents/entrance-exam-grading/callback | projectId/attemptId/examVersionId/paperId/roundNo/gradingRecordId/toolTraceId/status/items?/summary?/errorCode?/errorMessage? | 专用HMAC；首次必须PROCESSING当前trace                |

前两项旧Controller虽允许PM/NAVIGATOR，旧服务实际要求当前PM主策略官，新实现沿此规则。NAV人工池、EXPERT或招募协作负责人不能重试/补偿。允许CLOSED和历史版本，试卷/准入线始终取应试绑定版本。

重试清空trace、回调摘要、逐题临时结果、执行汇总/时间/错误，回到PENDING并消解失败待办；mock下一次领取生成新trace，迟到回调409。补偿完整覆盖实际试卷，所有分数与轮次投票由服务器计算；FAILED补偿才开放下一轮，COMPLETED修正不重复激活。清trace使旧回调失效；反转最终结论时拒绝转项结果及已入项成员，只撤销同应试未入项PENDING_CONFIRM成员。补偿原因写审计事实，所有写入失败整事务回滚。

回调使用`X-Agent-Timestamp`（Unix秒）和`X-Agent-Signature`（Base64），专用`AUTO_GRADING_HMAC_SECRET`至少32随机字符且独立于认证密钥；缺配置503。规范串为以下四行，无末尾换行：

```text
POST
/api/v1/integrations/agents/entrance-exam-grading/callback
<timestamp>
<Base64(SHA256(原始UTF-8请求体字节))>
```

签名为`Base64(HMAC-SHA256(secret, 规范串))`。先验原始体，再解析JSON；时间差绝对值超过300秒拒绝401。成功status=SUCCEEDED须完整items(questionId/correctness/gradingOpinion?)，正确计该题全分、错误计0；FAILED须省略items或null，不计票、不激活下一轮。数据库逐项核对项目、应试、绑定版本/试卷、自动轮/前轮与trace。相同trace的规范化内容摘要落库，同内容重放无写副作用，变化内容409；重试或补偿后旧trace拒绝。Cookie/Bearer不代替HMAC。

mock命令与本地后端必须使用相同数据库和专用密钥；它只处理指定真实PENDING自动记录，不创建答卷或伪造交卷。命令在`tyde/`执行，先确认已迁移及目标环境：

```sh
pnpm --filter @tyde/server exam-auto:mock <recordId> correct
pnpm --filter @tyde/server exam-auto:mock <recordId> incorrect
pnpm --filter @tyde/server exam-auto:mock <recordId> failed
pnpm --filter @tyde/server exam-auto:mock <recordId> timeout
pnpm --filter @tyde/server exam-auto:mock expire expire
```

correct/incorrect是可控全题正确/错误判定，不分析真实答案内容；逐题意见、总结明确标注模拟来源。failed投递签名失败回调，timeout只领取不回调；expire扫描最多100条超过60分钟的PROCESSING，按当前trace标FAILED。成功/失败回调由CLI仅投递本地`127.0.0.1:PORT`，拒绝重定向，15秒传输超时；接收成功但响应丢失时不覆盖已完成结果。再次执行同一非PENDING记录不会重复领取，失败后通过050重新入队。没有后台扫描/定时任务，不消费通用outbox的实际通知，事件仍非送达证据。

第21迁移`20261022020000_auto_grading_callback_digest`仅增加摘要列/格式约束，Agent未应用；用户本批6项已通过，无需当前专用库重复迁移，以下仅供复查：

```sh
pnpm db:deploy:test
pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t 'auto grading'
```

第一条不清库，第二条会清空专用`_test`库，177项中只跑本批6项。15:48:06本轮尝试全部停在初始化连接127.0.0.1:5432，未进入业务断言；前批049的5项通过仍有效，不重跑。382项单测、类型/变更ESLint/后端build已通过；真实HTTP写链路/部署未验收；本批6项后续已通过，05基础交接06，跨领域卡片重算/转项审批/实际投递仍归04/12/14，08交卷另归原任务，不接真实Agent。

2026-10-22第七批最新复验与交接：用户2026-10-22回传16:04:30启动的本批6项集成全部通过（1文件，171跳过，共177项，总6.63秒，测试4.35秒）；并发领取、签名HTTP回调/幂等、失败重试/旧trace拒绝、补偿及不可逆反转回滚、权限/逐题来源、超时和outbox故障整事务回滚已验证。第21迁移所需专用测试库结构已具备，迁移历史未另查；不是全177项复跑。原127.0.0.1:5432初始化连接阻塞解除，无需当前专用库再次迁移21或重复本批6项。 382项单测等仍为前批通过证据，本轮仅文档同步，未重跑或操作数据库。05基础已交接06，本轮未实施06；真实HTTP写链路/部署/完整兼容继续本任务，原接口状态保留，Agent继续mock。

## 13第十八批考试写入口卡片仲裁（2026-10-27）

2026-10-27最新13第十八批集成通过：考试发布/编辑/关闭在配置、主节点和管理轮次完成后，入场在应试绑定和来源关联完成后，同事务执行统一卡片仲裁，保持原静默语义。17:41:39全量668单测通过（69文件，总51.98秒，测试42.99秒，maxWorkers=2）；37定向、类型/变更ESLint/Prettier及后端build通过。17:41:41仅定向exam lifecycle card writes为6通过/1失败/319跳过（共326项，总15.95秒，测试9.63秒），唯一失败是入场故障注入仅拦截deleteMany而实际走upsert；补齐测试注入后17:42:22仅复验失败项通过（325跳过，共326项，总6.42秒，测试1.73秒）。本批7项集成分批全部通过，不是全326项复跑，不重复本批及前十七批，不重迁移29。无HTTP/schema/迁移/依赖变更，未操作开发/部署库或应用迁移，迁移历史未另查。保持13，下次直接招募协作负责人及其余写入口/读取、转项等待来源与跨域新来源轮次/剩余受众；业务Agent继续mock，实际投递归14。

`ExamCommandService.save/close`在配置与管理轮次更新后刷新全部角色卡片；`ExamCandidateService.enter`在来源绑定及试卷校验后刷新。卡片变更与原写入同事务失败回滚，原接口保持静默；重复入场保留原绑定和时间，current读取不写卡片、轮次或事件。本批未扩展卡片候选来源规则、跨域新来源轮次或实际投递。

## 配置命令同步本人独立轮次（13第二十三批，2026-10-28）

发布/编辑/关闭保持现有HTTP契约、权限、项目锁、版本校验和静默行为；在原事务内同步全项目EXPERT独立考试/培训轮次，然后统一仲裁卡片。覆盖没有普通接单关系的转项等待来源及仅剩旧OPEN轮次的失效用户。失去最后考试来源取消而非完成，重新发布有效考试另开轮；有效其他考试、已入场合法历史卷及独立培训保留。配置、轮次或卡片写入失败整体回滚。不新增schema/迁移/依赖。691单测、类型/静态/build及新增8项分批集成通过，详细证据见任务13第二十三批记录。

## 阅卷写入口同步独立轮次（13第二十八批，2026-10-28）

`refreshGradingSnapshots` 在原事务中先同步全项目EXPERT独立考试/培训轮次，再统一仲裁卡片。覆盖人工阅卷、mock成功/失败、补偿、重试及共用此入口的交卷/超时路径；失效来源取消，真实遗漏来源补开，历史及有效独立培训保留，不以阅卷卡片优先级决定独立轮次。原事件携带卡片变更受众，不增加单独通知；重复回调沿原幂等门禁保持无写入。轮次、评分、准入、快照或outbox失败整体回滚，HTTP和权限契约保持原样，实际投递仍归14。

78定向及711全量单测、服务端类型、变更静态检查和后端包build通过。用户10:54:53仅定向5项 `grading independent progress` 集成全部通过（358跳过，共363项，总16.97秒，测试6.44秒），原初始化连接阻塞解除；真实来源补轮、取消陈旧轮次、历史保留、重复回调及读取无副作用、实际评分/准入/轮次/卡片/outbox故障整事务回滚已验证。不重复本批及前批，不重迁移29；本轮仅同步用户结果与文档。详见[任务13记录](../../backend-migration/13-workbench/todoTask.md#第二十八批阅卷入口独立轮次2026-10-28)。
