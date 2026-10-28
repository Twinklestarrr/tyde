"""使用真实动作注册表，隔离 CDP 读取与桌面输入边界。"""

import asyncio
import json
import logging
import shutil
import subprocess
import sys
from types import SimpleNamespace

from PIL import Image
import pytest

from config.settings import Settings


class Desktop:
    def __init__(self):
        self.events = []
        self.text = "原文"
        self.focused = False
        self.allowed = True
        self.on_click = None
        self.on_keys = None
        self.scroll_top = 0
        self.screen_size = (900, 800)

    def authorize(self, timeout=120):
        self.allowed = True

    def revoke(self):
        self.allowed = False

    def guard(self):
        if not self.allowed:
            raise PermissionError("未授权")

    def focus_window(self, pid, window_info=None, *, restore=False):
        self.guard()
        self.events.append(("focus", pid))

    def get_cursor_position(self):
        self.guard()
        return (20, 20)

    def get_screen_size(self):
        self.guard()
        return self.screen_size

    def move_and_click(self, points):
        self.guard()
        self.focused = True
        self.events.append(("click", points[-1][:2]))
        if self.on_click:
            self.on_click()

    def press_keys(self, keys):
        self.guard()
        self.events.append(("keys", keys))
        if keys == ("backspace",):
            self.text = ""
        if self.on_keys:
            self.on_keys(keys)

    def type_text(self, text):
        self.guard()
        self.events.append(("type", text))
        self.text += text

    def move_to(self, x, y):
        self.guard()
        self.events.append(("move", x, y))

    def scroll(self, delta):
        self.guard()
        self.scroll_top = min(1000, max(0, self.scroll_top - delta * 120))
        self.events.append(("scroll", delta))

    def capture_region(self, region):
        self.guard()
        left, top, width, height = region
        if left + width > self.screen_size[0] or top + height > self.screen_size[1]:
            raise ValueError("截图超出屏幕")
        self.events.append(("capture", region))
        return Image.new("RGB", (region[2], region[3]), "white")

    def screenshot_verify(self, region, before):
        self.guard()
        assert before.size == region[2:]
        self.events.append(("verify", region))
        return False


