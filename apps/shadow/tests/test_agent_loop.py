"""通过原生 Agent 初始化验证扩展点，运行阶段替代外部模型和桌面授权。"""

import asyncio
import base64
from io import BytesIO
import json
import threading
from types import SimpleNamespace

import pytest

from config.settings import Settings


@pytest.fixture
def environment(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    from agent import loop
    assert hasattr(loop,"ShadowAgent"), "Agent 主循环尚未实现"
    from agent.controller import OSController
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.session import BrowserSession

    class Desktop:
        def __init__(self):
            self.allowed = False
            self.reject = False
        def authorize(self,timeout=120):
            if self.reject:
                raise PermissionError("用户取消")
            self.allowed = True
        def revoke(self):
            self.allowed = False

    desktop = Desktop()
    config = Settings(_env_file=None,LLM_API_KEY="test-private-key",SAVE_HISTORY=False,HISTORY_SAVE_PATH=str(tmp_path / "sessions"))
    session = BrowserSession(browser_profile=BrowserProfile(user_data_dir=tmp_path / "chrome"))
    # 原生注册表会注入 CDP 客户端；占位对象不提供任何浏览器输入能力。
    session._cdp_client_root = SimpleNamespace()
    tools = OSController(desktop,config=config)

    def build(**kwargs):
        kwargs.setdefault("audit_path", tmp_path / "audit.log")
        task = kwargs.pop("task", "本地验证")
        return loop.ShadowAgent(task=task,browser_session=session,tools=tools,config=config,
            file_system_path=str(tmp_path / "vendor-files"),enable_signal_handler=False,**kwargs)

    return SimpleNamespace(loop=loop,build=build,tools=tools,desktop=desktop,session=session,config=config)


@pytest.mark.asyncio
@pytest.mark.parametrize("task", [
    "访问 https://platform.deepseek.com/usage，只读取网页标题。",
    "访问 https://platform.deepseek.com/usage 并读取网页标题。",
])
async def test_startup_leaves_navigation_to_model_instead_of_guessing_a_task_url(environment, task):
    agent = environment.build(task=task, use_judge=False)

    assert agent.initial_actions is None
    assert agent.task == task


@pytest.mark.asyncio
async def test_explicit_initial_navigation_is_preserved(environment):
    agent = environment.build(use_judge=False, initial_actions=[{
        "navigate": {"url": "https://example.com/explicit", "new_tab": False},
    }])

    assert agent.initial_actions[0].model_dump(exclude_none=True)["navigate"]["url"] == "https://example.com/explicit"


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"])
@pytest.mark.parametrize("vision", [True, False, "auto"])
async def test_flash_restores_requested_vision_after_native_initialization(environment, model, vision):
    environment.config.LLM_MODEL_NAME = model
    environment.config.JUDGE_MODEL_NAME = model
    agent = environment.build(use_vision=vision)

    assert agent.settings.use_vision == vision


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro"])
async def test_text_only_deepseek_models_keep_native_vision_disabled(environment, model):
    environment.config.LLM_MODEL_NAME = model
    environment.config.JUDGE_MODEL_NAME = model

    assert environment.build().settings.use_vision is False


@pytest.mark.asyncio
async def test_flash_vision_rejects_a_text_only_judge_before_sending_images(environment):
    environment.config.LLM_MODEL_NAME = "deepseek-flash"
    environment.config.JUDGE_MODEL_NAME = "deepseek-v4-pro"

    with pytest.raises(ValueError, match="Judge.*图片"):
        environment.build()


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["main", "resume", "judge"])
@pytest.mark.parametrize("vision", [True, False])
async def test_flash_png_reaches_actual_client_request_only_when_vision_enabled(environment, monkeypatch, stage, vision):
    import httpx
    from PIL import Image
    from browser_use.agent.views import ActionResult, AgentHistory
    from browser_use.browser.views import BrowserStateHistory, BrowserStateSummary, TabInfo
    from browser_use.dom.views import SerializedDOMState

    environment.config.SAVE_HISTORY = True
    agent = environment.build(use_vision=vision)
    buffer = BytesIO()
    Image.new("RGB", (32, 32), "orange").save(buffer, format="PNG")
    screenshot = base64.b64encode(buffer.getvalue()).decode()
    state = BrowserStateSummary(dom_state=SerializedDOMState(_root=None, selector_map={}),
        url="https://example.com/vision", title="本地图片夹具",
        tabs=[TabInfo(url="https://example.com/vision", title="本地图片夹具", target_id="page_0001")],
        screenshot=screenshot)

    async def read_state(current, **kwargs):
        return state

    monkeypatch.setattr(type(environment.session), "get_browser_state_summary", read_state)
    requests = []
    completion = ({"action": [{"done": {"text": "完成", "success": True}}]} if stage == "main" else
                  {"can_resume": True} if stage == "resume" else {"verdict": True, "failure_reason": ""})

    def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        name = payload["tools"][0]["function"]["name"]
        return httpx.Response(200, json={"id": "vision-test", "object": "chat.completion", "created": 0,
            "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": None, "tool_calls": [{"id": "vision-call", "type": "function",
                    "function": {"name": name, "arguments": json.dumps(completion)}}]}}]})

    client = agent.judge_llm if stage == "judge" else agent.llm
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as transport:
        client.client_params = {"http_client": transport, "max_retries": 0}
        if stage == "main":
            await agent._prepare_context()
            result = await agent.get_model_output(agent._message_manager.get_messages())
            assert result.action[0].model_dump(exclude_none=True)["done"]["success"] is True
        elif stage == "resume":
            assert (await agent._verify_resume()).can_resume is True
        else:
            path = agent.recorder.save_screenshot(1, screenshot)
            agent.history.history.append(AgentHistory(model_output=None,
                result=[ActionResult(is_done=True, success=True, extracted_content="完成")],
                state=BrowserStateHistory(url=state.url, title=state.title, tabs=[],
                                         screenshot_path=str(path), interacted_element=[])))
            assert (await agent._judge_trace()).verdict is True

    assert len(requests) == 1
    pictures = [part["image_url"]["url"] for message in requests[0]["messages"]
                if isinstance(message.get("content"), list) for part in message["content"]
                if part.get("type") == "image_url"]
    assert pictures == ([f"data:image/png;base64,{screenshot}"] if vision else [])


