# Shadow 独立项目迁入记录

项目存放于 `tyde/apps/shadow`，继续作为独立 Python 项目运行。
本次没有接入 tyde 的应用启动、工作区命令或安装包构建。

已迁入源码及未被 Git 跟踪的本地文件，包括 `.env`、账号配置、
调试页、技术文档和 `tests/agent_evaluation_15_cases.xlsx`。
账号配置和凭据继续由 tyde 根目录中限定 `/apps/shadow/` 的规则忽略。
原 Shadow 目录及其 `.gitignore` 保留。

旧 `.git`、`.venv`、Python 缓存、系统杂项、`data/` 运行历史和
Chrome 用户数据没有迁入。旧浏览器数据和任务历史保留在原目录；
新位置首次运行会创建浏览器用户数据，需要重新登录。
PID 与 token 由新服务生成，不复用旧文件。
`.env` 的 `PID_FILE_PATH` 明确指向当前 `apps/shadow/data/agent.pid`。
其他默认数据路径由本项目的 `PROJECT_ROOT` 自动计算。

从 tyde 根目录运行：

```bash
cd apps/shadow
uv sync --locked
uv run python main.py
```

运行测试：

```bash
cd apps/shadow
uv run pytest -q
```

迁移验证只运行自动化测试，不启动实际浏览器任务或调用真实模型。
