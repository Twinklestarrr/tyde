"""验证第一版点流保留端点并拒绝无效坐标。"""

import pytest

from core.trajectory import generator


def generate(start, end):
    assert hasattr(generator, "HumanTrajectory"), "轨迹接口尚未实现"
    return generator.HumanTrajectory().generate(start, end)


def test_first_version_keeps_start_and_end_with_nonnegative_timing():
    points = generate((10.5, 20.5), (300, 400))

    assert [point[:2] for point in points] == [(10.5, 20.5), (300, 400)]
    assert all(isinstance(point[2], int) and point[2] >= 0 for point in points)


@pytest.mark.parametrize("start, end", [
    ((float("nan"), 20), (300, 400)),
    ((10, 20), (300, float("inf"))),
])
def test_invalid_endpoint_cannot_enter_the_os_point_stream(start, end):
    with pytest.raises(ValueError):
        generate(start, end)
