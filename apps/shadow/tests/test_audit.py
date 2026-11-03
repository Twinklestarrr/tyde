"""验证真实审计文件、统一工具入口及写入故障后的任务停止。"""

import asyncio
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest


def records(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines()]


@pytest.mark.asyncio
async def test_audit_is_lazy_private_and_encodes_only_structured_fields(tmp_path):
    from auth.audit import AuditLog

    path = tmp_path / "logs/audit.log"
    audit = AuditLog("任务\n一", account_id="账号 / 未校验\n二", path=path)
    assert not path.exists()
    await audit.record("action_start", action_id="a-1", step_number=3, action="input")
    assert len(path.read_text(encoding="utf-8").splitlines()) == 1
    row = records(path)[0]
    assert set(row) == {"timestamp", "event", "task_id", "account_id", "action_id",
                        "step_number", "action", "outcome", "error_code"}
    assert row["task_id"] == "任务\n一" and row["account_id"] == "账号 / 未校验\n二"
    assert row["action_id"] == "a-1" and row["step_number"] == 3
    assert datetime.fromisoformat(row["timestamp"]).utcoffset() == timedelta(0)
    if os.name == "posix":
        assert path.stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_concurrent_audit_writes_remain_complete_json_lines(tmp_path):
    from auth.audit import AuditLog

    path = tmp_path / "audit.log"
    audit = AuditLog("task-1", path=path)
    await asyncio.gather(*(audit.record("action_start", action="wait", action_id=str(i)) for i in range(30)))
    rows = records(path)
    assert len(rows) == 30 and {row["action_id"] for row in rows} == {str(i) for i in range(30)}


@pytest.mark.asyncio
async def test_rotation_keeps_current_and_three_recent_backups(tmp_path):
    from auth.audit import AuditLog

    path = tmp_path / "audit.log"
    audit = AuditLog("task-1", path=path, max_bytes=1)
    for i in range(5):
        await audit.record("action_start", action="wait", action_id=str(i))
    assert {p.name for p in tmp_path.iterdir()} == {"audit.log", "audit.log.1", "audit.log.2", "audit.log.3"}
    assert [records(tmp_path / name)[0]["action_id"] for name in
            ["audit.log", "audit.log.1", "audit.log.2", "audit.log.3"]] == ["4", "3", "2", "1"]


@pytest.mark.asyncio
async def test_write_failure_is_sticky_and_does_not_expose_exception_text(tmp_path, monkeypatch):
    from auth.audit import AuditError, AuditLog

    revoked = []
    audit = AuditLog("task-1", path=tmp_path / "audit.log", on_failure=lambda: revoked.append(True))

    def fail(line):
        raise OSError("test-private-password-token")

    monkeypatch.setattr(audit, "_append", fail)
    with pytest.raises(AuditError) as caught:
        await audit.record("task_start")
    assert "test-private" not in str(caught.value)
    assert revoked == [True]
    with pytest.raises(AuditError):
        await audit.record("task_end", outcome="failed", error_code="task_failed")
    assert not audit.path.exists()


@pytest.mark.asyncio
async def test_nonstandard_error_text_is_rejected_before_writing(tmp_path):
    from auth.audit import AuditError, AuditLog

    audit = AuditLog("task-1", path=tmp_path / "audit.log")
    with pytest.raises(AuditError):
        await audit.record("action_end", action="input", error_code="test-private-password")
    assert not audit.path.exists()


@pytest.mark.asyncio
async def test_cancelled_record_waits_for_its_file_worker(tmp_path, monkeypatch):
    from auth.audit import AuditLog

    audit = AuditLog("task-1", path=tmp_path / "audit.log")
    entered, release = threading.Event(), threading.Event()
    original = audit._append

    def blocked(line):
        entered.set()
        assert release.wait(timeout=3)
        original(line)

    monkeypatch.setattr(audit, "_append", blocked)
    writer = asyncio.create_task(audit.record("task_start"))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        writer.cancel()
        done, _ = await asyncio.wait({writer}, timeout=0.02)
        assert not done
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await writer
        assert records(audit.path)[0]["event"] == "task_start"
    finally:
        release.set()
        await asyncio.gather(writer, return_exceptions=True)


