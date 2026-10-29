"""消费模型请求的人工接管事件，保存状态并提供步末等待门。"""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Literal

from bubus import BaseEvent, EventBus
from pydantic import BaseModel, ConfigDict, Field, model_validator

from auth.audit import AuditError, AuditLog

TakeoverReason = Literal["login_required", "captcha_detected", "verification_required"]

MESSAGES: dict[TakeoverReason, str] = {
    "login_required": "检测到登录入口，请人工登录后点击'已完成'",
    "captcha_detected": "检测到验证码，请人工完成验证后点击'已完成'",
    "verification_required": "检测到二次验证，请人工完成后点击'已完成'",
}

RESUME_MESSAGES = {
    "login_required": "仍未检测到登录，请人工登录后再次点击'已完成'",
    "captcha_detected": "验证码仍未完成，请人工处理后再次点击'已完成'",
    "verification_required": "二次验证仍未完成，请人工处理后再次点击'已完成'",
    "uncertain": "无法确认登录或验证是否完成，请确认后再次点击'已完成'",
    "authorization_required": "桌面授权未完成，请再次点击'已完成'并确认授权",
    "task_page_required": "未能切回原任务页面，请保留任务窗口并再次点击'已完成'",
}


class ResumeConflictError(RuntimeError):
    """当前状态不能接收恢复或取消指令，供后续 API 映射为冲突响应。"""


class ResumeFatalError(RuntimeError):
    """浏览器已不可用等不可恢复错误，须退出原任务。"""


class ResumeCheck(BaseModel):
    """只读复核结果，不包含可执行动作或任意宿主提示。"""

    model_config = ConfigDict(extra="forbid")
    can_resume: bool = Field(strict=True)
    reason: TakeoverReason | Literal["uncertain"] | None = None

    @model_validator(mode="after")
    def check_consistency(self):
        if self.can_resume and self.reason is not None:
            raise ValueError("复核通过时不能同时报告未解除的障碍")
        return self


class ResumeResult(BaseModel):
    """恢复请求的实际结果；成功前必须完成复核、授权和状态切换。"""

    resumed: bool
    message: str | None = None


class RequestTakeoverAction(BaseModel):
    """模型只报告障碍原因，任务标识由代码绑定。"""

    model_config = ConfigDict(extra="forbid")
    reason: TakeoverReason


class UserTakeoverRequestedEvent(BaseEvent[None]):
    """沿用原生事件总线传递业务请求，不执行浏览器输入。"""

    task_id: str
    reason: TakeoverReason


@dataclass(frozen=True)
class TakeoverSnapshot:
    """一次替换完整快照，状态查询不会触发事件或模型。"""

    task_id: str
    status: Literal["running", "awaiting_user", "cancelling", "cancelled"] = "running"
    message: str | None = None
    takeover_reason: TakeoverReason | Literal["authorization_required"] | None = None
    login_required: bool = False
    captcha_detected: bool = False


