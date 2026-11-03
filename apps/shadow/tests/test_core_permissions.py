"""验证接管确认、系统权限生效、超时和授权失效的执行闸门。"""

import importlib
import importlib.util
import ctypes
import subprocess
import sys
from types import SimpleNamespace

import pytest


class Clock:
    def __init__(self):
        self.now = 0.0
        self.on_sleep = None

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        if self.on_sleep:
            self.on_sleep()


@pytest.fixture
def environment(monkeypatch):
    assert importlib.util.find_spec("core.executor.permissions"), "授权模块尚未实现"
    module = importlib.import_module("core.executor.permissions")
    clock = Clock()
    events = []
    native = SimpleNamespace(accessibility=True, screen_capture=True, on_request=None, on_status=None)

    class Native:
        def status(self):
            events.append("check")
            if native.on_status:
                native.on_status()
            return native.accessibility, native.screen_capture

        def request(self, *, accessibility, screen_capture):
            events.append(("request", accessibility, screen_capture))
            if native.on_request:
                native.on_request()

    dialog = SimpleNamespace(answer="allow", elapsed=0, error=None)

    def run(*args, **kwargs):
        events.append("dialog")
        clock.now += dialog.elapsed
        if dialog.error:
            raise dialog.error
        return subprocess.CompletedProcess(args, 0, stdout=dialog.answer + "\n", stderr="")

    monkeypatch.setattr(module, "sys", SimpleNamespace(platform="darwin"), raising=False)
    monkeypatch.setattr(module, "time", clock, raising=False)
    monkeypatch.setattr(module, "_MacPermissions", Native, raising=False)
    monkeypatch.setattr(module, "subprocess", SimpleNamespace(run=run, TimeoutExpired=subprocess.TimeoutExpired), raising=False)
    return SimpleNamespace(module=module, clock=clock, events=events, native=native, dialog=dialog)


def new_gate(environment):
    assert hasattr(environment.module, "DesktopPermissions"), "授权闸门尚未实现"
    return environment.module.DesktopPermissions()


def test_new_session_cannot_execute_without_a_confirmation(environment):
    gate = new_gate(environment)

    with pytest.raises(PermissionError):
        gate.ensure_authorized()

    assert environment.events == []


def test_each_takeover_requires_a_new_confirmation(environment):
    gate = new_gate(environment)
    gate.authorize()
    gate.ensure_authorized()
    gate.authorize()
    gate.ensure_authorized()

    assert environment.events.count("dialog") == 2
    assert not any(isinstance(event, tuple) for event in environment.events)


@pytest.mark.parametrize("answer, error", [("deny", PermissionError), ("timeout", TimeoutError), ("unknown", PermissionError)])
def test_rejection_or_no_valid_confirmation_leaves_the_gate_closed(environment, answer, error):
    gate = new_gate(environment)
    environment.dialog.answer = answer

    with pytest.raises(error):
        gate.authorize()
    with pytest.raises(PermissionError):
        gate.ensure_authorized()

    assert environment.events == ["dialog"]


def test_permissions_must_really_change_after_the_system_prompt(environment):
    gate = new_gate(environment)
    environment.native.accessibility = False
    environment.native.screen_capture = False
    environment.clock.on_sleep = lambda: setattr(environment.native, "accessibility", True)

    with pytest.raises(TimeoutError):
        gate.authorize(timeout=1)
    with pytest.raises(PermissionError):
        gate.ensure_authorized()

    assert environment.events.index("dialog") < environment.events.index(("request", True, True))
    assert environment.events.count(("request", True, True)) == 1


def test_only_missing_permissions_are_requested_and_grant_is_observed(environment):
    gate = new_gate(environment)
    environment.native.accessibility = False
    environment.clock.on_sleep = lambda: setattr(environment.native, "accessibility", True)

    gate.authorize(timeout=2)
    gate.ensure_authorized()

    assert ("request", True, False) in environment.events
    assert environment.clock.now > 0


def test_dialog_time_counts_towards_the_authorization_deadline(environment):
    gate = new_gate(environment)
    environment.dialog.elapsed = 2

    with pytest.raises(TimeoutError):
        gate.authorize(timeout=1)
    with pytest.raises(PermissionError):
        gate.ensure_authorized()

    assert environment.events == ["dialog"]