@pytest.mark.asyncio
@pytest.mark.parametrize("verdict", [True, False])
async def test_native_judge_reviews_trace_and_png_only_after_done(environment, monkeypatch, verdict):
    import httpx
    from PIL import Image
    from browser_use.agent.views import AgentStepInfo
    from browser_use.browser.views import BrowserStateSummary, TabInfo
    from browser_use.dom.views import SerializedDOMState

    environment.config.SAVE_HISTORY = True
    environment.config.MIN_ACTION_DELAY_MS = 0
    agent = environment.build(message_compaction=False, enable_planning=False)
    agent.os_controller.bind_takeover(agent.takeover)
    buffer = BytesIO()
    Image.new("RGB", (32, 32), "green").save(buffer, format="PNG")
    screenshot = base64.b64encode(buffer.getvalue()).decode()
    state = BrowserStateSummary(dom_state=SerializedDOMState(_root=None, selector_map={}),
        url="https://example.com/judge", title="本地任务页",
        tabs=[TabInfo(url="https://example.com/judge", title="本地任务页", target_id="page_0001")],
        screenshot=screenshot)

    async def read_state(current, **kwargs):
        return state

    async def read_url(current):
        return state.url

    monkeypatch.setattr(type(environment.session), "get_browser_state_summary", read_state)
    monkeypatch.setattr(type(environment.session), "get_current_page_url", read_url)
    events, judged = [], []
    main_calls = 0

    def respond(request):
        nonlocal main_calls
        payload = json.loads(request.content)
        name = payload["tools"][0]["function"]["name"]
        if name == "JudgementResult":
            events.append("judge")
            judged.append(payload)
            completion = {"verdict":verdict,"failure_reason":"" if verdict else "未满足要求"}
        else:
            main_calls += 1
            events.append("main")
            action = {"wait":{"seconds":0}} if main_calls == 1 else {"done":{"text":"完成","success":True}}
            completion = {"action":[action],"evaluation_previous_goal":"根据新页面评价上一步"}
        return httpx.Response(200, json={"id":"judge-test","object":"chat.completion","created":0,
            "model":"deepseek-flash","choices":[{"index":0,"finish_reason":"tool_calls","message":{
                "role":"assistant","content":None,"tool_calls":[{"id":"judge-call","type":"function",
                "function":{"name":name,"arguments":json.dumps(completion)}}]}}]})

    async def step_end(current):
        events.append("step_end")

    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as transport:
            for client in (agent.llm, agent.judge_llm):
                client.client_params = {"http_client":transport,"max_retries":0}
            assert not await agent._execute_step(0, 3, AgentStepInfo(step_number=0,max_steps=3), on_step_end=step_end)
            assert judged == []
            assert await agent._execute_step(1, 3, AgentStepInfo(step_number=1,max_steps=3), on_step_end=step_end)
        assert events == ["main","step_end","main","step_end","judge"]
        assert agent.history.history[-1].result[-1].judgement.verdict is verdict
        assert agent.history.is_successful() is True
        assert agent.history.history[-1].model_output.evaluation_previous_goal == "根据新页面评价上一步"
        parts = judged[0]["messages"][-1]["content"]
        pictures = [part["image_url"]["url"] for part in parts if part["type"] == "image_url"]
        text = "\n".join(part["text"] for part in parts if part["type"] == "text")
        assert pictures == [f"data:image/png;base64,{screenshot}"] * 2
        assert "Step 1:" in text and "Step 2:" in text and "Waited for 0 seconds" in text
        assert "browser_observations" not in text
    finally:
        agent.os_controller.unbind_takeover(agent.takeover)
        await agent.eventbus.stop(clear=True, timeout=1)
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("archive", ["screenshot", "history", "gif"])
async def test_cancelled_run_waits_for_archives_before_terminal(environment, tmp_path, monkeypatch, archive):
    from PIL import Image
    from browser_use.agent.service import Agent
    from browser_use.agent.views import AgentHistory, ActionResult
    from browser_use.browser.views import BrowserStateHistory
    from agent.memory import history

    environment.config.SAVE_HISTORY = True
    environment.config.SAVE_GIF = True
    environment.config.HISTORY_SAVE_INTERVAL = 1
    agent = environment.build(use_judge=False)
    agent.history.history.append(AgentHistory(model_output=None, result=[ActionResult(extracted_content="本地验证")],
        state=BrowserStateHistory(url="https://example.com", title="本地验证", tabs=[], interacted_element=[])))
    buffer = BytesIO()
    Image.new("RGB", (2, 2), "white").save(buffer, format="PNG")
    screenshot = base64.b64encode(buffer.getvalue()).decode()
    agent.recorder.save_screenshot(0, screenshot)
    entered, ready = asyncio.Event(), asyncio.Event()
    released, exited = threading.Event(), threading.Event()
    event_loop = asyncio.get_running_loop()
    original = {"screenshot": agent.recorder.save_screenshot, "history": history._save,
                "gif": agent.recorder.finish}[archive]

    def blocked_write(*args):
        event_loop.call_soon_threadsafe(entered.set)
        try:
            assert released.wait(timeout=5), "未释放文件线程"
            return original(*args)
        finally:
            exited.set()

    if archive == "history":
        monkeypatch.setattr(history, "_save", blocked_write)
    else:
        monkeypatch.setattr(agent.recorder, "save_screenshot" if archive == "screenshot" else "finish", blocked_write)

    async def native_run(current, **kwargs):
        ready.set()
        if archive == "screenshot":
            await current.recorder.store_screenshot(screenshot, 1)
        elif archive == "history":
            await history.maybe_save_history(current.history, current.task_id, 1, config=current.config)
        await asyncio.Event().wait()

    monkeypatch.setattr(Agent, "run", native_run)
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(ready.wait(), timeout=2)
        if archive == "gif":
            agent.cancel_task()
        await asyncio.wait_for(entered.wait(), timeout=2)
        agent.cancel_task()
        done, _ = await asyncio.wait({runner}, timeout=0.03)
        assert not done
        # 模拟服务退出时在已有取消请求上再次施加超时取消。
        shutdown = asyncio.create_task(asyncio.wait_for(runner, timeout=0.03))
        done, _ = await asyncio.wait({shutdown}, timeout=0.06)
        assert not done, "退出等待也不能提前结束文件清理"
        assert not exited.is_set()
        assert agent.takeover.snapshot.status == "cancelling"
        rows = [json.loads(line) for line in (tmp_path / "audit.log").read_text().splitlines()]
        assert not any(row["event"] == "task_end" for row in rows)
        released.set()
        with pytest.raises(TimeoutError):
            await shutdown
        assert runner.cancelled() and exited.is_set()
        assert agent.takeover.snapshot.status == "cancelled"
        assert not environment.desktop.allowed
        assert (agent.recorder.directory / "history.json").exists()
        assert (agent.recorder.directory / "recording.gif").exists()
        if archive == "screenshot":
            assert (agent.recorder.directory / "step_000001.png").exists()
        rows = [json.loads(line) for line in (tmp_path / "audit.log").read_text().splitlines()]
        terminal = [row for row in rows if row["event"] == "task_end"]
        assert len(terminal) == 1 and terminal[0]["outcome"] == "cancelled"
    finally:
        released.set()
        if not runner.done():
            agent.cancel_task()
        await asyncio.gather(runner, return_exceptions=True)
        if "shutdown" in locals():
            await asyncio.gather(shutdown, return_exceptions=True)
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("primary_failure", [False, True])
@pytest.mark.parametrize("archive", ["history", "gif"])
async def test_archive_cleanup_preserves_original_task_failure(environment, monkeypatch, primary_failure, archive):
    from browser_use.agent.service import Agent

    async def native_run(current, **kwargs):
        if primary_failure:
            raise ValueError("原始任务错误")
        return current.history

    async def save(*args, **kwargs):
        if archive == "history":
            raise OSError("存档失败")

    agent = environment.build(use_judge=False)

    def finish():
        if archive == "gif":
            raise OSError("存档失败")

    monkeypatch.setattr(Agent, "run", native_run)
    monkeypatch.setattr(environment.loop, "maybe_save_history", save)
    monkeypatch.setattr(agent.recorder, "finish", finish)
    try:
        with pytest.raises(ValueError if primary_failure else OSError,
                           match="原始任务错误" if primary_failure else "存档失败"):
            await agent.run()
        assert not environment.desktop.allowed
        assert agent._run_task is None
    finally:
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
async def test_cancel_during_final_history_is_not_overridden_by_gif_failure(environment, tmp_path, monkeypatch):
    from browser_use.agent.service import Agent
    from browser_use.agent.views import AgentHistory, ActionResult
    from browser_use.browser.views import BrowserStateHistory
    from agent.memory import history

    environment.config.SAVE_HISTORY = True
    agent = environment.build(use_judge=False)
    agent.history.history.append(AgentHistory(model_output=None, result=[ActionResult(extracted_content="本地验证")],
        state=BrowserStateHistory(url="https://example.com", title="本地验证", tabs=[], interacted_element=[])))
    entered, released = asyncio.Event(), threading.Event()
    event_loop, original = asyncio.get_running_loop(), history._save

    def blocked_save(*args):
        event_loop.call_soon_threadsafe(entered.set)
        assert released.wait(timeout=5), "未释放文件线程"
        return original(*args)

    def finish():
        raise OSError("GIF 写入失败")

    async def native_run(current, **kwargs):
        return current.history

    monkeypatch.setattr(Agent, "run", native_run)
    monkeypatch.setattr(history, "_save", blocked_save)
    monkeypatch.setattr(agent.recorder, "finish", finish)
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        # 正常运行已进入收尾，模拟服务退出直接取消运行协程。
        runner.cancel()
        released.set()
        with pytest.raises(asyncio.CancelledError):
            await runner
        assert (agent.recorder.directory / "history.json").exists()
        rows = [json.loads(line) for line in (tmp_path / "audit.log").read_text().splitlines()]
        terminal = [row for row in rows if row["event"] == "task_end"]
        assert len(terminal) == 1 and terminal[0]["outcome"] == "cancelled"
    finally:
        released.set()
        if not runner.done():
            runner.cancel()
        await asyncio.gather(runner, return_exceptions=True)
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("options", [{},{"use_thinking":False},{"flash_mode":True}])
async def test_native_agent_keeps_timing_after_page_schema_refresh(environment, options):
    agent = environment.build(**options)
    assert agent.output_model_schema is None
    assert agent.settings.max_actions_per_step == 1
    for stage in ("initial","page"):
        if stage == "page":
            await agent._update_action_models_for_page("https://example.com")
        for model in (agent.AgentOutput,agent.DoneAgentOutput):
            assert {"read_time_ms","action_type"} <= model.model_fields.keys()
        parsed = agent.AgentOutput.model_validate({"action":[{"click":{"index":1}}],"read_time_ms":0})
        assert parsed.action[0].get_index() == 1
        takeover = agent.AgentOutput.model_validate({"action": [{"request_takeover": {"reason": "login_required"}}]})
        assert takeover.action[0].model_dump(exclude_none=True) == {"request_takeover": {"reason": "login_required"}}
    assert "节奏协议" in agent.settings.extend_system_message
    assert agent.judge_llm.model == environment.config.JUDGE_MODEL_NAME
    assert agent.settings.llm_timeout == environment.config.LLM_TIMEOUT


