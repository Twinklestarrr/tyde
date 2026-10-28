"""宿主与本地 Agent 通信使用的请求和响应结构。"""

from typing import Any

from pydantic import BaseModel, Field, field_validator


class TaskRequest(BaseModel):
    account_id: str
    params: dict[str, Any] = Field(description="task 为非空任务说明，其余字段为补充业务参数")

    @field_validator("params")
    @classmethod
    def require_task_description(cls, value):
        task = value.get("task")
        if not isinstance(task, str) or not task.strip():
            raise ValueError("params.task 必须为非空字符串")
        return value


class TaskResponse(BaseModel):
    task_id: str
    status: str  # 提交成功返回 accepted，表示已受理，执行结果另行查询。
    steps_completed: int = Field(default=0, ge=0)
    screenshot: str | None = None


class ProgressResponse(BaseModel):
    task_id: str
    status: str  # 任务业务状态，例如 running、completed、failed。
    steps_completed: int = Field(ge=0)
    current_url: str | None = None
    message: str | None = None
    takeover_reason: str | None = None
    login_required: bool = False
    captcha_detected: bool = False


class ResumeResponse(BaseModel):
    resumed: bool
    message: str | None = None


class CancelResponse(BaseModel):
    task_id: str
    status: str  # 仅表示已接收取消，清理完成前返回 cancelling。
