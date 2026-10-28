## 1. 固定验收行为

- [x] 1.1 在 `tests/test_progress.py` 增加动作映射、导航 URL 原样展示及缺失回退、空动作、未知动作、输入正文不回显的参数化测试；先运行该文件，确认新能力尚未实现时测试失败。
- [x] 1.2 在 `tests/test_api_tasks.py` 使用隔离 Agent 触发 `register_new_step_callback`，覆盖动作开始后的即时查询、后续动作覆盖、最终总结及 `current_url`、步骤数不提前变化；定向运行新增用例，确认实现前失败。
- [x] 1.3 补充取消、人工接管、收尾、三种终态和重复轮询用例，验证迟到动作不能覆盖结果、轮询不触发模型或页面操作；定向测试先复现未保护消息更新的行为。

## 2. 实现动作消息

- [x] 2.1 在 `api/progress.py` 实现无桌面、浏览器及模型依赖的纯格式化函数，按规格生成中文描述；运行 `tests/test_progress.py` 全部通过，并检查 API 导入仍不初始化桌面组件。
- [x] 2.2 在 `api/server.py` 复用 Agent 已有步骤回调更新任务消息，限制为仍在运行且未取消、未收尾的任务；运行第 1 组 API 用例和 `tests/test_agent_loop.py` 的已有回调测试通过，确认现有接管及终态优先级不变。
- [x] 2.3 `ProgressResponse.message` 保持普通可空字段，不添加描述或示例；在 Shadow README 写明最新动作、导航示例和慢轮询边界，检查响应形状兼容，并运行修改文档的 Prettier 检查通过。

## 3. 回归与交付核对

- [x] 3.1 在 Shadow 项目根目录运行 `.venv/bin/python -m pytest -q tests/test_progress.py tests/test_api_tasks.py tests/test_agent_loop.py`，确认格式化、宿主状态与原生回调链路共同通过。
- [x] 3.2 在 Shadow 项目根目录运行 `env -u SHADOW_OS_INTEGRATION -u SHADOW_BROWSER_EXECUTABLE .venv/bin/python -m pytest -q`，记录通过和跳过数量；确认未调用真实模型或执行实际桌面任务。
- [x] 3.3 运行 `openspec validate shadow-status-action-messages --strict` 和 `git diff --check`，检查变更内容、路径及依赖符合仓库约束，确保未新增凭据、数据文件或依赖；核对规格中的每个场景都有对应测试证据后再标记实施任务完成。

## 4. 按模型输出原样展示导航目标

- [x] 4.1 修改导航消息测试，覆盖无协议、本地服务、静态文件及原样保留字符串，先复现旧格式化规则不符合要求。
- [x] 4.2 删除消息层的 URL 补协议、解析和校验，同步 README 与 OpenAPI 示例；运行定向测试通过。
- [x] 4.3 运行 Shadow 全量测试、OpenSpec 严格校验、文档格式与变更检查，记录修订后的验收结果。

## 字段精简验收记录

- 按用户要求删除 `ProgressResponse.message` 的 `description` 和 `examples`，恢复为 `str | None = None`，移除仅校验这些文档元数据的用例。
- `tests/test_api.py` 33 项通过；`tests/test_api_tasks.py -k action_message` 7 项通过。OpenSpec 严格校验、文档格式和 `git diff --check` 通过。

## 原样展示修订验收记录