@pytest.mark.asyncio
async def test_step_callback_keeps_zero_read_time_and_user_callback(environment):
    events = []

    async def consume(value,action_type):
        events.append((value,action_type))

    async def callback(*args):
        events.append("callback")

    agent = environment.build(orchestrator=SimpleNamespace(rhythm=SimpleNamespace(consume_read_time=consume)),register_new_step_callback=callback)
    output = agent.AgentOutput.model_validate({"action":[{"click":{"index":1}}],"read_time_ms":0,"action_type":"click"})
    await agent.register_new_step_callback(SimpleNamespace(),output,1)
    assert events == [(0,"click"),"callback"]


@pytest.mark.asyncio
async def test_default_rhythm_runs_before_user_callback_even_without_read_time(environment, monkeypatch):
    from core.orchestrator import rhythm

    events = []

    async def sleep(seconds):
        events.append(("wait", seconds))

    async def callback(*args):
        events.append("callback")

    monkeypatch.setattr(rhythm, "asyncio", SimpleNamespace(sleep=sleep))
    agent = environment.build(register_new_step_callback=callback)
    output = agent.AgentOutput.model_validate({"action": [{"click": {"index": 1}}]})

    await agent.register_new_step_callback(SimpleNamespace(), output, 1)

    assert events == [("wait", 0.5), "callback"]


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["done", "request_takeover"])
async def test_control_actions_skip_wait_even_when_labelled_as_click(environment, name):
    events = []

    async def consume(*args, **kwargs):
        events.append("wait")

    async def callback(*args):
        events.append("callback")

    agent = environment.build(register_new_step_callback=callback)
    agent.orchestrator = SimpleNamespace(rhythm=SimpleNamespace(consume_read_time=consume))
    params = {"text": "完成", "success": True} if name == "done" else {"reason": "login_required"}
    output = agent.AgentOutput.model_validate({
        "action": [{name: params}], "read_time_ms": 1000, "action_type": "click",
    })

    await agent.register_new_step_callback(SimpleNamespace(), output, 1)

    assert events == ["callback"]


