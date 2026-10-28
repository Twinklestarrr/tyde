"""同步 OS 键鼠执行与区域截图；系统调用按进程串行并检查合作式超时。"""

from contextlib import contextmanager
from functools import wraps
import logging
import math
import sys
import threading
import time

from PIL import Image, ImageChops

from core.executor.permissions import DesktopPermissions

_OS_LOCK = threading.Lock()
logger = logging.getLogger(__name__)


def _revoke_on_error(method):
    """参数校验和图像比较异常也必须结束本次接管。"""
    @wraps(method)
    def execute(self, *args, **kwargs):
        try:
            return method(self, *args, **kwargs)
        except BaseException:
            self.revoke()
            raise
    return execute


def _nonnegative(value: float, name: str) -> float:
    if (
        isinstance(value, bool) or not isinstance(value, (int, float))
        or not math.isfinite(value) or value < 0
    ):
        raise ValueError(f"{name} 必须是非负有限数值")
    return float(value)


def _type_character(keyboard, character: str) -> None:
    if sys.platform != "darwin" or character in "\n\r\t":
        keyboard.type(character)
        return

    import Quartz

    # 普通字符明确携带 Unicode，避免物理字母键被中文输入法组合成候选词。
    # Quartz 接收 UTF-16 单元数量，非基本平面字符不能直接用 len(character)。
    length = len(character.encode("utf-16-le")) // 2
    for pressed in (True, False):
        event = Quartz.CGEventCreateKeyboardEvent(None, 0, pressed)
        if event is None:
            raise OSError("无法创建系统键盘事件")
        Quartz.CGEventSetFlags(event, 0)
        Quartz.CGEventKeyboardSetUnicodeString(event, length, character)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)


def _browser_windows(pid):
    """读取指定进程可见的普通窗口，保留系统从前到后的顺序。"""
    import Quartz

    windows = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    return [window for window in windows or []
            if window.get("kCGWindowOwnerPID") == pid and window.get("kCGWindowLayer") == 0]


def _application_is_frontmost(pid):
    """直接确认目标应用前台状态；网页跳转时全局 AXFocusedApplication 可能无值。"""
    import ApplicationServices as ax

    error, frontmost = ax.AXUIElementCopyAttributeValue(
        ax.AXUIElementCreateApplication(pid), ax.kAXFrontmostAttribute, None)
    if error or type(frontmost) is not bool:
        logger.error("前台应用读取失败：阶段=application_frontmost pid=%s code=%s", pid, error)
        raise PermissionError("无法读取前台应用，本次接管已停止")
    return frontmost


def _focused_window_matches(pid, bounds):
    """Chrome 弹层也可能是零层窗口，用辅助功能确认实际获得焦点的主窗口。"""
    import ApplicationServices as ax

    error, window = ax.AXUIElementCopyAttributeValue(
        ax.AXUIElementCreateApplication(pid), ax.kAXFocusedWindowAttribute, None)
    if error or window is None:
        return False
    return _ax_window_matches(window, bounds)


def _ax_window_matches(window, bounds):
    import ApplicationServices as ax

    for attribute, kind, keys in (
        (ax.kAXPositionAttribute, ax.kAXValueCGPointType, ("X", "Y")),
        (ax.kAXSizeAttribute, ax.kAXValueCGSizeType, ("Width", "Height")),
    ):
        error, value = ax.AXUIElementCopyAttributeValue(window, attribute, None)
        if error or value is None:
            return False
        valid, values = ax.AXValueGetValue(value, kind, None)
        if not valid or any(not math.isfinite(number) or abs(number - bounds.get(key, math.inf)) > 1
                            for key, number in zip(keys, values)):
            return False
    return True


def _browser_window_for_bounds(pid, bounds):
    """只读取由唯一几何匹配确认的原窗口，不猜测标题或窗口顺序。"""
    import ApplicationServices as ax

    error, windows = ax.AXUIElementCopyAttributeValue(
        ax.AXUIElementCreateApplication(pid), ax.kAXWindowsAttribute, None)
    matches = [] if error else [window for window in windows or [] if _ax_window_matches(window, bounds)]
    if len(matches) != 1:
        raise PermissionError("无法唯一确认目标 Chrome 前台窗口，本次接管已停止")
    return matches[0]


