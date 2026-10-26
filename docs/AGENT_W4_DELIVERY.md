# Agent W4 逐文件交付清单

2026-10-23 · 仅提供建议，不执行暂存、提交、推送或合并。

原目录启动时干净；当前 W4 worktree 分支为 `feature/agent-w4-tools`，基线 `d73ea7a45693b59bbf36f5dc4eb9f509185a95d2`。原目录、用户配置和 W5 目录未切分支或覆盖。W2／W3 历史记录不改。

## 通用需提交：37 个文件

下表每行的“提交”对应后续精确分组。所有生成文件由现有生成器维护；21 源未改，生成器脚本未改。

| 实际相对路径                                                               | 修改用途                            | 依赖与缺席影响                             | 建议提交 | 相关验证                        |
| -------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------ | -------- | ------------------------------- |
| `AGENTS.md`                                                                | 当前工程入口/装配/兼容/W5协作说明   | 不参与执行；缺席会留下旧阶段说明           | 4        | 实现/命令/边界交叉核对          |
| `README.md`                                                                | 当前工程入口/装配/兼容/W5协作说明   | 不参与执行；缺席会留下旧阶段说明           | 4        | 实现/命令/边界交叉核对          |
| `apps/agent-web/README.md`                                                 | 真实工具过程与默认无demo边界        | 运行说明；缺席不影响编译但交付不完整       | 3        | 说明与实现核对                  |
| `apps/agent-web/src/App.tsx`                                               | 在聊天回答旁装配工具卡              | 依赖ChatMessages；缺席不显示工具过程       | 3        | 71项前端/真实浏览器             |
| `apps/agent-web/src/agent-events/projection.ts`                            | 快照历史事件工具缓存/终态不可回退   | controller依赖；缺席无法恢复工具过程       | 3        | 竞态/终态/换绑/文字收敛回归     |
| `apps/agent-web/src/agent-events/protocol.ts`                              | 工具可靠事件归属检查                | SSE客户端依赖；缺席跨会话校验不完整        | 3        | 未知/缺口/归属回归              |
| `apps/agent-web/src/components/ChatMessages.tsx`                           | 消息/工具按task与attempt组合        | App依赖；缺席编译失败                      | 3        | 展示/时间/归属回归              |
| `apps/agent-web/src/components/ToolExecutions.tsx`                         | 安全摘要/四态/演示标识/追溯         | ChatMessages依赖；缺席编译失败             | 3        | SSR展示/真实截图                |
| `apps/agent-web/src/styles/global.css`                                     | 工具卡主题/布局/追溯样式            | 卡片样式依赖；缺席显示退化                 | 3        | 构建/浅深色截图                 |
| `apps/agent-web/tests/chat-controller.test.ts`                             | 工具补读/旧订阅/终态/安全展示回归   | 与UI和投影配套；缺席失去覆盖               | 3        | 前端71/71                       |
| `apps/agent-web/tests/chat-fixtures.ts`                                    | 最小工具投影测试夹具                | 前端测试依赖；不被真实页面导入             | 3        | 前端71项                        |
| `apps/agent-web/tests/events.test.ts`                                      | 工具补读/旧订阅/终态/安全展示回归   | 与UI和投影配套；缺席失去覆盖               | 3        | 前端71/71                       |
| `apps/agent-web/tests/projection.test.ts`                                  | 工具补读/旧订阅/终态/安全展示回归   | 与UI和投影配套；缺席失去覆盖               | 3        | 前端71/71                       |
| `apps/agent-web/tests/tool-display.test.tsx`                               | 工具补读/旧订阅/终态/安全展示回归   | 与UI和投影配套；缺席失去覆盖               | 3        | 前端71/71                       |
| `apps/agent-web/upstream/pi-web/SOURCE.md`                                 | 标记新增组件自研/无新增上游代码     | 许可证来源映射配套；LICENSE原样保留        | 3        | 来源/无依赖变更                 |
| `apps/agent/README.md`                                                     | 当前工程入口/装配/兼容/W5协作说明   | 不参与执行；缺席会留下旧阶段说明           | 4        | 实现/命令/边界交叉核对          |
| `apps/agent/src/api/documentation.ts`                                      | 工具中文Swagger/当前边界            | API文档装配依赖；缺席文档校验失败          | 1        | Swagger字段与例子测试           |
| `apps/agent/src/application.ts`                                            | 可信宿主注入/固定启动配置           | 默认入口与本机宿主依赖；缺席不能注入       | 2        | 默认无demo启动/HTTP/真实页面    |
| `apps/agent/src/maas/transport.ts`                                         | 稳定模型请求ID/阻止重复派发         | Pi传输依赖；缺席无法保证跨层关联           | 2        | 传输13项/工具链                 |
| `apps/agent/src/pi/index.ts`                                               | 导出受控宿主接口                    | 应用/CLI/宿主依赖；缺席导入失败            | 2        | 类型/构建/默认入口              |
| `apps/agent/src/pi/resources.ts`                                           | 可信资源冻结/正文预加载/摘要        | Pi与宿主装配依赖；缺席编译失败             | 2        | 15项W4 Pi/缺失摘要/隔离构建     |
| `apps/agent/src/pi/session.ts`                                             | 工具循环/原生关联/取消/配置捕获     | 运行时与CLI依赖；缺席失去实际执行链        | 2        | 25旧+15新Pi、5工具集成/真实模型 |
| `apps/agent/src/runtime/memory-runtime.ts`                                 | 内存工具投影/原生保存/最终派发门禁  | 所有产品读取/执行依赖；缺席W4无法接入      | 2        | 5工具集成/旧运行时/TCP回归      |
| `apps/agent/tests/api.test.ts`                                             | 契约、序列化、Swagger与例子回归     | 与契约变更配套；缺席会失去对应回归         | 1        | 服务端156项                     |
| `apps/agent/tests/contracts-schema.test.ts`                                | 契约、序列化、Swagger与例子回归     | 与契约变更配套；缺席会失去对应回归         | 1        | 服务端156项                     |
| `apps/agent/tests/memory-tools.test.ts`                                    | 真实SDK到API投影/停止/预算/保存集成 | 最小合成工具在测试内；缺席失去W4集成回归   | 2        | 5/5                             |
| `apps/agent/tests/pi-w4.test.ts`                                           | 固定Pi资源/工具/故障/预算实验       | 最小合成夹具就在文件内；不依赖本机包       | 2        | 15/15                           |
| `docs/AGENT_DEVELOPMENT.md`                                                | 当前工程入口/装配/兼容/W5协作说明   | 不参与执行；缺席会留下旧阶段说明           | 4        | 实现/命令/边界交叉核对          |
| `docs/AGENT_W4_DELIVERY.md`                                                | 逐文件分类/建议提交与未完成项       | 交付索引；不参与执行                       | 4        | 本清单与git逐文件核对           |
| `docs/AGENT_W4_VALIDATION.md`                                              | A—E证据/隔离与真实区分/W5交接       | 交付证据；不参与执行                       | 4        | 156+71/421/87与真实7请求        |
| `packages/shared/src/agent/contracts/README.md`                            | 版本兼容和来源摘要                  | 开发来源记录；缺席不影响运行但交付不完整   | 1        | 摘要/外部源一致性               |
| `packages/shared/src/agent/contracts/document.generated.ts`                | 生成：JSON Schema与来源摘要         | 两端/Swagger配套依赖；不可只提交部分或手改 | 1        | 生成一致性/类型/完整测试        |
| `packages/shared/src/agent/contracts/generated.ts`                         | 生成：DTO和TypeBox                  | 两端/Swagger配套依赖；不可只提交部分或手改 | 1        | 生成一致性/类型/完整测试        |
| `packages/shared/src/agent/contracts/index.ts`                             | 工具状态/时间/结果/错误配对语义     | 两端统一验证；缺席会丢语义约束             | 1        | 契约与前端异常回归              |
| `packages/shared/src/agent/contracts/operations.generated.ts`              | 生成：OpenAPI路由/示例              | 两端/Swagger配套依赖；不可只提交部分或手改 | 1        | 生成一致性/类型/完整测试        |
| `packages/shared/src/agent/contracts/sources/22-reads-events.openapi.json` | 唯一22源；W4独立工具读取和事件      | 生成器唯一输入；缺席无法再生成/核对        | 1        | 103 Schema检查/契约/Swagger     |
| `packages/shared/src/agent/contracts/validator.generated.ts`               | 生成：静态浏览器校验器              | 两端/Swagger配套依赖；不可只提交部分或手改 | 1        | 生成一致性/类型/完整测试        |

