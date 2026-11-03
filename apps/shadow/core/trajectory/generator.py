"""第一版只提供带时序的起终点；拟人曲线留待后续扩展。"""

import math


class HumanTrajectory:
    """保持点流接口稳定，点到达后的等待时长单位为毫秒。"""

    def generate(
        self, start: tuple[float, float], end: tuple[float, float]
    ) -> list[tuple[float, float, int]]:
        """返回起点、终点各一次，不增加曲线、抖动或随机延迟。"""
        for point in (start, end):
            if len(point) != 2 or any(
                isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                for value in point
            ):
                raise ValueError("轨迹端点必须包含两个有限坐标")
        return [(start[0], start[1], 10), (end[0], end[1], 10)]
