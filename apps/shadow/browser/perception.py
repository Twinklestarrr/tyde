"""通过 browser-use 原生接口读取页面状态，不触发页面交互。"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.views import BrowserStateSummary


async def get_page_state_summary(session: BrowserSession) -> BrowserStateSummary:
    """读取新鲜 DOM 与截图，保留原生结构和错误信息。"""
    return await session.get_browser_state_summary(cached=False)