## 建议提交顺序与精确文件

每个分组的文件均在下方逐一列出，不需要手工挑选同一文件的代码块。默认无demo环境已独立验证。提交 1 可先合入 main；提交 2、3 依赖 1，可分批合入，但含新事件的服务部署需与前端配套；提交 4 在对应实现落地后合入。

### 提交 1：`feat(agent): 补充只读工具过程契约与安全投影`

- `apps/agent/src/api/documentation.ts`
- `apps/agent/tests/api.test.ts`
- `apps/agent/tests/contracts-schema.test.ts`
- `packages/shared/src/agent/contracts/README.md`
- `packages/shared/src/agent/contracts/document.generated.ts`
- `packages/shared/src/agent/contracts/generated.ts`
- `packages/shared/src/agent/contracts/index.ts`
- `packages/shared/src/agent/contracts/operations.generated.ts`
- `packages/shared/src/agent/contracts/sources/22-reads-events.openapi.json`
- `packages/shared/src/agent/contracts/validator.generated.ts`

### 提交 2：`feat(agent): 接入受控工具与可信资源宿主`

- `apps/agent/src/application.ts`
- `apps/agent/src/maas/transport.ts`
- `apps/agent/src/pi/index.ts`
- `apps/agent/src/pi/resources.ts`
- `apps/agent/src/pi/session.ts`
- `apps/agent/src/runtime/memory-runtime.ts`
- `apps/agent/tests/memory-tools.test.ts`
- `apps/agent/tests/pi-w4.test.ts`