def test_canceling_a_new_request_invalidates_the_previous_grant(environment):
    gate = new_gate(environment)
    gate.authorize()
    environment.dialog.answer = "deny"

    with pytest.raises(PermissionError):
        gate.authorize()
    with pytest.raises(PermissionError):
        gate.ensure_authorized()


def test_permission_revocation_requires_a_new_takeover_confirmation(environment):
    gate = new_gate(environment)
    gate.authorize()
    environment.native.screen_capture = False
    with pytest.raises(PermissionError):
        gate.ensure_authorized()
    environment.native.screen_capture = True
    with pytest.raises(PermissionError):
        gate.ensure_authorized()


def test_explicit_revoke_ends_the_takeover_session(environment):
    gate = new_gate(environment)
    gate.authorize()
    gate.revoke()

    with pytest.raises(PermissionError):
        gate.ensure_authorized()


def test_revoke_while_waiting_cannot_be_overwritten_by_a_later_system_grant(environment):
    gate = new_gate(environment)
    environment.native.accessibility = False

    def cancel_and_grant():
        gate.revoke()
        environment.native.accessibility = True

    environment.clock.on_sleep = cancel_and_grant
    with pytest.raises(PermissionError):
        gate.authorize(timeout=1)
    with pytest.raises(PermissionError):
        gate.ensure_authorized()


def test_revoke_during_system_status_query_invalidates_its_result(environment):
    gate = new_gate(environment)
    gate.authorize()
    environment.native.on_status = gate.revoke

    with pytest.raises(PermissionError):
        gate.ensure_authorized()


def test_a_hung_dialog_does_not_grant_access(environment):
    gate = new_gate(environment)
    environment.dialog.error = subprocess.TimeoutExpired("授权弹窗", 1)

    with pytest.raises(TimeoutError):
        gate.authorize(timeout=1)
    with pytest.raises(PermissionError):
        gate.ensure_authorized()


@pytest.mark.parametrize("timeout", [0, -1, float("nan"), True])
def test_invalid_wait_time_does_not_open_any_dialog(environment, timeout):
    with pytest.raises(ValueError):
        new_gate(environment).authorize(timeout=timeout)

    assert environment.events == []


@pytest.mark.skipif(sys.platform != "darwin", reason="只核验 macOS 的系统框架参数")
def test_mac_prompt_uses_a_real_corefoundation_true_option(monkeypatch):
    module = importlib.import_module("core.executor.permissions")
    native = module._MacPermissions()
    native.cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    native.cf.CFDictionaryGetValue.restype = ctypes.c_void_p
    key = ctypes.c_void_p.in_dll(native.ax, "kAXTrustedCheckOptionPrompt").value
    true_value = ctypes.c_void_p.in_dll(native.cf, "kCFBooleanTrue").value
    observed = []

    def request(options):
        observed.append(native.cf.CFDictionaryGetValue(options, key) == true_value)
        return False

    # 只替代会弹窗的系统调用，实际构造、读取并释放 CFDictionary，不请求真实权限。
    monkeypatch.setattr(native.ax, "AXIsProcessTrustedWithOptions", request)
    native.request(accessibility=True, screen_capture=False)

    assert observed == [True]


@pytest.mark.skipif(sys.platform != "darwin", reason="只核验 macOS 授权弹窗脚本语法")
def test_mac_confirmation_script_compiles_without_showing_a_dialog(tmp_path, monkeypatch):
    module = importlib.import_module("core.executor.permissions")
    commands = []

    def capture(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="allow", stderr="")

    with monkeypatch.context() as patch:
        patch.setattr(module, "subprocess", SimpleNamespace(run=capture, TimeoutExpired=subprocess.TimeoutExpired))
        module._confirm_takeover(10)
    script = tmp_path / "consent.applescript"
    script.write_text(commands[0][-1], encoding="utf-8")

    baseline = subprocess.run(
        ["/usr/bin/osacompile", "-o", str(tmp_path / "baseline.scpt"), "-e", 'display dialog "test"'],
        capture_output=True, text=True, timeout=10,
    )
    if baseline.returncode != 0:
        pytest.skip("当前沙箱无法加载 AppleScript Standard Additions，脚本编译需在系统环境验证")

    result = subprocess.run(
        ["/usr/bin/osacompile", "-o", str(tmp_path / "consent.scpt"), str(script)],
        capture_output=True, text=True, timeout=10,
    )

    assert result.returncode == 0, result.stderr
