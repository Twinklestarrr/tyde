import json
from pathlib import Path

from pydantic import ValidationError
import pytest

from browser import session as session_module


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setattr(session_module, "PROJECT_ROOT", tmp_path, raising=False)
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    return tmp_path


def write_profile(project, account_id="account_001", **overrides):
    profile = {
        "user_data_dir": f"config/profiles/{account_id}/chrome_data",
        "viewport": {"width": 1440, "height": 900},
        **overrides,
    }
    path = project / "config" / "profiles" / account_id / "browser_profile.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(profile), encoding="utf-8")
    return path


def test_profile_is_applied_with_root_relative_paths_and_project_policies(project, monkeypatch):
    write_profile(
        project, account_id="测试账号.01", headless=True,
        highlight_elements=True, dom_highlight_elements=True,
    )
    elsewhere = project / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    session = session_module.create_session("测试账号.01")
    profile = session.browser_profile

    assert Path(profile.user_data_dir) == project / "config/profiles/测试账号.01/chrome_data"
    assert profile.viewport is None
    assert profile.no_viewport is True
    assert profile.window_size.model_dump() == {"width": 1440, "height": 900}
    assert profile.headless is False
    assert profile.allowed_domains is None
    assert profile.highlight_elements is False
    assert profile.dom_highlight_elements is False
    assert not Path(profile.user_data_dir).exists()


def test_os_session_uses_native_window_without_device_emulation(project):
    write_profile(project, window_size={"width": 1000, "height": 750},
                  no_viewport=False, device_scale_factor=1)

    profile = session_module.create_session().browser_profile

    assert profile.viewport is None and profile.no_viewport is True
    assert profile.device_scale_factor is None
    assert profile.window_size.model_dump() == {"width": 1000, "height": 750}


def test_absolute_user_data_path_is_preserved(project):
    absolute = project / "browser-data"
    write_profile(project, user_data_dir=str(absolute))

    session = session_module.create_session()

    assert Path(session.browser_profile.user_data_dir) == absolute


@pytest.mark.parametrize("value", [None, ""])
def test_persistent_profile_requires_a_user_data_directory(project, value):
    write_profile(project, user_data_dir=value)

    with pytest.raises(ValueError, match="user_data_dir"):
        session_module.create_session()


@pytest.mark.parametrize("field", ["timezone", "locale"])
def test_unsupported_profile_options_are_reported_instead_of_ignored(project, field):
    write_profile(project, **{field: "unsupported"})

    with pytest.raises(ValidationError, match=field):
        session_module.create_session()


def test_account_configuration_cannot_escape_profiles_directory(project):
    write_profile(project, account_id="../outside")

    with pytest.raises(ValueError, match="profiles"):
        session_module.create_session("../outside")


def test_missing_account_configuration_is_not_created_implicitly(project):
    with pytest.raises(FileNotFoundError):
        session_module.create_session()

    assert not (project / "config/profiles/account_001").exists()


@pytest.mark.asyncio
async def test_session_factory_mounts_browser_events(project):
    write_profile(project)
    observed = []

    async def consumer(event):
        observed.append(event)

    session = session_module.create_session(on_event=consumer)
    from browser_use.browser.events import BrowserErrorEvent

    event = BrowserErrorEvent(error_type="fixture", message="模拟启动失败")
    try:
        await session.event_bus.dispatch(event)
        assert observed == [event]
    finally:
        await session.event_bus.stop(clear=True)