- 按用户反馈直接展示模型给出的 URL；消息层删除补协议、去空白、解析及网址校验，仅保留缺失、空字符串及非字符串时的通用提示。实际导航执行器和 `current_url` 的已有来源不变，未修改工作区中其它任务的 `agent/planner.py`。
- 修改期望后定向运行先复现 14 项失败、8 项通过；修改实现后导航、动作描述及 OpenAPI 定向 37 项通过。格式化和 HTTP 状态测试确认 `baidu.com`、本地地址和 `file://` 字符串原样展示。
- 本轮首次三个文件联跑为 168 项通过、1 项失败；失败仍为既有 `test_http_uses_real_shadow_agent_authorization_history_and_audit[False]` 的 10 秒超时，两种授权场景单独复跑均通过。未修改该用例或放宽超时。
- 最终运行 `env -u SHADOW_OS_INTEGRATION -u SHADOW_BROWSER_EXECUTABLE .venv/bin/python -m pytest -q -o faulthandler_timeout=8`：603 项通过、4 项跳过，耗时 27.31 秒。
- OpenSpec 严格校验、Prettier、`git diff --check` 及当前 693 个文件的限制内容检查通过；图片和依赖锁文件与此前核验版本相同，未新增依赖。

## 首次实施验收记录

以下为首次实施时的验证结果；导航规则以第 4 组修订及当前规格为准。

- 2026-10-28：实现前新增定向测试 46 项失败，分别复现格式化模块缺失和状态消息为空；接入未保护回调后 41 项通过、5 项失败，复现取消、收尾和三种终态被迟到回调覆盖。加入守卫后全部通过。OpenAPI 字段说明测试也先复现缺失说明，再实现通过。
- 定向命令（3.1）：194 项通过，耗时 14.35 秒。全量命令（3.2）：600 项通过、4 项跳过，耗时 26.77 秒；未启用真实浏览器、桌面集成或真实模型调用。
- 首次连同 `tests/test_api.py` 联跑时，既有原生授权测试出现一次 10 秒超时（227 项通过、1 项失败）。未修改超时阈值或业务实现；该测试单独复跑两种授权场景均通过，随后上述完整定向和全量回归均通过。单次超时原因未定位。
- API 独立进程导入检查通过，未加载模型、browser-use 或桌面模块。OpenSpec 严格校验、文档 Prettier 和 `git diff --check` 通过；独立代码评审无待修复问题。
- 检查当前 693 个受版本控制及新增文件的路径、文本、归档内容和图片元数据，结合本机提交策略检查通过；未新增依赖、凭据或运行数据，依赖清单和锁文件未变化。`.agents/`、本机规则及 `.env` 均保持忽略。

| 规格场景                                                            | 对应测试证据                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 点击即时展示、后续覆盖、慢轮询仅保留最新、导航不提前改变 URL 或步骤 | `tests/test_api_tasks.py::test_action_message_is_visible_before_step_end_and_replaced_by_latest_action`                                                                                          |
| 模型导航 URL 原样展示、本地服务与静态文件、缺失参数回退             | `tests/test_progress.py::test_navigation_description_uses_model_target_verbatim`、`test_malformed_navigation_parameters_do_not_break_progress`                                                   |
| 各动作映射、输入正文不回显、未知及空动作                            | `tests/test_progress.py::test_action_description_uses_public_action_type_only`、`test_empty_action_has_no_message_update`、`test_description_reads_native_model_shape_and_first_nonempty_action` |
| 整理结果不提前成功、收尾拒绝迟到动作                                | `tests/test_api_tasks.py::test_action_message_cannot_overwrite_message_during_final_cleanup`                                                                                                     |
| 最终总结覆盖、失败及取消结果不变、终态拒绝迟到动作                  | `tests/test_api_tasks.py::test_action_message_cannot_overwrite_terminal_results`                                                                                                                 |
| 人工接管及取消提示优先、取消拒绝迟到动作                            | `tests/test_api_tasks.py::test_action_message_does_not_mask_takeover_or_cancellation`                                                                                                            |
| 重复查询只读、响应字段与可空类型兼容、原鉴权及未知任务响应          | `tests/test_api_tasks.py::test_action_message_polling_is_read_only`、`test_action_message_is_visible_before_step_end_and_replaced_by_latest_action`，以及现有 API 鉴权及未知任务测试             |
| 节奏等待之后触发原生回调，控制动作继续转发                          | `tests/test_agent_loop.py::test_default_rhythm_runs_before_user_callback_even_without_read_time`、`test_control_actions_skip_wait_even_when_labelled_as_click`                                   |