@pytest.fixture
def environment(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    from agent import controller

    assert hasattr(controller, "OSController"), "同名 OS 动作尚未实现"
    desktop = Desktop()
    state = SimpleNamespace(url="https://allowed.example/task", visible=True, page_focused=True, node_present=True, resolved=[])

    async def evaluate(script, *args):
        if "chrome_height" in script:
            return '{"window_x":100,"window_y":100,"window_width":800,"window_height":680,"chrome_width":0,"chrome_height":80,"viewport_width":800,"viewport_height":600}'
        return json.dumps({"url": state.url, "visible": state.visible, "focused":state.page_focused,
            "scroll_top": desktop.scroll_top, "scroll_height":1600, "client_height":600,
            "x":10,"y":10,"width":1,"height":1})

    page = SimpleNamespace(evaluate=evaluate)

    async def get_page():
        return page

    async def get_url():
        return state.url

    async def get_node(index):
        assert index == 7
        return SimpleNamespace(backend_node_id=70) if state.node_present else None

    async def resolve(params, **kwargs):
        state.resolved.append(params["backendNodeId"])
        return {"object":{"objectId":"node-70"}}

    async def call(params, **kwargs):
        assert params["objectId"] == "node-70"
        return {"result":{"value":{"x":10,"y":20,"width":100,"height":40,
            "editable":True,"focused":desktop.focused,"value":desktop.text,
            "scroll_top":desktop.scroll_top,"scroll_height":1600,"client_height":600}}}

    async def release(*args, **kwargs):
        pass

    async def processes():
        return {"processInfo":[{"type":"browser","id":123}]}

    client = SimpleNamespace(send=SimpleNamespace(DOM=SimpleNamespace(resolveNode=resolve),
        Runtime=SimpleNamespace(callFunctionOn=call, releaseObject=release),
        SystemInfo=SimpleNamespace(getProcessInfo=processes)))
    cdp = SimpleNamespace(cdp_client=client, session_id="main")

    async def node_session(node):
        return cdp

    session = SimpleNamespace(agent_focus_target_id=None, get_current_page=get_page, get_current_page_url=get_url,
        get_element_by_index=get_node, cdp_client_for_node=node_session, cdp_client=client)
    session.logger = logging.getLogger("test_agent_controller")
    config = Settings(_env_file=None, VERIFY_SCREENSHOT=False)
    tools = controller.OSController(desktop, config=config)
    return SimpleNamespace(tools=tools, desktop=desktop, session=session, state=state, config=config)


async def execute(environment, name, params):
    return await environment.tools.registry.execute_action(name, params, browser_session=environment.session)


@pytest.fixture
def navigation(environment):
    """键盘边界模拟真实标签顺序，CDP 只提供只读接口。"""
    env = environment
    pages = [{"id": f"page_{index:04d}", "url": f"https://allowed.example/{index}", "window": 1}
             for index in (1, 2, 3)]
    state = SimpleNamespace(pages=pages, active="page_0001", address=False, typed="",
                            history=["https://allowed.example/before", "https://allowed.example/1"])
    modifier = "cmd" if sys.platform == "darwin" else "ctrl"

    class Page:
        def __init__(self, item):
            self.item, self._target_id = item, item["id"]

        async def evaluate(self, script, *args):
            if "chrome_height" in script:
                return json.dumps({"window_x":100, "window_y":100, "window_width":800,
                    "window_height":680,"chrome_width":0,"chrome_height":80,
                    "viewport_width":800,"viewport_height":600})
            return json.dumps({"url": self.item["url"], "visible":self._target_id == state.active,
                "focused":self._target_id == state.active and not state.address, "ready": "complete"})

    async def get_pages():
        # 反序返回，不能把 CDP 列表顺序当作屏幕标签顺序。
        return [Page(item) for item in reversed(pages)]

    async def get_current_page():
        return Page(next(item for item in pages if item["id"] == env.session.agent_focus_target_id))

    async def target_id(tab_id):
        matches = [item["id"] for item in pages if item["id"].endswith(tab_id)]
        if len(matches) != 1:
            raise ValueError("标签页不存在或有歧义")
        return matches[0]

    async def window(params, **kwargs):
        item = next(item for item in pages if item["id"] == params["targetId"])
        return {"windowId": item["window"]}

    async def history(**kwargs):
        return {"currentIndex":1,"entries":[{"url":url} for url in state.history]}

    async def cdp_session(target_id=None, focus=False):
        assert focus is False
        return SimpleNamespace(cdp_client=env.session.cdp_client, session_id=target_id)

    def press(keys):
        env.desktop.guard()
        env.desktop.events.append(("keys", keys))
        if keys == (modifier, "l"):
            state.address = True
        elif keys == ("enter",) and state.address:
            next(item for item in pages if item["id"] == state.active)["url"] = state.typed
            state.address = False
        elif keys == (modifier, "t"):
            pages.append({"id":"page_0004","url":"chrome://newtab/","window":1})
            state.active, state.address = "page_0004", True
        elif keys == ("ctrl", "tab"):
            index = next(i for i,item in enumerate(pages) if item["id"] == state.active)
            state.active = pages[(index + 1) % len(pages)]["id"]
        elif keys == (modifier, "w"):
            assert env.session.agent_focus_target_id != state.active, "不能触发原生关闭焦点恢复"
            index = next(i for i,item in enumerate(pages) if item["id"] == state.active)
            pages.pop(index)
            state.active = pages[min(index, len(pages)-1)]["id"]
        elif keys == (("cmd", "[") if sys.platform == "darwin" else ("alt", "left")):
            next(item for item in pages if item["id"] == state.active)["url"] = state.history[0]

    def type_text(text, interval_ms=50):
        env.desktop.guard()
        assert state.address, "网址必须输入地址栏"
        state.typed = text
        env.desktop.events.append(("type", text))

    def reject_cdp(event):
        raise AssertionError("不能派发原生 CDP 交互事件")

    env.desktop.press_keys, env.desktop.type_text = press, type_text
    env.session.get_pages, env.session.get_current_page = get_pages, get_current_page
    env.session.get_target_id_from_tab_id, env.session.get_or_create_cdp_session = target_id, cdp_session
    env.session.cdp_client.send.Browser = SimpleNamespace(getWindowForTarget=window)
    env.session.cdp_client.send.Page = SimpleNamespace(getNavigationHistory=history)
    env.session.event_bus = SimpleNamespace(dispatch=reject_cdp)
    env.session.agent_focus_target_id = state.active
    env.session._cached_browser_state_summary = object()
    env.session._cached_selector_map, env.session._cached_selector_indices = {}, {}
    env.session._dom_watchdog = None
    env.nav, env.modifier = state, modifier
    return env


@pytest.mark.asyncio
async def test_resume_restores_captured_task_tab_with_os_and_clears_old_page_indices(navigation):
    from core.orchestrator.takeover import TakeoverManager

    env = navigation
    manager = TakeoverManager("test", env.tools.revoke)

    async def request(bus, reason):
        env.tools.revoke()

    manager.request = request
    env.tools.bind_takeover(manager)
    await execute(env, "request_takeover", {"reason": "login_required"})
    # 人工切到其他标签，原生当前目标也随感知改变；仍须恢复暂停时的任务标签。
    env.nav.active = env.session.agent_focus_target_id = "page_0002"
    env.session._cached_selector_map[7] = object()
    env.session._cached_selector_indices[7] = object()
    await env.tools.authorize()
    await env.tools.restore_task_page(env.session)

    assert env.nav.active == env.session.agent_focus_target_id == "page_0001"
    assert env.session._cached_browser_state_summary is None
    assert not env.session._cached_selector_map and not env.session._cached_selector_indices
    assert env.desktop.events[0] == ("focus", 123)
    assert ("keys", ("ctrl", "tab")) in env.desktop.events
    assert not any(event[0] in {"click", "type"} for event in env.desktop.events)


@pytest.mark.asyncio
async def test_resume_does_not_substitute_another_tab_when_task_tab_was_closed(navigation):
    from core.orchestrator.takeover import TakeoverManager

    env = navigation
    manager = TakeoverManager("test", env.tools.revoke)

    async def request(bus, reason):
        env.tools.revoke()

    manager.request = request
    env.tools.bind_takeover(manager)
    await execute(env, "request_takeover", {"reason": "login_required"})
    env.nav.pages.pop(0)
    env.nav.active = env.session.agent_focus_target_id = "page_0002"
    await env.tools.authorize()
    with pytest.raises(ValueError, match="原任务标签页"):
        await env.tools.restore_task_page(env.session)
    assert env.desktop.events == []


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["before_check", "during_check"])
async def test_resume_rejects_target_replacement_after_new_page_perception(navigation, stage):
    env = navigation
    env.tools._takeover_target_id = "page_0001"
    await env.tools.authorize()
    await env.tools.restore_task_page(env.session)

    def replace_target():
        env.nav.active = env.session.agent_focus_target_id = "page_0002"

    if stage == "before_check":
        replace_target()
    else:
        get_page = env.session.get_current_page

        async def replaced_page():
            replace_target()
            return await get_page()

        env.session.get_current_page = replaced_page
    with pytest.raises(ValueError, match="原任务标签页已变化"):
        await env.tools.confirm_task_page(env.session)
    assert not any(event[0] in {"click", "type"} for event in env.desktop.events)


