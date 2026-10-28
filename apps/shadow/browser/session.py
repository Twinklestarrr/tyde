"""从账号配置创建 browser-use 原生浏览器会话。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

from config.settings import PROJECT_ROOT

if TYPE_CHECKING:
    from browser_use.browser.session import BrowserSession
    from browser.events import BrowserEventCallback


def create_session(
    account_id: str = "account_001", *, on_event: BrowserEventCallback | None = None
) -> BrowserSession:
    """加载配置并构造会话；调用方通过 start() 显式启动浏览器。"""
    profiles_root = (PROJECT_ROOT / "config" / "profiles").resolve()
    profile_path = (profiles_root / account_id / "browser_profile.json").resolve()
    if not profile_path.is_relative_to(profiles_root):
        raise ValueError("账号配置路径必须位于 config/profiles 目录内")
    profile_data = json.loads(profile_path.read_text(encoding="utf-8"))
    raw_user_data_dir = profile_data.get("user_data_dir")
    if not raw_user_data_dir:
        raise ValueError("账号配置必须提供 user_data_dir")
    user_data_dir = Path(raw_user_data_dir).expanduser()
    if not user_data_dir.is_absolute():
        user_data_dir = PROJECT_ROOT / user_data_dir
    profile_data.pop("user_data_dir")

    # 旧 viewport 改作真实窗口尺寸，避免视口仿真与屏幕上的 Chrome 大小不一致。
    viewport = profile_data.pop("viewport", None)
    if viewport and not profile_data.get("window_size"):
        profile_data["window_size"] = viewport

    # 账号配置保留原生字段，项目统一控制界面和只读感知策略。
    profile_data.update(
        headless=False,
        no_viewport=True,
        device_scale_factor=None,
        highlight_elements=False,
        dom_highlight_elements=False,
    )

    # 延迟导入，避免仅导入本模块就触发第三方的配置目录初始化。
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.session import BrowserSession

    profile = BrowserProfile.model_validate(profile_data, extra="forbid")
    session = BrowserSession(browser_profile=profile)
    # 0.13.11 构造时会克隆 Chrome 目录；构造后绑定项目专用目录以持久保存登录态。
    session.browser_profile.user_data_dir = user_data_dir.resolve()
    from browser.events import attach_browser_events

    attach_browser_events(session, on_event)
    return session
