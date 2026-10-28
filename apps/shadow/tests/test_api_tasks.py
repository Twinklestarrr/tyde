"""隔离浏览器、远程模型和桌面，验证 HTTP 受理、后台运行及资源所有权。"""

import asyncio
from contextlib import asynccontextmanager
import json
import logging
from pathlib import Path
import threading
import time
from types import SimpleNamespace

import httpx
import pytest

from api import server
from auth.audit import AuditLog
from config.settings import Settings


@pytest.fixture
def environment(tmp_path, monkeypatch):
    config = Settings(_env_file=None, LLM_API_KEY="test-private-key", SAVE_HISTORY=False,
        TOKEN_FILE_PATH=str(tmp_path / "token"), PID_FILE_PATH=str(tmp_path / "agent.pid"))
    env = SimpleNamespace(config=config, path=tmp_path / "audit.log", sessions=[], agents=[],
        started=asyncio.Event(), release=asyncio.Event(), cleanup_started=asyncio.Event(),
        cleanup_release=asyncio.Event(), kill_started=asyncio.Event(), kill_release=asyncio.Event(),
        success=True, final_text="页面标题：Example Domain\n已完成读取。",
        run_error=None, build_error=None, session_error=None, kill_failures=0,
        block_cleanup=False, block_kill=False, allowed=False)

    def audit(*args):
        return AuditLog(*args, path=env.path)

    class Session:
        def __init__(self, account_id):
            self.account_id, self.kills = account_id, 0
            self.browser_profile = SimpleNamespace(keep_alive=None)

        async def kill(self):
            self.kills += 1
            env.kill_started.set()
            if env.block_kill:
                await env.kill_release.wait()
            if env.kill_failures:
                env.kill_failures -= 1
                raise OSError("test-private-browser-error")

    class Agent:
        def __init__(self, **kwargs):
            self.kwargs, self._run_task = kwargs, None
            self.os_controller = SimpleNamespace(revoke=self.revoke)
            self.audit = audit(kwargs["task_id"], kwargs["account_id"])
            self.state = SimpleNamespace(n_steps=1)
            self.history = SimpleNamespace(history=[])
            self.takeover = SimpleNamespace(snapshot=SimpleNamespace(status="running", message=None,
                takeover_reason=None, login_required=False, captcha_detected=False))
            self.callbacks = {}

        def revoke(self):
            env.allowed = False

        def cancel_task(self):
            self.revoke()
            if self._run_task is not None:
                self._run_task.cancel()

        async def run(self, **kwargs):
            self.callbacks = kwargs
            self._run_task = asyncio.current_task()
            outcome, code = "failed", "task_failed"
            try:
                await self.audit.record("task_start")
                env.allowed = True
                env.started.set()
                await env.release.wait()
                if env.run_error is not None:
                    raise env.run_error
                outcome = "completed" if env.success is True else "failed" if env.success is False else "unknown"
                code = "task_failed" if outcome == "failed" else None
                return SimpleNamespace(is_successful=lambda: env.success, final_result=lambda: env.final_text)
            except asyncio.CancelledError:
                outcome, code = "cancelled", "task_cancelled"
                raise
            finally:
                self.revoke()
                env.cleanup_started.set()
                if env.block_cleanup:
                    await env.cleanup_release.wait()
                await self.audit.record("task_end", outcome=outcome, error_code=code)
                self._run_task = None

    def create_session(account_id):
        if env.session_error is not None:
            raise env.session_error
        session = Session(account_id)
        env.sessions.append(session)
        return session

    def build_agent(**kwargs):
        if env.build_error is not None:
            raise env.build_error
        agent = Agent(**kwargs)
        env.agents.append(agent)
        return agent

    monkeypatch.setattr(server, "create_session", create_session, raising=False)
    monkeypatch.setattr(server, "_build_agent", build_agent, raising=False)
    monkeypatch.setattr(server, "AuditLog", audit, raising=False)
    env.app = server.create_app(config)
    return env


@asynccontextmanager
async def client_for(env):
    async with env.app.router.lifespan_context(env.app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app), base_url="http://test",
            headers={"Authorization": f"Bearer {env.app.state.token_auth.token}"}) as client:
            try:
                yield client
            finally:
                env.release.set()
                env.cleanup_release.set()
                env.kill_release.set()
                if hasattr(env, "model_release"):
                    env.model_release.set()


async def submit(client, account_id="account_001", **params):
    return await client.post("/task", json={"account_id": account_id,
        "params": {"task": "  访问 https://example.com 并读取标题  ", **params}})


@pytest.mark.asyncio
async def test_frontend_key_is_used_by_next_task_without_mutating_caller_config(environment):
    env = environment
    async with client_for(env) as client:
        response = await client.put("/config/llm", json={"api_key": " frontend-test-key "})
        assert response.status_code == 200
        assert (await submit(client)).status_code == 202
        await asyncio.wait_for(env.started.wait(), 2)
        assert env.agents[0].kwargs["config"].LLM_API_KEY == "frontend-test-key"
        assert env.config.LLM_API_KEY == "test-private-key"


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["running", "awaiting_user", "cancelling", "cleanup"])
async def test_key_cannot_change_while_task_owns_desktop(environment, phase):
    env = environment
    async with client_for(env) as client:
        assert (await submit(client)).status_code == 202
        await asyncio.wait_for(env.started.wait(), 2)
        if phase == "awaiting_user":
            env.agents[0].takeover.snapshot.status = phase
        elif phase == "cancelling":
            env.block_cleanup = True
            await client.post(f"/task/{env.app.state.active_task.task_id}/cancel")
            await asyncio.wait_for(env.cleanup_started.wait(), 2)
        elif phase == "cleanup":
            env.block_kill = True
            env.release.set()
            await asyncio.wait_for(env.kill_started.wait(), 2)
        response = await client.put("/config/llm", json={"api_key": "replacement-test-key"})
        assert response.status_code == 409
        assert env.agents[0].kwargs["config"].LLM_API_KEY == "test-private-key"


async def result(env, task_id, *, timeout=3):
    record = env.app.state.task_results[task_id]
    if record.runner is not None:
        done, _ = await asyncio.wait({record.runner}, timeout=timeout)
        if not done:
            stacks = [f"{task.get_coro().__qualname__}: " + ", ".join(
                f"{Path(frame.f_code.co_filename).name}:{frame.f_lineno}" for frame in task.get_stack())
                for task in asyncio.all_tasks()]
            pytest.fail("后台任务未完成\n" + "\n".join(stacks))
    return record


def records(env):
    return [json.loads(line) for line in env.path.read_text().splitlines()]


