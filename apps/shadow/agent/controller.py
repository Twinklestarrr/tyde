"""以同名动作替换原生页面交互；CDP 只读取，真实输入统一进入 OSLayer。"""

import asyncio
from contextlib import suppress
import json
import logging
import math
import sys
import time
from urllib.parse import urlsplit
from uuid import uuid4

from browser_use.agent.views import ActionResult
from browser_use.tools.service import Tools

from auth.audit import AuditError
from config.settings import Settings, settings
from core.executor import coordinate
from core.executor.os_executor import OSLayer
from core.orchestrator.takeover import RequestTakeoverAction, TakeoverManager
from core.trajectory.generator import HumanTrajectory


logger = logging.getLogger(__name__)
# 只保留我方固定诊断文案，第三方异常可能包含键入内容，不能直接记录。
_SAFE_OS_ERRORS = {
    "请先确认并完成本次桌面接管授权",
    "桌面权限已失效，请重新授权接管",
    "本次接管已撤销，不能继续操作",
    "浏览器已失去前台焦点，本次接管已停止",
    "目标浏览器窗口已失去前台焦点，本次接管已停止",
    "无法唯一确认目标 Chrome 前台窗口，本次接管已停止",
    "无法读取前台应用，本次接管已停止",
    "Chrome 前台激活请求失败，本次接管已停止",
    "Chrome 未在限定时间内置于前台，本次接管已停止",
}


# 固定脚本只读取 DOM；逐级累加同源 iframe 偏移，不猜测跨域或变换后的几何。
ELEMENT_SNAPSHOT = """function() {
    if (!this.isConnected || !this.checkVisibility({checkOpacity:true, checkVisibilityCSS:true}))
        throw new Error('元素不可见或已脱离页面');
    const rect = this.getBoundingClientRect();
    let x = rect.x, y = rect.y, view = this.ownerDocument.defaultView;
    let hit = this.ownerDocument.elementFromPoint(x + rect.width/2, y + rect.height/2);
    while (hit && hit.shadowRoot) {
        const next = hit.shadowRoot.elementFromPoint(x + rect.width/2, y + rect.height/2);
        if (!next || next === hit) break;
        hit = next;
    }
    if (!hit || (hit !== this && !this.contains(hit))) throw new Error('元素中心被遮挡或不在视口内');
    while (view !== view.top) {
        const frame = view.frameElement;
        if (!frame) throw new Error('暂不支持跨域 iframe 的坐标归一化');
        const parent = view.parent, box = frame.getBoundingClientRect();
        for (let element=frame; element; element=element.parentElement || element.getRootNode().host) {
            const style = parent.getComputedStyle(element);
            if (style.transform !== 'none' || !['1','normal'].includes(style.zoom) ||
                style.scale !== 'none' || style.rotate !== 'none' || style.translate !== 'none')
                throw new Error('暂不支持框架及其祖先带变换或缩放的 iframe');
        }
        x += box.x + frame.clientLeft;
        y += box.y + frame.clientTop;
        if (parent.document.elementFromPoint(x + rect.width/2, y + rect.height/2) !== frame)
            throw new Error('iframe 中心被遮挡');
        view = parent;
    }
    const editable = !this.disabled && !this.readOnly &&
        (this.tagName === 'TEXTAREA' || this.isContentEditable ||
         (this.tagName === 'INPUT' && ['text','search','email','url','tel','password','number'].includes(this.type)));
    return {x, y, width:rect.width, height:rect.height, editable,
        focused:this.ownerDocument.hasFocus() && this.getRootNode().activeElement === this,
        value:this.type === 'password' ? null : (this.value ?? this.innerText),
        scroll_top:this.scrollTop, scroll_height:this.scrollHeight, client_height:this.clientHeight};
}"""

PAGE_SNAPSHOT = """() => ({url:location.href, visible:document.visibilityState === 'visible', focused:document.hasFocus(), ready:document.readyState})"""

