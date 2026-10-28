"""验证人工恢复只在复核和授权后放行，并隔离重复、取消与迟到结果。"""

import asyncio
from types import SimpleNamespace

from bubus import EventBus
import pytest
import pytest_asyncio


@pytest_asyncio.fixture
async def environment():
    from core.orchestrator.takeover import TakeoverManager

    state = SimpleNamespace(allowed=False, checks=0, authorizations=0, runner=None,
                            decision={"can_resume": True})

    def revoke():
        state.allowed = False

    async def verify():
        from core.orchestrator.takeover import ResumeCheck

        state.checks += 1
        if isinstance(state.decision, Exception):
            raise state.decision
        return ResumeCheck.model_validate(state.decision)

    async def authorize():
        state.authorizations += 1
        state.allowed = True

    state.bus = EventBus()
    state.manager = TakeoverManager("task-1", revoke)
    state.manager.bind(state.bus)
    await state.manager.request(state.bus, "login_required")

    def start(check=None, authorization=None, preparation=None):
        state.runner = asyncio.create_task(state.manager.wait_if_requested(
            check or verify, authorization or authorize, prepare=preparation,
        ))
        return state.runner

    state.start = start
    try:
        yield state
    finally:
        state.manager.close()
        if state.runner is not None:
            state.runner.cancel()
            await asyncio.gather(state.runner, return_exceptions=True)
        await state.bus.stop(clear=True)


async def wait_idle(manager):
    async def wait():
        while manager.resume_in_flight:
            await asyncio.sleep(0)
    await asyncio.wait_for(wait(), timeout=1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reason", "message", "login", "captcha"),
    [("login_required", "仍未检测到登录", True, False),
     ("captcha_detected", "验证码", False, True),
     ("verification_required", "二次验证", False, False),
     ("uncertain", "无法确认", True, False)],
)
async def test_failed_check_keeps_waiting_without_authorization(environment, reason, message, login, captcha):
    from core.orchestrator.takeover import ResumeCheck

    env = environment
    env.decision = ResumeCheck(can_resume=False, reason=reason)
    env.start()
    result = await asyncio.wait_for(env.manager.request_resume(), timeout=1)
    assert result.resumed is False and message in result.message
    assert not env.manager.resume_in_flight
    assert env.manager.snapshot.status == "awaiting_user"
    assert env.manager.snapshot.login_required is login
    assert env.manager.snapshot.captcha_detected is captcha
    assert not env.runner.done()
    assert env.checks == 1 and env.authorizations == 0
    assert not env.allowed


@pytest.mark.asyncio
async def test_success_is_reported_only_after_authorization_and_state_change(environment):
    env = environment
    entered, release = asyncio.Event(), asyncio.Event()

    async def authorize():
        entered.set()
        await release.wait()
        env.allowed = True

    env.start(authorization=authorize)
    request = asyncio.create_task(env.manager.request_resume())
    await asyncio.wait_for(entered.wait(), timeout=1)
    assert not request.done() and not env.runner.done()
    assert env.manager.snapshot.status == "awaiting_user"
    release.set()
    result = await request
    assert result.resumed is True
    assert env.manager.snapshot.status == "running"
    assert env.manager.snapshot.message is None
    assert env.manager.snapshot.takeover_reason is None
    assert not env.manager.snapshot.login_required and not env.manager.snapshot.captcha_detected
    assert env.allowed
    await asyncio.wait_for(env.runner, timeout=1)