@pytest.fixture
def resume_environment(environment, tmp_path, monkeypatch):
    """保留真实 Agent、接管门、复核与审计，只隔离页面、模型和桌面。"""
    from agent.controller import OSController
    from agent.loop import ShadowAgent
    from browser_use.agent.service import Agent
    from browser_use.agent.views import ActionResult, AgentHistory
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.views import BrowserStateHistory, BrowserStateSummary, TabInfo
    from browser_use.dom.views import SerializedDOMState
    from browser_use.llm import ChatOpenAI
    from browser_use.llm.views import ChatInvokeCompletion

    env = environment
    env.config.LLM_PROVIDER, env.config.LLM_MODEL_NAME = "openai", "test-model"
    env.model_started, env.model_release = asyncio.Event(), asyncio.Event()
    env.model_cancelled, env.continued = asyncio.Event(), asyncio.Event()
    env.can_resume, env.reason, env.model_error = True, None, None
    env.authorization_error, env.block_model, env.late_model = None, False, False
    env.reads, env.calls, env.authorizations = [], [], 0
    env.restore_started, env.restore_release = asyncio.Event(), asyncio.Event()
    env.block_restore = False
    native_session = BrowserSession(browser_profile=BrowserProfile(user_data_dir=tmp_path / "chrome"))
    native_session._cdp_client_root = SimpleNamespace()

    def authorize(timeout=120):
        env.authorizations += 1
        if env.authorizations > 1 and env.authorization_error is not None:
            raise env.authorization_error
        env.allowed = True

    def revoke():
        env.allowed = False

    def build(**kwargs):
        agent = ShadowAgent(**kwargs, tools=OSController(SimpleNamespace(authorize=authorize, revoke=revoke), config=env.config),
            audit_path=env.path, use_judge=False, use_vision=False, file_system_path=str(tmp_path / "vendor-files"))
        env.agents.append(agent)
        return agent

    async def state(current, **kwargs):
        env.reads.append(kwargs)
        return BrowserStateSummary(dom_state=SerializedDOMState(_root=None, selector_map={}),
            url="https://example.com/fresh", title="人工处理后的页面",
            tabs=[TabInfo(url="https://example.com/fresh", title="人工处理后的页面", target_id="page_0001")])

    async def restore(tools, session):
        assert env.allowed
        env.restore_started.set()
        if env.block_restore:
            await env.restore_release.wait()

    async def confirm(tools, session):
        assert env.restore_started.is_set() and env.allowed

    async def invoke(current, messages, output_format=None, **kwargs):
        env.calls.append((current, messages, output_format))
        env.model_started.set()
        if env.block_model:
            try:
                await env.model_release.wait()
            except asyncio.CancelledError:
                env.model_cancelled.set()
                if not env.late_model:
                    raise
                await env.model_release.wait()
        if env.model_error is not None:
            raise env.model_error
        return ChatInvokeCompletion(completion=output_format(can_resume=env.can_resume, reason=env.reason), usage=None)

    async def native_run(current, **kwargs):
        action = await current.os_controller.registry.execute_action("request_takeover",
            {"reason": "login_required"}, browser_session=current.browser_session)
        current.state.last_result = [action]
        env.started.set()
        await kwargs["on_step_end"](current)
        env.continued.set()
        await env.release.wait()
        current.history.add_item(AgentHistory(model_output=None, result=[ActionResult(is_done=True, success=True)],
            state=BrowserStateHistory(url="https://example.com/finished", title="完成", tabs=[], interacted_element=[])))
        return current.history

    monkeypatch.setattr(server, "create_session", lambda account_id: native_session)
    monkeypatch.setattr(server, "_build_agent", build)
    monkeypatch.setattr(BrowserSession, "get_browser_state_summary", state)
    monkeypatch.setattr(OSController, "restore_task_page", restore)
    monkeypatch.setattr(OSController, "confirm_task_page", confirm)
    monkeypatch.setattr(ChatOpenAI, "ainvoke", invoke)
    monkeypatch.setattr(Agent, "run", native_run)
    env.session = native_session
    env.app = server.create_app(env.config)
    return env


@asynccontextmanager
async def raw_resume(env, task_id):
    """发送真实 ASGI 断开事件，验证恢复请求与原任务的取消边界。"""
    incoming, messages = asyncio.Queue(), []
    incoming.put_nowait({"type": "http.request", "body": b"", "more_body": False})

    async def send(message):
        messages.append(message)

    path = f"/task/{task_id}/resume"
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
        "headers": [(b"authorization", f"Bearer {env.app.state.token_auth.token}".encode())],
        "client": ("127.0.0.1", 1), "server": ("test", 80)}
    request = asyncio.create_task(env.app(scope, incoming.get, send))
    try:
        yield SimpleNamespace(task=request, incoming=incoming, messages=messages)
    finally:
        if not request.done():
            request.cancel()
        await asyncio.gather(request, return_exceptions=True)


async def resume_idle(agent):
    async with asyncio.timeout(2):
        while agent.takeover.resume_in_flight:
            await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_submission_returns_before_execution_and_passes_identity_and_task(environment):
    env = environment
    async with client_for(env) as client:
        response = await submit(client, count=2, note="中文参数")
        assert response.status_code == 202
        body = response.json()
        assert body["status"] == "accepted" and body["steps_completed"] == 0
        await asyncio.wait_for(env.started.wait(), timeout=2)
        assert (await client.get("/version")).status_code == 200
        assert not env.release.is_set()
        kwargs = env.agents[0].kwargs
        assert kwargs["task_id"] == body["task_id"]
        assert kwargs["account_id"] == env.sessions[0].account_id == "account_001"
        assert kwargs["config"] is not env.config
        assert kwargs["config"].model_dump() == env.config.model_dump()
        assert kwargs["browser_session"] is env.sessions[0]
        assert kwargs["enable_signal_handler"] is False
        assert kwargs["task"].startswith("访问 https://example.com 并读取标题")
        supplement = kwargs["task"].split("\n")[-1]
        assert json.loads(supplement) == {"count": 2, "note": "中文参数"}
        env.release.set()
        saved = await result(env, body["task_id"])
        assert saved.status == "completed" and saved.cleanup_complete
        assert env.app.state.active_task is None
        assert saved.agent is saved.session is saved.runner is None
        assert env.sessions[0].kills == 1
        assert [row["event"] for row in records(env)] == ["task_start", "task_end"]
        assert {row["task_id"] for row in records(env)} == {body["task_id"]}


@pytest.mark.asyncio
async def test_simultaneous_submissions_share_one_desktop_slot(environment):
    env = environment
    async with client_for(env) as client:
        responses = await asyncio.gather(submit(client), submit(client))
        assert sorted(response.status_code for response in responses) == [202, 409]
        assert len(env.app.state.task_results) == 1
        await asyncio.wait_for(env.started.wait(), timeout=2)
        assert len(env.agents) == len(env.sessions) == 1
        env.release.set()
        body = next(response.json() for response in responses if response.status_code == 202)
        await result(env, body["task_id"])
        another = await submit(client)
        assert another.status_code == 202 and another.json()["task_id"] != body["task_id"]
        await result(env, another.json()["task_id"])