@pytest.mark.asyncio
async def test_repeated_cancellation_cannot_abandon_audit_file_worker(tmp_path, monkeypatch):
    from auth.audit import AuditLog

    audit = AuditLog("task-1", path=tmp_path / "audit.log")
    entered, release = threading.Event(), threading.Event()
    original = audit._append

    def blocked(line):
        entered.set()
        assert release.wait(timeout=3)
        original(line)

    monkeypatch.setattr(audit, "_append", blocked)
    writer = asyncio.create_task(audit.record("task_start"))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        writer.cancel()
        await asyncio.sleep(0)
        writer.cancel()
        done, _ = await asyncio.wait({writer}, timeout=0.02)
        assert not done
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await writer
        await audit.drain()
        assert records(audit.path)[0]["event"] == "task_start"
    finally:
        release.set()
        await asyncio.gather(writer, return_exceptions=True)


@pytest.mark.asyncio
async def test_cancelled_drain_waits_for_pending_file_write(tmp_path, monkeypatch):
    from auth.audit import AuditLog

    audit = AuditLog("task-1", path=tmp_path / "audit.log")
    entered, release = threading.Event(), threading.Event()
    original = audit._append

    def blocked(line):
        entered.set()
        assert release.wait(timeout=3)
        original(line)

    monkeypatch.setattr(audit, "_append", blocked)
    writer = asyncio.create_task(audit.record("task_start"))
    drain = None
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        drain = asyncio.create_task(audit.drain())
        await asyncio.sleep(0)
        drain.cancel()
        done, _ = await asyncio.wait({drain}, timeout=0.02)
        assert not done
        assert not writer.done()
        release.set()
        await writer
        with pytest.raises(asyncio.CancelledError):
            await drain
        await audit.drain()
        assert records(audit.path)[0]["event"] == "task_start"
    finally:
        release.set()
        await asyncio.gather(writer, *([drain] if drain is not None else []), return_exceptions=True)


@pytest.fixture
def agent_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    from agent.loop import ShadowAgent
    from agent.controller import OSController
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.session import BrowserSession
    from config.settings import Settings

    desktop = SimpleNamespace(allowed=False)

    def authorize(timeout=120):
        desktop.allowed = True

    def revoke():
        desktop.allowed = False

    desktop.authorize, desktop.revoke = authorize, revoke
    config = Settings(_env_file=None, LLM_API_KEY="test-private", SAVE_HISTORY=False, MIN_ACTION_DELAY_MS=0)
    session = BrowserSession(browser_profile=BrowserProfile(user_data_dir=tmp_path / "chrome"))
    session._cdp_client_root = SimpleNamespace()
    tools = OSController(desktop, config=config)

    def build(**kwargs):
        kwargs.setdefault("audit_path", tmp_path / "audit.log")
        return ShadowAgent(task="审计测试", browser_session=session, tools=tools, config=config,
            file_system_path=str(tmp_path / "files"), enable_signal_handler=False, use_judge=False, **kwargs)

    return SimpleNamespace(build=build, desktop=desktop, session=session, path=tmp_path / "audit.log")


def complete_history(agent, success):
    from browser_use.agent.views import ActionResult, AgentHistory
    from browser_use.browser.views import BrowserStateHistory

    agent.history.add_item(AgentHistory(model_output=None,
        result=[ActionResult(is_done=True, success=success)],
        state=BrowserStateHistory(url="https://private.example/secret", title="测试", tabs=[], interacted_element=[])))
    return agent.history


@pytest.mark.asyncio
@pytest.mark.parametrize("failure,code", [(PermissionError, "authorization_denied"),
                                        (TimeoutError, "authorization_timeout")])