@pytest.mark.asyncio
@pytest.mark.parametrize("new_tab", [False, True])
async def test_navigation_uses_os_address_bar_without_cdp_actions(navigation, new_tab):
    env = navigation
    result = await execute(env, "navigate", {"url":"https://allowed.example/search?q=test", "new_tab":new_tab})

    assert result.error is None
    active = next(page for page in env.nav.pages if page["id"] == env.nav.active)
    assert active["url"] == "https://allowed.example/search?q=test"
    assert ("keys", (env.modifier, "l")) in env.desktop.events
    assert ("type", "https://allowed.example/search?q=test") in env.desktop.events
    assert env.session.agent_focus_target_id == env.nav.active
    assert len(env.nav.pages) == (4 if new_tab else 3)


@pytest.mark.asyncio
async def test_navigation_accepts_different_source_and_destination_domains(navigation):
    navigation.nav.pages[0]["url"] = "https://source.example/page"
    result = await execute(navigation, "navigate", {"url":"https://destination.example/task"})

    assert result.error is None
    assert navigation.nav.pages[0]["url"] == "https://destination.example/task"
    assert ("type", "https://destination.example/task") in navigation.desktop.events


@pytest.mark.asyncio
async def test_navigation_accepts_redirect_to_another_http_domain(navigation):
    press = navigation.desktop.press_keys

    def redirect(keys):
        press(keys)
        if keys == ("enter",):
            navigation.nav.pages[0]["url"] = "https://redirected.example/page"

    navigation.desktop.press_keys = redirect
    result = await execute(navigation, "navigate", {"url":"https://allowed.example/start"})

    assert result.error is None
    assert navigation.nav.pages[0]["url"] == "https://redirected.example/page"