@pytest.mark.asyncio
async def test_resume_waits_for_task_page_restoration_before_running(environment):
    env = environment
    entered, release = asyncio.Event(), asyncio.Event()

    async def prepare():
        assert env.allowed and env.checks == 1
        entered.set()
        await release.wait()

    env.start(preparation=prepare)
    request = asyncio.create_task(env.manager.request_resume())
    await asyncio.wait_for(entered.wait(), timeout=1)
    assert env.manager.snapshot.status == "awaiting_user"
    assert not request.done() and not env.runner.done()
    release.set()
    assert (await request).resumed
    await env.runner
    assert env.manager.snapshot.status == "running"


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [PermissionError("失焦"), ValueError("标签已关闭"), TimeoutError("恢复超时")])
async def test_restore_failure_preserves_waiting_task_and_revokes_until_retry(environment, error):
    env = environment
    failures = [error]

    async def prepare():
        assert env.allowed
        if failures:
            raise failures.pop()

    env.start(preparation=prepare)
    result = await env.manager.request_resume()
    assert result.resumed is False and "原任务页面" in result.message
    assert env.manager.snapshot.status == "awaiting_user" and not env.runner.done()
    assert not env.allowed
    assert (await env.manager.request_resume()).resumed
    await env.runner
    assert env.checks == 2 and env.authorizations == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [PermissionError("拒绝授权"), TimeoutError("授权超时")])
async def test_authorization_failure_stays_waiting_and_can_retry(environment, error):
    env = environment
    failures = [error]

    async def authorize():
        if failures:
            raise failures.pop()
        env.allowed = True

    env.start(authorization=authorize)
    result = await env.manager.request_resume()
    assert result.resumed is False and "授权" in result.message
    assert env.manager.snapshot.status == "awaiting_user"
    assert env.manager.snapshot.takeover_reason == "authorization_required"
    assert not env.manager.snapshot.login_required and not env.manager.snapshot.captcha_detected
    assert not env.allowed
    assert (await env.manager.request_resume()).resumed
    await env.runner
    assert env.checks == 2 and env.allowed


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [ValueError("模型输出错误"), TimeoutError("复核超时")])
async def test_check_errors_are_reported_as_errors_and_retry_uses_new_check(environment, error):
    from core.orchestrator.takeover import ResumeCheck

    env = environment
    env.decision = error
    env.start()
    with pytest.raises(type(error)):
        await env.manager.request_resume()
    assert env.manager.snapshot.status == "awaiting_user"
    assert not env.runner.done() and env.authorizations == 0
    env.decision = ResumeCheck(can_resume=True)
    assert (await env.manager.request_resume()).resumed is True
    await env.runner
    assert env.checks == 2


@pytest.mark.asyncio
async def test_concurrent_resume_is_rejected_without_another_check(environment):
    from core.orchestrator.takeover import ResumeCheck, ResumeConflictError

    env = environment
    entered, release = asyncio.Event(), asyncio.Event()

    async def verify():
        env.checks += 1
        entered.set()
        await release.wait()
        return ResumeCheck(can_resume=True)

    env.start(check=verify)
    first = asyncio.create_task(env.manager.request_resume())
    await asyncio.wait_for(entered.wait(), timeout=1)
    with pytest.raises(ResumeConflictError):
        await env.manager.request_resume()
    assert env.checks == 1
    release.set()
    assert (await first).resumed
    await env.runner
    with pytest.raises(ResumeConflictError):
        await env.manager.request_resume()


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["check", "authorization", "preparation"])
async def test_aborted_request_cannot_publish_a_late_success(environment, stage):
    from core.orchestrator.takeover import ResumeCheck

    env = environment
    entered, release = asyncio.Event(), asyncio.Event()

    async def late_result():
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            await release.wait()

    async def verify():
        if stage == "check":
            await late_result()
        return ResumeCheck(can_resume=True)

    async def authorize():
        env.authorizations += 1
        if stage == "authorization":
            await late_result()
        env.allowed = True

    async def prepare():
        if stage == "preparation":
            await late_result()

    env.start(check=verify, authorization=authorize, preparation=prepare)
    request = asyncio.create_task(env.manager.request_resume())
    await asyncio.wait_for(entered.wait(), timeout=1)
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    release.set()
    await wait_idle(env.manager)
    assert env.manager.snapshot.status == "awaiting_user"
    assert not env.allowed and not env.runner.done()
    assert env.authorizations == (0 if stage == "check" else 1)


@pytest.mark.asyncio
async def test_resume_queued_before_step_end_is_not_lost(environment):
    env = environment
    request = asyncio.create_task(env.manager.request_resume())
    await asyncio.sleep(0)
    env.start()
    assert (await asyncio.wait_for(request, timeout=1)).resumed
    await env.runner