@pytest.mark.asyncio
@pytest.mark.parametrize("success, status", [(True, "completed"), (False, "failed"), (None, "failed")])
async def test_normal_return_uses_native_success_flag(environment, success, status):
    env, environment.success = environment, success
    async with client_for(env) as client:
        response = await submit(client)
        assert response.status_code == 202
        env.release.set()
        saved = await result(env, response.json()["task_id"])
        assert saved.status == status and saved.cleanup_complete
        progress = await client.get(f"/task/{saved.task_id}/status")
        assert progress.status_code == 200
        assert progress.json()["message"] == (env.final_text if success is True else "任务未完成")
        assert env.sessions[0].kills == 1 and not env.allowed
        assert len([r for r in records(env) if r["event"] == "task_end"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["session", "agent", "authorization", "run"])
async def test_startup_and_execution_failure_clean_up_and_keep_safe_result(environment, phase):
    env = environment
    error = PermissionError("test-private-failure") if phase == "authorization" else ValueError("test-private-failure")
    if phase == "session":
        env.session_error = error
    elif phase == "agent":
        env.build_error = error
    else:
        env.run_error = error
    async with client_for(env) as client:
        response = await submit(client)
        assert response.status_code == 202
        env.release.set()
        saved = await result(env, response.json()["task_id"])
        assert saved.status == "failed" and saved.cleanup_complete
        assert env.app.state.active_task is None
        assert saved.agent is saved.session is saved.runner is None
        assert "test-private" not in repr(saved)
        assert "test-private" not in env.path.read_text()
        assert [r["event"] for r in records(env)] == ["task_start", "task_end"]
        assert records(env)[-1]["outcome"] == "failed"
        assert not env.sessions or env.sessions[0].kills == 1


@pytest.mark.asyncio
async def test_slot_is_held_until_session_cleanup_really_completes(environment):
    env, environment.block_kill = environment, True
    async with client_for(env) as client:
        response = await submit(client)
        assert response.status_code == 202
        env.release.set()
        await asyncio.wait_for(env.kill_started.wait(), timeout=2)
        saved = env.app.state.task_results[response.json()["task_id"]]
        assert saved.status != "completed" and not saved.cleanup_complete
        assert (await submit(client)).status_code == 409
        env.kill_release.set()
        assert (await result(env, saved.task_id)).status == "completed"
        assert env.app.state.active_task is None


@pytest.mark.asyncio
async def test_failed_cleanup_blocks_new_work_until_shutdown_cleanup(environment):
    env, environment.kill_failures = environment, 1
    async with client_for(env) as client:
        response = await submit(client)
        assert response.status_code == 202
        env.release.set()
        saved = await result(env, response.json()["task_id"])
        assert saved.status == "failed" and not saved.cleanup_complete
        assert saved.error_code == "cleanup_failed"
        assert env.app.state.active_task is saved
        assert (await submit(client)).status_code == 409
        assert "test-private" not in repr(saved)
    assert saved.cleanup_complete and env.sessions[0].kills == 2


@pytest.mark.asyncio
async def test_shutdown_cancels_before_runner_starts_without_constructing_browser(environment, monkeypatch):
    env = environment
    # 绕过鉴权线程调度，让 HTTP 受理后直到退出都不让后台协程先启动。
    from auth.token import TokenAuth
    async def verify(self):
        return None
    monkeypatch.setattr(TokenAuth, "verify", verify)
    env.app = server.create_app(env.config)
    async with client_for(env) as client:
        response = await submit(client)
        assert response.status_code == 202
        saved = env.app.state.task_results[response.json()["task_id"]]
        assert not saved.started
    assert saved.status == "cancelled" and saved.cleanup_complete
    assert env.agents == env.sessions == []
    assert [r["event"] for r in records(env)] == ["task_start", "task_end"]
    assert records(env)[-1]["outcome"] == "cancelled"


@pytest.mark.asyncio
async def test_shutdown_waits_for_agent_and_browser_despite_repeated_cancellation(environment):
    env = environment
    env.block_cleanup = env.block_kill = True
    lifecycle = env.app.router.lifespan_context(env.app)
    await lifecycle.__aenter__()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app), base_url="http://test",
        headers={"Authorization": f"Bearer {env.app.state.token_auth.token}"}) as client:
        shutdown = None
        try:
            response = await submit(client)
            assert response.status_code == 202
            await asyncio.wait_for(env.started.wait(), timeout=2)
            shutdown = asyncio.create_task(lifecycle.__aexit__(None, None, None))
            await asyncio.wait_for(env.cleanup_started.wait(), timeout=2)
            assert not env.allowed
            assert (await submit(client)).status_code == 503
            shutdown.cancel()
            done, _ = await asyncio.wait({shutdown}, timeout=0.03)
            assert not done
            assert Path(env.config.PID_FILE_PATH).read_text()
            assert env.app.state.active_task is not None
            env.cleanup_release.set()
            await asyncio.wait_for(env.kill_started.wait(), timeout=2)
            shutdown.cancel()
            done, _ = await asyncio.wait({shutdown}, timeout=0.03)
            assert not done
            env.kill_release.set()
            with pytest.raises(asyncio.CancelledError):
                await shutdown
            saved = env.app.state.task_results[response.json()["task_id"]]
            assert saved.status == "cancelled" and saved.cleanup_complete
            assert env.app.state.active_task is None
            assert records(env)[-1]["outcome"] == "cancelled"
            assert Path(env.config.PID_FILE_PATH).read_text() == ""
            assert not env.app.state.token_auth.token
        finally:
            env.release.set()
            env.cleanup_release.set()
            env.kill_release.set()
            if shutdown is None:
                await lifecycle.__aexit__(None, None, None)
            else:
                await asyncio.gather(shutdown, return_exceptions=True)


@pytest.mark.asyncio
async def test_disconnected_submission_does_not_cancel_accepted_task(environment):
    env = environment
    async with client_for(env):
        async def receive():
            return {"type": "http.request", "body": json.dumps({"account_id": "account_001",
                "params": {"task": "读取标题"}}).encode(), "more_body": False}

        async def send(message):
            if message["type"] == "http.response.start":
                raise asyncio.CancelledError

        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
            "scheme": "http", "path": "/task", "raw_path": b"/task", "query_string": b"",
            "headers": [(b"content-type", b"application/json"),
                (b"authorization", f"Bearer {env.app.state.token_auth.token}".encode())],
            "client": ("127.0.0.1", 1), "server": ("test", 80)}
        with pytest.raises(asyncio.CancelledError):
            await asyncio.create_task(env.app(scope, receive, send))
        await asyncio.wait_for(env.started.wait(), timeout=2)
        assert env.allowed and len(env.app.state.task_results) == 1
        saved = next(iter(env.app.state.task_results.values()))
        env.release.set()
        assert (await result(env, saved.task_id)).status == "completed"


@pytest.mark.asyncio
@pytest.mark.parametrize("denied", [False, True])
async def test_http_uses_real_shadow_agent_authorization_history_and_audit(environment, tmp_path, monkeypatch, denied):
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    from agent.controller import OSController
    from agent.loop import ShadowAgent
    from browser_use.agent.service import Agent
    from browser_use.agent.views import ActionResult, AgentHistory
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.views import BrowserStateHistory

    env = environment
    native_session = BrowserSession(browser_profile=BrowserProfile(user_data_dir=tmp_path / "chrome"))
    native_session._cdp_client_root = SimpleNamespace()

    def authorize(timeout=120):
        if denied:
            raise PermissionError("用户拒绝授权")
        env.allowed = True

    def revoke():
        env.allowed = False

    def build(**kwargs):
        agent = ShadowAgent(**kwargs, tools=OSController(SimpleNamespace(authorize=authorize, revoke=revoke), config=env.config),
            audit_path=env.path, use_judge=False, file_system_path=str(tmp_path / "vendor-files"))
        env.agents.append(agent)
        return agent

    async def native_run(current, **kwargs):
        assert env.allowed
        current.history.add_item(AgentHistory(model_output=None, result=[ActionResult(is_done=True, success=True)],
            state=BrowserStateHistory(url="https://example.com", title="页面", tabs=[], interacted_element=[])))
        return current.history

    monkeypatch.setattr(server, "create_session", lambda account_id: native_session)
    monkeypatch.setattr(server, "_build_agent", build)
    monkeypatch.setattr(Agent, "run", native_run)
    async with client_for(env) as client:
        response = await submit(client)
        assert response.status_code == 202
        saved = await result(env, response.json()["task_id"], timeout=10)
        assert saved.status == ("failed" if denied else "completed")
        assert saved.cleanup_complete and not env.allowed
        assert env.agents[0].enable_signal_handler is False
        rows = records(env)
        assert [row["event"] for row in rows] == ["task_start", "authorization_start", "authorization_end", "task_end"]
        assert rows[-1]["outcome"] == ("failed" if denied else "completed")
        assert {row["task_id"] for row in rows} == {saved.task_id}
        assert {row["account_id"] for row in rows} == {"account_001"}


@pytest.mark.asyncio
async def test_prestart_audit_failure_does_not_launch_agent_or_leak_slot(environment, monkeypatch):
    env = environment
    env.build_error = ValueError("test-private-failure")

    def fail(*args):
        raise OSError("test-private-audit-error")

    monkeypatch.setattr(AuditLog, "_append", fail)
    async with client_for(env) as client:
        response = await submit(client)
        assert response.status_code == 202
        saved = await result(env, response.json()["task_id"])
        assert saved.status == "failed" and saved.cleanup_complete
        assert env.agents == [] and env.sessions[0].kills == 1
        assert env.app.state.active_task is None and not env.path.exists()
        assert "test-private" not in repr(saved)


