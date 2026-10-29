## Why

宿主轮询 Shadow 的 `GET /task/{task_id}/status` 时，运行中的 `message` 通常为空，只能在任务结束后获得总结，无法展示当前正在执行的动作。需要让宿主在运行期间看到点击、输入、导航等动作描述，并继续通过同一字段读取最终结果。

## What Changes

- 在每步动作开始执行前更新任务的 `message`，返回当前动作的中文描述。
- 导航描述直接拼接模型输出的目标 URL，例如 `正在导航 baidu.com`，不补协议或校验网址；点击显示 `正在点击页面元素`。
- 继续沿用现有 `message: string | null`，只保存最新描述；不增加动作历史、推送协议或宿主消费游标。
- 保留人工接管、取消和任务终态的现有优先级。成功结束后仍返回最终总结，失败和取消仍返回对应结果。
- 输入动作不回显输入正文，状态查询继续只读，动作描述不影响实际桌面操作。

## Capabilities

### New Capabilities

- `shadow-task-progress`: 定义 Shadow 状态接口中的当前动作描述、导航目标展示、消息更新时机及终态覆盖规则。现有实现尚无对应的 OpenSpec 规格。

### Modified Capabilities

无。

## Impact

- `api/server.py`：在任务运行回调中维护最新消息，保留现有接管和终态处理。
- `api/schemas.py`：`ProgressResponse.message` 保持普通可空字段，不添加描述或示例，不改变响应结构。
- 复用 `agent/loop.py` 已有的 `register_new_step_callback` 链路，避免改写原生执行循环。
- 新增独立的动作描述格式化函数及对应测试，扩展 `tests/test_api_tasks.py` 的状态查询覆盖。
- 更新 `README.md` 中的状态接口说明；无需新增依赖、数据库迁移或打包配置。
