
"""每次接管先确认，再申请并复查系统权限；失败时保持执行闸门关闭。"""

import ctypes
import logging
import math
import os
import subprocess
import sys
import threading
import time

logger = logging.getLogger(__name__)


class _MacPermissions:
    """通过系统框架检查当前进程，避免增加 Python 平台依赖。"""

    def __init__(self):
        self.ax = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
        self.cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        self.cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        self.ax.AXIsProcessTrusted.argtypes = []
        self.ax.AXIsProcessTrusted.restype = ctypes.c_bool
        self.ax.AXIsProcessTrustedWithOptions.argtypes = [ctypes.c_void_p]
        self.ax.AXIsProcessTrustedWithOptions.restype = ctypes.c_bool
        for name in ("CGPreflightScreenCaptureAccess", "CGRequestScreenCaptureAccess"):
            function = getattr(self.cg, name)
            function.argtypes = []
            function.restype = ctypes.c_bool
        self.cf.CFDictionaryCreate.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
            ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p,
        ]
        self.cf.CFDictionaryCreate.restype = ctypes.c_void_p
        self.cf.CFRelease.argtypes = [ctypes.c_void_p]
        self.cf.CFRelease.restype = None

    def status(self) -> tuple[bool, bool]:
        return bool(self.ax.AXIsProcessTrusted()), bool(self.cg.CGPreflightScreenCaptureAccess())

    def request(self, *, accessibility: bool, screen_capture: bool) -> None:
        if accessibility:
            key = ctypes.c_void_p.in_dll(self.ax, "kAXTrustedCheckOptionPrompt").value
            value = ctypes.c_void_p.in_dll(self.cf, "kCFBooleanTrue").value
            options = self.cf.CFDictionaryCreate(
                None, (ctypes.c_void_p * 1)(key), (ctypes.c_void_p * 1)(value), 1, None, None,
            )
            if not options:
                raise MemoryError("无法构造辅助功能权限申请")
            try:
                # 提示是异步的，返回值不能当作用户已经授予权限。
                self.ax.AXIsProcessTrustedWithOptions(options)
            finally:
                self.cf.CFRelease(options)
        if screen_capture:
            self.cg.CGRequestScreenCaptureAccess()


def _confirm_takeover(timeout: float) -> None:
    """使用独立原生弹窗进程，取消与超时均不会产生允许结果。"""
    seconds = max(1, math.ceil(timeout))
    if sys.platform == "darwin":
        script = f'''try
    activate
    set reply to display dialog "Shadow 将控制鼠标、键盘并采集屏幕。是否允许本次接管？" with title "Shadow 接管授权" buttons {{"取消", "允许本次接管"}} default button "取消" cancel button "取消" giving up after {seconds}
    if gave up of reply then return "timeout"
    if button returned of reply is "允许本次接管" then return "allow"
    return "deny"
on error number -128
    return "deny"
end try'''
        command = ["/usr/bin/osascript", "-e", script]
    elif sys.platform == "win32":
        script = (
            "$dialog = New-Object -ComObject WScript.Shell; "
            f"$answer = $dialog.Popup('Shadow 将控制鼠标、键盘并采集屏幕。是否允许本次接管？', {seconds}, 'Shadow 接管授权', 292); "
            "if ($answer -eq 6) { 'allow' } elseif ($answer -eq -1) { 'timeout' } else { 'deny' }"
        )
        executable = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        command = [executable, "-NoProfile", "-NonInteractive", "-Command", script]
    else:
        raise PermissionError("当前平台尚未实现桌面接管授权弹窗")
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise TimeoutError("等待用户确认接管超时") from error
    if result.returncode != 0:
        raise PermissionError("无法显示接管授权弹窗，已拒绝执行")
    answer = result.stdout.strip()
    if answer == "timeout":
        raise TimeoutError("等待用户确认接管超时")
    if answer != "allow":
        raise PermissionError("用户未允许本次接管")