async def test_authorization_failure_has_safe_result_and_task_terminal(agent_environment, monkeypatch, failure, code):
    env = agent_environment

    def authorize(timeout=120):
        raise failure("test-private")

    monkeypatch.setattr(env.desktop, "authorize", authorize)
    agent = env.build()
    with pytest.raises(failure):
        await agent.run()
    rows = records(env.path)
    assert [r["event"] for r in rows] == ["task_start", "authorization_start", "authorization_end", "task_end"]
    assert rows[2]["outcome"] == "failed" and rows[2]["error_code"] == code
    assert rows[-1]["outcome"] == "failed" and not env.desktop.allowed
    assert "test-private" not in env.path.read_text()


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_failed", [False, True])
async def test_audit_covers_native_and_os_tools_without_recording_payloads(agent_environment, monkeypatch, tool_failed):
    from browser_use.agent.service import Agent
    from browser_use.agent.views import ActionResult
    from browser_use.tools.service import Tools

    env = agent_environment
    executions = []

    async def execute(current, action, browser_session, **kwargs):
        executions.append(True)
        return ActionResult(extracted_content="test-private-payload", error="test-private-error" if tool_failed else None)

    async def native_run(current, **kwargs):
        for index, payload in enumerate([{"navigate": {"url": "https://private.example/?token=test-private"}},
                                          {"input": {"index": 1, "text": "test-private-password"}}]):
            output = current.AgentOutput.model_validate({"action": [payload]})
            if index:
                await current._on_step(SimpleNamespace(), output, 4)
            await current.os_controller.act(output.action[0], current.browser_session)
        return complete_history(current, not tool_failed)

    monkeypatch.setattr(Tools, "act", execute)
    monkeypatch.setattr(Agent, "run", native_run)
    agent = env.build(account_id="account / raw")
    await agent.run()
    rows = records(env.path)
    assert len(executions) == 2
    assert [r["event"] for r in rows] == ["task_start", "authorization_start", "authorization_end",
        "action_start", "action_end", "action_start", "action_end", "task_end"]
    assert all(r["task_id"] == agent.task_id and r["account_id"] == "account / raw" for r in rows)
    for start, end in [(rows[3], rows[4]), (rows[5], rows[6])]:
        assert start["action_id"] == end["action_id"] and start["action_id"]
        assert end["outcome"] == ("failed" if tool_failed else "completed")
    assert rows[3]["action"] == "navigate" and rows[3]["step_number"] is None
    assert rows[5]["action"] == "input" and rows[5]["step_number"] == 4
    assert rows[-1]["outcome"] == ("failed" if tool_failed else "completed")
    assert "test-private" not in env.path.read_text() and "https://" not in env.path.read_text()
    assert not env.desktop.allowed


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["action_start", "action_end"])
async def test_audit_failure_stops_native_retry_and_does_not_repeat_action(agent_environment, monkeypatch, phase):
    from auth.audit import AuditError
    from browser_use.agent.service import Agent
    from browser_use.agent.views import ActionResult
    from browser_use.tools.service import Tools

    env, executions, native_steps = agent_environment, [], []
    agent = env.build()
    original = agent.audit._append

    def write(line):
        if json.loads(line)["event"] == phase:
            raise OSError("测试写入失败")
        original(line)

    async def execute(current, *args, **kwargs):
        executions.append(True)
        return ActionResult(extracted_content="已执行")

    async def native_step(current, step_info=None):
        native_steps.append(True)

    async def native_run(current, **kwargs):
        output = current.AgentOutput.model_validate({"action": [{"wait": {"seconds": 1}}]})
        for _ in range(2):
            await current.multi_act(output.action)
            await current.step()
        return current.history

    monkeypatch.setattr(agent.audit, "_append", write)
    monkeypatch.setattr(Tools, "act", execute)
    monkeypatch.setattr(Agent, "step", native_step)
    monkeypatch.setattr(Agent, "run", native_run)
    with pytest.raises(AuditError):
        await agent.run()
    assert len(executions) == (0 if phase == "action_start" else 1)
    assert native_steps == [] and not env.desktop.allowed
    assert not any(r["event"] == "action_end" for r in records(env.path))


@pytest.mark.asyncio
async def test_task_start_failure_prevents_authorization(agent_environment, monkeypatch, tmp_path):
    from auth.audit import AuditError

    env = agent_environment
    blocked = tmp_path / "directory"
    blocked.mkdir()

    def authorize(timeout=120):
        pytest.fail("任务开始审计失败时不能请求桌面授权")

    monkeypatch.setattr(env.desktop, "authorize", authorize)
    agent = env.build(audit_path=blocked)
    with pytest.raises(AuditError):
        await agent.run()
    assert not env.desktop.allowed


@pytest.mark.asyncio
async def test_audit_cleanup_failure_preserves_original_task_error(agent_environment, monkeypatch):
    from browser_use.agent.service import Agent

    env = agent_environment
    agent = env.build()
    original = agent.audit._append

    def write(line):
        if json.loads(line)["event"] == "task_end":
            raise OSError("审计终态写入失败")
        original(line)

    async def native_run(current, **kwargs):
        raise ValueError("原始任务错误")

    monkeypatch.setattr(agent.audit, "_append", write)
    monkeypatch.setattr(Agent, "run", native_run)
    with pytest.raises(ValueError, match="原始任务错误"):
        await agent.run()
    assert [r["event"] for r in records(env.path)] == ["task_start", "authorization_start", "authorization_end"]