@pytest.mark.asyncio
async def test_cleanup_failure_preserves_original_run_failure(environment):
    env = environment
    env.run_error, env.kill_failures = ValueError("test-private-run-error"), 1
    async with client_for(env) as client:
        response = await submit(client)
        assert response.status_code == 202
        env.release.set()
        saved = await result(env, response.json()["task_id"])
        assert saved.status == "failed" and saved.error_code == "task_failed"
        assert not saved.cleanup_complete
        assert records(env)[-1]["outcome"] == "failed"
        assert (await submit(client)).status_code == 409


@pytest.mark.asyncio
async def test_scheduling_failure_is_not_accepted_or_reserved(environment, monkeypatch):
    env = environment
    create_task = asyncio.create_task

    def schedule(coroutine, **kwargs):
        if coroutine.cr_code.co_name == "_execute_task":
            raise RuntimeError("调度失败")
        return create_task(coroutine, **kwargs)

    monkeypatch.setattr(asyncio, "create_task", schedule)
    async with client_for(env) as client:
        response = await submit(client)
        assert response.status_code == 503 and "task_id" not in response.json()
        assert env.app.state.active_task is None
        assert env.app.state.task_results == {}
        assert env.agents == env.sessions == []
        assert not env.path.exists()


@pytest.mark.asyncio
async def test_native_swallowed_process_shutdown_error_does_not_release_desktop(environment, tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    from browser_use.agent.service import Agent
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.watchdogs.local_browser_watchdog import LocalBrowserWatchdog
    import psutil

    env = environment
    native_session = BrowserSession(browser_profile=BrowserProfile(user_data_dir=tmp_path / "chrome"))

    class Process:
        pid, alive = 123456, True

        def terminate(self):
            raise psutil.AccessDenied(self.pid)

        def is_running(self):
            return self.alive

        def status(self):
            return "running" if self.alive else "dead"

    process = Process()
    watchdog = LocalBrowserWatchdog(event_bus=native_session.event_bus, browser_session=native_session)
    watchdog._subprocess = process
    native_session._local_browser_watchdog = watchdog
    watchdog.attach_to_session()
    build = server._build_agent

    def build_and_close(**kwargs):
        agent = build(**kwargs)
        run = agent.run

        async def native_close(**kwargs):
            history = await run(**kwargs)
            # 保留原生 Agent.close 的行为，覆盖原库先关闭并丢弃 PID 的路径。
            await Agent.close(SimpleNamespace(browser_session=native_session, skill_service=None,
                logger=logging.getLogger(__name__)))
            return history

        agent.run = native_close
        return agent

    monkeypatch.setattr(server, "create_session", lambda account_id: native_session)
    monkeypatch.setattr(server, "_build_agent", build_and_close)
    async with client_for(env) as client:
        try:
            response = await submit(client)
            assert response.status_code == 202
            env.release.set()
            saved = await result(env, response.json()["task_id"], timeout=10)
            assert saved.status == "failed" and not saved.cleanup_complete
            assert saved.error_code == "cleanup_failed"
            assert saved.browser_process is process and process.alive
            assert env.app.state.active_task is saved
            assert (await submit(client)).status_code == 409
        finally:
            # 模拟用户随后关闭仍存活的 Chrome；不创建或结束真实进程。
            process.alive = False
    assert saved.cleanup_complete and saved.browser_process is None


@pytest.mark.asyncio
async def test_untracked_launch_cannot_be_reported_as_cleaned(environment, tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    from browser_use.browser.events import BrowserLaunchEvent
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.session import BrowserSession

    env = environment
    native_session = BrowserSession(browser_profile=BrowserProfile(user_data_dir=tmp_path / "chrome"))
    build = server._build_agent

    def build_with_failed_launch(**kwargs):
        agent = build(**kwargs)
        run = agent.run

        async def failed_launch(**kwargs):
            await native_session.event_bus.dispatch(BrowserLaunchEvent())
            return await run(**kwargs)

        agent.run = failed_launch
        return agent

    monkeypatch.setattr(server, "create_session", lambda account_id: native_session)
    monkeypatch.setattr(server, "_build_agent", build_with_failed_launch)
    with pytest.raises(RuntimeError, match="无法确认"):
        async with client_for(env) as client:
            response = await submit(client)
            assert response.status_code == 202
            env.release.set()
            saved = await result(env, response.json()["task_id"], timeout=10)
            assert not saved.cleanup_complete and saved.status == "failed"
            assert (await submit(client)).status_code == 409


@pytest.mark.asyncio
async def test_status_of_unknown_task_has_no_execution_side_effects(environment):
    env = environment
    async with client_for(env) as client:
        response = await client.get("/task/unknown/status")
        assert response.status_code == 404 and response.json()["detail"] == "任务不存在"
        assert env.agents == env.sessions == []
        assert not env.path.exists() and env.app.state.task_results == {}


@pytest.mark.asyncio
async def test_accepted_status_starts_at_zero_without_starting_agent(environment, monkeypatch):
    from auth.token import TokenAuth

    async def verify(self):
        pass

    env = environment
    monkeypatch.setattr(TokenAuth, "verify", verify)
    env.app = server.create_app(env.config)
    async with client_for(env) as client:
        submitted = await submit(client)
        task_id = submitted.json()["task_id"]
        response = await client.get(f"/task/{task_id}/status")
        assert response.status_code == 200
        assert response.json() == {"task_id": task_id, "status": "accepted", "steps_completed": 0,
            "current_url": None, "message": None, "takeover_reason": None,
            "login_required": False, "captcha_detected": False}
        assert not env.app.state.task_results[task_id].started


@pytest.mark.asyncio
@pytest.mark.parametrize("reason, login, captcha", [
    ("login_required", True, False), ("captcha_detected", False, True),
    ("verification_required", False, False), ("authorization_required", False, False),
])
async def test_polling_reads_takeover_without_reopening_or_running_model(environment, reason, login, captcha):
    from core.orchestrator.takeover import TakeoverSnapshot

    env = environment
    async with client_for(env) as client:
        submitted = await submit(client)
        task_id = submitted.json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        agent = env.agents[0]
        snapshot = TakeoverSnapshot(task_id, status="awaiting_user", message="请人工处理后点击已完成",
            takeover_reason=reason, login_required=login, captcha_detected=captcha)
        agent.takeover.snapshot = snapshot
        original_audit = env.path.read_bytes()

        async def forbidden(*args, **kwargs):
            pytest.fail("轮询不能调用模型、读取新页面或再次运行 Agent")

        agent.run = forbidden
        agent.llm = SimpleNamespace(ainvoke=forbidden)
        env.sessions[0].get_browser_state_summary = forbidden
        for _ in range(3):
            response = await client.get(f"/task/{task_id}/status")
            assert response.status_code == 200
            body = response.json()
            assert body["status"] == "awaiting_user" and body["steps_completed"] == 0
            assert body["takeover_reason"] == reason and body["message"] == "请人工处理后点击已完成"
            assert body["login_required"] is login and body["captcha_detected"] is captcha
        assert agent.takeover.snapshot is snapshot
        assert env.path.read_bytes() == original_audit
        assert len(env.agents) == len(env.sessions) == 1
        assert (await submit(client)).status_code == 409


@pytest.mark.asyncio
async def test_resume_snapshot_clears_waiting_fields_without_extra_steps(environment):
    from core.orchestrator.takeover import TakeoverSnapshot

    env = environment
    async with client_for(env) as client:
        submitted = await submit(client)
        task_id = submitted.json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        agent = env.agents[0]
        agent.takeover.snapshot = TakeoverSnapshot(task_id, status="awaiting_user",
            takeover_reason="login_required", login_required=True, message="请人工登录")
        waiting = await client.get(f"/task/{task_id}/status")
        assert waiting.status_code == 200 and waiting.json()["login_required"]
        agent.takeover.snapshot = TakeoverSnapshot(task_id)
        body = (await client.get(f"/task/{task_id}/status")).json()
        assert body["status"] == "running" and body["steps_completed"] == 0
        assert body["message"] is body["takeover_reason"] is None
        assert not body["login_required"] and not body["captcha_detected"]


@pytest.mark.asyncio
async def test_progress_waits_for_step_end_and_preserves_url_after_budget_row(environment):
    env = environment
    async with client_for(env) as client:
        submitted = await submit(client)
        task_id = submitted.json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        initial = await client.get(f"/task/{task_id}/status")
        assert initial.status_code == 200 and initial.json()["steps_completed"] == 0
        agent = env.agents[0]
        agent.history.history.append(SimpleNamespace(state=SimpleNamespace(url="https://example.com/start")))
        await agent.callbacks["on_step_start"](agent)
        body = (await client.get(f"/task/{task_id}/status")).json()
        assert body["steps_completed"] == 0 and body["current_url"] == "https://example.com/start"
        # 原生计数已递增，但存档尚未收尾，不能提前计入 HTTP 进度。
        agent.state.n_steps = 2
        agent.history.history.append(SimpleNamespace(state=SimpleNamespace(url="https://example.com/next")))
        assert (await client.get(f"/task/{task_id}/status")).json()["steps_completed"] == 0
        await agent.callbacks["on_step_end"](agent)
        body = (await client.get(f"/task/{task_id}/status")).json()
        assert body["steps_completed"] == 1 and body["current_url"] == "https://example.com/next"
        agent.history.history.append(SimpleNamespace(state=SimpleNamespace(url="")))
        env.success = None
        env.release.set()
        await result(env, task_id)
        body = (await client.get(f"/task/{task_id}/status")).json()
        assert body["status"] == "failed" and body["steps_completed"] == 1
        assert body["current_url"] == "https://example.com/next"


@pytest.mark.asyncio
@pytest.mark.parametrize("success", [True, False, None])
async def test_terminal_status_survives_release_and_ignores_old_waiting_snapshot(environment, success):
    from core.orchestrator.takeover import TakeoverSnapshot

    env, environment.success = environment, success
    async with client_for(env) as client:
        submitted = await submit(client)
        task_id = submitted.json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        env.agents[0].takeover.snapshot = TakeoverSnapshot(task_id, status="awaiting_user",
            takeover_reason="login_required", login_required=True, message="旧登录提示")
        env.release.set()
        saved = await result(env, task_id)
        assert saved.agent is None
        response = await client.get(f"/task/{task_id}/status")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == ("completed" if success is True else "failed")
        assert body["takeover_reason"] is None and body["message"] != "旧登录提示"
        assert not body["login_required"] and not body["captcha_detected"]


@pytest.mark.asyncio
async def test_failed_run_stops_showing_waiting_prompt_during_browser_cleanup(environment):
    from core.orchestrator.takeover import TakeoverSnapshot

    env = environment
    env.block_kill = True
    env.run_error = RuntimeError("test-private-resume-fatal")
    async with client_for(env) as client:
        submitted = await submit(client)
        task_id = submitted.json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        agent = env.agents[0]
        agent.takeover.snapshot = TakeoverSnapshot(task_id, status="awaiting_user",
            takeover_reason="login_required", login_required=True, message="请人工登录")
        assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "awaiting_user"
        env.release.set()
        await asyncio.wait_for(env.kill_started.wait(), timeout=2)
        body = (await client.get(f"/task/{task_id}/status")).json()
        assert body["status"] == "running"
        assert body["message"] != "请人工登录" and body["takeover_reason"] is None
        assert not body["login_required"] and not body["captcha_detected"]
        assert (await submit(client)).status_code == 409
        env.kill_release.set()
        await result(env, task_id)
        assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "failed"


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_requested", [False, True])
async def test_cancelled_snapshot_does_not_publish_terminal_before_browser_cleanup(environment, cancel_requested):
    from core.orchestrator.takeover import TakeoverSnapshot

    env, environment.block_kill = environment, True
    async with client_for(env) as client:
        submitted = await submit(client)
        task_id = submitted.json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        env.agents[0].takeover.snapshot = TakeoverSnapshot(task_id, status="cancelled", message="任务已取消")
        saved = env.app.state.task_results[task_id]
        saved.cancel_requested = cancel_requested
        if cancel_requested:
            saved.status = "cancelling"
        response = await client.get(f"/task/{task_id}/status")
        assert response.status_code == 200 and response.json()["status"] == "cancelling"
        env.release.set()
        await asyncio.wait_for(env.kill_started.wait(), timeout=2)
        assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "cancelling"
        env.kill_release.set()
        await result(env, task_id)
        assert (await client.get(f"/task/{task_id}/status")).json()["status"] != "cancelling"


@pytest.mark.asyncio
async def test_cleanup_failure_status_does_not_expose_original_exception(environment):
    env, environment.kill_failures = environment, 1
    async with client_for(env) as client:
        submitted = await submit(client)
        task_id = submitted.json()["task_id"]
        env.release.set()
        await result(env, task_id)
        response = await client.get(f"/task/{task_id}/status")
        assert response.status_code == 200
        assert response.json()["status"] == "failed"
        assert response.json()["message"] == "会话清理失败，暂不接受新任务"
        assert "test-private" not in response.text
        assert (await submit(client)).status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["failure", "timeout", "takeover"])
async def test_status_uses_native_step_completion_and_real_takeover(environment, tmp_path, monkeypatch, phase):
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    from agent.controller import OSController
    from agent.loop import ShadowAgent
    from browser_use.agent.service import Agent
    from browser_use.agent.views import ActionResult, AgentHistory, AgentStepInfo
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.views import BrowserStateHistory

    env = environment
    native_session = BrowserSession(browser_profile=BrowserProfile(user_data_dir=tmp_path / "chrome"))
    native_session._cdp_client_root = SimpleNamespace()

    def authorize(timeout=120):
        env.allowed = True

    def revoke():
        env.allowed = False

    def build(**kwargs):
        agent = ShadowAgent(**kwargs, tools=OSController(SimpleNamespace(authorize=authorize, revoke=revoke), config=env.config),
            audit_path=env.path, use_judge=False, file_system_path=str(tmp_path / "vendor-files"))
        agent.settings.step_timeout = 0.1
        env.agents.append(agent)
        return agent

    async def step(current, step_info):
        if phase == "timeout":
            await asyncio.Event().wait()
        result = ActionResult(error="元素暂时不可用")
        if phase == "takeover":
            result = await current.os_controller.registry.execute_action("request_takeover",
                {"reason": "login_required"}, browser_session=current.browser_session)
        current.state.last_result = [result]
        current.step_start_time = time.time()
        await current._finalize(None)
        if phase == "takeover":
            env.started.set()

    async def native_run(current, **kwargs):
        current.history.add_item(AgentHistory(model_output=None, result=[],
            state=BrowserStateHistory(url="https://example.com/start", title="首次导航", tabs=[], interacted_element=[])))
        await current._execute_step(0, 1, AgentStepInfo(step_number=0, max_steps=1),
            kwargs["on_step_start"], kwargs["on_step_end"])
        env.started.set()
        await env.release.wait()
        current.history.add_item(AgentHistory(model_output=None, result=[ActionResult(error="步骤预算耗尽")],
            state=BrowserStateHistory(url="", title="", tabs=[], interacted_element=[])))
        return current.history

    monkeypatch.setattr(server, "create_session", lambda account_id: native_session)
    monkeypatch.setattr(server, "_build_agent", build)
    monkeypatch.setattr(Agent, "step", step)
    monkeypatch.setattr(Agent, "run", native_run)
    async with client_for(env) as client:
        submitted = await submit(client)
        task_id = submitted.json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        response = await client.get(f"/task/{task_id}/status")
        assert response.status_code == 200
        body = response.json()
        assert body["steps_completed"] == 1 and body["current_url"] == "https://example.com/start"
        if phase == "takeover":
            assert body["status"] == "awaiting_user" and body["login_required"]
            assert body["message"] == "检测到登录入口，请人工登录后点击'已完成'"
            assert not env.allowed
            audit_before = env.path.read_bytes()
            again = await client.get(f"/task/{task_id}/status")
            assert again.json() == body and env.path.read_bytes() == audit_before
        else:
            env.release.set()
            await result(env, task_id, timeout=10)
            body = (await client.get(f"/task/{task_id}/status")).json()
            assert body["status"] == "failed" and body["steps_completed"] == 1
            assert body["current_url"] == "https://example.com/start"


@pytest.mark.asyncio
async def test_resume_unknown_task_does_not_create_execution(environment):
    env = environment
    async with client_for(env) as client:
        response = await client.post("/task/unknown/resume")
        assert response.status_code == 404 and response.json()["detail"] == "任务不存在"
        assert env.agents == env.sessions == [] and not env.path.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["running", "completed", "failed", "cancelling", "cleanup"])
