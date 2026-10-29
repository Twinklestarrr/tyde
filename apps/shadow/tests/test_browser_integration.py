"""按需启动本地 Chrome，验证 DOM、截图、事件与会话持久化。"""

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading

from PIL import Image
import pytest

from browser import session as session_module
from browser.perception import get_page_state_summary
from browser.recorder import ScreenshotRecorder
from config.settings import Settings


PAGES = {
    "/page": "<button>提交</button>",
    "/cookie": "<p>检查持久化</p>",
    "/dialog": '<p>弹窗事件验证</p><script>setTimeout(() => alert("本地事件验证"), 300)</script>',
}


@pytest.fixture
def browser_site():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = PAGES.get(self.path, "")
            data = ('<!doctype html><meta charset="utf-8"><body>' + body + "</body>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            if self.path == "/page":
                self.send_header("Set-Cookie", "shadow_fixture=kept; Max-Age=3600; Path=/")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


async def navigate(page, base_url, path):
    await page.goto(base_url + path)
    async with asyncio.timeout(10):
        while True:
            if await page.evaluate("() => document.readyState") == "complete":
                if await page.evaluate("() => location.pathname") == path:
                    return
            await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_native_browser_perception_and_persistence(tmp_path, monkeypatch, request):
    executable = os.environ.get("SHADOW_BROWSER_EXECUTABLE")
    if not executable:
        pytest.skip("设置 SHADOW_BROWSER_EXECUTABLE 后运行本地 Chrome 集成验证")
    assert Path(executable).is_file(), "Chrome 可执行文件不存在"
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    monkeypatch.setattr(session_module, "PROJECT_ROOT", tmp_path)
    config = Settings(
        _env_file=None,
        HISTORY_SAVE_PATH=str(tmp_path / "sessions"), SAVE_GIF=True,
    )
    profile_dir = tmp_path / "config/profiles/account_001"
    profile_dir.mkdir(parents=True)
    (profile_dir / "browser_profile.json").write_text(json.dumps({
        "user_data_dir": "config/profiles/account_001/chrome_data",
        "viewport": {"width": 1440, "height": 900},
        "executable_path": executable,
        "enable_default_extensions": False,
        "captcha_solver": False,
    }), encoding="utf-8")
    desired = (profile_dir / "chrome_data").resolve()

    # 配置好可选集成环境后再监听端口，常规测试不会启动服务或浏览器。
    base_url = request.getfixturevalue("browser_site")
    observed_events = []

    async def consumer(event):
        observed_events.append(event)

    session = session_module.create_session(on_event=consumer)
    try:
        await asyncio.wait_for(session.start(), timeout=40)
        assert Path(session.browser_profile.user_data_dir) == desired
        page = await session.get_current_page()
        assert page is not None
        await navigate(page, base_url, "/page")
        before = await page.evaluate("() => document.body.innerHTML")
        state = await asyncio.wait_for(get_page_state_summary(session), timeout=35)
        assert state.dom_state.selector_map
        assert state.screenshot
        assert await page.evaluate("() => document.body.innerHTML") == before

        recorder = ScreenshotRecorder("native", config=config)
        first = recorder.save_screenshot(1, state.screenshot)
        await navigate(page, base_url, "/dialog")
        async with asyncio.timeout(5):
            while not any(event.event_type == "DialogOpenedEvent" for event in observed_events):
                await asyncio.sleep(0.05)
        dialogs = [event for event in observed_events if event.event_type == "DialogOpenedEvent"]
        assert len(dialogs) == 1
        assert dialogs[0].message == "本地事件验证"
        next_state = await get_page_state_summary(session)
        assert "[alert] 本地事件验证" in next_state.closed_popup_messages
        recorder.save_screenshot(2, next_state.screenshot)
        gif = recorder.finish()
        with Image.open(first) as image:
            assert image.format == "PNG"
        with Image.open(gif) as image:
            assert image.format == "GIF"
            assert image.n_frames == 2
    finally:
        await asyncio.wait_for(session.kill(), timeout=20)

    assert any(event.event_type == "BrowserConnectedEvent" for event in observed_events)
    assert any(event.event_type == "BrowserStoppedEvent" for event in observed_events)
    assert (desired / "Default" / "Preferences").exists()
    restarted = session_module.create_session()
    try:
        await asyncio.wait_for(restarted.start(), timeout=40)
        page = await restarted.get_current_page()
        assert page is not None
        await navigate(page, base_url, "/cookie")
        cookie = await page.evaluate("() => document.cookie.includes('shadow_fixture=kept')")
        assert cookie.lower() == "true"
    finally:
        await asyncio.wait_for(restarted.kill(), timeout=20)
