"""验证发布包的配置初始化与运行目录独立于安装位置。"""

import importlib.util
from pathlib import Path
import sys

import pytest


def load_runtime(monkeypatch, tmp_path, *, packaged=True):
    source = Path(__file__).resolve().parents[1] / "config/runtime.py"
    assert source.is_file(), "尚未适配发布包运行路径"
    monkeypatch.setattr(sys, "frozen", packaged, raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "安装目录/shadow-agent"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "用户目录")
    monkeypatch.delenv("SHADOW_HOME", raising=False)
    monkeypatch.chdir(tmp_path)
    spec = importlib.util.spec_from_file_location("isolated_runtime", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def default_files(tmp_path):
    defaults = tmp_path / "安装目录/defaults"
    profile = defaults / "config/profiles/account_001/browser_profile.json"
    profile.parent.mkdir(parents=True)
    profile.write_text('{"user_data_dir":"config/profiles/account_001/chrome_data"}', encoding="utf-8")
    (defaults / ".env").write_text("LLM_API_KEY=\nAPI_PORT=29321\n", encoding="utf-8")
    return defaults


def test_packaged_runtime_copies_defaults_to_user_directory_and_preserves_changes(monkeypatch, tmp_path):
    module = load_runtime(monkeypatch, tmp_path)
    defaults = default_files(tmp_path)
    elsewhere = tmp_path / "其他工作目录"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    expected = tmp_path / "用户目录/Library/Application Support/Shadow"
    assert module.PROJECT_ROOT == expected
    assert not expected.exists()

    module.prepare_runtime()
    assert (expected / ".env").read_text() == "LLM_API_KEY=\nAPI_PORT=29321\n"
    profile = expected / "config/profiles/account_001/browser_profile.json"
    assert profile.read_bytes() == (defaults / "config/profiles/account_001/browser_profile.json").read_bytes()
    (expected / ".env").write_text("API_PORT=30123\n", encoding="utf-8")
    profile.write_text('{"user_data_dir":"custom"}', encoding="utf-8")
    module.prepare_runtime()
    assert (expected / ".env").read_text() == "API_PORT=30123\n"
    assert profile.read_text() == '{"user_data_dir":"custom"}'
    assert not (elsewhere / "data").exists()
    assert not (tmp_path / "安装目录/data").exists()


def test_source_runtime_does_not_create_configuration(monkeypatch, tmp_path):
    module = load_runtime(monkeypatch, tmp_path, packaged=False)
    module.prepare_runtime()

    assert module.PROJECT_ROOT == Path(__file__).resolve().parents[1]
    assert list(tmp_path.iterdir()) == []


def test_packaged_runtime_supports_explicit_data_directory(monkeypatch, tmp_path):
    module = load_runtime(monkeypatch, tmp_path)
    default_files(tmp_path)
    # 重新执行模块，模拟启动前指定独立目录的打包服务。
    monkeypatch.setenv("SHADOW_HOME", str(tmp_path / "联调数据"))
    module.__spec__.loader.exec_module(module)
    module.prepare_runtime()

    assert module.PROJECT_ROOT == tmp_path / "联调数据"
    assert (tmp_path / "联调数据/.env").exists()


def test_packaged_third_party_settings_cannot_read_unrelated_working_directory(monkeypatch, tmp_path):
    from browser_use.config import FlatEnvConfig

    module = load_runtime(monkeypatch, tmp_path)
    default_files(tmp_path)
    elsewhere = tmp_path / "其他应用"
    elsewhere.mkdir()
    (elsewhere / ".env").write_text("BROWSER_USE_INFO_LOG_FILE=unrelated-private-log\n", encoding="utf-8")
    monkeypatch.delenv("BROWSER_USE_INFO_LOG_FILE", raising=False)
    monkeypatch.chdir(elsewhere)
    module.prepare_runtime()

    assert FlatEnvConfig().BROWSER_USE_INFO_LOG_FILE is None
    assert Path.cwd() == module.PROJECT_ROOT
