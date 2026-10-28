# shadow-agent

基于 browser-use 的桌面操控 Agent，通过 CDP 感知页面，通过系统键鼠执行操作。已接通任务提交、后台执行、状态查询、人工恢复与取消。

使用 Python 3.12 和 uv：

```bash
uv sync --locked
cp .env.example .env
uv run python main.py
```

API 默认地址为 `http://127.0.0.1:29321`。模型密钥可填写 `.env` 的 `LLM_API_KEY`，或由宿主携带 Bearer token 调用 `PUT /config/llm`：

```json
{ "api_key": "你的模型密钥" }
```

成功返回 `{"configured":true}`；接口提交的密钥仅保存在内存，重启后需重传。任务运行或清理期间修改返回 409，未配置密钥提交任务返回 503。

系统键鼠操作默认超时 10 秒（`OS_CHANNEL_TIMEOUT`）；导航后的页面加载独立等待最多 30 秒（`PAGE_LOAD_TIMEOUT`），可在 `.env` 中调整。

本地调试页为 `tests/web_debug/index.html`，启动后访问 `http://127.0.0.1:29321/debug`。该目录已忽略，不随仓库提交；页面缺失时入口返回 404。

浏览器账号配置参考 [配置模板](config/profiles/browser_profile.example.json)，保存到 `config/profiles/<account_id>/browser_profile.json`。桌面操作前需确认接管并授予系统权限。

调用 `POST /task` 时携带 `Authorization: Bearer <token>`，token 从 `TOKEN_FILE_PATH` 读取。请求示例：

```json
{ "account_id": "account_001", "params": { "task": "访问 https://example.com 并读取页面标题" } }
```

受理返回 HTTP 202 与 `task_id`，后台执行；已有任务运行或清理时返回 409。

携带同一 token 调用 `GET /task/<task_id>/status`，读取状态、已完成步骤、最近页面 URL 和人工接管提示；未知任务返回 404。

人工处理完成后调用 `POST /task/<task_id>/resume`，无需请求体；复核并重新授权后，会主动激活暂停时的原任务窗口和标签页、清除旧元素索引并重新读取页面，完成后才返回 `{"resumed": true}` 并继续任务。复核、授权或页面恢复未通过时返回 `{"resumed": false, "message": "..."}`，保留浏览器并继续等待。

取消调用 `POST /task/<task_id>/cancel`，返回 202 与 `status: cancelling`；通过状态接口确认最终清理结果。已结束任务返回 409。

运行测试：`uv run pytest -q`。

macOS M 系列交付包：`uv run python deploy/build_macos.py`，输出到 `dist/`；使用方式见 [部署说明](deploy/部署说明.md)。
