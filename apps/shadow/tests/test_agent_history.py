"""验证项目历史保存间隔、目录边界与原生输入脱敏。"""

import asyncio
import base64
from io import BytesIO
import json
import threading

import pytest

from config.settings import Settings


@pytest.fixture
def native_history(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    from browser_use.agent.views import AgentHistory, AgentHistoryList, AgentOutput, ActionResult
    from browser_use.browser.views import BrowserStateHistory
    from browser_use.tools.service import Tools
    from agent.views import extend_output_model

    model = extend_output_model(AgentOutput.type_with_custom_actions(Tools().registry.create_action_model(include_actions=["input"])))
    output = model.model_validate({"action":[{"input":{"index":1,"text":"top-secret-value"}}], "read_time_ms":120})
    return AgentHistoryList(history=[AgentHistory(model_output=output, result=[ActionResult(extracted_content="已完成")],
        state=BrowserStateHistory(url="https://example.com",title="本地验证",tabs=[],interacted_element=[]))])


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled, interval, step, saved", [
    (False,1,-1,False),(True,3,1,False),(True,3,3,True),(True,0,2,False),(True,0,-1,True),
])
async def test_history_respects_interval_and_always_saves_on_exit(native_history, tmp_path, enabled, interval, step, saved):
    from agent.memory import history
    assert hasattr(history,"maybe_save_history"), "历史存档尚未实现"
    root = tmp_path / "sessions"
    config = Settings(_env_file=None,SAVE_HISTORY=enabled,HISTORY_SAVE_PATH=str(root),HISTORY_SAVE_INTERVAL=interval)
    path = await history.maybe_save_history(native_history,"task-1",step,config=config,sensitive_data={"password":"top-secret-value"})
    assert (path is not None) is saved
    assert (root / "task-1/history.json").exists() is saved
    if saved:
        text = path.read_text(encoding="utf-8")
        assert "top-secret-value" not in text
        assert json.loads(text)["history"][0]["model_output"]["read_time_ms"] == 120


@pytest.mark.asyncio
async def test_history_cannot_escape_the_task_directory(native_history, tmp_path):
    from agent.memory import history
    assert hasattr(history,"maybe_save_history"), "历史存档尚未实现"
    config = Settings(_env_file=None,HISTORY_SAVE_PATH=str(tmp_path / "sessions"))
    with pytest.raises(ValueError):
        await history.maybe_save_history(native_history,"../escape",-1,config=config)
    assert not (tmp_path / "escape").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("archive", ["screenshot", "history"])
@pytest.mark.parametrize("interruption", ["cancel", "repeat_cancel", "timeout"])
@pytest.mark.parametrize("write_fails", [False, True])
async def test_archive_waits_for_worker_before_propagating_interruption(
    native_history, tmp_path, monkeypatch, archive, interruption, write_fails,
):
    from PIL import Image
    from agent.memory import history

    config = Settings(_env_file=None, SAVE_HISTORY=True, HISTORY_SAVE_INTERVAL=1,
                      HISTORY_SAVE_PATH=str(tmp_path / "sessions"))
    recorder = history.HistoryRecorder("task-1", config=config)
    buffer = BytesIO()
    Image.new("RGB", (2, 2), "white").save(buffer, format="PNG")
    screenshot = base64.b64encode(buffer.getvalue()).decode()
    entered, released, exited = asyncio.Event(), threading.Event(), threading.Event()
    event_loop = asyncio.get_running_loop()
    original = recorder.save_screenshot if archive == "screenshot" else history._save

    def blocked_write(*args):
        event_loop.call_soon_threadsafe(entered.set)
        try:
            assert released.wait(timeout=5), "未释放文件线程"
            if write_fails:
                raise OSError("存档失败")
            return original(*args)
        finally:
            exited.set()

    if archive == "screenshot":
        monkeypatch.setattr(recorder, "save_screenshot", blocked_write)
    else:
        monkeypatch.setattr(history, "_save", blocked_write)

    async def save():
        async with asyncio.timeout(0.03 if interruption == "timeout" else None):
            if archive == "screenshot":
                return await recorder.store_screenshot(screenshot, 1)
            return await history.maybe_save_history(native_history, "task-1", 1, config=config)

    caller = asyncio.create_task(save())
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        if interruption != "timeout":
            caller.cancel()
        done, _ = await asyncio.wait({caller}, timeout=0.06)
        assert not done, "取消或超时不能遗留仍在写入的线程"
        if interruption == "repeat_cancel":
            caller.cancel()
            done, _ = await asyncio.wait({caller}, timeout=0.03)
            assert not done, "再次取消也必须等文件线程结束"
        assert not exited.is_set()
        released.set()
        expected = TimeoutError if interruption == "timeout" else asyncio.CancelledError
        with pytest.raises(expected):
            await caller
        assert exited.is_set()
        target = recorder.directory / ("step_000001.png" if archive == "screenshot" else "history.json")
        assert target.exists() is not write_fails
        assert not list(recorder.directory.glob("*.tmp"))
    finally:
        released.set()
        await asyncio.gather(caller, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("archive", ["screenshot", "history"])
async def test_archive_write_failure_is_not_swallowed(native_history, tmp_path, monkeypatch, archive):
    from agent.memory import history

    config = Settings(_env_file=None, SAVE_HISTORY=True, HISTORY_SAVE_PATH=str(tmp_path / "sessions"))

    def fail(*args):
        raise OSError("存档失败")

    recorder = history.HistoryRecorder("task-1", config=config)
    monkeypatch.setattr(recorder, "save_screenshot", fail)
    monkeypatch.setattr(history, "_save", fail)
    with pytest.raises(OSError, match="存档失败"):
        if archive == "screenshot":
            await recorder.store_screenshot("", 1)
        else:
            await history.maybe_save_history(native_history, "task-1", -1, config=config)
