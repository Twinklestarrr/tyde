## Purpose

让宿主通过现有的任务状态查询接口了解 Shadow 最新准备执行的动作，在执行过程中展示清晰的中文进度，并在任务结束后继续展示总结或失败、取消结果。描述只反映当前动作，不承担完整动作历史或可靠事件投递功能。

## ADDED Requirements

### Requirement: 状态消息展示最新动作

系统 MUST 在运行中的任务准备执行每步动作时更新 `GET /task/{task_id}/status` 返回的 `message`，使宿主能够读取该动作的中文描述。每次新动作覆盖上一次动作描述，消息不表示动作已经成功完成。

#### Scenario: 点击期间读取进度

- **WHEN** 任务准备执行 `click` 动作且尚未进入终态
- **THEN** 状态接口的 `message` 返回 `正在点击页面元素`

#### Scenario: 后续动作覆盖前一动作

- **WHEN** 同一任务先后准备执行点击和导航，宿主在导航开始后轮询状态
- **THEN** `message` 返回导航描述，不拼接先前点击描述，不增加历史数组

### Requirement: 导航消息包含目标 URL

系统 MUST 将模型输出的导航目标字符串原样拼接到 `正在导航 ` 后，不补协议、不去除首尾空白，也不解析或校验网址。本地服务地址及 `file://` 等字符串均 MUST 原样展示。缺失、空字符串或非字符串的 URL MUST 退化为 `正在导航`，不得使状态查询失败或改变原有导航校验。

#### Scenario: 导航到完整 URL

- **WHEN** 任务准备导航到 `https://www.baidu.com`
- **THEN** `message` 返回 `正在导航 https://www.baidu.com`

#### Scenario: 导航目标未指定协议

- **WHEN** 导航参数为 `baidu.com`
- **THEN** `message` 返回 `正在导航 baidu.com`

#### Scenario: 本地服务或静态文件目标

- **WHEN** 模型给出的导航目标为 `localhost:3000`、`http://localhost:3000` 或 `file:///private/path`
- **THEN** `message` 原样拼接该地址，展示层不根据协议筛选目标

#### Scenario: 导航参数无法展示

- **WHEN** URL 缺失、为空字符串或不是字符串
- **THEN** 动作描述为 `正在导航`，原有动作失败处理保持有效

### Requirement: 支持现有动作的中文描述

系统 MUST 为现有动作提供固定中文描述：`click` 为 `正在点击页面元素`，`input` 为 `正在输入内容`，`scroll` 为 `正在滚动页面`，`wait` 为 `正在等待`，`go_back` 为 `正在返回上一页`，`switch` 为 `正在切换标签页`，`close` 为 `正在关闭标签页`，`extract` 为 `正在提取页面内容`，`send_keys` 为 `正在发送按键`，`request_takeover` 为 `正在请求人工处理`。`done` MUST 使用 `正在整理任务结果` 作为收尾期间的动作描述，不能提前发布任务成功。无法识别的非空动作 MUST 使用 `正在执行操作`；无动作时 MUST 保留已有消息。

#### Scenario: 不回显输入正文

- **WHEN** 输入动作的参数含普通文字或密码
- **THEN** `message` 均为 `正在输入内容`，不包含输入正文或完整动作参数

#### Scenario: 整理结果尚未结束

- **WHEN** Agent 给出 `done` 动作但任务尚未完成实际收尾
- **THEN** 当前消息可以为 `正在整理任务结果`，`status` 不因该描述提前变为 `completed`

#### Scenario: 未知动作和空动作

- **WHEN** 本步包含无法识别的动作，或本步没有可描述动作
- **THEN** 前者返回通用动作描述，后者保留已有消息，均不因消息格式化而中断任务

### Requirement: 保持终态和人工处理消息优先级

系统 MUST 保留现有取消、人工接管和终态消息的优先级：`cancelling` 展示取消提示，`awaiting_user` 展示人工处理提示；`completed` 展示最终总结，`failed` 和 `cancelled` 展示对应结果。任务进入取消、收尾或终态后，迟到的动作回调 MUST NOT 覆盖这些结果。

#### Scenario: 最终总结覆盖动作消息

- **WHEN** 任务成功结束且已有最终总结
- **THEN** `status` 为 `completed`，`message` 为最终总结，不再返回最近一次动作描述

#### Scenario: 取消或人工接管期间读取状态

- **WHEN** 任务正等待人工处理或已受理取消
- **THEN** 状态接口继续返回对应提示及现有接管字段，动作描述不能掩盖该状态

#### Scenario: 收尾和终态收到旧动作回调

- **WHEN** 任务已进入收尾、取消流程或终态，旧动作回调随后返回
- **THEN** 已确定的状态及消息保持不变

### Requirement: 只读查询与响应兼容

系统 MUST 保持状态接口的路径、鉴权、未知任务响应和字段结构不变，`message` 继续为字符串或 `null`。轮询 MUST 只读取已保存的进度，不触发模型请求、页面读取或桌面操作。消息更新 MUST NOT 把目标导航 URL 当作已到达页面更新 `current_url`，也不得提前增加 `steps_completed`。

#### Scenario: 重复轮询没有执行副作用

- **WHEN** 宿主对运行中的任务连续调用状态接口
- **THEN** 返回已保存的最新描述，动作、模型、页面读取和步骤计数不会因轮询而增加

#### Scenario: 导航尚未到达目标页面

- **WHEN** `message` 已展示导航目标，但该动作尚未结束
- **THEN** `current_url` 和 `steps_completed` 仍依据已有实际进度更新，不从描述中推断导航成功

### Requirement: 仅保存最新动作描述

系统 MUST 对每个任务只保存一个最新消息值，不新增动作历史、消息队列、SSE 或 WebSocket 推送。宿主两次轮询之间发生多个动作时，只保证返回查询时最新的描述。

#### Scenario: 慢轮询只读到最新动作

- **WHEN** 宿主两次轮询之间已经开始多个动作
- **THEN** 第二次轮询返回最新动作描述，不承诺补发中间动作