@pytest.mark.asyncio
async def test_navigation_allows_loading_longer_than_os_input_timeout(navigation, monkeypatch):
    from agent import controller

    navigation.tools.config = Settings(_env_file=None, OS_CHANNEL_TIMEOUT=10, PAGE_LOAD_TIMEOUT=30)
    clock = SimpleNamespace(now=0)
    monkeypatch.setattr(controller, "time", SimpleNamespace(monotonic=lambda: clock.now))

    async def evaluate(script):
        clock.now += 1
        return json.dumps({"url":"https://destination.example/video", "visible":True,
                           "focused":True, "ready":"interactive" if clock.now >= 12 else "loading"})

    page = SimpleNamespace(evaluate=evaluate, _target_id=navigation.nav.active)
    result = await navigation.tools._wait_navigation(
        navigation.session, page, "https://allowed.example/1", "https://destination.example/video")

    assert result.error is None
    assert clock.now == 12
    assert navigation.desktop.events == []


@pytest.mark.asyncio
async def test_navigation_enforces_its_own_loading_deadline(navigation, monkeypatch):
    from agent import controller

    navigation.tools.config = Settings(_env_file=None, OS_CHANNEL_TIMEOUT=10, PAGE_LOAD_TIMEOUT=2)
    clock = SimpleNamespace(now=0)
    monkeypatch.setattr(controller, "time", SimpleNamespace(monotonic=lambda: clock.now))

    async def evaluate(script):
        clock.now += 1
        return json.dumps({"url":"https://destination.example/video", "visible":True,
                           "focused":True, "ready":"loading"})

    page = SimpleNamespace(evaluate=evaluate, _target_id=navigation.nav.active)
    with pytest.raises(TimeoutError, match="未观察到目标页面"):
        await navigation.tools._wait_navigation(
            navigation.session, page, "https://allowed.example/1", "https://destination.example/video")

    assert clock.now == 2
    assert navigation.desktop.events == []


