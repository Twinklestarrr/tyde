"""按任务写入结构化审计；不接收动作参数、页面内容或原始异常。"""

import asyncio
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
import os
from pathlib import Path
import threading
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from config.settings import PROJECT_ROOT


AuditEvent = Literal["task_start", "task_end", "authorization_start", "authorization_end",
                     "action_start", "action_end", "takeover", "resume_start", "resume_end"]
AuditAction = Literal["click", "input", "scroll", "send_keys", "navigate", "go_back",
                      "switch", "close", "wait", "extract", "done", "request_takeover", "unknown"]
AuditOutcome = Literal["completed", "failed", "cancelled", "unknown"]
AuditErrorCode = Literal["authorization_denied", "authorization_timeout", "authorization_failed",
                         "action_failed", "action_cancelled", "task_failed", "task_cancelled",
                         "resume_not_ready", "resume_check_failed", "resume_cancelled", "browser_unavailable"]
_WRITE_LOCK = threading.Lock()


class AuditError(RuntimeError):
    """审计不可用，当前任务必须停止；不能继续或重试业务动作。"""


class AuditRecord(BaseModel):
    """只允许固定字段和错误类别，避免把业务正文写入审计。"""

    model_config = ConfigDict(extra="forbid", frozen=True)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    event: AuditEvent
    task_id: str
    account_id: str | None = None
    action_id: str | None = None
    step_number: int | None = Field(default=None, ge=0)
    action: AuditAction | None = None
    outcome: AuditOutcome | None = None
    error_code: AuditErrorCode | None = None


class AuditLog:
    """延迟创建 JSONL 文件；同进程串行写入，故障对本任务持续有效。"""

    def __init__(self, task_id: str, account_id: str | None = None, *, path=None,
                 on_failure: Callable[[], None] | None = None,
                 max_bytes: int = 5 * 1024 * 1024, backup_count: int = 3):
        if max_bytes <= 0 or backup_count < 1:
            raise ValueError("审计文件大小和备份数量必须大于零")
        self.task_id, self.account_id = task_id, account_id
        self.path = Path(path) if path is not None else PROJECT_ROOT / "data/logs/audit.log"
        self.step_number: int | None = None
        self.max_bytes, self.backup_count = max_bytes, backup_count
        self._on_failure = on_failure
        self._failed = False
        self._pending: set[asyncio.Task] = set()

    def _fail(self) -> None:
        if not self._failed:
            self._failed = True
            if self._on_failure is not None:
                with suppress(Exception):
                    self._on_failure()

    def raise_if_failed(self) -> None:
        if self._failed:
            raise AuditError("操作审计写入失败，任务已停止") from None

    def _written(self, worker) -> None:
        if worker.cancelled() or worker.exception() is not None:
            self._fail()
        self._pending.discard(worker)

    async def record(self, event: AuditEvent, *, action_id=None, step_number=None,
                     action: AuditAction | None = None, outcome: AuditOutcome | None = None,
                     error_code: AuditErrorCode | None = None) -> None:
        self.raise_if_failed()
        try:
            line = (AuditRecord(event=event, task_id=self.task_id, account_id=self.account_id,
                action_id=action_id, step_number=self.step_number if step_number is None else step_number,
                action=action, outcome=outcome, error_code=error_code).model_dump_json() + "\n").encode("utf-8")
        except Exception:
            self._fail()
            raise AuditError("操作审计字段无效，任务已停止") from None
        worker = asyncio.create_task(asyncio.to_thread(self._append, line))
        self._pending.add(worker)
        worker.add_done_callback(self._written)
        try:
            await asyncio.shield(worker)
        except asyncio.CancelledError:
            # 已开始的文件线程不能取消；再次取消也须等实际线程退出。
            while not worker.done():
                try:
                    await asyncio.shield(worker)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            raise
        except Exception:
            self._fail()
            raise AuditError("操作审计写入失败，任务已停止") from None
        self.raise_if_failed()

    async def drain(self) -> None:
        """任务终态之前等待已提交的记录，不重试失败的写入。"""
        cancelled = False
        while self._pending:
            try:
                await asyncio.shield(asyncio.gather(*self._pending, return_exceptions=True))
            except asyncio.CancelledError:
                cancelled = True
        if cancelled:
            raise asyncio.CancelledError
        self.raise_if_failed()

    def _append(self, line: bytes) -> None:
        with _WRITE_LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.exists() and self.path.stat().st_size and self.path.stat().st_size + len(line) > self.max_bytes:
                for index in range(self.backup_count, 0, -1):
                    previous = self.path if index == 1 else self.path.with_name(f"{self.path.name}.{index - 1}")
                    if previous.exists():
                        previous.replace(self.path.with_name(f"{self.path.name}.{index}"))
            flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(self.path, flags, 0o600)
            with os.fdopen(descriptor, "ab") as stream:
                stream.write(line)
                stream.flush()