@pytest.mark.asyncio
async def test_cancelled_action_records_unknown_result_and_one_task_terminal(agent_environment, monkeypatch):
    from browser_use.agent.service import Agent
    from browser_use.tools.service import Tools

    env = agent_environment
    entered = asyncio.Event()

    async def execute(current, *args, **kwargs):
        entered.set()
        await asyncio.Event().wait()

    async def native_run(current, **kwargs):
        output = current.AgentOutput.model_validate({"action": [{"input": {"index": 1, "text": "test-private"}}]})
        await current.os_controller.act(output.action[0], current.browser_session)

    monkeypatch.setattr(Tools, "act", execute)
    monkeypatch.setattr(Agent, "run", native_run)
    agent = env.build()
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        agent.cancel_task()
        with pytest.raises(asyncio.CancelledError):
            await runner
        rows = records(env.path)
        result = next(r for r in rows if r["event"] == "action_end")
        assert result["outcome"] == "unknown" and result["error_code"] == "action_cancelled"
        terminal = [r for r in rows if r["event"] == "task_end"]
        assert len(terminal) == 1 and terminal[0]["outcome"] == "cancelled"
        assert "test-private" not in env.path.read_text()
    finally:
        if not runner.done():
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)


@pytest.mark.asyncio
async def test_takeover_and_resume_audit_preserves_single_task_terminal(agent_environment, monkeypatch):
    from browser_use.agent.service import Agent
    from agent.loop import ShadowAgent
    from core.orchestrator.takeover import ResumeCheck

    env, ready = agent_environment, asyncio.Event()
    decisions = [ResumeCheck(can_resume=False, reason="login_required"), ResumeCheck(can_resume=True)]

    async def verify(current):
        return decisions.pop(0)

    async def prepare(current):
        # 本用例只验证审计终态；真实页面恢复由控制器和恢复接口用例覆盖。
        assert env.desktop.allowed

    async def native_run(current, **kwargs):
        output = current.AgentOutput.model_validate({"action": [{"request_takeover": {"reason": "login_required"}}]})
        await current.os_controller.act(output.action[0], current.browser_session)
        ready.set()
        await kwargs["on_step_end"](current)
        return complete_history(current, True)

    monkeypatch.setattr(ShadowAgent, "_verify_resume", verify)
    monkeypatch.setattr(ShadowAgent, "_prepare_resume", prepare)
    monkeypatch.setattr(Agent, "run", native_run)
    agent = env.build()
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(ready.wait(), timeout=2)
        assert not (await agent.resume_task()).resumed
        assert not any(r["event"] == "task_end" for r in records(env.path))
        assert (await agent.resume_task()).resumed
        await runner
        rows = records(env.path)
        assert len([r for r in rows if r["event"] == "takeover"]) == 1
        assert [r["outcome"] for r in rows if r["event"] == "resume_end"] == ["failed", "completed"]
        assert len([r for r in rows if r["event"] == "authorization_end"]) == 2
        assert len([r for r in rows if r["event"] == "task_end"]) == 1
    finally:
        if not runner.done():
            agent.cancel_task()
            await asyncio.gather(runner, return_exceptions=True)
        await env.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["resume_start", "resume_end"])
async def test_resume_audit_failure_cannot_release_waiting_agent(agent_environment, monkeypatch, phase):
    from auth.audit import AuditError
    from browser_use.agent.service import Agent
    from agent.loop import ShadowAgent
    from core.orchestrator.takeover import ResumeCheck

    env, ready, advanced = agent_environment, asyncio.Event(), []
    agent = env.build()
    original = agent.audit._append

    def write(line):
        if json.loads(line)["event"] == phase:
            raise OSError("恢复记录写入失败")
        original(line)

    async def verify(current):
        return ResumeCheck(can_resume=True)

    async def native_run(current, **kwargs):
        await current.takeover.request(current.browser_session.event_bus, "login_required")
        ready.set()
        await kwargs["on_step_end"](current)
        advanced.append(True)
        return current.history

    monkeypatch.setattr(agent.audit, "_append", write)
    monkeypatch.setattr(ShadowAgent, "_verify_resume", verify)
    monkeypatch.setattr(Agent, "run", native_run)
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(ready.wait(), timeout=2)
        with pytest.raises(AuditError):
            await agent.resume_task()
        with pytest.raises(AuditError):
            await runner
        assert advanced == [] and not env.desktop.allowed
    finally:
        if not runner.done():
            agent.cancel_task()
            await asyncio.gather(runner, return_exceptions=True)
        await env.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