@pytest.mark.asyncio
@pytest.mark.parametrize("ready", ["private-ready-value", {"private-ready-value": "unexpected"}])
async def test_navigation_timeout_does_not_log_page_supplied_ready_value(navigation, monkeypatch, caplog, ready):
    from agent import controller

    navigation.tools.config = Settings(_env_file=None, PAGE_LOAD_TIMEOUT=1)
    clock = SimpleNamespace(now=0)
    monkeypatch.setattr(controller, "time", SimpleNamespace(monotonic=lambda: clock.now))

    async def evaluate(script):
        clock.now += 1
        return json.dumps({"url":"https://destination.example/video", "visible":True,
                           "focused":True, "ready":ready})

    page = SimpleNamespace(evaluate=evaluate, _target_id=navigation.nav.active)
    with pytest.raises(TimeoutError, match="未观察到目标页面"):
        await navigation.tools._wait_navigation(
            navigation.session, page, "https://allowed.example/1", "https://destination.example/video")

    assert "private-ready-value" not in caplog.text
    assert "unknown" in caplog.text


@pytest.mark.asyncio
async def test_navigation_waits_for_address_bar_to_receive_os_focus(navigation):
    press = navigation.desktop.press_keys
    loop = asyncio.get_running_loop()

    def delayed_focus(keys):
        press(keys)
        if keys == (navigation.modifier, "l"):
            navigation.nav.address = False
            loop.call_soon_threadsafe(loop.call_later, 0.03, setattr, navigation.nav, "address", True)

    navigation.desktop.press_keys = delayed_focus
    result = await execute(navigation, "navigate", {"url":"https://destination.example/task"})
    assert result.error is None
    assert navigation.nav.pages[0]["url"] == "https://destination.example/task"


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["javascript:alert(1)",
                                 "data:text/html,test", "https://allowed.example/\nmalformed",
                                 "https://allowed.example:invalid/", "https://user:password@allowed.example/",
                                 r"https://blocked.example\.allowed.example/path"])
async def test_navigation_rejects_invalid_destination_before_any_os_input(navigation, url):
    result = await execute(navigation, "navigate", {"url":url})
    assert result.error
    assert navigation.desktop.events == []


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["https://allowed.example/before", "https://another.example/history",
                                 "javascript:alert(1)"])
async def test_go_back_validates_history_url_format_before_os_shortcut(navigation, url):
    env = navigation
    env.nav.history[0] = url
    result = await execute(env, "go_back", {})
    if url.startswith("javascript:"):
        assert result.error
        assert env.desktop.events == []
    else:
        assert result.error is None
        assert env.nav.pages[0]["url"] == url


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["switch", "close"])
async def test_tab_actions_use_os_and_sync_observed_focus(navigation, action):
    result = await execute(navigation, action, {"tab_id":"0002"})
    assert result.error is None
    assert navigation.session.agent_focus_target_id == navigation.nav.active
    if action == "switch":
        assert navigation.nav.active == "page_0002"
        assert ("keys", ("ctrl", "tab")) in navigation.desktop.events
    else:
        assert all(page["id"] != "page_0002" for page in navigation.nav.pages)
        assert ("keys", (navigation.modifier, "w")) in navigation.desktop.events


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["switch", "close"])
@pytest.mark.parametrize("selected", ["page_0002", "page_0003"])
async def test_tab_actions_recover_after_user_changes_visible_tab(navigation, action, selected):
    navigation.nav.active = selected
    assert navigation.session.agent_focus_target_id == "page_0001"

    result = await execute(navigation, action, {"tab_id":"0002"})
    assert result.error is None
    assert navigation.session.agent_focus_target_id == navigation.nav.active
    if action == "switch":
        assert navigation.nav.active == "page_0002"
    else:
        assert all(page["id"] != "page_0002" for page in navigation.nav.pages)


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["switch", "close"])
async def test_tab_actions_accept_current_and_target_on_different_domains(navigation, action):
    navigation.nav.active = "page_0003"
    navigation.nav.pages[2]["url"] = "https://source.example/page"
    navigation.nav.pages[1]["url"] = "https://destination.example/task"

    result = await execute(navigation, action, {"tab_id":"0002"})

    assert result.error is None
    assert navigation.session.agent_focus_target_id == navigation.nav.active
    if action == "switch":
        assert navigation.nav.active == "page_0002"
    else:
        assert all(page["id"] != "page_0002" for page in navigation.nav.pages)


