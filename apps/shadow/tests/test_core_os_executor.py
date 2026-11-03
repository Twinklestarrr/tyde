"""隔离真实桌面副作用，验证执行顺序、停止条件与实际图像比较。"""

import sys
import threading
from types import ModuleType, SimpleNamespace

from PIL import Image
import pytest

from core.executor import os_executor
from core.executor import permissions as permissions_module
from core.trajectory.generator import HumanTrajectory


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.on_sleep = None

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        if self.on_sleep is not None:
            self.on_sleep()


class Desktop:
    """仅替代系统输入输出边界，保留光标、点击、文字和屏幕图像状态。"""

    class FailSafeException(Exception):
        pass

    def __init__(self):
        self.FAILSAFE = False
        self.cursor = (10, 10)
        self.moves = []
        self.clicks = []
        self.text = ""
        self.scroll_total = 0
        self.image = Image.new("RGB", (10, 10), "white")
        self.capture_error = None
        self.captures = 0
        self.on_capture_enter = None
        self.on_move = None
        self.held_keys = []
        self.key_events = []
        self.on_press = None

    def size(self):
        return (1000, 800)

    def failSafeCheck(self):
        if self.FAILSAFE and self.cursor == (0, 0):
            raise self.FailSafeException("模拟紧急停止")

    def moveTo(self, x, y, *, _pause):
        self.failSafeCheck()
        self.cursor = (x, y)
        self.moves.append(self.cursor)
        if self.on_move is not None:
            self.on_move()

    def click(self, *, button, _pause):
        self.failSafeCheck()
        self.clicks.append((self.cursor, button))

    def scroll(self, delta, *, _pause):
        self.failSafeCheck()
        self.scroll_total += delta

    def type(self, text):
        self.text += text

    def position(self):
        return self.cursor

    def press(self, key):
        self.held_keys.append(key)
        self.key_events.append(("down", key))
        if self.on_press:
            self.on_press()

    def release(self, key):
        self.held_keys.remove(key)
        self.key_events.append(("up", key))

    def grab(self, region):
        self.captures += 1
        if self.capture_error is not None:
            raise self.capture_error
        return SimpleNamespace(size=self.image.size, rgb=self.image.tobytes())


@pytest.fixture
def desktop(monkeypatch):
    backend = Desktop()
    clock = FakeClock()
    monkeypatch.setattr(os_executor, "time", clock, raising=False)
    monkeypatch.setattr(os_executor, "sys", SimpleNamespace(platform="win32"), raising=False)
    dialog = SimpleNamespace(answer="allow")
    monkeypatch.setattr(permissions_module, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(permissions_module, "subprocess", SimpleNamespace(
        run=lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=dialog.answer),
        TimeoutExpired=TimeoutError,
    ))
    monkeypatch.setitem(sys.modules, "pyautogui", backend)
    keyboard = ModuleType("pynput.keyboard")
    keyboard.Controller = lambda: backend
    keyboard.Key = SimpleNamespace(**{name: f"key:{name}" for name in (
        "ctrl", "cmd", "alt", "shift", "enter", "tab", "esc", "backspace", "delete",
        "left", "right", "up", "down", "home", "end", "page_up", "page_down", "space",
    )})
    pynput = ModuleType("pynput")
    pynput.keyboard = keyboard
    monkeypatch.setitem(sys.modules, "pynput", pynput)
    monkeypatch.setitem(sys.modules, "pynput.keyboard", keyboard)

    class Capture:
        def __enter__(self):
            if backend.on_capture_enter:
                backend.on_capture_enter()
            return backend

        def __exit__(self, *args):
            return False

    monkeypatch.setitem(sys.modules, "mss", SimpleNamespace(mss=Capture))
    try:
        yield SimpleNamespace(backend=backend, clock=clock, dialog=dialog)
    finally:
        backend.image.close()


def layer(timeout=10):
    assert hasattr(os_executor, "OSLayer"), "OS 执行器尚未实现"
    executor = os_executor.OSLayer(timeout=timeout)
    executor.authorize()
    return executor