async def test_history_failure_does_not_disable_audit(agent_environment, monkeypatch):
    from agent import loop
    from browser_use.agent.service import Agent

    env = agent_environment
    agent = env.build()
    agent.config.SAVE_HISTORY = True

    async def fail_history(*args, **kwargs):
        raise RuntimeError("历史写入失败")

    async def native_run(current, **kwargs):
        return complete_history(current, True)

    monkeypatch.setattr(loop, "maybe_save_history", fail_history)
    monkeypatch.setattr(Agent, "run", native_run)
    with pytest.raises(RuntimeError, match="历史写入失败"):
        await agent.run()
    terminal = [r for r in records(env.path) if r["event"] == "task_end"]
    assert len(terminal) == 1 and terminal[0]["outcome"] == "failed"


@pytest.mark.asyncio
async def test_cancellation_during_cleanup_records_cancelled_task(agent_environment, monkeypatch):
    from agent import loop
    from browser_use.agent.service import Agent

    env, cleanup = agent_environment, asyncio.Event()

    async def native_run(current, **kwargs):
        return complete_history(current, True)

    async def save(*args, **kwargs):
        cleanup.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(Agent, "run", native_run)
    monkeypatch.setattr(loop, "maybe_save_history", save)
    agent = env.build()
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(cleanup.wait(), timeout=2)
        runner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await runner
        terminal = [r for r in records(env.path) if r["event"] == "task_end"]
        assert len(terminal) == 1 and terminal[0]["outcome"] == "cancelled"
        assert terminal[0]["error_code"] == "task_cancelled"
    finally:
        if not runner.done():
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("prior_error", [False, True])
async def test_run_cancelled_during_drain_waits_and_keeps_one_terminal(agent_environment, monkeypatch, prior_error):
    from browser_use.agent.service import Agent

    env, waiting = agent_environment, asyncio.Event()
    agent = env.build()
    entered, release = threading.Event(), threading.Event()
    original_append, original_drain = agent.audit._append, agent.audit.drain
    writers = []

    def write(line):
        if json.loads(line)["event"] == "takeover":
            entered.set()
            assert release.wait(timeout=3)
        original_append(line)

    async def native_run(current, **kwargs):
        writers.append(asyncio.create_task(current.audit.record("takeover")))
        assert await asyncio.to_thread(entered.wait, 1)
        if prior_error:
            raise ValueError("原始任务错误")
        return complete_history(current, True)

    async def drain():
        waiting.set()
        await original_drain()

    monkeypatch.setattr(Agent, "run", native_run)
    monkeypatch.setattr(agent.audit, "_append", write)
    monkeypatch.setattr(agent.audit, "drain", drain)
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(waiting.wait(), timeout=2)
        runner.cancel()
        done, _ = await asyncio.wait({runner}, timeout=0.02)
        assert not done
        release.set()
        with pytest.raises(ValueError if prior_error else asyncio.CancelledError):
            await runner
        terminal = [r for r in records(env.path) if r["event"] == "task_end"]
        assert len(terminal) == 1
        assert terminal[0]["outcome"] == ("failed" if prior_error else "cancelled")
        assert records(env.path)[-1]["event"] == "task_end"
    finally:
        release.set()
        if not runner.done():
            runner.cancel()
        await asyncio.gather(runner, *writers, return_exceptions=True)


@pytest.mark.asyncio
async def test_cancel_during_pause_audit_cannot_restore_awaiting_user(tmp_path, monkeypatch):
    from auth.audit import AuditLog
    from bubus import EventBus
    from core.orchestrator.takeover import ResumeConflictError, TakeoverManager

    audit = AuditLog("task-1", path=tmp_path / "audit.log")
    manager = TakeoverManager("task-1", lambda: None, audit=audit)
    bus = EventBus()
    manager.bind(bus)
    entered, release = threading.Event(), threading.Event()
    original = audit._append

    def write(line):
        if json.loads(line)["event"] == "takeover":
            entered.set()
            assert release.wait(timeout=3)
        original(line)

    monkeypatch.setattr(audit, "_append", write)
    request = asyncio.create_task(manager.request(bus, "login_required"))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        manager.request_cancel()
        release.set()
        with pytest.raises(ResumeConflictError):
            await request
        assert manager.snapshot.status == "cancelling"
    finally:
        release.set()
        manager.close()
        await asyncio.gather(request, return_exceptions=True)
        await bus.stop(clear=True)