async def test_resume_rejects_nonwaiting_and_finishing_tasks(environment, phase):
    env = environment
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        if phase in {"completed", "failed"}:
            env.success = phase == "completed"
            env.release.set()
            await result(env, task_id)
        elif phase == "cancelling":
            env.block_cleanup = True
            server._request_stop(env.app.state.task_results[task_id])
            await asyncio.wait_for(env.cleanup_started.wait(), timeout=2)
        elif phase == "cleanup":
            from core.orchestrator.takeover import TakeoverSnapshot

            env.agents[0].takeover.snapshot = TakeoverSnapshot(task_id, status="awaiting_user", login_required=True)
            env.block_kill = True
            env.release.set()
            await asyncio.wait_for(env.kill_started.wait(), timeout=2)
        response = await client.post(f"/task/{task_id}/resume")
        assert response.status_code == 409
        assert "test-private" not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", [None, "login_required", "captcha_detected", "uncertain", "authorization_required"])
async def test_resume_returns_real_result_after_fresh_check_and_authorization(resume_environment, reason):
    env = resume_environment
    if reason == "authorization_required":
        env.authorization_error = PermissionError("用户未授权")
    elif reason is not None:
        env.can_resume, env.reason = False, reason
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        agent = env.agents[0]
        history, steps = agent.history, agent.state.n_steps
        response = await client.post(f"/task/{task_id}/resume")
        assert response.status_code == 200
        assert response.json()["resumed"] is (reason is None)
        assert len(env.calls) == 1
        assert env.reads == [{"cached": False, "include_screenshot": False}] * (2 if reason is None else 1)
        assert env.calls[0][0] is agent.llm
        assert "https://example.com/fresh" in env.calls[0][1][-1].text
        assert "action" not in env.calls[0][2].model_fields
        assert agent.history is history and agent.state.n_steps == steps
        status = (await client.get(f"/task/{task_id}/status")).json()
        if reason is None:
            assert response.json() == {"resumed": True}
            await asyncio.wait_for(env.continued.wait(), timeout=2)
            assert status["status"] == "running" and not status["login_required"]
            assert env.authorizations == 2 and env.allowed
        else:
            assert response.json()["message"] == status["message"]
            assert status["status"] == "awaiting_user" and not env.continued.is_set() and not env.allowed
            assert env.authorizations == (2 if reason == "authorization_required" else 1)
            await resume_idle(agent)
            env.can_resume, env.reason, env.authorization_error = True, None, None
            retry = await client.post(f"/task/{task_id}/resume")
            assert retry.status_code == 200 and retry.json() == {"resumed": True}
        rows = records(env)
        assert len([row for row in rows if row["event"] == "task_start"]) == 1
        assert len(env.agents) == 1 and env.app.state.active_task.agent is agent
        assert {row["task_id"] for row in rows} == {task_id}


