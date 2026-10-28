# 项目标准与案例材料（06）

2026-10-22最新验收：用户16:47:26定向复验附件项1通过、181跳过（共182项，总2.74秒，测试665ms），原附件状态断言阻塞解除。结合16:44:41已通过4项，06新增5项集成分批全部通过；不是全182项复跑，无需重复。前批396单测/类型/ESLint/build及28项定向单测证据保留。本轮仅同步结果，未重跑测试、修改业务代码或操作数据库，无新迁移，迁移历史未另查。保持06，下次直接056—060；真实HTTP/OSS、部署与完整兼容仍待验收。下方待复验描述为此前历史。

2026-10-22：API-053—055已接入，保留已实现待验收；056—060未接入，默认任务仍为06。无新迁移，不连接真实业务Agent。

## HTTP契约

统一前缀`/api/v1`，沿用现有Cookie/Bearer和来源校验，响应为`code/message/data`。完整字段、中文说明及可校验示例见Swagger。

- `GET /projects/standard-materials/detail?projectId=3001`：只读取未删除PUBLISHED项目，其他404。NAVIGATOR仅创建人，PM当前ASSIGNED主策略官或招募协作负责人。EXPERT须有ACCEPTED个人接单或已接单组织的有效成员关系（ACTIVE/EXIT_APPROVING/PENDING_LEAVE）；无生产计划或不要求笔试时无需考试，要求笔试时组织主管、有效项目负责人或未删除项目考试已有ADMITTED结果才允许。负责人旧字段只在完全无新负责人记录时回退。统一账号身份本身不授予项目权限。
- `POST /projects/standard-materials/update`：body为`projectId`、`standardContent`、`standardLink`、`attachments`。仅NAVIGATOR创建人或PM当前主策略官；招募协作负责人只读。正文/链接trim后至少一项非空；省略/null文本清空，链接最多2000字符，不抓取远程文档。附件最多20个，省略/null保留，空数组清空，非空数组整体替换；保留旧附件可用id/objectKey，新附件需要attachmentType/objectKey/uploadToken，元数据取上传台账。

```json
{ "projectId": 3001, "standardContent": "按规范标注", "standardLink": null, "attachments": [] }
```

响应包含projectId、standardContent、standardLink、attachments、currentNodeCode、stateTransitioned、canConfirmRead、confirmedReadAt、readConfirmationTransitioned、versionNo。确认时间为上海`yyyy-MM-dd HH:mm:ss`，非普通执行成员或未确认为null；查询/修改的readConfirmationTransitioned恒false。canConfirmRead如实反映已入项普通成员资格，API-055可提交确认。

修改先锁上传人、再锁项目，同事务条件递增版本、更新材料、认领/释放附件和结算管理主线轮次。客户端沿旧请求无需传versionNo；串行化并发修改均可成功，版本分别递增。当前主策略官补交前序标准可单向推进到RECRUIT_EXECUTION_EXPERT，后期编辑不回退；创建人编辑不推进。旧动作不发布实时事件，本批也不新增投递。

附件返回ACTIVE台账元数据，按sortNo/id排序，不含上传凭证或公开链接。专家元数据读取资格不等于文件下载权限；专家文件读取仍待01/07/08联调。专家确认动作、个人支线轮次与快照刷新已由API-055接入，跨领域卡片优先级重算归04。

## 确认已读（API-055）

`POST /projects/standard-materials/confirm-read?projectId=3001`：沿旧接口使用查询参数，不使用JSON body。仅当前EXPERT且具备上述材料读取资格、存在ACTIVE且joinedAt非空的普通成员可操作；未实际入项400，项目负责人403。项目负责人判断沿有效负责人关系，无任何新负责人历史时才回退旧字段。

锁项目后锁本人最新ACTIVE已实际入项成员；首次记录确认时间、完成本人的STANDARD_TRAINING轮次，同事务完整重算七种项目卡片视角；来源采集、仲裁或写入失败全部回滚。其他账号和管理主线轮次不变，不为生产任务创建待办轮次。重复确认保留首次时间、不重复建轮次，并继续重算真实候选；有效高优先级支线继续竞争，失效旧支线清除后恢复实际培训/生产或其他来源。个人履约须满足统一仲裁的实时成员准入资格及最新成员事实；已结项清除旧快照，不新建个人轮次。材料更新也在附件/主线轮次更新后统一仲裁，沿原规则保持静默。

首次响应readConfirmationTransitioned=true，重复为false；stateTransitioned恒false，canConfirmRead=false，confirmedReadAt返回首次上海时间。项目versionNo及共享currentNodeCode不变，不发布实时事件，不调用业务Agent。

本批396项单测（35文件，16:40:36启动，总13.11秒）、类型/变更ESLint/后端build通过；新增2项集成均停在beforeEach数据库不可达（127.0.0.1:5432），180跳过，共182项，未执行业务断言。覆盖普通入项/负责人/接单权限、并发一次转换、时间幂等/快照修复及快照失败整事务回滚。用户本机仅复测本批：`pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t '^materials confirmation '`。无新增迁移/依赖，未应用迁移或操作开发/部署库。真实HTTP/OSS、部署与兼容仍待验收。

