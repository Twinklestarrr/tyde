"""显式开启后，在临时本地页面验证真实 OS 点击、中文输入、滚动与截图。"""

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading

import pytest

from browser import session as session_module
from core.executor.coordinate import get_window_info, page_to_screen
from core.executor.os_executor import OSLayer
from core.trajectory.generator import HumanTrajectory


HTML = """<!doctype html><meta charset="utf-8"><title>Shadow core fixture</title>
<style>
body { margin: 0; height: 3000px; background: white; }
#target { position: fixed; left: 120px; top: 160px; width: 200px; height: 90px;
          background: rgb(30, 30, 30); color: white; border: 0; }
#text { position: fixed; left: 120px; top: 290px; width: 300px; height: 120px; }
</style>
<button id="target" data-clicks="0">本地点击验证</button>
<textarea id="text"></textarea>
<script>
document.querySelector('#target').addEventListener('click', function () {
    this.dataset.clicks = Number(this.dataset.clicks) + 1;
    this.style.background = this.dataset.clicks % 2 === 1 ? 'rgb(230, 100, 20)' : 'rgb(30, 30, 30)';
});
window.inputEvents = [];
for (const type of ['keydown', 'beforeinput', 'compositionstart', 'compositionupdate', 'compositionend']) {
    document.querySelector('#text').addEventListener(type, event => {
        window.inputEvents.push({type, key: event.key, data: event.data, composing: event.isComposing});
    });
}
</script>"""


@pytest.fixture
def core_site():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

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


async def read_box(page, selector):
    return json.loads(await page.evaluate("""(selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return {x: box.x, y: box.y, width: box.width, height: box.height};
    }""", selector))


@pytest.mark.asyncio
async def test_native_os_actions_and_scrolled_coordinates(tmp_path, monkeypatch, request):
    if os.environ.get("SHADOW_OS_INTEGRATION") != "1":
        pytest.skip("设置 SHADOW_OS_INTEGRATION=1 后才会控制真实鼠标键盘")
    executable = os.environ.get("SHADOW_BROWSER_EXECUTABLE")
    assert executable and Path(executable).is_file(), "需要有效的 Chrome 可执行文件路径"
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    monkeypatch.setattr(session_module, "PROJECT_ROOT", tmp_path)
    profile_dir = tmp_path / "config/profiles/account_001"
    profile_dir.mkdir(parents=True)
    (profile_dir / "browser_profile.json").write_text(json.dumps({
        "user_data_dir": "config/profiles/account_001/chrome_data",
        "executable_path": executable, "viewport": None,
        "window_size": {"width": 1000, "height": 750},
        "window_position": {"width": 100, "height": 100},
        "enable_default_extensions": False, "captcha_solver": False,
    }), encoding="utf-8")
    executor = OSLayer(timeout=10)
    session = None
    try:
        authorization = asyncio.create_task(asyncio.to_thread(executor.authorize, timeout=120))
        try:
            await asyncio.shield(authorization)
        except BaseException:
            executor.revoke()
            await asyncio.gather(authorization, return_exceptions=True)
            raise
        base_url = request.getfixturevalue("core_site")
        session = session_module.create_session()
        await asyncio.wait_for(session.start(), timeout=40)
        page = await session.get_current_page()
        assert page is not None
        await page.goto(base_url)
        async with asyncio.timeout(10):
            while await page.evaluate("() => document.readyState") != "complete":
                await asyncio.sleep(0.05)
        if sys.platform == "darwin":
            # 验收直接复用生产激活与窗口绑定，避免测试仍依赖旧激活标志。
            processes = await session.cdp_client.send.SystemInfo.getProcessInfo()
            pid = next(item["id"] for item in processes["processInfo"] if item["type"] == "browser")
            await asyncio.to_thread(executor.focus_window, int(pid), await get_window_info(page))
            # 地址栏持焦时 document.hasFocus() 为 False，但页面仍可见；先核对进程与活动页。
            assert await page.evaluate("() => document.visibilityState") == "visible"
        else:
            assert await page.evaluate("() => document.hasFocus()") == "True", "请先让临时 Chrome 页面保持前台焦点"
        import pyautogui

        original_cursor = pyautogui.position()
        trajectory = HumanTrajectory()
        info = await get_window_info(page)
        target = page_to_screen(await read_box(page, "#target"), info)
        region = (target[0] - 60, target[1] - 25, 120, 50)
        before = executor.capture_region(region)
        try:
            print("临时页面 OS 诊断：", {
                "window_info": info, "target": target, "screen_size": tuple(pyautogui.size()),
                "cursor_before": tuple(original_cursor),
                "center_rgb": before.getpixel((before.width // 2, before.height // 2)),
            })
            executor.move_and_click(trajectory.generate(original_cursor, target))
            print("临时页面点击后诊断：", {
                "cursor_after": tuple(pyautogui.position()),
                "page_focus": await page.evaluate("() => document.hasFocus()"),
                "clicks": await page.evaluate("() => document.querySelector('#target').dataset.clicks"),
            })
            async with asyncio.timeout(5):
                while await page.evaluate("() => document.querySelector('#target').dataset.clicks") != "1":
                    await asyncio.sleep(0.05)
            assert executor.screenshot_verify(region, before)
        finally:
            before.close()

        text_target = page_to_screen(await read_box(page, "#text"), await get_window_info(page))
        executor.move_and_click(trajectory.generate(pyautogui.position(), text_target))
        assert await page.evaluate("() => document.hasFocus() && document.activeElement.id === 'text'") == "True"
        expected_text = "Shadow 中文 😀!?\n下一行"
        executor.type_text(expected_text, interval_ms=30)
        try:
            async with asyncio.timeout(5):
                while await page.evaluate("() => document.querySelector('#text').value") != expected_text:
                    await asyncio.sleep(0.05)
        finally:
            # 只记录本地测试文本，区分输入内容错误与焦点丢失。
            print("临时页面输入后诊断：", await page.evaluate("""() => ({
                text: document.querySelector('#text').value,
                focused: document.hasFocus(),
                active_id: document.activeElement.id,
                events: window.inputEvents
            })"""))

        # 将鼠标移出文本框后滚动页面；固定按钮用于识别重复扣除滚动偏移的回归。
        executor.move_and_click(trajectory.generate(pyautogui.position(), target))
        executor.scroll(-8)
        async with asyncio.timeout(5):
            while float(await page.evaluate("() => window.scrollY")) <= 0:
                await asyncio.sleep(0.05)
        scrolled_info = await get_window_info(page)
        assert scrolled_info["scroll_y"] > 0
        target_after_scroll = page_to_screen(await read_box(page, "#target"), scrolled_info)
        executor.move_and_click(trajectory.generate(pyautogui.position(), target_after_scroll))
        async with asyncio.timeout(5):
            while await page.evaluate("() => document.querySelector('#target').dataset.clicks") != "3":
                await asyncio.sleep(0.05)
    finally:
        executor.revoke()
        if session is not None:
            await asyncio.wait_for(session.kill(), timeout=20)