@pytest.mark.asyncio
@pytest.mark.parametrize("reject", [False,True])
async def test_run_authorizes_before_native_execution_and_always_revokes(environment, monkeypatch, reject):
    from browser_use.agent.service import Agent
    entered = []

    async def native_run(agent,*args,**kwargs):
        assert environment.desktop.allowed
        entered.append(True)
        return agent.history

    monkeypatch.setattr(Agent,"run",native_run)
    environment.desktop.reject = reject
    agent = environment.build()
    if reject:
        with pytest.raises(Exception):
            await agent.run()
        assert entered == []
    else:
        assert await agent.run() is agent.history
        assert entered == [True]
    assert environment.desktop.allowed is False


@pytest.mark.asyncio
async def test_disabled_archives_do_not_use_native_screenshot_storage(environment, tmp_path):
    agent = environment.build()
    path = await agent.screenshot_service.store_screenshot("not-an-image",1)
    assert path is None
    assert not (tmp_path / "sessions").exists()
    assert not (agent.agent_directory / "screenshots").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("async_hook", [False, True])
async def test_takeover_suspends_at_native_step_end_outside_step_timeout(environment, monkeypatch, async_hook):
    from browser_use.agent.service import Agent
    from browser_use.agent.views import AgentStepInfo
    from core.orchestrator.takeover import UserTakeoverRequestedEvent

    hook_entered, events = asyncio.Event(), []
    agent = environment.build(use_judge=False)
    # 步内包含真实审计写盘；等待用户的时间仍须超过整个步骤预算。
    agent.settings.step_timeout = 0.2
    initial_step = agent.state.n_steps
    history = agent.history

    async def step(current, step_info):
        output = current.AgentOutput.model_validate({
            "action": [{"request_takeover": {"reason": "login_required"}}],
        })
        results = await current.multi_act(output.action)
        result = results[0]
        assert result.error is None and not result.is_done
        assert current.takeover.snapshot.status == "awaiting_user"
        assert not environment.desktop.allowed
        current.state.n_steps += 1
        events.append("step_finished")

    async def native_run(current, max_steps, on_step_start, on_step_end):
        await current._execute_step(0, max_steps, AgentStepInfo(step_number=0, max_steps=max_steps),
                                    on_step_start, on_step_end)
        events.append("next_step")
        return current.history

    def sync_hook(current):
        assert current is agent
        events.append("user_hook")
        hook_entered.set()

    async def coroutine_hook(current):
        sync_hook(current)

    monkeypatch.setattr(Agent, "step", step)
    monkeypatch.setattr(Agent, "run", native_run)
    runner = asyncio.create_task(agent.run(2, None, coroutine_hook if async_hook else sync_hook))
    try:
        await asyncio.wait_for(hook_entered.wait(), timeout=2)
        done, _ = await asyncio.wait({runner}, timeout=0.25)
        assert not done
        assert events == ["step_finished", "user_hook"]
        assert agent.state.n_steps == initial_step + 1
        assert agent.state.consecutive_failures == 0
        assert agent.history is history
    finally:
        runner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await runner
        assert not environment.desktop.allowed
        assert not environment.session.event_bus.handlers.get(UserTakeoverRequestedEvent.__name__)
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
async def test_no_takeover_preserves_user_hook_and_does_not_suspend(environment, monkeypatch):
    from browser_use.agent.service import Agent

    called = []

    async def native_run(current, **kwargs):
        await kwargs["on_step_end"](current)
        return current.history

    async def hook(current):
        called.append(current.task_id)

    monkeypatch.setattr(Agent, "run", native_run)
    agent = environment.build()
    assert await asyncio.wait_for(agent.run(on_step_end=hook), timeout=2) is agent.history
    assert called == [agent.task_id]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["missing", "handler", "revocation"])
