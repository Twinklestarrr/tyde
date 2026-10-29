from pathlib import Path

import pytest
from pydantic import ValidationError

from config import settings as settings_module


def test_reads_api_key_from_environment_without_exposing_it(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "test-key-do-not-log")
    assert hasattr(settings_module, "Settings"), "Settings has not been implemented"

    config = settings_module.Settings(_env_file=None)

    assert config.LLM_API_KEY == "test-key-do-not-log"
    assert "test-key-do-not-log" not in repr(config)


def test_environment_overrides_dotenv_and_allows_unrelated_entries(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "LLM_API_KEY=dotenv-test-key\nAPI_PORT=30123\nOTHER_APP_SETTING=unused\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("LLM_API_KEY", "environment-test-key")
    monkeypatch.delenv("API_PORT", raising=False)

    config = settings_module.Settings(_env_file=env_file)

    assert config.LLM_API_KEY == "environment-test-key"
    assert config.API_PORT == 30123


def test_default_data_paths_are_independent_of_working_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("HISTORY_SAVE_PATH", raising=False)
    monkeypatch.delenv("TOKEN_FILE_PATH", raising=False)
    monkeypatch.delenv("PID_FILE_PATH", raising=False)
    project_root = Path(__file__).resolve().parents[1]

    config = settings_module.Settings(_env_file=None)

    assert Path(config.HISTORY_SAVE_PATH) == project_root / "data" / "sessions"
    assert Path(config.TOKEN_FILE_PATH) == project_root / "data" / "agent_token.txt"
    assert Path(config.PID_FILE_PATH) == project_root / "data" / "agent.pid"
    assert not (tmp_path / "data").exists()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("LLM_TIMEOUT", 0),
        ("READ_TIME_JITTER", -0.1),
        ("READ_TIME_JITTER", 1.1),
        ("MIN_ACTION_DELAY_MS", -1),
        ("OS_CHANNEL_TIMEOUT", 0),
        ("PAGE_LOAD_TIMEOUT", 0),
        ("HISTORY_SAVE_INTERVAL", -1),
        ("API_PORT", 0),
        ("API_PORT", 65536),
    ],
)
def test_rejects_values_that_break_timing_or_server_configuration(name, value):
    with pytest.raises(ValidationError):
        settings_module.Settings(_env_file=None, **{name: value})


def test_zero_save_interval_and_disabled_delay_remain_valid():
    config = settings_module.Settings(
        _env_file=None,
        HISTORY_SAVE_INTERVAL=0,
        MIN_ACTION_DELAY_MS=0,
        READ_TIME_JITTER=0,
    )

    assert config.HISTORY_SAVE_INTERVAL == 0
    assert config.MIN_ACTION_DELAY_MS == 0
    assert config.READ_TIME_JITTER == 0


def test_api_configuration_can_load_before_model_credentials_are_supplied(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    config = settings_module.Settings(_env_file=None)

    assert config.LLM_API_KEY == ""
