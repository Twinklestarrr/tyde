"""扩展原生每步动作输出，不占用最终结果的 output_model_schema。"""

from typing import Literal

from browser_use.agent.views import AgentOutput
from pydantic import BaseModel, Field, create_model


class TimingFields(BaseModel):
    """阅读时长属于当前一步；实际抖动由执行节奏模块处理。"""

    read_time_ms: int | None = Field(default=None, ge=0)
    action_type: Literal["navigate", "click", "type", "scroll", "wait"] | None = None


class TimedAgentOutput(AgentOutput, TimingFields):
    """保留原生推理和动作字段，增加可选的节奏信息。"""


def extend_output_model(model: type[AgentOutput]) -> type[AgentOutput]:
    """扩展已绑定当前动作表的模型，保留普通、无推理与快速模式的差异。"""
    return create_model(f"Timed{model.__name__}", __base__=(model, TimingFields))
