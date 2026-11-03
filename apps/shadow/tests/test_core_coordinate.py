"""验证视口坐标换算、显式缩放与原生窗口信息解析。"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from core.executor import coordinate


def convert(box, info, **kwargs):
    assert hasattr(coordinate, "page_to_screen"), "坐标换算尚未实现"
    return coordinate.page_to_screen(box, info, **kwargs)


def test_viewport_coordinates_do_not_subtract_scroll_again():
    result = convert(
        {"x": 100, "y": 200, "width": 80, "height": 40},
        {"window_x": 30, "window_y": 50, "chrome_height": 90,
         "scroll_x": 300, "scroll_y": 900},
    )

    assert result == (170, 360)


def test_window_border_and_explicit_os_scale_are_applied_once():
    result = convert(
        {"x": 100, "y": 200, "width": 80, "height": 40},
        {"window_x": 30, "window_y": 50, "chrome_width": 6, "chrome_height": 90},
        dpi_scale=1.5,
    )

    assert result == (264, 540)


def test_retina_pixel_ratio_does_not_implicitly_scale_mouse_coordinates():
    result = convert(
        {"x": 100, "y": 200, "width": 80, "height": 40},
        {"window_x": 30, "window_y": 50, "chrome_height": 90, "device_pixel_ratio": 2},
    )

    assert result == (170, 360)


@pytest.mark.parametrize("box, scale", [
    ({"x": float("nan"), "y": 0, "width": 10, "height": 10}, 1),
    ({"x": 0, "y": 0, "width": 0, "height": 10}, 1),
    ({"x": 0, "y": 0, "width": 10, "height": -1}, 1),
    ({"x": 0, "y": 0, "width": 10, "height": 10}, 0),
    ({"x": 0, "y": 0, "width": 10, "height": 10}, float("inf")),
])
def test_invalid_geometry_cannot_produce_a_click_position(box, scale):
    with pytest.raises(ValueError):
        convert(box, {"window_x": 0, "window_y": 0, "chrome_height": 90}, dpi_scale=scale)


def test_center_outside_viewport_is_rejected():
    with pytest.raises(ValueError):
        convert(
            {"x": 100, "y": 850, "width": 80, "height": 40},
            {"window_x": 0, "window_y": 0, "chrome_height": 90,
             "viewport_width": 1000, "viewport_height": 800},
        )


@pytest.mark.asyncio
async def test_window_info_decodes_the_native_evaluate_json_string():
    assert hasattr(coordinate, "get_window_info"), "窗口信息读取尚未实现"
    info = {"window_x": 30, "window_y": 50, "chrome_height": 90,
            "chrome_width": 0, "viewport_width": 1000, "viewport_height": 800,
            "device_pixel_ratio": 2, "scroll_x": 0, "scroll_y": 900}
    page = SimpleNamespace(evaluate=AsyncMock(return_value=json.dumps(info)))

    result = await coordinate.get_window_info(page)

    assert result == info
    assert convert({"x": 100, "y": 200, "width": 80, "height": 40}, result) == (170, 360)


@pytest.mark.asyncio
async def test_window_info_preserves_cdp_errors():
    assert hasattr(coordinate, "get_window_info"), "窗口信息读取尚未实现"
    page = SimpleNamespace(evaluate=AsyncMock(side_effect=RuntimeError("模拟 CDP 断开")))

    with pytest.raises(RuntimeError, match="CDP"):
        await coordinate.get_window_info(page)


@pytest.mark.asyncio
async def test_window_info_rejects_non_object_results():
    assert hasattr(coordinate, "get_window_info"), "窗口信息读取尚未实现"
    page = SimpleNamespace(evaluate=AsyncMock(return_value="[]"))

    with pytest.raises(ValueError):
        await coordinate.get_window_info(page)


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [
    {"is_top_level": False}, {"viewport_scale": 2}, {"chrome_width": -20},
])
async def test_unsupported_window_geometry_is_not_used_for_clicking(extra):
    assert hasattr(coordinate, "get_window_info"), "窗口信息读取尚未实现"
    info = {"window_x": 30, "window_y": 50, "chrome_height": 90, "chrome_width": 0, **extra}
    page = SimpleNamespace(evaluate=AsyncMock(return_value=json.dumps(info)))

    with pytest.raises(ValueError):
        await coordinate.get_window_info(page)
