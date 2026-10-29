"""验证项目事件挂载、原生处理保留和只读 CDP 观察。"""

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from browser import events as events_module


@pytest_asyncio.fixture
async def environment(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    from bubus import EventBus
    from browser_use.browser import events
    from cdp_use import CDPClient

    clients = []

    def create_observer(url):
        client = CDPClient(url)

        async def start():
            client.ws = SimpleNamespace(close=AsyncMock())

        monkeypatch.setattr(client, "start", start)
        monkeypatch.setattr(client.send.Target, "setDiscoverTargets", AsyncMock())
        monkeypatch.setattr(client.send.Target, "getTargets", AsyncMock(return_value={"targetInfos": []}))
        clients.append(client)
        return client

    monkeypatch.setattr(events_module, "CDPClient", create_observer, raising=False)
    bus = EventBus()
    try:
        yield SimpleNamespace(
            events=events, bus=bus, clients=clients,
            session=SimpleNamespace(event_bus=bus, cdp_client=CDPClient("ws://native")),
        )
    finally:
        await bus.dispatch(events.BrowserStoppedEvent(reason="测试清理"))
        await bus.stop(clear=True)


@pytest.mark.asyncio
async def test_observer_preserves_existing_handlers_and_delivers_original_event(environment):
    observed = []

    async def original(event):
        observed.append(("原生", event))

    async def consumer(event):
        observed.append(("项目", event))

    environment.bus.on(environment.events.BrowserErrorEvent, original)
    events_module.attach_browser_events(environment.session, consumer)
    event = environment.events.BrowserErrorEvent(error_type="fixture", message="模拟断开")

    await environment.bus.dispatch(event)

    assert ("原生", event) in observed
    assert ("项目", event) in observed


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["connected", "stopped", "navigation", "reconnecting", "reconnected"])
async def test_status_events_reach_the_consumer(environment, kind):
    observed = []

    async def consumer(event):
        observed.append(event)

    events_module.attach_browser_events(environment.session, consumer)
    events = environment.events
    event = {
        "connected": lambda: events.BrowserConnectedEvent(cdp_url="ws://fixture"),
        "stopped": lambda: events.BrowserStoppedEvent(reason="模拟关闭"),
        "navigation": lambda: events.NavigationCompleteEvent(target_id="fixture", url="https://example.com"),
        "reconnecting": lambda: events.BrowserReconnectingEvent(cdp_url="ws://fixture", attempt=1, max_attempts=3),
        "reconnected": lambda: events.BrowserReconnectedEvent(cdp_url="ws://fixture", attempt=1, downtime_seconds=1),
    }[kind]()

    await environment.bus.dispatch(event)

    assert observed == [event]


@pytest.mark.asyncio
async def test_cdp_observers_emit_dialog_and_crash_after_reconnection(environment):
    observed = []

    async def consumer(event):
        observed.append(event)

    events_module.attach_browser_events(environment.session, consumer)
    await environment.bus.dispatch(environment.events.BrowserConnectedEvent(cdp_url="ws://fixture"))
    await environment.bus.dispatch(environment.events.BrowserReconnectedEvent(
        cdp_url="ws://fixture", attempt=1, downtime_seconds=1
    ))
    client = environment.clients[-1]
    await client.emit_event("Page.javascriptDialogOpening", {
        "type": "alert", "message": "模拟弹窗", "url": "https://example.com"
    }, "session")
    await client.emit_event("Target.targetCrashed", {
        "targetId": "fixture", "status": "crashed", "errorCode": 1
    })
    await environment.bus.wait_until_idle()

    dialogs = [event for event in observed if isinstance(event, environment.events.DialogOpenedEvent)]
    crashes = [event for event in observed if isinstance(event, environment.events.TargetCrashedEvent)]
    assert len(dialogs) == len(crashes) == 1
    assert dialogs[0].dialog_type == "alert"
    assert dialogs[0].message == "模拟弹窗"
    assert crashes[0].target_id == "fixture"
    assert "crashed" in crashes[0].error


@pytest.mark.asyncio
async def test_failed_consumer_does_not_interrupt_native_event_handling(environment, caplog):
    async def consumer(event):
        raise RuntimeError("模拟观察回调失败")

    events_module.attach_browser_events(environment.session, consumer)
    event = environment.events.BrowserErrorEvent(error_type="fixture", message="模拟错误")

    with caplog.at_level(logging.ERROR, logger="browser.events"):
        await environment.bus.dispatch(event)
        await event.event_result(raise_if_any=True, raise_if_none=False)

    assert any(record.levelno >= logging.ERROR for record in caplog.records)


@pytest.mark.asyncio
async def test_failed_navigation_is_logged_without_a_consumer(environment, caplog):
    events_module.attach_browser_events(environment.session)

    with caplog.at_level(logging.WARNING, logger="browser.events"):
        await environment.bus.dispatch(environment.events.NavigationCompleteEvent(
            target_id="fixture", url="https://example.com", error_message="模拟超时"
        ))

    assert any(record.levelno >= logging.WARNING for record in caplog.records)


@pytest.mark.asyncio
async def test_attaching_observation_does_not_overwrite_native_cdp_popup_handler(environment):
    from cdp_use import CDPClient

    native_client = CDPClient("ws://fixture")
    environment.session.cdp_client = native_client
    handled = []

    async def native_popup_handler(params, session_id):
        handled.append("原生弹窗处理")

    native_client.register.Page.javascriptDialogOpening(native_popup_handler)
    events_module.attach_browser_events(environment.session)
    await environment.bus.dispatch(environment.events.BrowserConnectedEvent(cdp_url="ws://fixture"))

    await native_client.emit_event(
        "Page.javascriptDialogOpening",
        {"type": "alert", "message": "模拟弹窗", "url": "https://example.com"},
        "native-session",
    )

    assert handled == ["原生弹窗处理"]


@pytest.mark.asyncio
async def test_reconnecting_and_stopping_release_observer_connections(environment):
    events_module.attach_browser_events(environment.session)
    await environment.bus.dispatch(environment.events.BrowserConnectedEvent(cdp_url="ws://fixture"))
    original = environment.clients[-1]
    assert original.ws is not None

    await environment.bus.dispatch(environment.events.BrowserReconnectingEvent(
        cdp_url="ws://fixture", attempt=1, max_attempts=3
    ))
    assert original.ws is None

    await environment.bus.dispatch(environment.events.BrowserReconnectedEvent(
        cdp_url="ws://fixture", attempt=1, downtime_seconds=1
    ))
    current = environment.clients[-1]
    assert current.ws is not None

    await environment.bus.dispatch(environment.events.BrowserStoppedEvent(reason="模拟关闭"))
    assert current.ws is None
