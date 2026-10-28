"""只读观察浏览器状态、弹窗和崩溃，保留原生 watchdog。"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import logging
from typing import TYPE_CHECKING

from cdp_use import CDPClient

if TYPE_CHECKING:
    from bubus import BaseEvent
    from browser_use.browser.session import BrowserSession

BrowserEventCallback = Callable[["BaseEvent"], Awaitable[None]]
logger = logging.getLogger(__name__)


def attach_browser_events(
    session: BrowserSession, on_event: BrowserEventCallback | None = None
) -> None:
    """由会话工厂挂载一次；回调接收原生事件，耗时工作应由消费方入队。"""
    from browser_use.browser.events import (
        BrowserConnectedEvent,
        BrowserErrorEvent,
        BrowserReconnectedEvent,
        BrowserReconnectingEvent,
        BrowserStoppedEvent,
        DialogOpenedEvent,
        NavigationCompleteEvent,
        TargetCrashedEvent,
    )

    observer = None
    attached_targets = set()
    pending_tasks = set()

    def observe_dialog(params, session_id=None):
        session.event_bus.dispatch(DialogOpenedEvent(
            dialog_type=params["type"], message=params.get("message", ""),
            url=params["url"], frame_id=params.get("frameId"),
        ))

    def observe_crash(params, session_id=None):
        session.event_bus.dispatch(TargetCrashedEvent(
            target_id=params["targetId"],
            error=f'{params["status"]} ({params["errorCode"]})',
        ))

    async def close_observer():
        nonlocal observer
        tasks = list(pending_tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        pending_tasks.clear()
        attached_targets.clear()
        if observer is not None:
            await observer.stop()
            observer = None

    async def attach_target(client, target_id):
        try:
            attached = await client.send.Target.attachToTarget({"targetId": target_id, "flatten": True})
            await client.send.Page.enable(session_id=attached["sessionId"])
        except Exception:
            attached_targets.discard(target_id)
            session.event_bus.dispatch(BrowserErrorEvent(
                error_type="ObserverAttachError", message="浏览器观察目标挂载失败",
                details={"target_id": target_id},
            ))

    def schedule_target(info):
        target_id = info["targetId"]
        if info["type"] != "page" or target_id in attached_targets:
            return
        attached_targets.add(target_id)
        # CDP 消息回调内只排队，避免等待同一读循环处理命令响应造成死锁。
        task = asyncio.create_task(attach_target(observer, target_id))
        pending_tasks.add(task)
        task.add_done_callback(pending_tasks.discard)

    def observe_target(params, session_id=None):
        schedule_target(params["targetInfo"])

    def observe_target_destroyed(params, session_id=None):
        attached_targets.discard(params["targetId"])

    async def open_observer(url):
        nonlocal observer
        await close_observer()
        # CDP 回调注册是覆盖式的；使用独立连接，不能占用原生 watchdog 的槽位。
        observer = CDPClient(url)
        observer.register.Page.javascriptDialogOpening(observe_dialog)
        observer.register.Target.targetCrashed(observe_crash)
        observer.register.Target.targetCreated(observe_target)
        observer.register.Target.targetDestroyed(observe_target_destroyed)
        await observer.start()
        await observer.send.Target.setDiscoverTargets({"discover": True})
        result = await observer.send.Target.getTargets()
        for info in result["targetInfos"]:
            schedule_target(info)
        if pending_tasks:
            await asyncio.gather(*list(pending_tasks))

    async def handle_event(event):
        if isinstance(event, (BrowserConnectedEvent, BrowserReconnectedEvent)):
            try:
                async with asyncio.timeout(10):
                    await open_observer(event.cdp_url)
            except Exception:
                await close_observer()
                session.event_bus.dispatch(BrowserErrorEvent(
                    error_type="ObserverConnectionError", message="浏览器观察连接建立失败"
                ))
        elif isinstance(event, (BrowserStoppedEvent, BrowserReconnectingEvent)):
            await close_observer()

        if isinstance(event, (BrowserErrorEvent, TargetCrashedEvent)):
            logger.error("浏览器异常：%s", event.event_type)
        elif isinstance(event, DialogOpenedEvent):
            logger.warning("浏览器弹窗：%s", event.dialog_type)
        elif isinstance(event, NavigationCompleteEvent) and (
            event.error_message or (event.status is not None and event.status >= 400)
        ):
            logger.warning("浏览器导航异常，目标：%s", event.target_id)
        else:
            logger.info("浏览器状态：%s", event.event_type)

        if on_event is not None:
            try:
                await on_event(event)
            except Exception:
                logger.exception("浏览器事件回调执行失败")

    for event_type in (
        BrowserConnectedEvent, BrowserStoppedEvent, BrowserErrorEvent,
        BrowserReconnectingEvent, BrowserReconnectedEvent, NavigationCompleteEvent,
        DialogOpenedEvent, TargetCrashedEvent,
    ):
        session.event_bus.on(event_type, handle_event)
