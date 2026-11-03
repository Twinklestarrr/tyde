"""验证交付内容只从公开模板生成，不混入本机配置和运行数据。"""

import importlib.util
from pathlib import Path
import stat
import zipfile

import pytest


def build_module():
    source = Path(__file__).resolve().parents[1] / "deploy/build_macos.py"
    assert source.is_file(), "尚未实现 macOS 交付脚本"
    spec = importlib.util.spec_from_file_location("isolated_build", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def project_files(tmp_path, *, template_key=""):
    root = tmp_path / "source"
    profiles = root / "config/profiles"
    profiles.mkdir(parents=True)
    (profiles / "browser_profile.example.json").write_text(
        '{"user_data_dir":"config/profiles/account_001/chrome_data"}', encoding="utf-8")
    (root / ".env.example").write_text(f"LLM_API_KEY={template_key}\nAPI_PORT=29321\n", encoding="utf-8")
    (root / "deploy").mkdir()
    (root / "deploy/部署说明.md").write_text("联调部署说明", encoding="utf-8")
    (root / ".env").write_text("LLM_API_KEY=private-local-key", encoding="utf-8")
    (profiles / "account_001").mkdir()
    (profiles / "account_001/Cookies").write_text("private-login-state", encoding="utf-8")
    (root / "data").mkdir()
    (root / "data/agent_token.txt").write_text("private-host-token", encoding="utf-8")
    bundle = tmp_path / "dist/shadow-agent"
    bundle.mkdir(parents=True)
    (bundle / "shadow-agent").write_bytes(b"synthetic-executable")
    (bundle / "shadow-agent").chmod(0o755)
    return root, bundle, tmp_path / "shadow-agent.zip"


def test_release_contains_blank_key_configuration_and_excludes_private_files(tmp_path):
    module = build_module()
    root, bundle, archive = project_files(tmp_path)
    module.create_archive(root, bundle, archive)

    with zipfile.ZipFile(archive) as package:
        names = set(package.namelist())
        assert "shadow-agent/defaults/.env" in names
        assert "shadow-agent/defaults/config/profiles/account_001/browser_profile.json" in names
        assert "shadow-agent/启动.command" in names
        assert "shadow-agent/部署说明.md" in names
        assert package.read("shadow-agent/defaults/.env") == b"LLM_API_KEY=\nAPI_PORT=29321\n"
        for name in names:
            content = package.read(name)
            assert b"private-local-key" not in content
            assert b"private-login-state" not in content
            assert b"private-host-token" not in content
        assert (package.getinfo("shadow-agent/启动.command").external_attr >> 16) & 0o111


def test_release_rejects_nonempty_api_key_in_public_template(tmp_path):
    module = build_module()
    root, bundle, archive = project_files(tmp_path, template_key="must-never-ship")

    with pytest.raises(ValueError, match="API Key") as error:
        module.create_archive(root, bundle, archive)

    assert "must-never-ship" not in str(error.value)
    assert not archive.exists()


def test_release_preserves_native_library_and_directory_symbolic_links(tmp_path):
    module = build_module()
    root, bundle, archive = project_files(tmp_path)
    library = bundle / "_internal/real.dylib"
    library.parent.mkdir()
    library.write_bytes(b"synthetic-native-library")
    (library.parent / "alias.dylib").symlink_to("real.dylib")
    (bundle / "library-folder").symlink_to("_internal", target_is_directory=True)
    module.create_archive(root, bundle, archive)

    with zipfile.ZipFile(archive) as package:
        for name, target in [("shadow-agent/_internal/alias.dylib", b"real.dylib"),
                             ("shadow-agent/library-folder", b"_internal")]:
            assert stat.S_ISLNK(package.getinfo(name).external_attr >> 16)
            assert package.read(name) == target


def test_runtime_check_loads_native_backends_and_prompts_without_model_requests(monkeypatch):
    source = Path(__file__).resolve().parents[1] / "deploy/runtime_check.py"
    assert source.is_file(), "尚未提供发布包运行依赖检查"
    spec = importlib.util.spec_from_file_location("isolated_check", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    import httpx

    async def forbid_request(*args, **kwargs):
        pytest.fail("依赖检查不能调用远程模型")

    monkeypatch.setattr(httpx.AsyncClient, "send", forbid_request)
    module.check_runtime()