async def test_failed_takeover_stops_instead_of_advancing(environment, monkeypatch, failure):
    from browser_use.agent.service import Agent
    from core.orchestrator.takeover import UserTakeoverRequestedEvent

    advanced = []

    async def native_run(current, **kwargs):
        if failure == "missing":
            current.browser_session.event_bus.handlers[UserTakeoverRequestedEvent.__name__].clear()
        elif failure == "handler":
            async def broken(event):
                raise RuntimeError("测试事件处理失败")
            current.browser_session.event_bus.on(UserTakeoverRequestedEvent, broken)
        else:
            def broken_revoke():
                raise RuntimeError("测试撤销失败")
            current.takeover.revoke = broken_revoke
        result = await current.os_controller.registry.execute_action(
            "request_takeover", {"reason": "login_required"}, browser_session=current.browser_session,
        )
        assert result.error and result.is_done and result.success is False
        assert not environment.desktop.allowed
        await kwargs["on_step_end"](current)
        advanced.append(True)
        return current.history

    monkeypatch.setattr(Agent, "run", native_run)
    agent = environment.build()
    try:
        with pytest.raises(RuntimeError, match="接管"):
            await agent.run()
        assert advanced == []
    finally:
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
async def test_interrupted_takeover_request_stops_after_native_step_timeout(environment, monkeypatch):
    from browser_use.agent.service import Agent
    from browser_use.agent.views import AgentStepInfo
    from core.orchestrator.takeover import UserTakeoverRequestedEvent

    release = asyncio.Event()

    async def blocked_observer(event):
        await release.wait()

    async def step(current, step_info):
        await current.os_controller.registry.execute_action(
            "request_takeover", {"reason": "login_required"}, browser_session=current.browser_session,
        )

    async def native_run(current, **kwargs):
        current.browser_session.event_bus.on(UserTakeoverRequestedEvent, blocked_observer)
        await current._execute_step(0, 2, AgentStepInfo(step_number=0, max_steps=2),
                                    on_step_end=kwargs["on_step_end"])
        pytest.fail("未完整确认的接管请求不能进入后续业务步骤")

    monkeypatch.setattr(Agent, "step", step)
    monkeypatch.setattr(Agent, "run", native_run)
    agent = environment.build(use_judge=False)
    agent.settings.step_timeout = 0.02
    try:
        with pytest.raises(RuntimeError, match="接管"):
            await asyncio.wait_for(agent.run(), timeout=0.5)
        assert not environment.desktop.allowed
    finally:
        release.set()
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("vision", [False, True])
async def test_resume_uses_fresh_native_context_same_llm_and_preserves_agent_state(environment, monkeypatch, vision):
    from browser_use.agent.service import Agent
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.views import BrowserStateSummary, TabInfo
    from browser_use.dom.views import SerializedDOMState
    from browser_use.llm import ChatOpenAI
    from browser_use.llm.views import ChatInvokeCompletion

    ready, continued = asyncio.Event(), []
    reads, calls = [], []
    restored = []

    async def restore(tools, session):
        assert environment.desktop.allowed
        assert session is environment.session
        restored.append(True)

    async def confirm(tools, session):
        assert restored and len(reads) == 2

    async def state(current, **kwargs):
        if reads:
            assert restored, "放行前的新页面感知必须在切回任务页面之后"
        reads.append(kwargs)
        return BrowserStateSummary(dom_state=SerializedDOMState(_root=None, selector_map={}),
            url="https://allowed.example/fresh", title="新页面 test-secret",
            tabs=[TabInfo(url="https://allowed.example/fresh", title="新页面 test-secret", target_id="page_0001")],
            screenshot="ZmFrZQ==" if vision else None)

    async def invoke(current, messages, output_format=None, **kwargs):
        calls.append((current, messages, output_format, kwargs))
        return ChatInvokeCompletion(completion=output_format(can_resume=True), usage=None)

    async def native_run(current, **kwargs):
        result = await current.os_controller.registry.execute_action("request_takeover",
            {"reason": "login_required"}, browser_session=current.browser_session)
        assert not result.is_done
        current.state.last_result = [result]
        ready.set()
        await kwargs["on_step_end"](current)
        assert "任务已恢复" in current.state.last_result[0].long_term_memory
        continued.append(current.takeover.snapshot.status)
        return current.history

    monkeypatch.setattr(BrowserSession, "get_browser_state_summary", state)
    monkeypatch.setattr(environment.loop.OSController, "restore_task_page", restore, raising=False)
    monkeypatch.setattr(environment.loop.OSController, "confirm_task_page", confirm)
    monkeypatch.setattr(ChatOpenAI, "ainvoke", invoke)
    monkeypatch.setattr(Agent, "run", native_run)
    environment.config.LLM_PROVIDER = "openai"
    environment.config.LLM_MODEL_NAME = "test-model"
    agent = environment.build(use_judge=False, use_vision=vision, sensitive_data={"password": "test-secret"})
    original_steps, original_history = agent.state.n_steps, agent.history
    original_messages = agent._message_manager.get_messages()
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(ready.wait(), timeout=2)
        result = await asyncio.wait_for(agent.resume_task(), timeout=2)
        assert result.resumed is True
        assert agent.takeover.snapshot.status == "running"
        assert restored == [True]
        assert len(reads) == 2 and all(read["cached"] is False for read in reads)
        assert all(read["include_screenshot"] is vision for read in reads)
        assert len(calls) == 1 and calls[0][0] is agent.llm
        messages, schema, options = calls[0][1:]
        assert "https://allowed.example/fresh" in messages[-1].text
        assert "test-secret" not in messages[-1].text
        assert "action" not in schema.model_fields and "tools" not in options
        assert agent.state.n_steps == original_steps and agent.history is original_history
        assert agent._message_manager.get_messages() == original_messages
        assert await runner is original_history
        assert continued == ["running"]
    finally:
        if not runner.done():
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["waiting", "check", "action"])
async def test_cancel_task_interrupts_run_and_prevents_resume(environment, monkeypatch, stage):
    from browser_use.agent.service import Agent
    from core.orchestrator.takeover import ResumeCheck, ResumeConflictError, UserTakeoverRequestedEvent

    ready, checking, continued = asyncio.Event(), asyncio.Event(), []

    async def verify(current):
        checking.set()
        await asyncio.Event().wait()
        return ResumeCheck(can_resume=True)

    async def native_run(current, **kwargs):
        if stage == "action":
            ready.set()
            await asyncio.Event().wait()
        else:
            await current.os_controller.registry.execute_action("request_takeover",
                {"reason": "login_required"}, browser_session=current.browser_session)
            ready.set()
            await kwargs["on_step_end"](current)
        continued.append(True)
        return current.history

    monkeypatch.setattr(Agent, "run", native_run)
    monkeypatch.setattr(environment.loop.ShadowAgent, "_verify_resume", verify)
    agent = environment.build(use_judge=False)
    runner = asyncio.create_task(agent.run())
    request = None
    try:
        await asyncio.wait_for(ready.wait(), timeout=2)
        if stage == "check":
            request = asyncio.create_task(agent.resume_task())
            await asyncio.wait_for(checking.wait(), timeout=1)
        agent.cancel_task()
        agent.cancel_task()
        assert agent.takeover.snapshot.status == "cancelling"
        assert not environment.desktop.allowed
        with pytest.raises(ResumeConflictError):
            await agent.resume_task()
        with pytest.raises(asyncio.CancelledError):
            await runner
        if request is not None:
            with pytest.raises(ResumeConflictError):
                await request
        assert agent.takeover.snapshot.status == "cancelled"
        assert continued == []
        assert not environment.session.event_bus.handlers.get(UserTakeoverRequestedEvent.__name__)
    finally:
        if not runner.done():
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
async def test_cancel_waits_for_authorization_thread_before_publishing_cancelled(environment, monkeypatch):
    from browser_use.agent.service import Agent
    from core.orchestrator.takeover import ResumeCheck, ResumeConflictError

    ready = asyncio.Event()
    entered, release = threading.Event(), threading.Event()
    authorizations = []

    def authorize(timeout=120):
        authorizations.append(True)
        if len(authorizations) == 2:
            entered.set()
            assert release.wait(timeout=3)
        environment.desktop.allowed = True

    async def verify(current):
        return ResumeCheck(can_resume=True)

    async def native_run(current, **kwargs):
        await current.os_controller.registry.execute_action("request_takeover",
            {"reason": "login_required"}, browser_session=current.browser_session)
        ready.set()
        await kwargs["on_step_end"](current)
        pytest.fail("取消后不能续跑")

    monkeypatch.setattr(environment.desktop, "authorize", authorize)
    monkeypatch.setattr(Agent, "run", native_run)
    monkeypatch.setattr(environment.loop.ShadowAgent, "_verify_resume", verify)
    agent = environment.build(use_judge=False)
    runner = asyncio.create_task(agent.run())
    request = None
    try:
        await asyncio.wait_for(ready.wait(), timeout=2)
        request = asyncio.create_task(agent.resume_task())
        assert await asyncio.to_thread(entered.wait, 1)
        agent.cancel_task()
        agent.cancel_task()
        done, _ = await asyncio.wait({runner}, timeout=0.03)
        assert not done
        assert agent.takeover.snapshot.status == "cancelling"
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await runner
        with pytest.raises(ResumeConflictError):
            await request
        assert agent.takeover.snapshot.status == "cancelled"
        assert not environment.desktop.allowed
    finally:
        release.set()
        if not runner.done():
            agent.cancel_task()
            await asyncio.gather(runner, return_exceptions=True)
        if request is not None:
            await asyncio.gather(request, return_exceptions=True)
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "closed", "malformed", "unavailable"])
async def test_resume_reports_actual_read_or_model_failure(environment, monkeypatch, failure):
    from browser_use.agent.service import Agent
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.views import BrowserStateSummary
    from browser_use.dom.views import SerializedDOMState
    from browser_use.llm import ChatDeepSeek
    from browser_use.llm.views import ChatInvokeCompletion
    from pydantic import ValidationError
    from core.orchestrator.takeover import ResumeFatalError

    ready, model_calls = asyncio.Event(), []

    async def state(current, **kwargs):
        return BrowserStateSummary(dom_state=SerializedDOMState(_root=None, selector_map={}),
            url="https://allowed.example/", title="页面", tabs=[],
            state_error="页面捕获失败" if failure == "unavailable" else None)

    async def invoke(current, messages, output_format=None, **kwargs):
        model_calls.append(True)
        if failure == "timeout":
            await asyncio.Event().wait()
        return ChatInvokeCompletion(completion={"can_resume": True, "reason": "login_required"}, usage=None)

    async def native_run(current, **kwargs):
        await current.os_controller.registry.execute_action("request_takeover",
            {"reason": "login_required"}, browser_session=current.browser_session)
        ready.set()
        await kwargs["on_step_end"](current)
        pytest.fail("复核错误不能放行下一步")

    monkeypatch.setattr(BrowserSession, "get_browser_state_summary", state)
    monkeypatch.setattr(ChatDeepSeek, "ainvoke", invoke)
    monkeypatch.setattr(Agent, "run", native_run)
    agent = environment.build(use_judge=False)
    agent.settings.llm_timeout = 0.02
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(ready.wait(), timeout=2)
        if failure == "closed":
            environment.session._cdp_client_root = None
        expected = {"timeout": TimeoutError, "closed": ResumeFatalError,
                    "malformed": ValidationError, "unavailable": RuntimeError}[failure]
        with pytest.raises(expected):
            await asyncio.wait_for(agent.resume_task(), timeout=1)
        assert not environment.desktop.allowed
        if failure == "closed":
            with pytest.raises(ResumeFatalError):
                await runner
        else:
            assert agent.takeover.snapshot.status == "awaiting_user" and not runner.done()
        assert len(model_calls) == (1 if failure in {"timeout", "malformed"} else 0)
    finally:
        if not runner.done():
            agent.cancel_task()
            await asyncio.gather(runner, return_exceptions=True)
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [PermissionError("用户拒绝"), TimeoutError("授权超时")])
async def test_resume_returns_false_for_real_controller_authorization_failure(environment, monkeypatch, error):
    from browser_use.agent.service import Agent
    from core.orchestrator.takeover import ResumeCheck

    ready, authorizations = asyncio.Event(), []

    def authorize(timeout=120):
        authorizations.append(True)
        if len(authorizations) > 1:
            raise error
        environment.desktop.allowed = True

    async def verify(current):
        return ResumeCheck(can_resume=True)

    async def native_run(current, **kwargs):
        await current.os_controller.registry.execute_action("request_takeover",
            {"reason": "login_required"}, browser_session=current.browser_session)
        ready.set()
        await kwargs["on_step_end"](current)
        pytest.fail("授权未通过不能续跑")

    monkeypatch.setattr(environment.desktop, "authorize", authorize)
    monkeypatch.setattr(Agent, "run", native_run)
    monkeypatch.setattr(environment.loop.ShadowAgent, "_verify_resume", verify)
    agent = environment.build(use_judge=False)
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(ready.wait(), timeout=2)
        result = await agent.resume_task()
        assert result.resumed is False and "授权" in result.message
        assert agent.takeover.snapshot.takeover_reason == "authorization_required"
        assert agent.takeover.snapshot.status == "awaiting_user" and not runner.done()
        assert not environment.desktop.allowed
    finally:
        agent.cancel_task()
        await asyncio.gather(runner, return_exceptions=True)
        await environment.session.event_bus.stop(clear=True)