@pytest.mark.asyncio
async def test_duplicate_resume_is_rejected_while_first_request_is_checking(resume_environment):
    env, resume_environment.block_model = resume_environment, True
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        pending = asyncio.create_task(client.post(f"/task/{task_id}/resume"))
        try:
            await asyncio.wait_for(env.model_started.wait(), timeout=2)
            assert not pending.done() and not env.continued.is_set() and not env.allowed
            duplicate = await client.post(f"/task/{task_id}/resume")
            assert duplicate.status_code == 409 and len(env.calls) == 1
            env.model_release.set()
            response = await asyncio.wait_for(pending, timeout=2)
            assert response.status_code == 200 and response.json() == {"resumed": True}
        finally:
            env.model_release.set()
            await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_api_resume_cannot_succeed_before_original_task_page_is_ready(resume_environment):
    env, resume_environment.block_restore = resume_environment, True
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        pending = asyncio.create_task(client.post(f"/task/{task_id}/resume"))
        try:
            await asyncio.wait_for(env.restore_started.wait(), timeout=2)
            assert not pending.done() and not env.continued.is_set()
            assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "awaiting_user"
            env.restore_release.set()
            response = await asyncio.wait_for(pending, timeout=2)
            assert response.status_code == 200 and response.json() == {"resumed": True}
            await asyncio.wait_for(env.continued.wait(), timeout=2)
        finally:
            env.restore_release.set()
            await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("error, code", [(RuntimeError("test-private-model-error"), 502),
    (TimeoutError("test-private-timeout"), 504)])
async def test_resume_check_errors_are_not_reported_as_login_failure(resume_environment, error, code):
    env, resume_environment.model_error = resume_environment, error
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        response = await client.post(f"/task/{task_id}/resume")
        assert response.status_code == code and "test-private" not in response.text
        assert "resumed" not in response.json()
        assert not env.continued.is_set() and not env.allowed
        assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "awaiting_user"
        await resume_idle(env.agents[0])
        env.model_error = None
        assert (await client.post(f"/task/{task_id}/resume")).json() == {"resumed": True}


@pytest.mark.asyncio
async def test_resume_model_timeout_leaves_original_run_waiting(resume_environment):
    env = resume_environment
    env.config.LLM_TIMEOUT, env.block_model = 1, True
    env.app = server.create_app(env.config)
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        response = await asyncio.wait_for(client.post(f"/task/{task_id}/resume"), timeout=3)
        assert response.status_code == 504
        assert env.model_cancelled.is_set() and not env.continued.is_set() and not env.allowed
        assert env.app.state.active_task.runner is not None
        assert not env.app.state.active_task.runner.done()
        assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "awaiting_user"


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["browser", "audit"])
async def test_fatal_resume_failure_ends_original_task(resume_environment, monkeypatch, phase):
    from auth.audit import AuditError

    env = resume_environment
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        if phase == "browser":
            env.session._cdp_client_root = None
        else:
            record_audit = env.agents[0].audit.record

            async def fail_resume(event, **kwargs):
                if event == "resume_start":
                    raise AuditError("test-private-audit-error")
                return await record_audit(event, **kwargs)

            monkeypatch.setattr(env.agents[0].audit, "record", fail_resume)
        response = await client.post(f"/task/{task_id}/resume")
        assert response.status_code == 503 and "test-private" not in response.text
        assert not env.continued.is_set() and not env.allowed
        saved = await result(env, task_id, timeout=10)
        assert saved.status == "failed" and saved.cleanup_complete