@pytest.fixture
def mac_focus(desktop, monkeypatch):
    """替代系统辅助功能边界；Cocoa 保留旧读数，验证不会继续依赖其缓存。"""
    state = SimpleNamespace(pid=999, copy_error=0, pid_error=0, activation_error=0,
                            front_error=0, front_missing=False, front_invalid=False,
                            auto_activate=True, missing_app=False, requests=[],
                            bounds=lambda:{"X":100,"Y":100,"Width":800,"Height":680})

    def attribute(element, name, output):
        if name == "AXFocusedApplication":
            return state.copy_error, None if state.missing_app else ("app", state.pid)
        if name == "AXFrontmost":
            value = None if state.front_missing else "true" if state.front_invalid else element[1] == state.pid
            return state.front_error, value
        if name == "AXFocusedWindow":
            return 0, "focused-window"
        if name == "AXPosition":
            return 0, (state.bounds()["X"], state.bounds()["Y"])
        if name == "AXSize":
            return 0, (state.bounds()["Width"], state.bounds()["Height"])
        raise AssertionError(f"未预期的辅助功能读取：{name}")

    def activate(element, name, value):
        state.requests.append((element, name, value))
        if state.activation_error == 0 and state.auto_activate:
            state.pid = element[1]
        return state.activation_error

    monkeypatch.setattr(os_executor, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setitem(sys.modules, "ApplicationServices", SimpleNamespace(
        AXUIElementCreateSystemWide=lambda:"system", AXUIElementCreateApplication=lambda pid:("app",pid),
        AXUIElementCopyAttributeValue=attribute, AXUIElementGetPid=lambda element, output:(state.pid_error,element[1]),
        AXUIElementSetAttributeValue=activate, AXValueGetValue=lambda value, kind, output:(True,value),
        kAXFocusedApplicationAttribute="AXFocusedApplication", kAXFrontmostAttribute="AXFrontmost",
        kAXFocusedWindowAttribute="AXFocusedWindow", kAXPositionAttribute="AXPosition", kAXSizeAttribute="AXSize",
        kAXValueCGPointType=1, kAXValueCGSizeType=2))
    monkeypatch.setitem(sys.modules, "AppKit", SimpleNamespace(
        NSRunningApplication=SimpleNamespace(runningApplicationWithProcessIdentifier_=lambda pid:
            SimpleNamespace(activateWithOptions_=lambda options:False)),
        NSWorkspace=SimpleNamespace(sharedWorkspace=lambda:SimpleNamespace(
            frontmostApplication=lambda:SimpleNamespace(processIdentifier=lambda:999))),
        NSApplicationActivateIgnoringOtherApps=2))
    return state


def test_accessibility_activation_reaches_owned_pid_without_cocoa_refresh(desktop, mac_focus):
    executor = layer(timeout=0.1)
    executor.focus_window(123)
    assert executor.get_cursor_position() == (10,10)
    assert mac_focus.requests == [(("app",123),"AXFrontmost",True)]
    assert desktop.backend.moves == desktop.backend.clicks == desktop.backend.key_events == []


@pytest.mark.parametrize("error", [-25204, -25205, -25212])
def test_accessibility_activation_rejection_stops_without_waiting(desktop, mac_focus, caplog, error):
    mac_focus.activation_error = error
    executor = layer(timeout=0.1)
    with pytest.raises(PermissionError, match="前台激活请求失败"):
        executor.focus_window(123)
    assert desktop.clock.now == 0
    assert "pid=123" in caplog.text and f"code={error}" in caplog.text
    with pytest.raises(PermissionError):
        executor.scroll(1)


def test_accessibility_activation_acceptance_still_requires_actual_foreground(desktop, mac_focus, caplog):
    mac_focus.auto_activate = False
    executor = layer(timeout=0.1)
    with pytest.raises(TimeoutError, match="未在限定时间内置于前台"):
        executor.focus_window(123)
    assert len(mac_focus.requests) == 1
    assert "pid=123" in caplog.text and "frontmost=False" in caplog.text
    with pytest.raises(PermissionError):
        executor.scroll(1)


@pytest.mark.parametrize("failure", ["copy", "no_value", "missing", "invalid"])
def test_frontmost_read_failure_never_activates_or_inputs(desktop, mac_focus, failure):
    mac_focus.front_error = {"copy": -25204, "no_value": -25212}.get(failure, 0)
    mac_focus.front_missing = failure == "missing"
    mac_focus.front_invalid = failure == "invalid"
    executor = layer(timeout=0.1)
    with pytest.raises(PermissionError, match="无法读取前台应用"):
        executor.focus_window(123)
    assert mac_focus.requests == []
    assert desktop.backend.moves == desktop.backend.clicks == desktop.backend.key_events == []


@pytest.mark.parametrize("global_error", [-25204, -25212])
def test_enter_navigation_survives_missing_global_focus(desktop, mac_focus, global_error):
    mac_focus.pid = 123
    executor = layer()
    executor.focus_window(123)
    desktop.backend.on_press = lambda: setattr(mac_focus, "copy_error", global_error)

    executor.press_keys(("enter",))

    assert desktop.backend.key_events == [("down", "key:enter"), ("up", "key:enter")]
    assert executor.get_cursor_position() == (10, 10)


def test_enter_releases_key_before_post_action_focus_read(desktop, mac_focus, monkeypatch):
    mac_focus.pid = 123
    executor = layer()
    executor.focus_window(123)
    ax = sys.modules["ApplicationServices"]
    original = ax.AXUIElementCopyAttributeValue

    def read(element, name, output):
        if name in {"AXFocusedApplication", "AXFrontmost"} and desktop.backend.held_keys:
            return -25212, None
        return original(element, name, output)

    monkeypatch.setattr(ax, "AXUIElementCopyAttributeValue", read)
    executor.press_keys(("enter",))

    assert desktop.backend.key_events == [("down", "key:enter"), ("up", "key:enter")]
    assert desktop.backend.held_keys == []
    assert executor.get_cursor_position() == (10, 10)


def test_successive_browser_instances_use_their_own_pid(desktop, mac_focus):
    for pid in (123,456):
        executor = layer(timeout=0.1)
        executor.focus_window(pid)
        assert executor.get_cursor_position() == (10,10)
        executor.revoke()
    assert [request[0][1] for request in mac_focus.requests] == [123,456]


def test_owned_foreground_browser_needs_no_activation_request(desktop, mac_focus):
    mac_focus.pid = 123
    executor = layer()
    executor.focus_window(123)
    assert executor.get_cursor_position() == (10,10)
    assert mac_focus.requests == []


@pytest.mark.parametrize("interruption", ["revoke", "timeout"])
def test_interruption_during_frontmost_read_prevents_activation(desktop, mac_focus, monkeypatch, interruption):
    executor = layer(timeout=0.1)
    ax = sys.modules["ApplicationServices"]
    original = ax.AXUIElementCopyAttributeValue

    def read(element, name, output):
        if name in {"AXFocusedApplication", "AXFrontmost"}:
            if interruption == "revoke":
                executor.revoke()
            else:
                desktop.clock.sleep(0.2)
        return original(element, name, output)

    monkeypatch.setattr(ax, "AXUIElementCopyAttributeValue", read)
    with pytest.raises(PermissionError if interruption == "revoke" else TimeoutError):
        executor.focus_window(123)
    assert mac_focus.requests == []


def test_generated_points_reach_the_target_before_the_click(desktop):
    executor = layer()
    points = HumanTrajectory().generate((10, 10), (300, 400))

    executor.move_and_click(points, button="right")

    assert desktop.backend.moves == [(10, 10), (300, 400)]
    assert desktop.backend.clicks == [((300, 400), "right")]
    assert desktop.clock.now >= 0.02
    assert desktop.backend.FAILSAFE is True


def test_cursor_can_move_without_an_unrequested_click(desktop):
    executor = layer()
    assert hasattr(executor, "move_to"), "滚动定位尚未接入"
    assert hasattr(executor, "get_cursor_position"), "光标读取尚未接入"
    executor.move_to(200, 300)
    assert executor.get_cursor_position() == (200, 300)
    assert desktop.backend.clicks == []


def test_shortcut_releases_all_keys_when_takeover_is_revoked(desktop):
    executor = layer()
    assert hasattr(executor, "press_keys"), "OS 快捷键尚未实现"
    desktop.backend.on_press = executor.revoke
    with pytest.raises(PermissionError):
        executor.press_keys(("ctrl", "a"))
    assert desktop.backend.held_keys == []
    assert desktop.backend.key_events == [("down", "key:ctrl"), ("up", "key:ctrl")]


def test_shortcut_keeps_modifier_and_release_order(desktop):
    executor = layer()
    assert hasattr(executor, "press_keys"), "OS 快捷键尚未实现"
    executor.press_keys(("ctrl", "a"))
    assert desktop.backend.key_events == [
        ("down", "key:ctrl"), ("down", "a"), ("up", "a"), ("up", "key:ctrl"),
    ]


@pytest.mark.parametrize("key", ["[", "]"])
def test_chrome_history_shortcut_accepts_brackets_and_releases_keys(desktop, key):
    executor = layer()
    executor.press_keys(("cmd", key))
    assert desktop.backend.key_events == [
        ("down", "key:cmd"), ("down", key), ("up", key), ("up", "key:cmd"),
    ]


@pytest.mark.parametrize("front_pid", [123, 999])
def test_focus_waits_for_the_owned_browser_process(desktop, mac_focus, front_pid):
    mac_focus.pid = front_pid
    mac_focus.auto_activate = False
    executor = layer(timeout=0.1)
    assert hasattr(executor, "focus_window"), "浏览器前台激活尚未实现"
    if front_pid == 123:
        executor.focus_window(123)
    else:
        with pytest.raises(TimeoutError):
            executor.focus_window(123)
        with pytest.raises(PermissionError):
            executor.scroll(1)
    assert len(mac_focus.requests) == (0 if front_pid == 123 else 1)


def test_losing_browser_foreground_during_movement_prevents_the_click(desktop, mac_focus):
    mac_focus.pid = 123
    executor = layer()
    executor.focus_window(123)
    desktop.backend.on_move = lambda:setattr(mac_focus,"pid",999)
    with pytest.raises(PermissionError):
        executor.move_and_click([(100,200,0),(300,400,0)])
    assert desktop.backend.clicks == []
    assert desktop.backend.moves == [(100,200)]


@pytest.mark.parametrize("failure", ["wrong_window", "ambiguous", "switch_during_move"])
def test_browser_pid_cannot_substitute_for_target_window_identity(desktop, mac_focus, monkeypatch, caplog, failure):
    target = {"kCGWindowOwnerPID":123,"kCGWindowLayer":0,"kCGWindowNumber":10,
        "kCGWindowBounds":{"X":100,"Y":100,"Width":800,"Height":680}}
    other = {**target,"kCGWindowNumber":11,"kCGWindowBounds":{**target["kCGWindowBounds"],"X":200}}
    windows = [target, other]
    if failure == "wrong_window":
        windows.reverse()
    elif failure == "ambiguous":
        other["kCGWindowBounds"] = dict(target["kCGWindowBounds"])
    mac_focus.pid = 123
    mac_focus.bounds = lambda:windows[0]["kCGWindowBounds"]
    monkeypatch.setitem(sys.modules,"Quartz",SimpleNamespace(
        CGWindowListCopyWindowInfo=lambda *args:windows,
        kCGWindowListOptionOnScreenOnly=1,kCGWindowListExcludeDesktopElements=2,kCGNullWindowID=0,
    ))
    info = {"window_x":100,"window_y":100,"window_width":800,"window_height":680}
    executor = layer()
    if failure == "switch_during_move":
        executor.focus_window(123, info)
        desktop.backend.on_move = windows.reverse
        with pytest.raises(PermissionError):
            executor.move_and_click([(100,200,0),(300,400,0)])
    else:
        with pytest.raises(PermissionError):
            executor.focus_window(123, info)
        assert "Chrome 窗口匹配失败" in caplog.text
        assert "expected=" in caplog.text and "visible=" in caplog.text
    assert desktop.backend.clicks == []
    with pytest.raises(PermissionError):
        executor.scroll(1)


@pytest.mark.parametrize("failure", [None, "ambiguous", "raise_error", "no_effect", "revoke", "timeout"])
def test_explicit_resume_raises_only_the_unique_original_window(desktop, mac_focus, monkeypatch, failure):
    target = {"kCGWindowOwnerPID":123,"kCGWindowLayer":0,"kCGWindowNumber":10,
        "kCGWindowBounds":{"X":100,"Y":100,"Width":800,"Height":680}}
    other = {**target,"kCGWindowNumber":11,"kCGWindowBounds":{**target["kCGWindowBounds"],"X":200}}
    windows = [other, target]
    mac_focus.pid = 123
    mac_focus.bounds = lambda:windows[0]["kCGWindowBounds"]
    monkeypatch.setitem(sys.modules, "Quartz", SimpleNamespace(CGWindowListCopyWindowInfo=lambda *args:windows,
        kCGWindowListOptionOnScreenOnly=1,kCGWindowListExcludeDesktopElements=2,kCGNullWindowID=0))
    ax = sys.modules["ApplicationServices"]
    original = ax.AXUIElementCopyAttributeValue
    raises = []

    def attribute(element, name, output):
        if name == "AXWindows":
            if failure == "revoke":
                executor.revoke()
            elif failure == "timeout":
                desktop.clock.sleep(1)
            return 0, ["task-window", "duplicate-window"] if failure == "ambiguous" else ["task-window"]
        if element in {"task-window", "duplicate-window"}:
            return (0, (100, 100)) if name == "AXPosition" else (0, (800, 680))
        return original(element, name, output)

    def raise_window(element, action):
        assert element == "task-window" and action == "AXRaise"
        raises.append(element)
        if failure == "raise_error":
            return -25204
        if failure != "no_effect":
            windows[:] = [target, other]
        return 0

    monkeypatch.setattr(ax, "AXUIElementCopyAttributeValue", attribute)
    monkeypatch.setattr(ax, "kAXWindowsAttribute", "AXWindows", raising=False)
    monkeypatch.setattr(ax, "kAXRaiseAction", "AXRaise", raising=False)
    monkeypatch.setattr(ax, "AXUIElementPerformAction", raise_window, raising=False)
    executor = layer(timeout=0.1)
    info = {"window_x":100,"window_y":100,"window_width":800,"window_height":680}
    if failure:
        with pytest.raises((PermissionError, TimeoutError)):
            executor.focus_window(123, info, restore=True)
        with pytest.raises(PermissionError):
            executor.scroll(1)
    else:
        executor.focus_window(123, info, restore=True)
        assert executor.get_cursor_position() == (10,10)
        assert windows[0]["kCGWindowNumber"] == 10
    assert raises == ([] if failure in {"ambiguous", "revoke", "timeout"} else ["task-window"])
    assert desktop.backend.moves == desktop.backend.clicks == desktop.backend.key_events == []


def test_explicit_window_restore_requires_a_new_authorization(desktop, mac_focus):
    executor = layer()
    executor.focus_window(123)
    mac_focus.pid = 999
    with pytest.raises(PermissionError):
        executor.focus_window(123, restore=True)
    assert len(mac_focus.requests) == 1


@pytest.mark.parametrize("focused", ["owned", "other", "unreadable", "ambiguous"])
@pytest.mark.parametrize("phase", ["bind", "execute"])
def test_address_bar_popup_requires_accessibility_confirmation_of_owned_window(desktop, mac_focus, monkeypatch, focused, phase):
    target = {"kCGWindowOwnerPID":123, "kCGWindowLayer":0, "kCGWindowNumber":10,
              "kCGWindowBounds":{"X":100,"Y":100,"Width":800,"Height":680}}
    popup = {**target, "kCGWindowNumber":11,
             "kCGWindowBounds":{"X":180,"Y":120,"Width":600,"Height":136}}
    windows = [target]
    mac_focus.pid = 123
    mac_focus.bounds = lambda:dict(target["kCGWindowBounds"], X=100 if focused in {"owned", "ambiguous"} else 200)
    monkeypatch.setitem(sys.modules, "Quartz", SimpleNamespace(CGWindowListCopyWindowInfo=lambda *args:windows,
        kCGWindowListOptionOnScreenOnly=1,kCGWindowListExcludeDesktopElements=2,kCGNullWindowID=0))

    ax = sys.modules["ApplicationServices"]
    original_attribute = ax.AXUIElementCopyAttributeValue

    def attribute(element, name, output):
        if focused == "unreadable" and name == "AXFocusedWindow":
            return -25204, None
        return original_attribute(element, name, output)

    monkeypatch.setattr(ax, "AXUIElementCopyAttributeValue", attribute)
    executor = layer()
    info = {"window_x":100,"window_y":100,"window_width":800,"window_height":680}
    if phase == "execute":
        executor.focus_window(123, info)
    windows.insert(0, popup)
    if focused == "ambiguous":
        windows.insert(0, {**target, "kCGWindowNumber":12})
    def operation():
        if phase == "bind":
            executor.focus_window(123, info)
        return executor.get_cursor_position()

    if focused == "owned":
        assert operation() == (10,10)
    else:
        with pytest.raises(PermissionError):
            operation()


@pytest.mark.parametrize("points, button", [
    ([], "left"),
    ([(10, 10, 0), (float("nan"), 30, 0)], "left"),
    ([(10, 10, 0), (1000, 30, 0)], "left"),
    ([(10, 10, 0), (-1, 30, 0)], "left"),
    ([(10, 10, -1)], "left"),
    ([(10, 10, 0)], "unknown"),
])
def test_bad_point_stream_is_rejected_before_any_movement(desktop, points, button):
    with pytest.raises(ValueError):
        layer().move_and_click(points, button=button)

    assert desktop.backend.cursor == (10, 10)
    assert desktop.backend.moves == []
    assert desktop.backend.clicks == []


def test_timeout_after_a_slow_movement_prevents_the_click(desktop):
    desktop.backend.on_move = lambda: desktop.clock.sleep(1)

    with pytest.raises(TimeoutError):
        layer(timeout=0.1).move_and_click([(300, 400, 0)])

    assert desktop.backend.clicks == []
    desktop.backend.on_move = None
    layer().scroll(-2)
    assert desktop.backend.scroll_total == -2


def test_failsafe_during_point_delay_prevents_following_actions(desktop):
    desktop.clock.on_sleep = lambda: setattr(desktop.backend, "cursor", (0, 0))

    with pytest.raises(Desktop.FailSafeException):
        layer().move_and_click([(100, 200, 1000), (300, 400, 0)])

    assert desktop.backend.moves == [(100, 200)]
    assert desktop.backend.clicks == []


def test_unicode_and_control_characters_are_preserved(desktop):
    layer().type_text("Shadow 中文\n下一行", interval_ms=5)

    assert desktop.backend.text == "Shadow 中文\n下一行"
    assert desktop.clock.now >= 0.05


@pytest.mark.skipif(sys.platform != "darwin", reason="需要 macOS Quartz 事件对象，不发送真实按键")
def test_mac_text_uses_unicode_events_instead_of_ime_keycodes(desktop, monkeypatch):
    import Quartz

    monkeypatch.setattr(os_executor, "sys", SimpleNamespace(platform="darwin"), raising=False)
    events = []

    def collect(tap, event):
        # 创建和解析真实事件对象，仅替代发送边界，不触发桌面输入。
        length, text = Quartz.CGEventKeyboardGetUnicodeString(event, 8, None, None)
        events.append((Quartz.CGEventGetType(event), text, length, Quartz.CGEventGetFlags(event)))

    monkeypatch.setattr(Quartz, "CGEventPost", collect)
    layer().type_text("Shadow 中文😀\n下一行", interval_ms=5)

    down = [event for event in events if event[0] == Quartz.kCGEventKeyDown]
    up = [event for event in events if event[0] == Quartz.kCGEventKeyUp]
    assert "".join(event[1] for event in down) == "Shadow 中文😀下一行"
    assert [event[1:] for event in up] == [event[1:] for event in down]
    assert next(event[2] for event in down if event[1] == "😀") == 2
    assert all(event[3] == 0 for event in events)
    assert desktop.backend.text == "\n"


@pytest.mark.skipif(sys.platform != "darwin", reason="需要 macOS Quartz，不发送真实按键")
def test_mac_keyboard_event_failure_revokes_takeover(desktop, monkeypatch):
    import Quartz

    monkeypatch.setattr(os_executor, "sys", SimpleNamespace(platform="darwin"), raising=False)
    monkeypatch.setattr(Quartz, "CGEventCreateKeyboardEvent", lambda *args: None)
    executor = layer()

    with pytest.raises(OSError, match="键盘事件"):
        executor.type_text("不应输入")
    with pytest.raises(PermissionError):
        executor.scroll(-1)
    assert desktop.backend.text == ""


def test_typing_timeout_does_not_send_remaining_characters(desktop):
    with pytest.raises(TimeoutError):
        layer(timeout=0.02).type_text("中文", interval_ms=50)

    assert desktop.backend.text == "中"


def test_unicode_typing_obeys_the_same_mouse_failsafe(desktop):
    desktop.backend.cursor = (0, 0)

    with pytest.raises(Desktop.FailSafeException):
        layer().type_text("不应输入")

    assert desktop.backend.text == ""


@pytest.mark.parametrize("interval", [-1, float("nan")])
def test_invalid_typing_interval_produces_no_input(desktop, interval):
    with pytest.raises(ValueError):
        layer().type_text("不应输入", interval_ms=interval)

    assert desktop.backend.text == ""


def test_scroll_uses_signed_wheel_units(desktop):
    executor = layer()
    executor.scroll(-4)
    executor.scroll(1)

    assert desktop.backend.scroll_total == -3


def test_multiple_instances_cannot_interleave_os_actions(desktop):
    executor = layer()
    second = layer(timeout=0.01)
    entered = threading.Event()
    release = threading.Event()
    errors = []

    def block_move():
        entered.set()
        assert release.wait(2), "测试线程未按时释放"

    def first_action():
        try:
            executor.move_and_click([(300, 400, 0)])
        except BaseException as error:
            errors.append(error)

    desktop.backend.on_move = block_move
    thread = threading.Thread(target=first_action)
    thread.start()
    try:
        assert entered.wait(2)
        with pytest.raises(TimeoutError):
            second.scroll(-2)
        assert desktop.backend.scroll_total == 0
    finally:
        release.set()
        thread.join(timeout=2)

    assert not thread.is_alive()
    assert errors == []
    assert desktop.backend.clicks == [((300, 400), "left")]


def test_capture_returns_rgb_pixels_without_writing_files(desktop):
    desktop.backend.image.putpixel((2, 3), (10, 20, 30))

    with layer().capture_region((10, 20, 10, 10)) as image:
        assert image.mode == "RGB"
        assert image.size == (10, 10)
        assert image.getpixel((2, 3)) == (10, 20, 30)


def test_identical_screenshot_is_not_reported_as_success(desktop):
    with desktop.backend.image.copy() as before:
        assert layer().screenshot_verify((10, 20, 10, 10), before) is False


def test_screenshot_verification_requires_enough_actual_change(desktop):
    with desktop.backend.image.copy() as before:
        desktop.backend.image.putpixel((0, 0), (0, 0, 0))
        desktop.backend.image.putpixel((0, 1), (0, 0, 0))
        executor = layer()

        assert executor.screenshot_verify((10, 20, 10, 10), before, min_changed_ratio=0.01) is True
        assert executor.screenshot_verify((10, 20, 10, 10), before, min_changed_ratio=0.03) is False


def test_small_pixel_noise_is_ignored(desktop):
    with desktop.backend.image.copy() as before:
        desktop.backend.image.paste((250, 250, 250), (0, 0, 10, 10))

        assert layer().screenshot_verify((10, 20, 10, 10), before, pixel_threshold=10) is False


def test_different_capture_sizes_cannot_be_compared(desktop):
    with Image.new("RGB", (5, 5), "white") as before:
        with pytest.raises(ValueError):
            layer().screenshot_verify((10, 20, 10, 10), before)


@pytest.mark.parametrize("region", [(0, 0, 0, 10), (990, 0, 20, 10), (-1, 0, 10, 10)])
def test_capture_rejects_invalid_or_off_screen_region(desktop, region):
    with pytest.raises(ValueError):
        layer().capture_region(region)


def test_capture_failure_is_not_disguised_as_success(desktop):
    desktop.backend.capture_error = OSError("模拟屏幕录制权限不足")
    with desktop.backend.image.copy() as before:
        with pytest.raises(OSError, match="权限"):
            layer().screenshot_verify((10, 20, 10, 10), before)


@pytest.mark.parametrize("timeout", [0, -1, float("inf")])
def test_invalid_timeout_is_rejected_before_accessing_the_desktop(timeout):
    with pytest.raises(ValueError):
        layer(timeout=timeout)


@pytest.mark.parametrize("action", ["click", "type", "scroll", "capture", "verify"])
def test_unconfirmed_session_cannot_send_input_or_capture(desktop, action):
    executor = os_executor.OSLayer()
    with pytest.raises(PermissionError):
        if action == "click":
            executor.move_and_click([(100, 100, 0)])
        elif action == "type":
            executor.type_text("不得输入")
        elif action == "scroll":
            executor.scroll(1)
        elif action == "capture":
            with executor.capture_region((10, 10, 10, 10)):
                pass
        else:
            executor.screenshot_verify((10, 10, 10, 10), desktop.backend.image)

    assert desktop.backend.moves == []
    assert desktop.backend.text == ""
    assert desktop.backend.scroll_total == 0


def test_revoke_during_wait_stops_the_remaining_point_stream(desktop):
    executor = os_executor.OSLayer()
    assert hasattr(executor, "authorize"), "执行器尚未接入授权闸门"
    executor.authorize()
    desktop.clock.on_sleep = executor.revoke

    with pytest.raises(PermissionError):
        executor.move_and_click([(100, 200, 100), (300, 400, 0)])

    assert desktop.backend.moves == [(100, 200)]
    assert desktop.backend.clicks == []


def test_new_confirmation_rejection_invalidates_os_access(desktop):
    executor = os_executor.OSLayer()
    assert hasattr(executor, "authorize"), "执行器尚未接入授权闸门"
    executor.authorize()
    desktop.dialog.answer = "deny"

    with pytest.raises(PermissionError):
        executor.authorize()
    with pytest.raises(PermissionError):
        executor.scroll(-1)

    assert desktop.backend.scroll_total == 0


def test_canceled_request_waiting_for_the_os_lock_cannot_be_restarted(desktop, monkeypatch):
    class Channel:
        def acquire(self, **kwargs):
            executor.revoke()
            return True

        def release(self):
            pass

    monkeypatch.setattr(os_executor, "_OS_LOCK", Channel())
    executor = os_executor.OSLayer()

    with pytest.raises(PermissionError):
        executor.authorize()
    with pytest.raises(PermissionError):
        executor.scroll(-1)

    assert desktop.backend.scroll_total == 0


def test_status_query_cancellation_prevents_the_next_input(desktop, monkeypatch):
    executor = layer()
    checks = 0

    def status():
        nonlocal checks
        checks += 1
        if checks == 2:
            executor.revoke()
        return True, True

    monkeypatch.setattr(executor._permissions, "_status", status)
    with pytest.raises(PermissionError):
        executor.scroll(1)

    assert desktop.backend.scroll_total == 0


@pytest.mark.parametrize("failure, error", [("revoke", PermissionError), ("timeout", TimeoutError)])
def test_capture_initialization_cannot_bypass_the_execution_gate(desktop, failure, error):
    executor = layer(timeout=0.1)
    if failure == "revoke":
        desktop.backend.on_capture_enter = executor.revoke
    else:
        desktop.backend.on_capture_enter = lambda: desktop.clock.sleep(1)

    with pytest.raises(error):
        executor.capture_region((10, 10, 10, 10))

    assert desktop.backend.captures == 0


@pytest.mark.parametrize("failure", ["invalid_points", "image_size"])
def test_public_validation_failure_ends_the_authorized_session(desktop, failure):
    executor = layer()
    with pytest.raises(ValueError):
        if failure == "invalid_points":
            executor.move_and_click([])
        else:
            with Image.new("RGB", (5, 5)) as before:
                executor.screenshot_verify((10, 10, 10, 10), before)

    with pytest.raises(PermissionError):
        executor.scroll(1)
    assert desktop.backend.scroll_total == 0