@pytest.mark.asyncio
async def test_resume_keeps_browser_waiting_when_restored_page_cannot_be_read(environment, monkeypatch):
    from browser_use.agent.service import Agent
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.views import BrowserStateSummary
    from browser_use.dom.views import SerializedDOMState
    from core.orchestrator.takeover import ResumeCheck

    ready = asyncio.Event()
    failures = [True]

    async def verify(current):
        return ResumeCheck(can_resume=True)

    async def restore(tools, session):
        assert environment.desktop.allowed

    async def confirm(tools, session):
        assert not failures

    async def state(current, **kwargs):
        return BrowserStateSummary(dom_state=SerializedDOMState(_root=None, selector_map={}),
            url="https://allowed.example/task", title="任务页", tabs=[],
            state_error="读取失败" if failures else None)

    async def native_run(current, **kwargs):
        await current.os_controller.registry.execute_action("request_takeover",
            {"reason": "login_required"}, browser_session=current.browser_session)
        ready.set()
        await kwargs["on_step_end"](current)
        return current.history

    monkeypatch.setattr(Agent, "run", native_run)
    monkeypatch.setattr(environment.loop.ShadowAgent, "_verify_resume", verify)
    monkeypatch.setattr(environment.loop.OSController, "restore_task_page", restore)
    monkeypatch.setattr(environment.loop.OSController, "confirm_task_page", confirm)
    monkeypatch.setattr(BrowserSession, "get_browser_state_summary", state)
    agent = environment.build(use_judge=False)
    runner = asyncio.create_task(agent.run())
    try:
        await asyncio.wait_for(ready.wait(), timeout=2)
        result = await asyncio.wait_for(agent.resume_task(), timeout=2)
        assert not result.resumed and "原任务页面" in result.message
        assert agent.takeover.snapshot.status == "awaiting_user" and not runner.done()
        assert not environment.desktop.allowed
        failures.clear()
        assert (await asyncio.wait_for(agent.resume_task(), timeout=2)).resumed
        await runner
    finally:
        if not runner.done():
            agent.cancel_task()
            await asyncio.gather(runner, return_exceptions=True)
        await environment.session.event_bus.stop(clear=True)
