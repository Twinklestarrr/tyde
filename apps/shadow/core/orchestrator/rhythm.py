"""根据模型估算的阅读时长，在执行动作前异步等待。"""

import asyncio
import random

from config.settings import Settings, settings


class RhythmEngine:
    """阅读时长加随机抖动，并遵守配置中的最小等待时间。"""

    def __init__(self, config: Settings | None = None):
        self.config = config if config is not None else settings

    async def consume_read_time(
        self, read_time_ms: int | None, action_type: str | None = None
    ) -> None:
        """缺少阅读估计时只应用最小等待；取消直接向上传播。"""
        if read_time_ms is not None and (type(read_time_ms) is not int or read_time_ms < 0):
            raise ValueError("阅读时长必须为非负整数或 None")
        jitter = self.config.READ_TIME_JITTER
        factor = random.uniform(1 - jitter, 1 + jitter)
        wait_ms = max(int((read_time_ms or 0) * factor), self.config.MIN_ACTION_DELAY_MS)
        await asyncio.sleep(wait_ms / 1000)