## 16:44:41用户集成复测与修正（历史，16:47:26已复验通过）

累计5项集成4通过、1失败、177跳过（共182项，总6.03秒，测试2.99秒），原初始化连接阻塞解除。管理权限/并发版本/管理轮次、专家范围和055确认并发幂等/快照修复/失败回滚均通过。唯一失败为附件移除末尾误断言PENDING_DELETE；已按现行台账契约修正为RELEASED，同时检查expiresAt到期时间、deletedAt为空及附件逻辑删除。移除只释放台账，到期清理再删除对象，业务实现未改。

修正后28项定向单测（16:45:48，总2.38秒）与变更ESLint通过；仅该1项数据库集成待用户本机复验，不宣称5项全过。前批396单测/类型/build证据保留。无需重做已通过4项或迁移，保持06，之后从056继续。用户从tyde运行（仅配置的专用_test库，会清表）：

```sh
pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t '^materials attachment claim, removal and task-write failure are one database transaction$'
```

## 第一批验证历史

392项单测（35文件，16:31:39启动，总12.53秒）通过；服务端typecheck、变更ESLint与后端包build通过。未新增依赖或迁移，未应用迁移，未操作开发/部署库或真实Agent，真实HTTP/OSS和部署兼容未验收。

第一批新增3项集成覆盖管理权限/并发/轮次、专家接单/组织/准入/阅读元数据、附件认领/移除及任务写故障整事务回滚。16:31:22尝试运行时3项均在beforeEach初始化报数据库不可达（127.0.0.1:5432），177项跳过，业务断言尚未执行；测试主体随后补齐已关闭考试准入/逻辑删除场景并修正故障注入为事务客户端代理，尚待同命令复验。此状态不撤销05此前已通过的6项集成结果。

在专用测试库可连接的用户本机，从`tyde/`执行以下命令；测试会清空`.env.test`指定且允许重置的`_test`库，不连接开发库。本批无迁移，不要求重做21迁移。

```sh
pnpm --filter @tyde/server exec vitest run tests/auth.integration.test.ts -t '^materials '
```

本任务056/057已由第三批接入，见[招募负责人](PROJECT_RECRUITMENT.md)；下一批从API-058—060继续；按需核对对应旧Controller/DTO/Service/Mapper与真实接单来源，保持当前会话角色权限。详细唯一接口状态及交接见[06任务记录](../../backend-migration/06-training-recruitment/todoTask.md)。

2026-10-27任务13第十三批回补：确认与材料更新已接统一仲裁；原HTTP、鉴权、确认时间和轮次幂等、静默约定保持。新增数据库验收尚未执行主体，仅本机专用_test库定向`candidate and training card writes`；不重复上述06已通过批次。详细验证见[任务13](../../backend-migration/13-workbench/todoTask.md)。

2026-10-27第十三批复验更新：用户15:45:16培训一项停在旧卡片夹具create，遗漏必填calculatedAt；已补固定时间，业务代码/约束未改。仅本机定向`candidate and training card writes: confirmation repairs`，培训/静默/终态材料清理主体尚待验证；交卷/取消另三项已过，不重复。

2026-10-27第十三批验收通过：用户15:47:36仅复验培训一项通过（310跳过，共311项，总7.23秒，测试2.37秒），培训确认陈旧来源清理、真实生产来源/时间、重复轮次幂等及静默、终态材料更新撤卡已验证。结合15:45:16三项，本批四项集成已分批全部通过，不再复验。终态夹具不代表真实终态命令/事件验收；650单测及类型/静态/build保留前批证据，本轮仅同步结果与文档，保持13。

2026-10-28任务13第二十六批：材料更新在原事务中同步全项目独立考试/培训轮次后统一仲裁；本人确认先完成原培训轮次，再同步本人独立轮次。真实来源补开、无来源或终态取消，保留历史、其他用户范围及原静默语义。35定向单测、类型/静态/后端build通过；新增4项集成仅初始化数据库不可达，待本机仅定向 `materials independent progress`。不重迁移29，不重复前二十五批；详见[任务13](../../backend-migration/13-workbench/todoTask.md)。

2026-10-28第二十六批验收通过：用户10:43:55仅定向 `materials independent progress` 四项全部通过（350跳过，共354项，总8.34秒，测试3.98秒），原初始化连接阻塞解除。材料更新/本人确认的独立轮次修复、取消范围、历史/静默/幂等/纯读取及实际轮次和卡片写入后故障回滚已验证；不是全354项复跑，不再复验本批或前二十五批、不重迁移29。本轮仅同步结果和文档，保持13，继续其余写入口和跨域来源/受众；业务Agent保持mock。
