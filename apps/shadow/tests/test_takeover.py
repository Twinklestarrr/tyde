"""使用真实事件总线验证接管状态、任务归属和订阅清理。"""

import asyncio

from bubus import EventBus
import pytest


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reason", "login_required", "captcha_detected"),
    [("login_required", True, False), ("captcha_detected", False, True),
     ("verification_required", False, False)],
)
async def test_request_updates_snapshot_and_revokes_before_waiting(reason, login_required, captcha_detected):
    from core.orchestrator.takeover import TakeoverManager

    bus, revocations = EventBus(), []
    manager = TakeoverManager("task-1", lambda: revocations.append(True))
    manager.bind(bus)
    try:
        await asyncio.wait_for(manager.request(bus, reason), timeout=1)
        snapshot = manager.snapshot
        assert snapshot.task_id == "task-1"
        assert snapshot.status == "awaiting_user"
        assert snapshot.takeover_reason == reason
        assert snapshot.login_required is login_required
        assert snapshot.captcha_detected is captcha_detected
        assert snapshot.message
        assert revocations == [True]
        waiter = asyncio.create_task(manager.wait_if_requested())
        done, _ = await asyncio.wait({waiter}, timeout=0.02)
        assert not done
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
    finally:
        manager.close()
        await bus.stop(clear=True)


@pytest.mark.asyncio
async def test_duplicate_request_preserves_existing_wait_and_reason():
    from core.orchestrator.takeover import TakeoverManager

    bus, revocations = EventBus(), []
    manager = TakeoverManager("task-1", lambda: revocations.append(True))
    manager.bind(bus)
    try:
        await manager.request(bus, "login_required")
        before = manager.snapshot
        await manager.request(bus, "captcha_detected")
        assert manager.snapshot == before
        assert revocations == [True]
    finally:
        manager.close()
        await bus.stop(clear=True)


@pytest.mark.asyncio
async def test_wrong_task_event_cannot_change_state():
    from core.orchestrator.takeover import TakeoverManager, UserTakeoverRequestedEvent

    bus, revocations = EventBus(), []
    manager = TakeoverManager("task-1", lambda: revocations.append(True))
    manager.bind(bus)
    try:
        event = bus.dispatch(UserTakeoverRequestedEvent(task_id="other", reason="login_required"))
        await event
        with pytest.raises(RuntimeError, match="任务"):
            await event.event_result(raise_if_any=True, raise_if_none=False)
        assert manager.snapshot.status == "running"
        assert revocations == []
    finally:
        manager.close()
        await bus.stop(clear=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("observer", [False, True])
async def test_missing_consumer_is_not_reported_as_success(observer):
    from core.orchestrator.takeover import TakeoverManager, UserTakeoverRequestedEvent

    bus = EventBus()
    manager = TakeoverManager("task-1", lambda: None)
    manager.bind(bus)
    bus.handlers[UserTakeoverRequestedEvent.__name__].clear()
    if observer:
        async def observe(event):
            pass
        bus.on(UserTakeoverRequestedEvent, observe)
    try:
        with pytest.raises(RuntimeError, match="接管"):
            await manager.request(bus, "login_required")
        assert manager.snapshot.status == "running"
    finally:
        manager.close()
        await bus.stop(clear=True)


@pytest.mark.asyncio
async def test_close_removes_only_own_subscription_and_rejects_late_request():
    from core.orchestrator.takeover import TakeoverManager, UserTakeoverRequestedEvent

    bus, observed, revocations = EventBus(), [], []

    async def observe(event):
        observed.append(event.task_id)

    bus.on(UserTakeoverRequestedEvent, observe)
    manager = TakeoverManager("task-1", lambda: revocations.append(True))
    manager.bind(bus)
    manager.close()
    try:
        event = bus.dispatch(UserTakeoverRequestedEvent(task_id="task-1", reason="login_required"))
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)
        assert observed == ["task-1"]
        assert revocations == []
        assert manager.snapshot.status == "running"
        with pytest.raises(RuntimeError):
            await manager.request(bus, "login_required")
    finally:
        await bus.stop(clear=True)
