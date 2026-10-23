# Agent PostgreSQL 18 迁移

Agent 使用独立 PostgreSQL 数据库中的 `agent` schema；不得用业务 `DATABASE_URL` 或根 `db:*` 命令运行本目录。业务 Prisma、业务迁移及业务接口不参与。`agent.schema_migrations` 是迁移元数据，18 张领域表之外的基础设施对象。

`0001_agent_baseline` 实现当前 13—17 号字段及 20 号约束清单：18 表、269 字段、18 主键、26 复合引用目标唯一键、25 业务唯一键、7 部分唯一索引、17 查询索引、67 外键。只有 FK-01/05/17/19/25/54 声明 `DEFERRABLE INITIALLY IMMEDIATE`；首次 Pi 初始化只延迟 FK-17。所有外键为 `MATCH SIMPLE / ON DELETE NO ACTION / ON UPDATE NO ACTION`。

`baseline-spec.json` 记录本次冻结的结构来源和精确对象清单，SQL 在 `sql/0001`。即时守卫保护身份、原生数据、终态、单次授权、预算单调和冻结配置；延迟约束重新读取事务最终状态，检查双向绑定、原生前缀与版本链、消费明细、完成与最终消息、水位、来源、业务证据和预算快照。叶子可旧、可空；原生记录顺序不按时间或分支重排。

## 目标与账号

部署前由数据库管理员确认数据库是 Agent 专用目标并创建三个独立 LOGIN 账号，不在脚本中填写凭据：

- 迁移账号：Agent schema/object owner，持发布权限；只用于独立迁移命令。
- 运行账号：仅授 `tyde_agent_runtime`，不是对象 owner，无 Agent DDL、TRUNCATE、不可变历史 UPDATE/DELETE 或 S/F/G 发布权。
- 配置发布账号：仅授 `tyde_agent_publisher`，登记完整配置和成员；普通运行仅读取。
- 需要保留清理时另授 `tyde_agent_cleanup` 给专用清理 LOGIN。运行账号不得继承清理组。

先在已确认的 Agent 库执行 `roles.sql`（只创建无凭据的 NOLOGIN 权限组），再向独立 LOGIN 授对应组。迁移安装 `05_privileges.sql`，只给已经存在的组授权；PUBLIC 没有 Agent schema/table/function 权限。账号连接、数据库 CONNECT、网络与 TLS、数据库级权限由部署管理员配置。不要把迁移账号当作 HTTP 服务账号。

连接池固定 `search_path=pg_catalog,agent`，不包含 public。Agent SQL 对象不能落入业务 schema。迁移始终显式限定 `agent`。

## 运行命令

先实际切换 Node.js 24.19.0、pnpm 11.23.0。只通过服务端环境注入连接字符串，不在命令记录或日志中展开密码。

```sh
pnpm migrate:agent
pnpm check:agent-db
pnpm test:agent-db
```

迁移／检查读取 `AGENT_MIGRATION_DATABASE_URL`；集成测试只读取显式 `AGENT_TEST_DATABASE_URL`，无值时跳过，不能把跳过当作通过。HTTP PG 模式读取独立 `AGENT_DATABASE_URL`，启动只检查兼容性，不自动 DDL，不回退内存。

底层入口为 `src/storage/migrations.ts`（编译后 `dist/storage/migrations.js`），参数 `check` 只读检查。迁移使用独立稳定 pg Client、事务级 advisory lock 和一个完整 DDL 事务。失败返回非零；完整基线未提交则没有可服务的半套结构。提交结果不明先以原版本、SQL 摘要及实际对象核实，不能换版本或忽略失败。

已安装版本重复执行只核对版本、资源 SHA-256 及对象定义指纹，不重放 DDL。已发布 SQL 不得原地修改；新改动追加版本。定义指纹覆盖列、约束、索引、函数和触发器，排除单独管理的 owner/ACL。源文件与编译代码均读取同一组 `migrations/sql` 资源，现有 package `files` 包含 `migrations`；交付时必须保留整个目录。

