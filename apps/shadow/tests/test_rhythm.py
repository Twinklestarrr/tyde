"""验证动作前等待的计算、配置隔离与异步取消。"""

import asyncio
from types import SimpleNamespace

import pytest

from config.settings import Settings
from core.orchestrator import rhythm


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("read_time", "jitter", "minimum", "boundary", "seconds"),
    [
        (1000, 0.2, 500, "lower", 0.8),
        (1000, 0.2, 500, "upper", 1.2),
        (100, 0.2, 500, "lower", 0.5),
        (0, 0.2, 500, "upper", 0.5),
        (None, 0.2, 500, "lower", 0.5),
        (250, 0, 0, "upper", 0.25),
        (0, 0, 0, "lower", 0),
    ],
)
async def test_wait_uses_configured_jitter_and_minimum(
    monkeypatch, read_time, jitter, minimum, boundary, seconds
):
    waits = []

    async def sleep(value):
        waits.append(value)

    monkeypatch.setattr(rhythm, "asyncio", SimpleNamespace(sleep=sleep))
    monkeypatch.setattr(rhythm.random, "uniform", lambda low, high: low if boundary == "lower" else high)
    config = Settings(_env_file=None, READ_TIME_JITTER=jitter, MIN_ACTION_DELAY_MS=minimum)

    await rhythm.RhythmEngine(config=config).consume_read_time(read_time, action_type="click")

    assert waits == [pytest.approx(seconds)]


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [-1, True, 1.5, float("inf"), float("nan")])
async def test_invalid_read_time_is_rejected_before_waiting(monkeypatch, value):
    waits = []

    async def sleep(seconds):
        waits.append(seconds)

    monkeypatch.setattr(rhythm, "asyncio", SimpleNamespace(sleep=sleep))
    with pytest.raises(ValueError, match="阅读时长"):
        await rhythm.RhythmEngine().consume_read_time(value)
    assert waits == []


@pytest.mark.asyncio
async def test_wait_yields_to_other_tasks_and_can_be_cancelled(monkeypatch):
    started = asyncio.Event()
    never_released = asyncio.Event()

    async def sleep(seconds):
        started.set()
        await never_released.wait()

    monkeypatch.setattr(rhythm, "asyncio", SimpleNamespace(sleep=sleep))
    task = asyncio.create_task(rhythm.RhythmEngine().consume_read_time(1000))
    await asyncio.wait_for(started.wait(), timeout=1)
    assert not task.done()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