class DesktopPermissions:
    """授权只属于当前对象；每次 authorize 都重新确认，不持久保存用户同意。"""

    def __init__(self, execution_lock=None):
        self._approved = False
        self._native = None
        self._generation = 0
        self._state_lock = threading.Lock()
        self._execution_lock = execution_lock

    def _status(self) -> tuple[bool, bool]:
        if sys.platform == "darwin":
            if self._native is None:
                self._native = _MacPermissions()
            return self._native.status()
        if sys.platform == "win32":
            # Windows 无对应的 TCC 权限；不申请管理员权限，不承诺操作高权限窗口。
            return True, True
        raise PermissionError("当前平台尚未实现桌面授权检查")

    def authorize(self, timeout: float = 120) -> None:
        """确认本次接管并等待系统权限，timeout 包含弹窗和用户修改设置的时间。"""
        with self._state_lock:
            self._approved = False
            self._generation += 1
            request_id = self._generation
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("授权等待时间必须是大于零的有限数值")
        deadline = time.monotonic() + timeout
        acquired = False
        try:
            if self._execution_lock is not None:
                acquired = self._execution_lock.acquire(timeout=timeout)
                if not acquired:
                    raise TimeoutError("等待桌面授权通道超时")
            self._finish_authorization(deadline, request_id)
        finally:
            if acquired:
                self._execution_lock.release()

    def _finish_authorization(self, deadline, request_id):
        with self._state_lock:
            if request_id != self._generation:
                raise PermissionError("本次接管申请已取消")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("等待接管确认超时")
        try:
            _confirm_takeover(remaining)
        except TimeoutError:
            logger.warning("桌面授权超时：本次接管确认尚未返回，未进入系统权限检查")
            raise
        with self._state_lock:
            if request_id != self._generation:
                raise PermissionError("本次接管申请已取消")
        if time.monotonic() >= deadline:
            raise TimeoutError("接管确认已超时，请重新授权")
        accessibility, screen_capture = self._status()
        permission_status = (accessibility, screen_capture)
        if not (accessibility and screen_capture):
            logger.warning("接管已确认，当前进程系统权限尚未生效：辅助功能=%s，屏幕录制=%s",
                           accessibility, screen_capture)
            self._native.request(accessibility=not accessibility, screen_capture=not screen_capture)
        while True:
            with self._state_lock:
                if request_id != self._generation:
                    raise PermissionError("本次接管申请已取消")
            if time.monotonic() >= deadline:
                logger.warning("等待系统权限超时：辅助功能=%s，屏幕录制=%s；请检查启动宿主权限及是否需要重启",
                               *permission_status)
                raise TimeoutError("系统权限尚未生效，请完成辅助功能及屏幕录制授权后重新接管")
            permission_status = self._status()
            if all(permission_status):
                if time.monotonic() >= deadline:
                    raise TimeoutError("系统授权已超时，请重新接管")
                with self._state_lock:
                    if request_id != self._generation:
                        raise PermissionError("本次接管申请已取消")
                    self._approved = True
                return
            time.sleep(min(0.25, max(deadline - time.monotonic(), 0)))

    def ensure_authorized(self) -> None:
        """每个执行边界复查权限；一旦失效，恢复系统设置也不能复用旧确认。"""
        with self._state_lock:
            if not self._approved:
                raise PermissionError("请先确认并完成本次桌面接管授权")
            request_id = self._generation
        try:
            if not all(self._status()):
                raise PermissionError("桌面权限已失效，请重新授权接管")
            with self._state_lock:
                if not self._approved or request_id != self._generation:
                    raise PermissionError("本次接管已撤销，不能继续操作")
        except BaseException:
            self.revoke()
            raise

    def revoke(self) -> None:
        """结束本次接管；后续输入必须重新确认。"""
        with self._state_lock:
            self._approved = False
            self._generation += 1