class OSLayer:
    """仅操控主屏；调用前由上层确保目标窗口处于前台并具有输入焦点。"""

    def __init__(self, timeout: float = 10):
        self.timeout = _nonnegative(timeout, "timeout")
        if self.timeout == 0:
            raise ValueError("timeout 必须大于零")
        self._permissions = DesktopPermissions(execution_lock=_OS_LOCK)
        self._target_pid = None
        self._target_window_id = None

    def authorize(self, timeout: float = 120) -> None:
        """每次开始接管显式调用；授权等待时间与单次 OS 操作超时分开。"""
        self._target_pid = None
        self._target_window_id = None
        self._permissions.authorize(timeout=timeout)

    def revoke(self) -> None:
        """结束或取消接管；正在执行的点流在下一个检查边界停止。"""
        self._permissions.revoke()
        self._target_pid = None
        self._target_window_id = None

    def _check(self, deadline, backend):
        backend.failSafeCheck()
        self._permissions.ensure_authorized()
        if self._target_pid is not None:
            if not _application_is_frontmost(self._target_pid):
                raise PermissionError("浏览器已失去前台焦点，本次接管已停止")
            if self._target_window_id is not None:
                windows = _browser_windows(self._target_pid)
                target = next((window for window in windows
                               if window.get("kCGWindowNumber") == self._target_window_id), None)
                foreground = target is not None and windows[0].get("kCGWindowNumber") == self._target_window_id
                if target is not None and not foreground:
                    bounds = target["kCGWindowBounds"]
                    matches = sum(all(abs(window.get("kCGWindowBounds", {}).get(key, math.inf)
                                          - bounds.get(key, -math.inf)) <= 1
                                      for key in ("X", "Y", "Width", "Height")) for window in windows)
                    foreground = matches == 1 and _focused_window_matches(self._target_pid, bounds)
                if not foreground:
                    logger.error("Chrome 窗口前台校验失败：pid=%s expected_id=%s visible=%s",
                        self._target_pid, self._target_window_id,
                        [{"id":window.get("kCGWindowNumber"), "bounds":window.get("kCGWindowBounds")}
                         for window in windows])
                    raise PermissionError("目标浏览器窗口已失去前台焦点，本次接管已停止")
        if time.monotonic() >= deadline:
            raise TimeoutError("OS 操作超时，已停止后续动作")

    @contextmanager
    def _operation(self):
        self._permissions.ensure_authorized()
        deadline = time.monotonic() + self.timeout
        if not _OS_LOCK.acquire(timeout=self.timeout):
            self.revoke()
            raise TimeoutError("等待 OS 执行通道超时")
        try:
            # 延迟导入，普通模块导入与 API 启动不会初始化桌面输入后端。
            import pyautogui

            pyautogui.FAILSAFE = True
            self._check(deadline, pyautogui)
            yield pyautogui, deadline
            self._check(deadline, pyautogui)
        except BaseException:
            self.revoke()
            raise
        finally:
            _OS_LOCK.release()

    def _wait(self, seconds, deadline, backend):
        end = time.monotonic() + seconds
        while True:
            self._check(deadline, backend)
            remaining = end - time.monotonic()
            if remaining <= 0:
                return
            # 长等待期间仍响应鼠标角落紧急停止，不把超时留到下一次点击之后。
            time.sleep(min(remaining, max(deadline - time.monotonic(), 0), 0.05))

    @_revoke_on_error
    def get_cursor_position(self) -> tuple[int, int]:
        """读取主屏光标位置，供轨迹起点使用。"""
        with self._operation() as (backend, deadline):
            return tuple(backend.position())

    @_revoke_on_error
    def get_screen_size(self) -> tuple[int, int]:
        """读取主屏 OS 尺寸，用于裁剪操作前后的同一区域。"""
        with self._operation() as (backend, deadline):
            return tuple(backend.size())

    @_revoke_on_error
    def move_to(self, x: int, y: int) -> None:
        """仅移动鼠标，滚动定位时不额外触发点击。"""
        x, y = _nonnegative(x, "x"), _nonnegative(y, "y")
        with self._operation() as (backend, deadline):
            width, height = backend.size()
            if x >= width or y >= height:
                raise ValueError("鼠标目标必须位于主屏范围内")
            self._check(deadline, backend)
            backend.moveTo(x, y, _pause=False)

    @_revoke_on_error
    def press_keys(self, keys: tuple[str, ...]) -> None:
        """发送单键或组合键；撤销与异常后仍释放已经按下的键。"""
        modifiers = {"ctrl", "cmd", "alt", "shift"}
        named = modifiers | {"enter", "tab", "esc", "backspace", "delete", "left", "right",
                             "up", "down", "home", "end", "page_up", "page_down", "space"}
        if not isinstance(keys, (tuple, list)) or not 1 <= len(keys) <= 4:
            raise ValueError("按键必须是一到四个键组成的序列")
        if any(not isinstance(key, str) or not (key in named or key in {"[", "]"}
               or len(key) == 1 and key.isascii() and key.isalnum()) for key in keys):
            raise ValueError("不支持的按键")
        if any(key not in modifiers for key in keys[:-1]) or keys[-1] in modifiers:
            raise ValueError("组合键必须以普通键结束")
        with self._operation() as (backend, deadline):
            from pynput.keyboard import Controller, Key

            keyboard = Controller()
            held = []
            try:
                for key in keys:
                    self._check(deadline, backend)
                    resolved = getattr(Key, key) if key in named else key
                    held.append(resolved)
                    keyboard.press(resolved)
            finally:
                # 松键属于必要清理；不能因撤销而把修饰键留在按下状态。
                for key in reversed(held):
                    keyboard.release(key)

    @_revoke_on_error
    def focus_window(self, pid: int, window_info: dict | None = None, *, restore: bool = False) -> None:
        """激活 Chrome，并按页面外框绑定唯一前台窗口；Windows 尚待验收。"""
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
            raise ValueError("浏览器进程号必须是正整数")
        with self._operation() as (backend, deadline):
            if restore and self._target_pid is not None:
                raise PermissionError("本次接管已撤销，不能继续操作")
            if sys.platform != "darwin":
                raise NotImplementedError("当前前台窗口管理仅在 macOS 实现")
            import ApplicationServices as ax

            self._check(deadline, backend)
            frontmost = _application_is_frontmost(pid)
            if not frontmost:
                self._check(deadline, backend)
                # 本次接管已获辅助功能授权，只向目标进程请求前台，不使用失效的强制激活标志。
                error = ax.AXUIElementSetAttributeValue(
                    ax.AXUIElementCreateApplication(pid), ax.kAXFrontmostAttribute, True)
                if error:
                    logger.error("Chrome 前台激活请求失败：pid=%s frontmost=%s code=%s", pid, frontmost, error)
                    raise PermissionError("Chrome 前台激活请求失败，本次接管已停止")
                try:
                    while not frontmost:
                        self._wait(0.05, deadline, backend)
                        frontmost = _application_is_frontmost(pid)
                    self._check(deadline, backend)
                except TimeoutError:
                    logger.error("Chrome 前台激活等待超时：pid=%s frontmost=%s code=0", pid, frontmost)
                    raise TimeoutError("Chrome 未在限定时间内置于前台，本次接管已停止") from None
            self._target_pid = pid
            if window_info is not None:
                windows = _browser_windows(pid)
                expected = {key:_nonnegative(window_info[name],name) if key in {"Width","Height"}
                            else float(window_info[name]) for key,name in (
                    ("X","window_x"),("Y","window_y"),("Width","window_width"),("Height","window_height"))}
                matches = [window for window in windows if all(
                    math.isfinite(value) and abs(window.get("kCGWindowBounds",{}).get(key,math.inf)-value) <= 1
                    for key,value in expected.items())]
                if (restore and len(matches) == 1
                        and windows[0].get("kCGWindowNumber") != matches[0].get("kCGWindowNumber")
                        and not _focused_window_matches(pid, expected)):
                    self._check(deadline, backend)
                    window = _browser_window_for_bounds(pid, expected)
                    self._check(deadline, backend)
                    if ax.AXUIElementPerformAction(window, ax.kAXRaiseAction):
                        raise PermissionError("无法唯一确认目标 Chrome 前台窗口，本次接管已停止")
                    while (not windows or windows[0].get("kCGWindowNumber") != matches[0].get("kCGWindowNumber")):
                        if _focused_window_matches(pid, expected):
                            break
                        self._wait(0.05, deadline, backend)
                        windows = _browser_windows(pid)
                if len(matches) != 1 or (windows[0].get("kCGWindowNumber") != matches[0].get("kCGWindowNumber")
                                         and not _focused_window_matches(pid, expected)):
                    # 只记录数字几何和窗口编号，不记录系统窗口标题或页面内容。
                    logger.error("Chrome 窗口匹配失败：pid=%s expected=%s visible=%s matches=%s", pid, expected,
                        [{"id":window.get("kCGWindowNumber"), "bounds":window.get("kCGWindowBounds")}
                         for window in windows], len(matches))
                    raise PermissionError("无法唯一确认目标 Chrome 前台窗口，本次接管已停止")
                self._target_window_id = matches[0]["kCGWindowNumber"]

    @_revoke_on_error
    def move_and_click(
        self, points: list[tuple[float, float, int]], button: str = "left"
    ) -> None:
        """按点流移动，到达各点后等待 delay_ms，最后点击一次。"""
        if not points or button not in {"left", "middle", "right"}:
            raise ValueError("点流不能为空，鼠标按键必须是 left、middle 或 right")
        validated = []
        for x, y, delay_ms in points:
            x = _nonnegative(x, "x")
            y = _nonnegative(y, "y")
            delay = _nonnegative(delay_ms, "delay_ms") / 1000
            validated.append((x, y, delay))
        with self._operation() as (backend, deadline):
            width, height = backend.size()
            if any(x >= width or y >= height for x, y, _ in validated):
                raise ValueError("轨迹点必须位于主屏范围内")
            for x, y, delay in validated:
                self._check(deadline, backend)
                # 由点流控制等待，避免 PyAutoGUI 的全局 PAUSE 和短 duration 截断影响时序。
                backend.moveTo(x, y, _pause=False)
                self._wait(delay, deadline, backend)
            self._check(deadline, backend)
            backend.click(button=button, _pause=False)

    @_revoke_on_error
    def type_text(self, text: str, interval_ms: int = 50) -> None:
        """通过系统键盘输入 Unicode；不使用剪贴板，不记录输入内容。"""
        if not isinstance(text, str):
            raise ValueError("输入内容必须是字符串")
        interval = _nonnegative(interval_ms, "interval_ms") / 1000
        if not text:
            return
        with self._operation() as (backend, deadline):
            from pynput.keyboard import Controller

            keyboard = Controller()
            for index, character in enumerate(text):
                self._check(deadline, backend)
                _type_character(keyboard, character)
                if index + 1 < len(text):
                    self._wait(interval, deadline, backend)

    @_revoke_on_error
    def scroll(self, delta: int) -> None:
        """滚轮单位沿用 PyAutoGUI：正数向上，负数向下，不能当作像素。"""
        if isinstance(delta, bool) or not isinstance(delta, int):
            raise ValueError("滚轮增量必须是整数")
        if delta == 0:
            return
        with self._operation() as (backend, deadline):
            backend.scroll(delta, _pause=False)

    @_revoke_on_error
    def capture_region(self, region: tuple[int, int, int, int]) -> Image.Image:
        """采集主屏区域为 RGB 图像；region 为 OS 坐标，调用方负责关闭图像。"""
        if len(region) != 4 or any(isinstance(value, bool) or not isinstance(value, int) for value in region):
            raise ValueError("截图区域必须是四个整数：left、top、width、height")
        left, top, width, height = region
        if left < 0 or top < 0 or width <= 0 or height <= 0:
            raise ValueError("截图起点不能为负数，宽高必须大于零")
        with self._operation() as (backend, deadline):
            screen_width, screen_height = backend.size()
            if left + width > screen_width or top + height > screen_height:
                raise ValueError("截图区域必须完整位于主屏范围内")
            import mss

            with mss.mss() as capture:
                self._check(deadline, backend)
                screenshot = capture.grab({"left": left, "top": top, "width": width, "height": height})
                return Image.frombytes("RGB", screenshot.size, screenshot.rgb)

    @_revoke_on_error
    def screenshot_verify(
        self, region: tuple[int, int, int, int], before: Image.Image,
        *, min_changed_ratio: float = 0.01, pixel_threshold: int = 10,
    ) -> bool:
        """判断区域亮度变化占比；仅说明画面变化，不代表业务操作成功。"""
        ratio = _nonnegative(min_changed_ratio, "min_changed_ratio")
        if not 0 < ratio <= 1:
            raise ValueError("变化占比阈值必须大于零且不超过一")
        if isinstance(pixel_threshold, bool) or not isinstance(pixel_threshold, int) or not 0 <= pixel_threshold <= 255:
            raise ValueError("像素亮度阈值必须是 0 到 255 的整数")
        with self.capture_region(region) as after, before.convert("RGB") as reference:
            if reference.size != after.size:
                raise ValueError("前后截图尺寸不一致，必须重新采集基准图")
            with ImageChops.difference(reference, after) as difference:
                with difference.convert("L") as luminance:
                    histogram = luminance.histogram()
            changed = sum(histogram[pixel_threshold + 1:])
            return changed / (after.width * after.height) >= ratio