## 验证与边界

独立测试覆盖真实 PostgreSQL 18 对象数量、重复迁移、正常初始化、accepted 命令事务末拒绝、JSON 缺键即时拒绝、完整原生字段／多根／旧叶／空叶往返、旧 owner 拒绝、不可变保护、孤立追加及假完成回滚、限定 schema DDL 故障回滚，以及运行权限。另有真实回环 HTTP 集成，以本隔离实例内临时创建的独立 NOSUPERUSER LOGIN（仅 runtime 组）验证创建、可靠完成、部分输出停止、原请求键重放和不可变／DDL 权限；执行配置由独立发布连接提前登记。该用例使用受控模型传输，不能算真实供应商验收；结束后删除临时 LOGIN，不删除并行测试数据。故障回滚使用同一隔离测试库中的临时 probe schema，并在事务内整体回滚；不清理业务数据，也不删除并行测试的预算记录。

本地 W5 验证实例是本轮新建的 PostgreSQL 18.6，回环独立端口 55435、数据库 `agent_w5_test`。这只是可清理的专用测试目标，不是开发／部署业务数据库。基线在交付前曾于该专用库刷新未发布守卫和测试摘要，保留所有活动计时夹具；这不是生产升级或已发布迁移改写。

约束触发器当前采用完整聚合复查，优先覆盖最终状态和删除路径；大数据量下需评估扫描成本，再在保留全部不变量的前提下优化受影响聚合范围。哈希规范化、真实 Pi 类型语义、SDK 等待屏障、制品原字节／可取回性、外部回执可信性仍由受控适配器验证，数据库外键不能替代这些证明。

清理前必须确认旧进程及发送路径已隔离、尝试已收敛、无未决授权保留需求。全会话清理依设计只延迟六条指定 FK，按 V→M→D→L→I→O→B→H→Q→A→R→E→P→T→C 的完整范围执行，保留 S/F/G；不能通过清空历史引用、停用触发器、`session_replication_role` 或客户端 SET 标记绕过。W5 默认不开放产品删除／保留清理入口。

## CT07 资源发布与约束

`src/storage/resource-publication.ts` 提供可信内部发布入口，必须显式提供制品字节／来源／可取回性 verifier；它不开放 HTTP、不加载工具、不扫描或下载文件。普通 HTTP runtime 账号仍不能写 S/F/G，真实 W5 聊天仍使用空工具和零成员。

资源摘要 `resource-manifest-v1` 由发布器及 DB 共用 `resource_manifest_normalize/digest`：按 load_order/member_key(C) 排列完整 G 语义与 F 稳定身份，排除记录 ID／创建时间，并把归档 bigint 大小转为十进制字符串，再取 PG18 JSONB 规范文本 UTF-8 的 SHA-256。它与 snapshot／命令 JCS 独立；空 `[]` 摘要保持兼容。完整规范、来源差异和测试证据见 [D1](../../../docs/AGENT_W5_D1.md)。

F.manifest_schema_version=1 文件清单使用 `files` 数组：每项包含 path、size_bytes、sha256、mode、kind='file'，可带 exports。G 入口须在清单中；skill 入口是 SKILL.md。工具实现只能绑定 extension/business_adapter 成员的声明 export 或固定 runtime export；成员的 requires_members/tools/files 依赖全部闭合。显式隔离 test fixture 需要双方完整固定身份和安全 tests/ 路径。

延迟资源触发器覆盖 S/G/F 与 T/R 的 I/U/D 最终状态。缺成员、摘要不符、缺文件或工具导出、未闭合 Skill 引用、部分成员删除均拒绝。重复摘要会复比完整 S/G/F 语义，不因摘要命中跳过内容。元数据约束不代替实际归档／源码字节、资源依赖和可取回性的可信验证，也不表示已经实现生产资源装配。