class TakeoverManager:
    """每个任务独立持有；有效请求立即返回，等待发生在步末。"""

    def __init__(self, task_id: str, revoke: Callable[[], None], *, audit: AuditLog | None = None):
        self.task_id = task_id
        self.revoke = revoke
        self.audit = audit
        self._snapshot = TakeoverSnapshot(task_id)
        self._gate = asyncio.Event()
        self._gate.set()
        self._bus: EventBus | None = None
        self._closed = False
        self._resume_request: asyncio.Future[ResumeResult] | None = None
        self._resume_worker: asyncio.Task | None = None

    @property
    def snapshot(self) -> TakeoverSnapshot:
        return self._snapshot

    @property
    def resume_in_flight(self) -> bool:
        return self._resume_request is not None

    def bind(self, bus: EventBus) -> None:
        """订阅当前任务使用的浏览器事件总线。"""
        if self._closed or self._bus is not None:
            raise RuntimeError("人工接管管理器不能重复绑定")
        bus.on(UserTakeoverRequestedEvent, self._handle_event)
        self._bus = bus

    async def _handle_event(self, event: UserTakeoverRequestedEvent) -> None:
        if self._closed or self._bus is None or event.task_id != self.task_id:
            raise RuntimeError("人工接管事件不属于当前运行任务")
        if self._snapshot.status == "awaiting_user":
            return
        if self._snapshot.status != "running":
            raise ResumeConflictError("任务正在取消或已结束，不能请求人工接管")
        # 先撤销授权；记录写入后重新检查取消，避免迟到事件恢复等待状态。
        self._gate.clear()
        self.revoke()
        if self.audit is not None:
            await self.audit.record("takeover", outcome="completed")
        if self._closed or self._snapshot.status != "running":
            raise ResumeConflictError("任务正在取消或已结束，不能请求人工接管")
        self._snapshot = TakeoverSnapshot(
            task_id=self.task_id,
            status="awaiting_user",
            message=MESSAGES[event.reason],
            takeover_reason=event.reason,
            login_required=event.reason == "login_required",
            captcha_detected=event.reason == "captcha_detected",
        )

    async def request(self, bus: EventBus, reason: TakeoverReason) -> None:
        """等待事件处理确认，不在动作中等待用户。"""
        if self._closed or bus is not self._bus:
            raise RuntimeError("人工接管未绑定当前浏览器事件总线")
        event = bus.dispatch(UserTakeoverRequestedEvent(task_id=self.task_id, reason=reason))
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)
        # None 是正常事件返回值，仍须确认确有消费者完成了状态更新。
        if not event.event_results or self._snapshot.status != "awaiting_user":
            raise RuntimeError("人工接管事件没有消费者完成状态更新")

    async def request_resume(self) -> ResumeResult:
        """宿主声明已处理完成，只唤醒步末复核，不直接放行业务步骤。"""
        if self._closed or self._bus is None or self._snapshot.status != "awaiting_user":
            raise ResumeConflictError("任务当前不在等待人工处理状态")
        if self.resume_in_flight:
            raise ResumeConflictError("已有恢复请求正在处理")
        request = asyncio.get_running_loop().create_future()
        self._resume_request = request
        # 唤醒只启动复核；状态仍为 awaiting_user，通过复核与授权后才能续跑。
        self._gate.set()
        try:
            return await request
        finally:
            if request.cancelled() and self._resume_request is request:
                self.revoke()
                self._cancel_resume_worker()
                self._gate.set()

    def _cancel_resume_worker(self) -> None:
        # 避免重复取消打断 OS 授权线程的退出等待。
        worker = self._resume_worker
        if worker is not None and not worker.done() and not worker.cancelling():
            worker.cancel()

    def _ensure_current_request(self, request) -> None:
        if (self._closed or self._snapshot.status != "awaiting_user"
                or self._resume_request is not request or request.done()):
            raise asyncio.CancelledError

    async def _verify_and_authorize(self, request, verify, authorize, prepare):
        if verify is None or authorize is None:
            raise RuntimeError("恢复复核与授权处理器尚未绑定")
        if self.audit is not None:
            await self.audit.record("resume_start")
        self._ensure_current_request(request)
        decision = ResumeCheck.model_validate(await verify())
        self._ensure_current_request(request)
        if not decision.can_resume:
            reason = decision.reason or "uncertain"
            return ResumeResult(resumed=False, message=RESUME_MESSAGES[reason]), reason
        try:
            await authorize()
        except (PermissionError, TimeoutError):
            self.revoke()
            self._ensure_current_request(request)
            return ResumeResult(resumed=False, message=RESUME_MESSAGES["authorization_required"]), "authorization_required"
        self._ensure_current_request(request)
        if prepare is not None:
            try:
                await prepare()
            except (AuditError, ResumeFatalError):
                raise
            except Exception:
                self.revoke()
                self._ensure_current_request(request)
                return ResumeResult(resumed=False, message=RESUME_MESSAGES["task_page_required"]), "uncertain"
            self._ensure_current_request(request)
        return ResumeResult(resumed=True), None

    async def wait_if_requested(
        self, verify: Callable[[], Awaitable[ResumeCheck]] | None = None,
        authorize: Callable[[], Awaitable[None]] | None = None,
        *, prepare: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        """主循环直接等待；单次复核可中止，人工等待始终不进入 step_timeout。"""
        while self._snapshot.status == "awaiting_user" and not self._closed:
            await self._gate.wait()
            self._gate.clear()
            if self._closed or self._snapshot.status != "awaiting_user":
                break
            request = self._resume_request
            if request is None:
                continue
            if request.done():
                self._resume_request = None
                continue
            worker = asyncio.create_task(self._verify_and_authorize(request, verify, authorize, prepare))
            self._resume_worker = worker
            try:
                result, reason = await asyncio.shield(worker)
                self._ensure_current_request(request)
                if self.audit is not None:
                    await self.audit.record("resume_end", outcome="completed" if result.resumed else "failed",
                        error_code=None if result.resumed else "resume_not_ready")
                self._ensure_current_request(request)
                if result.resumed:
                    self._snapshot = TakeoverSnapshot(self.task_id)
                    self._gate.set()
                elif reason == "uncertain":
                    self._snapshot = replace(self._snapshot, message=result.message)
                else:
                    self._snapshot = replace(self._snapshot, message=result.message,
                        takeover_reason=reason, login_required=reason == "login_required",
                        captcha_detected=reason == "captcha_detected")
                request.set_result(result)
            except asyncio.CancelledError:
                self.revoke()
                self._cancel_resume_worker()
                await asyncio.gather(worker, return_exceptions=True)
                if self.audit is not None:
                    try:
                        await self.audit.record("resume_end", outcome="cancelled", error_code="resume_cancelled")
                    except AuditError as error:
                        if not request.done():
                            request.set_exception(error)
                        if not asyncio.current_task().cancelling():
                            raise
                if asyncio.current_task().cancelling() or self._closed or self._snapshot.status == "cancelling":
                    raise
            except Exception as error:
                self.revoke()
                if self.audit is not None and not isinstance(error, AuditError):
                    try:
                        await self.audit.record("resume_end", outcome="failed",
                            error_code="browser_unavailable" if isinstance(error, ResumeFatalError) else "resume_check_failed")
                    except AuditError as audit_error:
                        error = audit_error
                if not request.done():
                    request.set_exception(error)
                if isinstance(error, (ResumeFatalError, AuditError)):
                    raise error
            finally:
                self._cancel_resume_worker()
                await asyncio.gather(worker, return_exceptions=True)
                if not request.done():
                    request.set_exception(ResumeConflictError("本次恢复请求已中止"))
                self._resume_worker = None
                self._resume_request = None
        if self._snapshot.status in {"cancelling", "cancelled"}:
            raise asyncio.CancelledError
        if self._closed:
            raise RuntimeError("人工接管任务已结束")

    def request_cancel(self) -> None:
        """先撤销授权并使恢复失效；运行协程负责完成资源清理。"""
        if self._snapshot.status in {"cancelling", "cancelled"}:
            return
        if self._closed or self._bus is None:
            raise ResumeConflictError("任务尚未运行或已结束")
        self._snapshot = TakeoverSnapshot(self.task_id, status="cancelling", message="正在取消任务")
        self.revoke()
        if self._resume_request is not None and not self._resume_request.done():
            self._resume_request.set_exception(ResumeConflictError("任务正在取消，不能恢复"))
        self._cancel_resume_worker()
        self._gate.set()

    def finish_cancel(self) -> None:
        """仅在运行退出及清理完成后发布取消终态。"""
        if self._snapshot.status == "cancelling":
            self._snapshot = TakeoverSnapshot(self.task_id, status="cancelled", message="任务已取消")

    def close(self) -> None:
        """解绑本任务处理器，阻止迟到事件更新状态。"""
        self._closed = True
        self._cancel_resume_worker()
        if self._resume_request is not None and not self._resume_request.done():
            self._resume_request.set_exception(ResumeConflictError("任务已结束，不能恢复"))
        if self._bus is not None:
            # bubus 1.5.6 没有 off；只移除自己的订阅，保留其他观察器。
            handlers = self._bus.handlers.get(UserTakeoverRequestedEvent.__name__, [])
            if self._handle_event in handlers:
                handlers.remove(self._handle_event)
            self._bus = None
        self._gate.set()
