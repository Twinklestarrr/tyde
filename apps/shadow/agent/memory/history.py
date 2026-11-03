"""复用原生历史序列化，按任务存档，并补充节奏字段与已知敏感值脱敏。"""

import asyncio
import json
from pathlib import Path
import tempfile

from browser_use.utils import collect_sensitive_data_values, redact_sensitive_string

from browser.recorder import ScreenshotRecorder
from config.settings import Settings, settings


async def _write_archive(function, *args):
    """取消只停止后续流程，已提交的文件写入须等线程退出。"""
    worker = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        # 取出写入异常，避免无人接收；已有取消仍优先传播。
        if not worker.cancelled():
            worker.exception()
        raise


class HistoryRecorder(ScreenshotRecorder):
    """接入原生截图存储扩展点，避免绕过 SAVE_HISTORY 或重复保存截图。"""

    async def store_screenshot(self, screenshot_b64: str, step_number: int) -> str | None:
        path = await _write_archive(self.save_screenshot, step_number, screenshot_b64)
        return str(path) if path is not None else None

    async def finish_async(self) -> Path | None:
        """等待 GIF 汇总完成，重复取消也不遗留写入线程。"""
        return await _write_archive(self.finish)


def _save(history, path: Path, sensitive_data):
    data = history.model_dump(sensitive_data=sensitive_data)
    for row, item in zip(data["history"], history.history):
        if row["model_output"] is not None:
            for name in ("read_time_ms", "action_type"):
                row["model_output"][name] = getattr(item.model_output, name, None)
    values = collect_sensitive_data_values(sensitive_data)

    def redact(value):
        if isinstance(value, str):
            return redact_sensitive_string(value, values)
        if isinstance(value, dict):
            return {key:redact(item) for key,item in value.items()}
        if isinstance(value, list):
            return [redact(item) for item in value]
        return value

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(redact(data), stream, ensure_ascii=False, indent=2)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return path


async def maybe_save_history(history, task_id: str, step_num: int, *, config: Settings | None = None, sensitive_data=None):
    """step_num=-1 表示结束；间隔为零时仅在结束保存，不写空历史。"""
    config = config if config is not None else settings
    if not config.SAVE_HISTORY or not history.history:
        return None
    if step_num != -1 and (config.HISTORY_SAVE_INTERVAL == 0 or step_num <= 0 or step_num % config.HISTORY_SAVE_INTERVAL):
        return None
    directory = HistoryRecorder(task_id, config=config).directory
    known = dict(sensitive_data or {})
    if config.LLM_API_KEY:
        known["llm_api_key"] = config.LLM_API_KEY
    return await _write_archive(_save, history, directory / "history.json", known)