@pytest.mark.asyncio
async def test_cross_window_tab_is_rejected_without_os_input(navigation):
    navigation.nav.pages[1]["window"] = 2
    result = await execute(navigation, "switch", {"tab_id":"0002"})
    assert result.error
    assert navigation.desktop.events == []


@pytest.mark.asyncio
async def test_last_tab_cannot_trigger_native_tab_recovery(navigation):
    navigation.nav.pages[:] = navigation.nav.pages[:1]
    result = await execute(navigation, "close", {"tab_id":"0001"})
    assert result.error
    assert navigation.desktop.events == []


@pytest.mark.asyncio
async def test_navigation_focus_loss_never_submits_or_falls_back_to_cdp(navigation):
    original = navigation.desktop.type_text

    def lose_focus(text, **kwargs):
        original(text, **kwargs)
        navigation.nav.address = False

    navigation.desktop.type_text = lose_focus
    result = await execute(navigation, "navigate", {"url":"https://allowed.example/new"})
    assert result.is_done and result.error and not navigation.desktop.allowed
    assert ("keys", ("enter",)) not in navigation.desktop.events
    assert navigation.nav.pages[0]["url"] == "https://allowed.example/1"


@pytest.mark.asyncio
async def test_os_tab_switch_timeout_stops_without_cdp_fallback(navigation):
    navigation.config.OS_CHANNEL_TIMEOUT = 0.03

    def ignored(keys):
        navigation.desktop.events.append(("keys", keys))

    navigation.desktop.press_keys = ignored
    result = await execute(navigation, "switch", {"tab_id":"0002"})
    assert result.is_done and result.error and not navigation.desktop.allowed
    assert navigation.nav.active == "page_0001"


def test_original_schemas_survive_overrides_and_coordinate_reregistration(environment):
    from browser_use.tools.service import Tools
    original = Tools().registry.registry.actions
    actions = environment.tools.registry.registry.actions
    for name in ("click", "input", "scroll", "send_keys", "navigate", "go_back", "switch", "close"):
        assert actions[name].param_model is original[name].param_model
        assert actions[name].terminates_sequence == original[name].terminates_sequence
        assert actions[name].domains == original[name].domains
    assert {"click", "input"}.isdisjoint(environment.tools.registry.exclude_actions)
    assert {"evaluate", "upload_file", "select_dropdown", "scroll_to_text"}.isdisjoint(actions)
    environment.tools.set_coordinate_clicking(True)
    assert "coordinate_x" in actions["click"].param_model.model_fields
    environment.tools.set_coordinate_clicking(False)
    assert "coordinate_x" not in actions["click"].param_model.model_fields


@pytest.mark.asyncio
async def test_index_is_resolved_to_the_real_backend_node_before_os_click(environment):
    result = await execute(environment, "click", {"index":7})
    assert result.error is None
    assert environment.state.resolved == [70]
    assert ("click", (160, 220)) in environment.desktop.events


@pytest.mark.asyncio
async def test_coordinate_mode_still_calls_os_after_reregistration(environment):
    environment.tools.set_coordinate_clicking(True)
    result = await execute(environment, "click", {"coordinate_x":150,"coordinate_y":200})
    assert result.error is None
    assert ("click", (250, 380)) in environment.desktop.events
    assert environment.state.resolved == []


@pytest.mark.asyncio
async def test_resized_screenshot_coordinates_are_converted_before_os_click(environment):
    environment.tools.set_coordinate_clicking(True)
    environment.session.llm_screenshot_size = (400,300)
    environment.session._original_viewport_size = (800,600)
    result = await execute(environment,"click",{"coordinate_x":75,"coordinate_y":100})
    assert result.error is None
    assert ("click",(250,380)) in environment.desktop.events