### 提交 3：`feat(agent-web): 展示工具过程与调用追溯`

- `apps/agent-web/README.md`
- `apps/agent-web/src/App.tsx`
- `apps/agent-web/src/agent-events/projection.ts`
- `apps/agent-web/src/agent-events/protocol.ts`
- `apps/agent-web/src/components/ChatMessages.tsx`
- `apps/agent-web/src/components/ToolExecutions.tsx`
- `apps/agent-web/src/styles/global.css`
- `apps/agent-web/tests/chat-controller.test.ts`
- `apps/agent-web/tests/chat-fixtures.ts`
- `apps/agent-web/tests/events.test.ts`
- `apps/agent-web/tests/projection.test.ts`
- `apps/agent-web/tests/tool-display.test.tsx`
- `apps/agent-web/upstream/pi-web/SOURCE.md`

### 提交 4：`docs(agent): 记录 W4 验证与交付边界`

- `AGENTS.md`
- `README.md`
- `apps/agent/README.md`
- `docs/AGENT_DEVELOPMENT.md`
- `docs/AGENT_W4_DELIVERY.md`
- `docs/AGENT_W4_VALIDATION.md`

## 本机演示与配置产物：逐文件不提交

下表全部不暂存、不推送，没有建议提交。具体资源文件属于“本机演示不提交”；JSON证据、截图、临时日志和清单属于“配置产物不提交”。路径是worktree实际相对路径。