SCROLL_SNAPSHOT = """() => {
    const root = document.scrollingElement;
    for (const [x,y] of [[innerWidth-12,innerHeight/2],[12,innerHeight/2],[innerWidth/2,12]]) {
        let hit = document.elementFromPoint(x,y), nested = false;
        if (!hit) continue;
        for (let element=hit; element && element!==root; element=element.parentElement) {
            if (['auto','scroll'].includes(getComputedStyle(element).overflowY) &&
                element.scrollHeight > element.clientHeight) { nested=true; break; }
        }
        if (!nested) return {x:x-0.5,y:y-0.5,width:1,height:1,scroll_top:root.scrollTop,
            scroll_height:root.scrollHeight,client_height:root.clientHeight};
    }
    throw new Error('未找到可安全滚动主页面的位置，请指定滚动容器索引');
}"""


class DesktopActionError(RuntimeError):
    """OS 已失败并撤销授权，当前任务必须结束，不能悄悄重试。"""


class OSController(Tools):
    """保留原生动作参数，页面交互、导航与标签操作统一走 OS。"""

    def __init__(self, os_executor: OSLayer | None = None, trajectory=None,
                 *, config: Settings | None = None, **kwargs):
        self.config = config if config is not None else settings
        self.os_executor = os_executor if os_executor is not None else OSLayer(self.config.OS_CHANNEL_TIMEOUT)
        self.trajectory = trajectory if trajectory is not None else HumanTrajectory()
        self._action_lock = asyncio.Lock()
        self._takeover: TakeoverManager | None = None
        self._takeover_target_id: str | None = None
        self.takeover_error: str | None = None
        if {"click", "input"}.intersection(kwargs.get("exclude_actions") or []):
            raise ValueError("click/input 必须同名覆盖，不能排除")
        super().__init__(**kwargs)
        for name, handler in (("input", self._input), ("scroll", self._scroll), ("send_keys", self._send_keys),
                              ("navigate", self._navigate), ("go_back", self._go_back),
                              ("switch", self._switch), ("close", self._close)):
            self._replace(name, handler)

        @self.registry.action("请求用户处理阻碍当前任务的登录、验证码或二次验证",
                              param_model=RequestTakeoverAction, terminates_sequence=True)
        async def request_takeover(params: RequestTakeoverAction, browser_session):
            return await self._request_takeover(params, browser_session)

        supported = {"done", "navigate", "go_back", "switch", "close", "wait", "extract",
                     "click", "input", "scroll", "send_keys", "request_takeover"}
        for name in list(self.registry.registry.actions):
            if name not in supported:
                self.exclude_action(name)

    def _register_click_action(self):
        # Agent 初始化及模式切换都会重注册 click；每次都立即覆盖回 OS 实现。
        super()._register_click_action()
        if "click" in self.registry.registry.actions:
            self._replace("click", self._click)

    def _replace(self, name, handler):
        original = self.registry.registry.actions.pop(name)

        async def action(params, browser_session):
            async with self._action_lock:
                try:
                    return await handler(params, browser_session)
                except (DesktopActionError, PermissionError, TimeoutError) as error:
                    self.revoke()
                    return ActionResult(error=str(error), is_done=True, success=False)
                except asyncio.CancelledError:
                    self.revoke()
                    raise
                except Exception as error:
                    return ActionResult(error=str(error))

        action.__name__ = name
        self.registry.action(original.description, param_model=original.param_model,
                             domains=original.domains, terminates_sequence=original.terminates_sequence)(action)

    async def _run_os(self, function, *args, **kwargs):
        worker = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
        try:
            return await asyncio.shield(worker)
        except BaseException as error:
            self.revoke()
            await asyncio.gather(worker, return_exceptions=True)
            if isinstance(error, asyncio.CancelledError):
                raise
            operation = getattr(function, "__name__", "unknown")
            reason = str(error) if str(error) in _SAFE_OS_ERRORS else type(error).__name__
            logger.error("OS 操作失败：阶段=%s；异常=%s；原因=%s", operation, type(error).__name__, reason)
            raise DesktopActionError(f"桌面操作失败（{operation}：{reason}），本次接管已结束") from error

    async def authorize(self, timeout=120):
        audit = self._takeover.audit if self._takeover is not None else None
        if audit is not None:
            await audit.record("authorization_start")
        try:
            try:
                await self._run_os(self.os_executor.authorize, timeout=timeout)
            except DesktopActionError as error:
                # 授权拒绝和超时保留可重试的类型，其他 OS 错误仍按执行故障处理。
                if isinstance(error.__cause__, (PermissionError, TimeoutError)):
                    raise type(error.__cause__)("桌面授权未完成") from error
                raise
        except BaseException as error:
            if audit is not None:
                code = ("authorization_denied" if isinstance(error, PermissionError) else
                        "authorization_timeout" if isinstance(error, TimeoutError) else "authorization_failed")
                with suppress(AuditError):
                    await audit.record("authorization_end",
                        outcome="unknown" if isinstance(error, asyncio.CancelledError) else "failed", error_code=code)
            raise
        if audit is not None:
            await audit.record("authorization_end", outcome="completed")

    async def act(self, action, browser_session, *args, **kwargs):
        """统一包围全部保留工具；动作参数和工具返回正文不进入审计。"""
        audit = self._takeover.audit if self._takeover is not None else None
        if audit is None:
            self.revoke()
            raise AuditError("动作尚未绑定任务审计，不能执行")
        name = next(iter(action.model_dump(exclude_none=True)), "unknown")
        if name not in self.registry.registry.actions:
            name = "unknown"
        action_id = str(uuid4())
        await audit.record("action_start", action_id=action_id, action=name)
        try:
            result = await super().act(action, browser_session, *args, **kwargs)
            audit.raise_if_failed()
        except BaseException as error:
            with suppress(AuditError):
                await audit.record("action_end", action_id=action_id, action=name,
                    outcome="unknown" if isinstance(error, asyncio.CancelledError) else "failed",
                    error_code="action_cancelled" if isinstance(error, asyncio.CancelledError) else "action_failed")
            raise
        await audit.record("action_end", action_id=action_id, action=name,
            outcome="failed" if result.error else "completed", error_code="action_failed" if result.error else None)
        return result

    def revoke(self):
        self.os_executor.revoke()

    def bind_takeover(self, takeover: TakeoverManager) -> None:
        if self._takeover is not None:
            raise RuntimeError("控制器已绑定其他任务，不能共享桌面动作入口")
        self._takeover = takeover
        self.takeover_error = None

    def unbind_takeover(self, takeover: TakeoverManager) -> None:
        if self._takeover is takeover:
            self._takeover = None

    async def _request_takeover(self, params, browser_session):
        async with self._action_lock:
            try:
                if self._takeover is None:
                    raise RuntimeError("人工接管未绑定运行任务")
                target_id = browser_session.agent_focus_target_id
                await self._takeover.request(browser_session.event_bus, params.reason)
                self._takeover_target_id = target_id
            except asyncio.CancelledError:
                self.takeover_error = "人工接管请求被中断，本次任务已停止"
                self.revoke()
                raise
            except Exception:
                self.takeover_error = "人工接管请求处理失败，本次任务已停止"
                self.revoke()
                return ActionResult(error=self.takeover_error, is_done=True, success=False)
            return ActionResult(extracted_content=self._takeover.snapshot.message,
                                long_term_memory="已请求人工处理，等待宿主发送后续指令")

    async def restore_task_page(self, session):
        """重新授权后，通过 OS 激活原窗口和标签；不产生页面点击或业务输入。"""
        async with self._action_lock, asyncio.timeout(self.config.PAGE_LOAD_TIMEOUT):
            pages = await session.get_pages()
            target = next((page for page in pages if page._target_id == self._takeover_target_id), None)
            if target is None:
                raise ValueError("原任务标签页已关闭，无法恢复")
            self._navigation_url(json.loads(await target.evaluate(PAGE_SNAPSHOT))["url"])
            window_id = await self._window_id(session, target)
            processes = await session.cdp_client.send.SystemInfo.getProcessInfo()
            pid = next(item["id"] for item in processes["processInfo"] if item["type"] == "browser")
            await self._run_os(self.os_executor.focus_window, int(pid),
                               await coordinate.get_window_info(target), restore=True)
            await self._switch_page(session, target, window_id, pages)
            await self._prepare(session)

    async def confirm_task_page(self, session):
        """重新感知后只校验原目标与前台，不能借此切到替代标签。"""
        if not self._takeover_target_id or session.agent_focus_target_id != self._takeover_target_id:
            raise ValueError("原任务标签页已变化，暂不能恢复")
        await self._prepare(session)
        if session.agent_focus_target_id != self._takeover_target_id:
            raise ValueError("原任务标签页已变化，暂不能恢复")

    async def _prepare(self, session):
        page = await session.get_current_page()
        if page is None:
            raise ValueError("浏览器没有当前页面")
        state = json.loads(await page.evaluate(PAGE_SNAPSHOT))
        if not state["visible"]:
            raise ValueError("目标标签页不可见，请先切换标签页")
        processes = await session.cdp_client.send.SystemInfo.getProcessInfo()
        pid = next(item["id"] for item in processes["processInfo"] if item["type"] == "browser")
        await self._run_os(self.os_executor.focus_window, int(pid), await coordinate.get_window_info(page))
        current = json.loads(await page.evaluate(PAGE_SNAPSHOT))
        if not current["visible"] or current["url"] != state["url"]:
            raise ValueError("页面在定位期间发生变化，需重新感知")
        return page, state["url"]

    def _navigation_url(self, url):
        url = url.strip()
        # Chrome 与 urllib 对反斜杠的解析不同，拒绝有歧义的网址。
        if not url or "\\" in url or any(ord(char) <= 32 or ord(char) == 127 for char in url):
            raise ValueError("导航网址不能为空或包含控制字符、空格或反斜杠")
        if ":" not in url:
            url = "https://" + url
        parsed = urlsplit(url)
        # 无效端口不能交给地址栏，否则 Chrome 可能把网址当搜索词。
        parsed.port
        if url != "about:blank" and (parsed.scheme not in {"http", "https"} or not parsed.hostname
                                    or parsed.username is not None or parsed.password is not None):
            raise ValueError("导航只支持无内嵌凭据的 HTTP(S) 网址和 about:blank")
        return url

    async def _window_id(self, session, page):
        result = await session.cdp_client.send.Browser.getWindowForTarget(params={"targetId":page._target_id})
        return result["windowId"]

    def _sync_focus(self, session, page):
        # 只在观察到真实 OS 切换后同步原生缓存，不派发会激活标签的 CDP 事件。
        session.agent_focus_target_id = page._target_id
        session._cached_browser_state_summary = None
        session._cached_selector_map.clear()
        session._cached_selector_indices.clear()
        if session._dom_watchdog is not None:
            session._dom_watchdog.clear_cache()

    async def _visible_page(self, session, window_id, *, ignore=None):
        visible = []
        for page in await session.get_pages():
            if page._target_id == ignore or await self._window_id(session, page) != window_id:
                continue
            if json.loads(await page.evaluate(PAGE_SNAPSHOT))["visible"]:
                visible.append(page)
        if len(visible) > 1:
            raise PermissionError("同一窗口的可见标签存在歧义，本次接管已停止")
        return visible[0] if visible else None

    async def _wait_visible_page(self, session, window_id, deadline, *, previous=None, closed=None):
        while time.monotonic() < deadline:
            if closed and any(page._target_id == closed for page in await session.get_pages()):
                await asyncio.sleep(0.03)
                continue
            page = await self._visible_page(session, window_id, ignore=closed)
            if page is not None and page._target_id != previous:
                self._sync_focus(session, page)
                return page
            await asyncio.sleep(0.03)
        raise TimeoutError("未能确认 OS 标签操作结果，本次接管已停止")

    async def _wait_navigation(self, session, page, previous_url, expected_url):
        deadline = time.monotonic() + self.config.PAGE_LOAD_TIMEOUT
        last_observed = None
        while time.monotonic() < deadline:
            await asyncio.sleep(0.05)
            try:
                state = json.loads(await page.evaluate(PAGE_SNAPSHOT))
            except RuntimeError:
                # 跨文档导航会短暂销毁旧执行上下文，只重试读取，不重发导航。
                continue
            ready = state["ready"]
            if not isinstance(ready, str) or ready not in {"loading", "interactive", "complete"}:
                ready = "unknown"
            last_observed = {"url_changed": state["url"] != previous_url,
                             "matches_requested": state["url"].rstrip("/") == expected_url.rstrip("/"),
                             "ready": ready, "visible": state["visible"] is True}
            if not state["visible"]:
                raise PermissionError("导航期间目标标签页失去可见性，本次接管已停止")
            if (state["url"] != previous_url or state["url"].rstrip("/") == expected_url.rstrip("/")) and ready in {"interactive", "complete"}:
                self._navigation_url(state["url"])
                self._sync_focus(session, page)
                return ActionResult(extracted_content="已通过 OS 完成导航，请根据新页面状态继续任务")
        logger.warning("导航等待超时：timeout=%s last_state=%s", self.config.PAGE_LOAD_TIMEOUT, last_observed)
        raise TimeoutError("OS 导航后未观察到目标页面，本次接管已停止")

    async def _navigate(self, params, session):
        url = self._navigation_url(params.url)
        page, previous_url = await self._prepare(session)
        modifier = "cmd" if sys.platform == "darwin" else "ctrl"
        if params.new_tab:
            window_id = await self._window_id(session, page)
            await self._run_os(self.os_executor.press_keys, (modifier, "t"))
            page = await self._wait_visible_page(session, window_id,
                time.monotonic() + self.config.OS_CHANNEL_TIMEOUT, previous=page._target_id)
            previous_url = json.loads(await page.evaluate(PAGE_SNAPSHOT))["url"]
        await self._run_os(self.os_executor.press_keys, (modifier, "l"))
        # OS 快捷键返回时 Chrome 可能尚未处理焦点事件，只等待观测，不重发按键。
        deadline = time.monotonic() + self.config.OS_CHANNEL_TIMEOUT
        while True:
            state = json.loads(await page.evaluate(PAGE_SNAPSHOT))
            if not state["visible"] or state["url"] != previous_url:
                raise PermissionError("地址栏定位期间页面已变化，本次接管已停止")
            if not state["focused"]:
                break
            if time.monotonic() >= deadline:
                raise PermissionError("地址栏未获得焦点，本次接管已停止")
            await asyncio.sleep(0.03)
        await self._run_os(self.os_executor.type_text, url, interval_ms=0)
        state = json.loads(await page.evaluate(PAGE_SNAPSHOT))
        if not state["visible"] or state["focused"]:
            raise PermissionError("地址栏输入期间焦点已变化，本次接管已停止")
        await self._run_os(self.os_executor.press_keys, ("enter",))
        return await self._wait_navigation(session, page, previous_url, url)

    async def _go_back(self, params, session):
        page = await session.get_current_page()
        cdp = await session.get_or_create_cdp_session(target_id=page._target_id, focus=False)
        history = await cdp.cdp_client.send.Page.getNavigationHistory(session_id=cdp.session_id)
        if history["currentIndex"] <= 0:
            return ActionResult(extracted_content="当前标签页没有可后退的历史")
        url = self._navigation_url(history["entries"][history["currentIndex"] - 1]["url"])
        page, previous_url = await self._prepare(session)
        keys = ("cmd", "[") if sys.platform == "darwin" else ("alt", "left")
        await self._run_os(self.os_executor.press_keys, keys)
        return await self._wait_navigation(session, page, previous_url, url)

    async def _tab_target(self, session, tab_id):
        target_id = await session.get_target_id_from_tab_id(tab_id)
        pages = await session.get_pages()
        target = next((page for page in pages if page._target_id == target_id), None)
        current = await session.get_current_page()
        if target is None or current is None:
            raise ValueError("标签页已关闭，请重新感知")
        window_id = await self._window_id(session, current)
        if await self._window_id(session, target) != window_id:
            raise ValueError("暂不支持跨 Chrome 窗口切换标签")
        self._navigation_url(json.loads(await target.evaluate(PAGE_SNAPSHOT))["url"])
        return target, window_id, pages

    async def _switch_page(self, session, target, window_id, pages):
        # 人工处理可能已切换标签；先读取真实可见页，再由 _prepare 校验 OS 窗口。
        current = await self._visible_page(session, window_id)
        if current is None:
            raise PermissionError("目标窗口没有可见标签，本次接管已停止")
        self._sync_focus(session, current)
        await self._prepare(session)
        deadline = time.monotonic() + self.config.OS_CHANNEL_TIMEOUT
        for _ in pages:
            current = await self._visible_page(session, window_id)
            if current is None:
                raise PermissionError("目标窗口没有可见标签，本次接管已停止")
            if current._target_id == target._target_id:
                self._sync_focus(session, current)
                return current
            await self._run_os(self.os_executor.press_keys, ("ctrl", "tab"))
            await self._wait_visible_page(session, window_id, deadline, previous=current._target_id)
        raise ValueError("未找到目标标签，请重新感知")

    async def _switch(self, params, session):
        target, window_id, pages = await self._tab_target(session, params.tab_id)
        await self._switch_page(session, target, window_id, pages)
        return ActionResult(extracted_content="已通过 OS 切换到目标标签")

    async def _close(self, params, session):
        target, window_id, pages = await self._tab_target(session, params.tab_id)
        remaining = [page for page in pages if page._target_id != target._target_id
                     and await self._window_id(session, page) == window_id]
        if not remaining:
            raise ValueError("不能关闭窗口中的最后一个标签，请结束任务以清理浏览器")
        await self._switch_page(session, target, window_id, pages)
        # 避免原生目标分离回调把主动关闭误当崩溃，再用 CDP 恢复或创建标签。
        session.agent_focus_target_id = remaining[0]._target_id
        modifier = "cmd" if sys.platform == "darwin" else "ctrl"
        await self._run_os(self.os_executor.press_keys, (modifier, "w"))
        await self._wait_visible_page(session, window_id, time.monotonic() + self.config.OS_CHANNEL_TIMEOUT,
                                      closed=target._target_id)
        return ActionResult(extracted_content="已通过 OS 关闭目标标签")

    async def _element(self, session, index):
        node = await session.get_element_by_index(index)
        if node is None:
            raise ValueError("元素索引已失效，需重新感知页面")
        cdp = await session.cdp_client_for_node(node)
        result = await cdp.cdp_client.send.DOM.resolveNode(
            params={"backendNodeId":node.backend_node_id}, session_id=cdp.session_id)
        object_id = result.get("object", {}).get("objectId")
        if not object_id:
            raise ValueError("元素已脱离页面")
        try:
            result = await cdp.cdp_client.send.Runtime.callFunctionOn(params={
                "objectId":object_id,"functionDeclaration":ELEMENT_SNAPSHOT,"returnByValue":True,
            }, session_id=cdp.session_id)
            if result.get("exceptionDetails"):
                raise ValueError("元素不可见、被遮挡或框架几何不受支持，需重新感知")
            return result["result"]["value"]
        finally:
            with suppress(Exception):
                await cdp.cdp_client.send.Runtime.releaseObject(params={"objectId":object_id}, session_id=cdp.session_id)

    async def _click_at(self, page, box):
        target = coordinate.page_to_screen(box, await coordinate.get_window_info(page))
        start = await self._run_os(self.os_executor.get_cursor_position)
        before = None
        if self.config.VERIFY_SCREENSHOT:
            width, height = await self._run_os(self.os_executor.get_screen_size)
            if not 0 <= target[0] < width or not 0 <= target[1] < height:
                raise ValueError("点击位置必须位于主屏范围内")
            left, top = max(0,target[0]-20), max(0,target[1]-20)
            region = (left, top, min(width,target[0]+20)-left, min(height,target[1]+20)-top)
            before = await self._run_os(self.os_executor.capture_region, region)
        try:
            await self._run_os(self.os_executor.move_and_click, self.trajectory.generate(start,target))
            if before is not None:
                await asyncio.sleep(0.05)
                changed = await self._run_os(self.os_executor.screenshot_verify, region, before)
                return "已点击；区域画面已变化" if changed else "已点击；区域变化不明显，须结合下一次页面状态判断"
            return "已执行 OS 点击，须结合下一次页面状态判断"
        finally:
            if before is not None:
                before.close()

    async def _click(self, params, session):
        page, _ = await self._prepare(session)
        if params.index is not None:
            box = await self._element(session, params.index)
        elif params.coordinate_x is not None and params.coordinate_y is not None:
            x, y = params.coordinate_x, params.coordinate_y
            resized = getattr(session,"llm_screenshot_size",None)
            original = getattr(session,"_original_viewport_size",None)
            if resized:
                if not original or min(*resized,*original) <= 0:
                    raise ValueError("截图缩放信息不完整，不能换算坐标")
                x, y = int(x/resized[0]*original[0]), int(y/resized[1]*original[1])
            box = {"x":x-0.5,"y":y-0.5,"width":1,"height":1}
        else:
            raise ValueError("必须提供元素索引或完整视口坐标")
        return ActionResult(extracted_content=await self._click_at(page, box))

    async def _wait_input(self, session, index, predicate, *, require_focus=False):
        deadline = time.monotonic() + self.config.OS_CHANNEL_TIMEOUT
        while True:
            state = await self._element(session, index)
            if require_focus and not state["focused"]:
                raise PermissionError("目标输入控件已失去焦点，本次接管已停止")
            if predicate(state):
                return state
            if time.monotonic() >= deadline:
                raise ValueError("输入控件未达到预期状态，请重新感知")
            await asyncio.sleep(0.03)

    async def _input(self, params, session):
        page, _ = await self._prepare(session)
        box = await self._element(session, params.index)
        if not box["editable"]:
            raise ValueError("目标元素不是可编辑输入控件")
        await self._click_at(page, box)
        await self._wait_input(session, params.index, lambda state: state["focused"])
        modifier = "cmd" if sys.platform == "darwin" else "ctrl"
        if params.clear:
            await self._run_os(self.os_executor.press_keys, (modifier,"a"))
            await self._wait_input(session, params.index, lambda state: True, require_focus=True)
            await self._run_os(self.os_executor.press_keys, ("backspace",))
            await self._wait_input(session, params.index, lambda state: state["value"] in (None,""), require_focus=True)
        else:
            await self._run_os(self.os_executor.press_keys, (modifier,"down" if sys.platform == "darwin" else "end"))
        await self._wait_input(session, params.index, lambda state: True, require_focus=True)
        await self._run_os(self.os_executor.type_text, params.text)
        expected = params.text if params.clear else (box["value"] or "") + params.text
        await self._wait_input(session, params.index,
            lambda state: state["value"] is None or state["value"] == expected, require_focus=True)
        return ActionResult(extracted_content="已通过 OS 完成输入")

    async def _scroll(self, params, session):
        if not math.isfinite(params.pages) or params.pages <= 0:
            raise ValueError("滚动页数必须大于零")
        page, url = await self._prepare(session)

        async def measure():
            return await self._element(session, params.index) if params.index is not None else json.loads(await page.evaluate(SCROLL_SNAPSHOT))

        initial = await measure()
        if initial["client_height"] <= 0:
            raise ValueError("滚动容器尺寸无效")
        target = params.pages * initial["client_height"]
        position = coordinate.page_to_screen(initial, await coordinate.get_window_info(page))
        await self._run_os(self.os_executor.move_to, *position)
        deadline, previous, idle = time.monotonic()+self.config.OS_CHANNEL_TIMEOUT, initial["scroll_top"], 0
        while abs(previous-initial["scroll_top"]) < target:
            state = json.loads(await page.evaluate(PAGE_SNAPSHOT))
            if not state["visible"] or state["url"] != url:
                raise ValueError("滚动期间页面发生变化")
            if time.monotonic() >= deadline:
                raise TimeoutError("OS 滚动未在预期时间内完成")
            await self._run_os(self.os_executor.scroll, -1 if params.down else 1)
            await asyncio.sleep(0.05)
            current = await measure()
            idle = idle+1 if current["scroll_top"] == previous else 0
            previous = current["scroll_top"]
            if idle >= 3:
                break
        return ActionResult(extracted_content=f"已通过 OS 滚动，观测距离 {abs(previous-initial['scroll_top'])} CSS 像素")

    async def _send_keys(self, params, session):
        page, _ = await self._prepare(session)
        aliases = {"control":"ctrl","meta":"cmd","command":"cmd","escape":"esc",
                   "arrowleft":"left","arrowright":"right","arrowup":"up","arrowdown":"down",
                   "pageup":"page_up","pagedown":"page_down"}
        keys = tuple(aliases.get(key.lower(),key.lower()) for key in params.keys.split("+"))
        if not json.loads(await page.evaluate(PAGE_SNAPSHOT))["focused"]:
            raise PermissionError("目标页面没有键盘焦点，本次接管已停止")
        await self._run_os(self.os_executor.press_keys, keys)
        return ActionResult(extracted_content="已通过 OS 发送按键")
