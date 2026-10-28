"""为原生任务结束 Judge 配置模型，轨迹、截图与判定沿用原库。"""

from agent.planner import build_llm
from config.settings import Settings, settings


def build_judge_llm(config: Settings | None = None):
    """Judge 与主模型共用提供方和密钥，模型名使用 JUDGE_MODEL_NAME。"""
    config = config if config is not None else settings
    return build_llm(config, model=config.JUDGE_MODEL_NAME)