| 实际相对路径                                                                          | 用途／分类                                       | 依赖与缺席影响                                                | 验证                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- | ----------------------- |
| `.local/agent-w4-demo/README.md`                                                      | 本机启动步骤与具体验收输入／本机演示不提交       | 仅显式演示依赖；默认入口/通用检查不依赖                       | 本机步骤核对            |
| `.local/agent-w4-demo/SKILL.md`                                                       | 固定Skill正文／本机演示不提交                    | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/browser-login.mjs`                                              | 本机浏览器身份辅助（不输出凭据）／本机演示不提交 | 仅显式演示依赖；默认入口/通用检查不依赖                       | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/data.json`                                                      | 合成人员和规则／本机演示不提交                   | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/demo-tool.mjs`                                                  | 具体只读演示工具实现／本机演示不提交             | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/demo.test.mjs`                                                  | 具体演示4项测试／本机演示不提交                  | 仅显式演示依赖；默认入口/通用检查不依赖                       | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/evidence/19cae725-2b61-4ab9-8ec5-bd78f3c7d30c-final-build.json` | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/530f1148-f9de-40f6-a756-a776ef40cce0-completed.json`   | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/530f1148-f9de-40f6-a756-a776ef40cce0-followup.json`    | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/530f1148-f9de-40f6-a756-a776ef40cce0-ordinary.json`    | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/530f1148-f9de-40f6-a756-a776ef40cce0-reconnected.json` | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/530f1148-f9de-40f6-a756-a776ef40cce0.json`             | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/547c1bf7-2620-496e-b85a-780db34fd389-reconnected.json` | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/547c1bf7-2620-496e-b85a-780db34fd389-refreshed.json`   | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/evidence/547c1bf7-2620-496e-b85a-780db34fd389-stopped.json`     | 安全产品快照／配置产物不提交                     | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/load.mjs`                                                       | 固定路径受控读取和装配／本机演示不提交           | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/manifest.json`                                                  | 预期版本和资源摘要／本机演示不提交               | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/output/playwright/cli/console-2026-10-22T14-36-27-722Z.log`     | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/cli/console-2026-10-22T14-53-51-669Z.log`     | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/cli/page-2026-10-22T14-36-28-270Z.yml`        | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/cli/page-2026-10-22T14-39-08-357Z.yml`        | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/cli/page-2026-10-22T14-53-51-766Z.yml`        | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/completed.png`                                | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/disconnected.png`                             | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/final-build.png`                              | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/followup-ordinary.png`                        | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/reconnected.png`                              | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/refreshed.png`                                | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/running.png`                                  | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/stopped.png`                                  | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/output/playwright/switched-dark.png`                            | 截图/浏览器临时证据／配置产物不提交              | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/prompt.md`                                                      | 演示系统提示词／本机演示不提交                   | 仅显式演示依赖；默认入口/通用检查不依赖；缺席演示明确配置失败 | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/record.mjs`                                                     | 公开安全快照只读验收脚本／本机演示不提交         | 仅显式演示依赖；默认入口/通用检查不依赖                       | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/start.mjs`                                                      | 显式本机服务入口／本机演示不提交                 | 仅显式演示依赖；默认入口/通用检查不依赖                       | 本机4项/真实7次模型请求 |
| `.local/agent-w4-demo/verification/build-artifacts.json`                              | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/content-audit-script.mjs`                          | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/content-audit.json`                                | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/delivery-files.json`                               | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/FILES.json`                    | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/FINAL_REPORT.md`               | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/GENERIC_FILES.json`            | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/INITIAL_REPORT.md`             | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/default-start-smoke.json`      | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/final-source-comparison.json`  | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/format-only-comparison.json`   | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/incremental-checks.json`       | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/initial-checks.json`           | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |
| `.local/agent-w4-demo/verification/independent-generic/isolated-manifest.json`        | 独立验证/审计产物／配置产物不提交                | 仅验收证据；缺席不影响执行，不能据此恢复服务                  | 只读/凭据扫描/已忽略    |

构建生成文件逐文件列在本机 `.local/agent-w4-demo/verification/build-artifacts.json`，每条注明“配置产物不提交”、用途、缺席影响及生成命令；依赖安装目录不作为源码交付。原目录 `apps/agent/.env` 未复制、未改动且不提交；缺席时默认健康可启动，真实聊天须另行显式配置。`commit-policy.json` 在原目录及worktree均缺席，忽略规则有效，没有创建或暂存它。