@pytest.mark.asyncio
@pytest.mark.parametrize("pages", [float("nan"),float("inf"),0,-1])
async def test_invalid_scroll_distance_cannot_start_os_actions(environment,pages):
    result = await execute(environment,"scroll",{"pages":pages})
    assert result.error
    assert environment.desktop.events == []


@pytest.mark.asyncio
@pytest.mark.parametrize("clear, expected", [(True,"新文"), (False,"原文新文"), (True,"")])
async def test_input_clears_or_appends_through_os_only(environment, clear, expected):
    text = "" if expected == "" else "新文"
    result = await execute(environment, "input", {"index":7,"text":text,"clear":clear})
    assert result.error is None
    assert environment.desktop.text == expected
    assert (("keys", ("backspace",)) in environment.desktop.events) is clear
    assert text not in (result.extracted_content or "") if text else True


@pytest.mark.asyncio
async def test_click_accepts_http_page_without_whitelist_setup(environment):
    environment.state.url = "https://another.example/page"
    result = await execute(environment, "click", {"index":7})
    assert result.error is None
    assert ("click", (160, 220)) in environment.desktop.events


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["hidden", "stale"])
async def test_invalid_page_or_index_never_generates_input(environment, failure):
    if failure == "hidden":
        environment.state.visible = False
    else:
        environment.state.node_present = False
    result = await execute(environment, "click", {"index":7})
    assert result.error
    assert all(event[0] != "click" for event in environment.desktop.events)


@pytest.mark.asyncio
async def test_os_failure_ends_takeover_without_a_cdp_fallback(environment):
    environment.desktop.allowed = False
    result = await execute(environment, "click", {"index":7})
    assert result.error and result.is_done and result.success is False
    assert environment.desktop.events == []


@pytest.mark.asyncio
@pytest.mark.parametrize("reason, visible", [
    ("无法唯一确认目标 Chrome 前台窗口，本次接管已停止", True),
    ("键盘库异常含私密输入 test-private-input", False),
])
async def test_os_failure_records_stage_and_only_known_safe_reason(environment, caplog, reason, visible):
    def focus_window(*args, **kwargs):
        raise PermissionError(reason)

    environment.desktop.focus_window = focus_window
    with caplog.at_level(logging.ERROR, logger="agent.controller"):
        result = await execute(environment, "click", {"index":7})

    assert result.is_done and result.success is False
    assert "focus_window" in result.error and "focus_window" in caplog.text
    assert (reason in result.error) is visible
    assert (reason in caplog.text) is visible
    assert not environment.desktop.allowed


@pytest.mark.asyncio
async def test_scroll_uses_observed_distance_and_never_clicks_the_container(environment):
    result = await execute(environment, "scroll", {"down":True,"pages":0.5})
    assert result.error is None
    assert environment.desktop.scroll_top >= 300
    assert all(event[0] != "click" for event in environment.desktop.events)


@pytest.mark.asyncio
async def test_send_keys_preserves_physical_shortcut_semantics(environment):
    result = await execute(environment, "send_keys", {"keys":"Control+a"})
    assert result.error is None
    assert ("keys", ("ctrl", "a")) in environment.desktop.events


def test_native_screenshot_tool_cannot_bypass_project_archive_switch(environment):
    assert "screenshot" not in environment.tools.registry.registry.actions
    model = environment.tools.registry.create_action_model()
    assert all("screenshot" not in schema.get("properties", {})
               for schema in model.model_json_schema().get("$defs", {}).values())


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["select", "clear", "append"])
async def test_input_focus_change_during_preparation_prevents_body_input(environment, phase):
    environment.config.OS_CHANNEL_TIMEOUT = 1

    def change_focus(keys):
        if (phase == "select" and keys[-1] == "a" or
            phase == "clear" and keys == ("backspace",) or
            phase == "append" and keys[-1] in {"down", "end"}):
            environment.desktop.focused = False

    environment.desktop.on_keys = change_focus
    result = await execute(environment, "input", {"index":7,"text":"不得进入其他控件","clear":phase != "append"})
    assert not any(event[0] == "type" for event in environment.desktop.events)
    if phase == "select":
        assert ("keys", ("backspace",)) not in environment.desktop.events
    assert result.error and result.is_done and result.success is False
    assert environment.desktop.allowed is False


