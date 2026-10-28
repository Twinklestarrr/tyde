"""将主页面视口 CSS 坐标换算为 OS 输入坐标，不重复扣除滚动。"""

from __future__ import annotations

import json
import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from browser_use.actor.page import Page


def _number(value: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} 必须是有限数值")
    return float(value)


def page_to_screen(
    node_box: dict, window_info: dict, dpi_scale: float = 1.0
) -> tuple[int, int]:
    """输入主页面视口包围盒；dpi_scale 须由调用方校准，不等于 devicePixelRatio。"""
    x, y, width, height = (_number(node_box[key], key) for key in ("x", "y", "width", "height"))
    scale = _number(dpi_scale, "dpi_scale")
    if width <= 0 or height <= 0 or scale <= 0:
        raise ValueError("元素尺寸与坐标倍率必须大于零")
    center_x, center_y = x + width / 2, y + height / 2
    for center, key in ((center_x, "viewport_width"), (center_y, "viewport_height")):
        if key in window_info and not 0 <= center < _number(window_info[key], key):
            raise ValueError("元素中心不在当前视口内，需重新定位或滚动后再读取")
    window_x = _number(window_info["window_x"], "window_x")
    window_y = _number(window_info["window_y"], "window_y")
    chrome_width = _number(window_info.get("chrome_width", 0), "chrome_width")
    chrome_height = _number(window_info["chrome_height"], "chrome_height")
    if chrome_width < 0 or chrome_height < 0:
        raise ValueError("窗口边框偏移不能为负数，请检查缩放或设备模拟")
    return (
        round((window_x + chrome_width + center_x) * scale),
        round((window_y + chrome_height + center_y) * scale),
    )


async def get_window_info(page: Page) -> dict:
    """读取桌面 Chrome 窗口信息；要求 100% 缩放、无停靠开发者工具与设备模拟。"""
    result = await page.evaluate("""() => {
        const border = (window.outerWidth - window.innerWidth) / 2;
        return {
            window_x: window.screenX,
            window_y: window.screenY,
            window_width: window.outerWidth,
            window_height: window.outerHeight,
            chrome_width: border,
            chrome_height: window.outerHeight - window.innerHeight - border,
            viewport_width: window.innerWidth,
            viewport_height: window.innerHeight,
            scroll_x: window.scrollX,
            scroll_y: window.scrollY,
            device_pixel_ratio: window.devicePixelRatio,
            viewport_scale: window.visualViewport ? window.visualViewport.scale : 1,
            is_top_level: window === window.top
        };
    }""")
    info = json.loads(result)
    if not isinstance(info, dict):
        raise ValueError("浏览器窗口信息必须是 JSON 对象")
    if not info.get("is_top_level", True) or info.get("viewport_scale", 1) != 1:
        raise ValueError("窗口信息仅支持未进行手势缩放的主页面")
    for key in ("chrome_width", "chrome_height"):
        if _number(info.get(key, 0), key) < 0:
            raise ValueError("窗口几何不适用，请检查浏览器缩放或设备模拟")
    return info