@pytest.mark.asyncio
async def test_task_cancellation_wins_over_pending_resume(resume_environment):
    env, resume_environment.block_model = resume_environment, True
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        request = asyncio.create_task(client.post(f"/task/{task_id}/resume"))
        try:
            await asyncio.wait_for(env.model_started.wait(), timeout=2)
            server._request_stop(env.app.state.task_results[task_id])
            response = await asyncio.wait_for(request, timeout=2)
            assert response.status_code == 409 and not env.continued.is_set()
            assert env.model_cancelled.is_set() and not env.allowed
            assert (await result(env, task_id, timeout=10)).status == "cancelled"
        finally:
            env.model_release.set()
            await asyncio.gather(request, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("cancelled", [False, True])
async def test_resume_result_survives_fast_task_finish_but_not_cancellation(resume_environment, monkeypatch, cancelled):
    env = resume_environment
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        agent, record = env.agents[0], env.app.state.task_results[task_id]
        resume, runner = agent.resume_task, record.runner

        async def delayed_delivery():
            result = await resume()
            if cancelled:
                server._request_stop(record)
            else:
                env.release.set()
            # 模拟 HTTP 得到恢复结果前，原任务已完成后续业务及清理。
            await runner
            return result

        monkeypatch.setattr(agent, "resume_task", delayed_delivery)
        response = await client.post(f"/task/{task_id}/resume")
        if cancelled:
            assert response.status_code == 409
            assert record.status == "cancelled"
        else:
            assert response.status_code == 200 and response.json() == {"resumed": True}
            assert record.status == "completed"


@pytest.mark.asyncio
@pytest.mark.parametrize("interruption", ["cancel", "disconnect"])
async def test_interrupted_resume_rejects_late_result_and_keeps_original_task(resume_environment, interruption):
    env = resume_environment
    env.block_model = env.late_model = True
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        agent, record = env.agents[0], env.app.state.task_results[task_id]
        runner = record.runner
        async with raw_resume(env, task_id) as request:
            await asyncio.wait_for(env.model_started.wait(), timeout=2)
            if interruption == "cancel":
                request.task.cancel()
            else:
                request.incoming.put_nowait({"type": "http.disconnect"})
            await asyncio.wait_for(env.model_cancelled.wait(), timeout=2)
            await asyncio.wait_for(asyncio.gather(request.task, return_exceptions=True), timeout=2)
            if interruption == "cancel":
                assert request.task.cancelled()
            else:
                assert next(message["status"] for message in request.messages
                    if message["type"] == "http.response.start") == 499
            assert not runner.done() and not runner.cancelling() and not record.cancel_requested
            assert not env.allowed and not env.continued.is_set()
            assert (await client.post(f"/task/{task_id}/resume")).status_code == 409
            env.model_release.set()
            await resume_idle(agent)
            body = (await client.get(f"/task/{task_id}/status")).json()
            assert body["status"] == "awaiting_user" and not env.continued.is_set() and not env.allowed
            retry = await client.post(f"/task/{task_id}/resume")
            assert retry.status_code == 200 and retry.json() == {"resumed": True}
            assert env.app.state.active_task.agent is agent and record.runner is runner


@pytest.mark.asyncio
async def test_disconnect_before_resume_commit_wins_same_loop_completion(resume_environment, monkeypatch):
    env = resume_environment
    audit_started, audit_release = asyncio.Event(), asyncio.Event()
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        agent = env.agents[0]
        record_audit = agent.audit.record

        async def delay_commit(event, **kwargs):
            await record_audit(event, **kwargs)
            if event == "resume_end" and kwargs.get("outcome") == "completed":
                audit_started.set()
                await audit_release.wait()

        monkeypatch.setattr(agent.audit, "record", delay_commit)
        async with raw_resume(env, task_id) as request:
            try:
                await asyncio.wait_for(audit_started.wait(), timeout=2)
                assert agent.takeover.snapshot.status == "awaiting_user"
                # 同一轮先收到断开、再允许状态提交，断开必须及时使请求失效。
                request.incoming.put_nowait({"type": "http.disconnect"})
                audit_release.set()
                await asyncio.wait_for(request.task, timeout=2)
                await resume_idle(agent)
                body = (await client.get(f"/task/{task_id}/status")).json()
                assert body["status"] == "awaiting_user" and not env.continued.is_set() and not env.allowed
                assert next(message["status"] for message in request.messages
                    if message["type"] == "http.response.start") == 499
            finally:
                audit_release.set()


@pytest.mark.asyncio
async def test_cancel_unknown_task_has_no_execution_side_effects(environment):
    env = environment
    async with client_for(env) as client:
        response = await client.post("/task/unknown/cancel")
        assert response.status_code == 404 and response.json()["detail"] == "任务不存在"
        assert env.agents == env.sessions == [] and not env.path.exists()


@pytest.mark.asyncio
async def test_cancel_before_runner_starts_does_not_construct_browser(environment, monkeypatch):
    from auth.token import TokenAuth

    async def verify(self):
        pass

    env = environment
    monkeypatch.setattr(TokenAuth, "verify", verify)
    env.app = server.create_app(env.config)
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        saved = env.app.state.task_results[task_id]
        assert not saved.started
        response = await client.post(f"/task/{task_id}/cancel")
        assert response.status_code == 202 and response.json() == {"task_id": task_id, "status": "cancelling"}
        assert not saved.started and saved.cancel_requested
        assert (await result(env, task_id)).status == "cancelled"
        assert env.agents == env.sessions == []
        assert [row["event"] for row in records(env)] == ["task_start", "task_end"]
        assert records(env)[-1]["outcome"] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_keeps_slot_and_repeated_requests_do_not_interrupt_cleanup(environment):
    env = environment
    env.block_cleanup = env.block_kill = True
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        response = await client.post(f"/task/{task_id}/cancel")
        assert response.status_code == 202 and response.json() == {"task_id": task_id, "status": "cancelling"}
        await asyncio.wait_for(env.cleanup_started.wait(), timeout=2)
        saved = env.app.state.task_results[task_id]
        runner = saved.runner
        duplicates = await asyncio.gather(*(client.post(f"/task/{task_id}/cancel") for _ in range(3)))
        assert all(response.status_code == 202 for response in duplicates)
        assert not runner.done() and not saved.cleanup_complete and not env.kill_started.is_set()
        assert not env.allowed and env.app.state.active_task is saved
        status = (await client.get(f"/task/{task_id}/status")).json()
        assert status["status"] == "cancelling" and not status["login_required"]
        assert (await client.post(f"/task/{task_id}/resume")).status_code == 409
        assert (await submit(client)).status_code == 409
        env.cleanup_release.set()
        await asyncio.wait_for(env.kill_started.wait(), timeout=2)
        assert (await client.post(f"/task/{task_id}/cancel")).status_code == 202
        assert not runner.done() and not saved.cleanup_complete
        assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "cancelling"
        env.kill_release.set()
        await result(env, task_id)
        assert saved.status == "cancelled" and saved.cleanup_complete
        assert saved.agent is saved.runner is saved.session is None and env.app.state.active_task is None
        assert len([row for row in records(env) if row["event"] == "task_end"]) == 1
        assert records(env)[-1]["outcome"] == "cancelled"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
async def test_cancel_finished_task_cannot_stop_a_new_task(environment, status):
    env = environment
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        if status == "cancelled":
            first = await client.post(f"/task/{task_id}/cancel")
            assert first.status_code == 202
        else:
            env.success = status == "completed"
            env.release.set()
        assert (await result(env, task_id)).status == status
        env.started.clear()
        env.release.clear()
        new_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        current = env.app.state.active_task
        assert current.task_id == new_id
        response = await client.post(f"/task/{task_id}/cancel")
        assert response.status_code == 409
        assert current is env.app.state.active_task and not current.cancel_requested and env.allowed
        assert not current.runner.done()


@pytest.mark.asyncio
@pytest.mark.parametrize("failed", [False, True])
async def test_cancel_during_browser_cleanup_preserves_prior_execution_failure(environment, failed):
    env = environment
    env.block_kill = True
    if failed:
        env.run_error = RuntimeError("test-private-original-error")
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        env.release.set()
        await asyncio.wait_for(env.kill_started.wait(), timeout=2)
        response = await client.post(f"/task/{task_id}/cancel")
        assert response.status_code == 202 and "test-private" not in response.text
        assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "cancelling"
        env.kill_release.set()
        saved = await result(env, task_id)
        assert saved.status == ("failed" if failed else "cancelled")
        assert saved.cleanup_complete and env.app.state.active_task is None


@pytest.mark.asyncio
@pytest.mark.parametrize("success", [False, None])
async def test_cleanup_cancel_cannot_replace_native_incomplete_result(environment, success):
    env = environment
    env.block_kill, env.success = True, success
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        env.release.set()
        await asyncio.wait_for(env.kill_started.wait(), timeout=2)
        assert (await client.post(f"/task/{task_id}/cancel")).status_code == 202
        assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "cancelling"
        env.kill_release.set()
        saved = await result(env, task_id)
        assert saved.status == "failed" and saved.error_code == "task_incomplete"
        assert saved.message == "任务未完成" and saved.cleanup_complete
        assert env.app.state.active_task is None


@pytest.mark.asyncio
async def test_cancel_cleanup_failure_keeps_desktop_occupied(environment):
    env, environment.kill_failures = environment, 1
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)
        assert (await client.post(f"/task/{task_id}/cancel")).status_code == 202
        saved = await result(env, task_id)
        body = (await client.get(f"/task/{task_id}/status")).json()
        assert body["status"] == "failed" and body["message"] == "会话清理失败，暂不接受新任务"
        assert not saved.cleanup_complete and env.app.state.active_task is saved
        assert (await submit(client)).status_code == 409
        assert (await client.post(f"/task/{task_id}/cancel")).status_code == 409


