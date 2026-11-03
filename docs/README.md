# 文档导航

日常使用先看下方入口；业务接口按模块放在 `backend/`，原阶段交付与验证记录集中到 `archive/`。文档以当前代码和明确标注的验收范围为准，归档中的旧续做指令不再生效。

## 常用入口

| 文档                                  | 用途                                                       |
| ------------------------------------- | ---------------------------------------------------------- |
| [当前功能](IMPLEMENTED_FEATURES.md)   | Web、Electron、独立 Agent 已接入及未开放范围               |
| [界面规范](UI_STANDARDS.md)           | 业务 Web/Electron 的统一尺度、公共组件及用途差异           |
| [验证入口](VERIFICATION.md)           | 回归方式、已记录基线和仍待验收范围                         |
| [测试部署](DEPLOY_TEST.md)            | 交付包、服务、存储、HTTPS和维护命令                        |
| [release 发布](RELEASE_DEPLOYMENT.md) | release 发布目标、跨仓同步的显式启用与失败处理             |
| [试用安装](INSTALL_TRIAL.md)          | Mac/Windows安装与测试后端连接                              |
| [Agent 协作](AGENT_DEVELOPMENT.md)    | 职责、契约、持久化与工具边界；启动配置以应用 README 为入口 |

Agent 运行说明：[服务](../apps/agent/README.md)、[页面](../apps/agent-web/README.md)、[独立数据库迁移](../apps/agent/migrations/README.md)。业务续做位置与提交约束沿用根目录 `AGENTS.md`；任务13新增22项业务断言尚未执行，业务 Agent 继续 mock，不开始14。

## 业务接口说明

以下文档保留独有的字段、权限、来源、精度或事务规则，按模块查阅。`PRODUCTION_QUALITY.md` 原名带有 `ACCEPTANCE`，因包含现行接口规则而保留；独立管理授权说明已合入 `UNIFIED_ACCOUNTS.md`。

| 文档                                                                | 内容                                    |
| ------------------------------------------------------------------- | --------------------------------------- |
| [API](backend/API.md)                                               | API 与 Swagger 使用说明                 |
| [ATTENDANCE_CLOCK](backend/ATTENDANCE_CLOCK.md)                     | 工作台打卡与原始事件重放（API-078/079） |
| [AUTH_BACKEND](backend/AUTH_BACKEND.md)                             | 认证与会话                              |
| [ENTRANCE_EXAM_CANDIDATE](backend/ENTRANCE_EXAM_CANDIDATE.md)       | 执行专家考试（08）                      |
| [ENTRANCE_EXAM_MANAGEMENT](backend/ENTRANCE_EXAM_MANAGEMENT.md)     | 准入考试配置与导入基础                  |
| [EXPERT_ASSIGNMENTS](backend/EXPERT_ASSIGNMENTS.md)                 | 执行专家接单侧（07）                    |
| [ORGANIZATION_SCHEDULES](backend/ORGANIZATION_SCHEDULES.md)         | 组织排班后端                            |
| [PERSONAL_WORKBENCH](backend/PERSONAL_WORKBENCH.md)                 | 个人中心与工作台后端                    |
| [PERSONNEL_MOVEMENTS](backend/PERSONNEL_MOVEMENTS.md)               | 人员变动与转项                          |
| [PRODUCTION_OUTPUT_REPORTS](backend/PRODUCTION_OUTPUT_REPORTS.md)   | 生产报量（11第二批）                    |
| [PRODUCTION_QUALITY](backend/PRODUCTION_QUALITY.md)                 | 人员日生产、质量与子任务验收            |
| [PRODUCTION_SUBTASKS](backend/PRODUCTION_SUBTASKS.md)               | 生产子任务（11第一批）                  |
| [PROJECT_CREATION](backend/PROJECT_CREATION.md)                     | 项目草稿与发布                          |
| [PROJECT_DETAILS](backend/PROJECT_DETAILS.md)                       | 已发布项目详情与成员关系基础            |
| [PROJECT_LISTS](backend/PROJECT_LISTS.md)                           | 项目待办卡片列表                        |
| [PROJECT_MANAGERS](backend/PROJECT_MANAGERS.md)                     | 策略官候选、分配与项目任务基础          |
| [PROJECT_PERSONNEL_ENTRY](backend/PROJECT_PERSONNEL_ENTRY.md)       | 项目花名册与入项决定（10第一批）        |
| [PROJECT_PERSONNEL_RECORDS](backend/PROJECT_PERSONNEL_RECORDS.md)   | 项目考勤与成员表现（10第二批）          |
| [PROJECT_PRODUCTION_PLANS](backend/PROJECT_PRODUCTION_PLANS.md)     | 生产计划查询与确认                      |
| [PROJECT_RECRUITMENT](backend/PROJECT_RECRUITMENT.md)               | 项目招募负责人及专家下发                |
| [PROJECT_STANDARD_MATERIALS](backend/PROJECT_STANDARD_MATERIALS.md) | 项目标准与案例材料（06）                |
| [PROJECT_WORKBENCH](backend/PROJECT_WORKBENCH.md)                   | 项目看板与任务统计                      |
| [UNIFIED_ACCOUNTS](backend/UNIFIED_ACCOUNTS.md)                     | 统一账号、三角色与组织创建              |

## 历史证据

| 归档                                          | 原文件与保留理由                                                    |
| --------------------------------------------- | ------------------------------------------------------------------- |
| [Agent 阶段记录](archive/AGENT_MILESTONES.md) | 合并10份 W3/W4/W5交付、验证、复核及联调记录，保留每批独有证据       |
| [业务专项验收](archive/ACCEPTANCE_HISTORY.md) | 合并6份账号、个人工作台、考试、分配及双端联调验收记录               |
| [后端开发历史](archive/BACKEND_HISTORY.md)    | 保存看板48批流水、旧API/认证/部署上下文、最初验证及根README验收流水 |

旧文档的“等待开发”“未迁移”不代表当前实现。外部 `backend-migration/` 任务目录和未提交的本地报告只保留为历史路径，现行导航不依赖这些文件。