## 未修改但必须说明的配套文件

| 文件                                                                                                    | 状态与处理                                                            |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `package.json`、`apps/agent/package.json`、`apps/agent-web/package.json`、其余包清单及 `pnpm-lock.yaml` | 全部未改；共9份清单，锁文件来源检查，无需提交；3个Pi SDK仍精确1.3.0。 |
| `apps/agent-web/upstream/pi-web/LICENSE`                                                                | 原MIT许可证保留，未引入新的上游切片；SOURCE.md配套提交。              |
| `packages/shared/src/agent/contracts/sources/21-commands.openapi.json`                                  | 字节未改；不提交。                                                    |
| `scripts/generate-agent-contracts.mjs`                                                                  | 原生成器未改；103 Schema生成检查通过。                                |
| `docs/AGENT_W3_VALIDATION.md`                                                                           | 原历史证据未改；不提交。                                              |
| `apps/server/tests/exam-grading-query.test.ts`                                                          | 既有格式问题，与HEAD一致；不属于本轮，不提交或覆盖。                  |

## 仓库外本轮新增设计修订

以下路径相对 `shell_engineering相关文档/Pi接入与ShellEngineering/`，不在tyde提交中；需单独同步设计负责人。没有把完整架构规划当实现清单。

| 文件                                     | 用途／缺席影响                                         | 分类与验证                           |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| `22-Agent查询与SSE接口契约.md`           | 明确W4新增设计及兼容、展示恢复语义；缺席来源说明不完整 | 通用设计需另库提交；与实现核对       |
| `contracts/22-reads-events.openapi.json` | 外部当前22唯一设计，与repo sources字节一致             | 通用设计需另库提交；103 Schema       |
| `contracts/22-stream-example.sse`        | W4 tool.updated可靠顺序示例                            | 通用设计需另库提交；序号11/12/13核对 |
| `contracts/22-w4-契约静态核对.json`      | 本轮来源、摘要和静态检查证据；旧核对记录未覆盖         | 通用设计需另库提交；摘要一致         |

## W5 与后续联调

先同步 `PiNativeState.configuration`、`NativeExecutionCapture`、`saveNativeState`、`beforeDispatch`、真实 modelRequestId／toolCallId／entry 关联、资源manifest及独立工具投影契约；详细字段见 [W4验收](AGENT_W4_VALIDATION.md)。W5 复用同一公开契约，不依赖具体演示内容。合入后再验原生树往返、提交失败/不明、租约代次、工具结果与产品事件事务、持久预算/deadline和重启保护。

W4没有实现PostgreSQL、持久事件outbox、重启恢复、继续/重试/provide_input、正式平台身份、业务写工具、完整资源平台、真实十分钟预算调优或Electron。

## 最终检查与已有用户修改

启动原目录无已跟踪或未跟踪修改、无暂存；本轮没有用户业务修改需要纳入提交。原有忽略的模型与身份配置保持原位，原目录HEAD/分支最后复核见本机审计。没有对W5工作区作修改。

`check:agent-contracts`、Agent及全仓类型、156项服务端/71项前端、421项业务单测/87项核心、两项构建和全仓lint通过。全仓format:check仍仅基线业务测试文件失败；所有本轮变更格式和git diff --check通过。

真实模型共7次请求，具体演示包仅留本机；本轮临时服务/浏览器已关闭。无demo独立目录完成离线安装、检查、测试、构建与默认启动；其默认聊天使用受控回环替身，真实调用0。

内容/依赖/凭据检查保存在本机verification/content-audit.json。当前缺少本机commit-policy.json，因此指定本机词表匹配未执行，不能宣称已按该词表通过；仍执行当前文件/路径、公开依赖来源、实际凭据值及二进制可提取文本/元数据检查。没有新增私有依赖或产品二进制资源。