@pytest.mark.asyncio
async def test_disconnected_cancel_request_does_not_undo_accepted_cancellation(environment):
    env, environment.block_cleanup = environment, True
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=2)

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            if message["type"] == "http.response.start":
                assert message["status"] == 202
                raise asyncio.CancelledError

        path = f"/task/{task_id}/cancel"
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
            "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
            "headers": [(b"authorization", f"Bearer {env.app.state.token_auth.token}".encode())],
            "client": ("127.0.0.1", 1), "server": ("test", 80)}
        with pytest.raises(asyncio.CancelledError):
            await env.app(scope, receive, send)
        await asyncio.wait_for(env.cleanup_started.wait(), timeout=2)
        assert env.app.state.active_task.cancel_requested and not env.allowed
        env.cleanup_release.set()
        assert (await result(env, task_id)).status == "cancelled"


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["waiting", "verify", "continued"])
async def test_http_cancel_interrupts_real_takeover_without_late_resume(resume_environment, phase):
    env = resume_environment
    env.block_model = env.late_model = phase == "verify"
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        pending = None
        try:
            if phase == "verify":
                pending = asyncio.create_task(client.post(f"/task/{task_id}/resume"))
                await asyncio.wait_for(env.model_started.wait(), timeout=2)
            elif phase == "continued":
                assert (await client.post(f"/task/{task_id}/resume")).json() == {"resumed": True}
                await asyncio.wait_for(env.continued.wait(), timeout=2)
            response = await client.post(f"/task/{task_id}/cancel")
            assert response.status_code == 202 and not env.allowed
            if phase == "verify":
                assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "cancelling"
                assert (await client.post(f"/task/{task_id}/cancel")).status_code == 202
                assert (await client.post(f"/task/{task_id}/resume")).status_code == 409
                env.model_release.set()
                assert (await asyncio.wait_for(pending, timeout=2)).status_code == 409
            saved = await result(env, task_id, timeout=10)
            assert saved.status == "cancelled" and saved.cleanup_complete and not env.allowed
            assert env.continued.is_set() is (phase == "continued")
            assert env.authorizations == (2 if phase == "continued" else 1)
            assert len(env.agents) == 1 and env.app.state.active_task is None
            rows = records(env)
            assert len([row for row in rows if row["event"] == "task_end"]) == 1
            assert rows[-1]["outcome"] == "cancelled" and {row["task_id"] for row in rows} == {task_id}
        finally:
            env.model_release.set()
            if pending is not None:
                await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_http_cancel_waits_for_real_authorization_thread_before_terminal(resume_environment, monkeypatch):
    env = resume_environment
    entered, release = threading.Event(), threading.Event()
    async with client_for(env) as client:
        task_id = (await submit(client)).json()["task_id"]
        await asyncio.wait_for(env.started.wait(), timeout=10)
        agent = env.agents[0]

        def authorize(timeout=120):
            env.allowed = True
            entered.set()
            assert release.wait(timeout=5)

        monkeypatch.setattr(agent.os_controller.os_executor, "authorize", authorize)
        pending = asyncio.create_task(client.post(f"/task/{task_id}/resume"))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            response = await client.post(f"/task/{task_id}/cancel")
            assert response.status_code == 202 and not env.allowed
            saved = env.app.state.task_results[task_id]
            assert saved.runner is not None and not saved.runner.done() and not saved.cleanup_complete
            assert (await client.get(f"/task/{task_id}/status")).json()["status"] == "cancelling"
            assert (await client.post(f"/task/{task_id}/cancel")).status_code == 202
            assert (await submit(client)).status_code == 409
            release.set()
            assert (await asyncio.wait_for(pending, timeout=2)).status_code == 409
            assert (await result(env, task_id, timeout=10)).status == "cancelled"
            assert not env.allowed and env.app.state.active_task is None
        finally:
            release.set()
            await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("success", [False, None])
async def test_cancel_before_agent_returns_preserves_existing_archive_cancel_priority(resume_environment, monkeypatch, success):
    import agent.loop as agent_loop
    from browser_use.agent.service import Agent
    from browser_use.agent.views import ActionResult, AgentHistory
    from browser_use.browser.views import BrowserStateHistory

    env = resume_environment
    archive_started, archive_release = asyncio.Event(), asyncio.Event()

    async def native_run(current, **kwargs):
        current.history.add_item(AgentHistory(model_output=None, result=[ActionResult(is_done=True, success=success)],
            state=BrowserStateHistory(url="https://example.com/finished", title="未完成", tabs=[], interacted_element=[])))
        return current.history

    async def archive(*args, **kwargs):
        archive_started.set()
        await archive_release.wait()

    monkeypatch.setattr(Agent, "run", native_run)
    monkeypatch.setattr(agent_loop, "maybe_save_history", archive)
    async with client_for(env) as client:
        try:
            task_id = (await submit(client)).json()["task_id"]
            await asyncio.wait_for(archive_started.wait(), timeout=10)
            assert not env.app.state.task_results[task_id].finishing
            assert (await client.post(f"/task/{task_id}/cancel")).status_code == 202
            saved = await result(env, task_id, timeout=10)
            # Agent.run 尚未返回，沿用存档阶段先取消、后清理的既有约定。
            assert saved.status == "cancelled" and saved.cleanup_complete
            assert records(env)[-1]["outcome"] == "cancelled" and not env.allowed
        finally:
            archive_release.set()