@pytest.mark.asyncio
async def test_shortcut_requires_target_document_keyboard_focus(environment):
    environment.state.page_focused = False
    result = await execute(environment, "send_keys", {"keys":"Control+a"})
    assert not any(event[0] == "keys" for event in environment.desktop.events)
    assert result.error and result.is_done and result.success is False
    assert environment.desktop.allowed is False


@pytest.mark.asyncio
@pytest.mark.parametrize("screen, point, expected_region", [
    ((900,800), (790,200), (870,360,30,40)),
    ((900,600), (100,410), (180,570,40,30)),
])
async def test_click_near_screen_edge_clips_both_verification_captures(environment, screen, point, expected_region):
    environment.config.VERIFY_SCREENSHOT = True
    environment.desktop.screen_size = screen
    environment.tools.set_coordinate_clicking(True)
    result = await execute(environment, "click", {"coordinate_x":point[0],"coordinate_y":point[1]})
    assert result.error is None
    assert ("capture", expected_region) in environment.desktop.events
    assert ("verify", expected_region) in environment.desktop.events
    assert any(event[0] == "click" for event in environment.desktop.events)


@pytest.mark.parametrize("target, property_name, value", [
    ("frame", "scale", "2"),
    ("frame", "rotate", "15deg"),
    ("frame", "translate", "10px"),
    ("ancestor", "transform", "matrix(2,0,0,2,0,0)"),
    ("ancestor", "zoom", "2"),
    ("shadow_host", "transform", "matrix(2,0,0,2,0,0)"),
])
def test_readonly_iframe_script_rejects_individual_and_ancestor_transforms(target, property_name, value):
    node = shutil.which("node")
    if node is None:
        pytest.skip("该只读几何脚本回归需要本机 Node.js")
    from agent.controller import ELEMENT_SNAPSHOT

    # 执行生产脚本本身，仅用最小 DOM 几何替代浏览器，不镜像判断实现。
    script = """
    const shadow_host = {parentElement:null,getRootNode:() => ({})};
    const ancestor = {parentElement:null,getRootNode:() => ({host:shadow_host})};
    const frame = {parentElement:ancestor, clientLeft:0, clientTop:0,
        getBoundingClientRect:() => ({x:100,y:120,width:300,height:200})};
    const parent = {document:{elementFromPoint:() => frame}};
    parent.top = parent;
    parent.getComputedStyle = element => Object.assign(
        {transform:'none',zoom:'1',scale:'none',rotate:'none',translate:'none'},
        element === TARGET ? {[PROPERTY]:VALUE} : {});
    const view = {top:parent,parent,frameElement:frame};
    const element = {isConnected:true,checkVisibility:() => true,contains:() => false,
        getBoundingClientRect:() => ({x:20,y:20,width:100,height:40}),
        ownerDocument:{defaultView:view,elementFromPoint:() => element,hasFocus:() => true},
        getRootNode:() => ({activeElement:element})};
    try { (SNAPSHOT).call(element); process.stdout.write('accepted'); }
    catch (error) { process.stdout.write(error.message); }
    """.replace("TARGET",target).replace("PROPERTY",json.dumps(property_name)).replace("VALUE",json.dumps(value)).replace("SNAPSHOT",ELEMENT_SNAPSHOT)
    result = subprocess.run([node,"-e",script],capture_output=True,text=True,check=True,timeout=5)
    assert "变换" in result.stdout
