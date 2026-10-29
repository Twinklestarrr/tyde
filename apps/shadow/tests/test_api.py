from pathlib import Path
import tomllib
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from api import server as server_module
from api.lifecycle import Lifecycle
from config.settings import Settings


@pytest.fixture
def config(tmp_path, monkeypatch):
    from auth.audit import AuditLog

    class Agent:
        os_controller = SimpleNamespace(revoke=lambda: None)
        history = SimpleNamespace(history=[])

        async def run(self, **kwargs):
            return SimpleNamespace(is_successful=lambda: True, final_result=lambda: None)

    class Session:
        browser_profile = SimpleNamespace(keep_alive=None)

        async def kill(self):
            pass

    monkeypatch.setattr(server_module, "create_session", lambda account_id: Session(), raising=False)
    monkeypatch.setattr(server_module, "_build_agent", lambda **kwargs: Agent(), raising=False)
    monkeypatch.setattr(server_module, "AuditLog", lambda *args: AuditLog(*args, path=tmp_path / "audit.log"), raising=False)
    return Settings(
        _env_file=None,
        LLM_API_KEY="test-model-key",
        TOKEN_FILE_PATH=str(tmp_path / "data" / "token"),
        PID_FILE_PATH=str(tmp_path / "data" / "agent.pid"),
    )


def authorization(config):
    token = Path(config.TOKEN_FILE_PATH).read_text(encoding="utf-8")
    return {"Authorization": f"Bearer {token}"}


def test_app_creates_runtime_files_only_at_startup_and_reports_project_version(config):
    app = server_module.create_app(config)
    assert not Path(config.TOKEN_FILE_PATH).parent.exists()
    project_file = Path(__file__).resolve().parents[1] / "pyproject.toml"
    version = tomllib.loads(project_file.read_text(encoding="utf-8"))["project"]["version"]

    with TestClient(app) as client:
        response = client.get("/version")
        assert response.status_code == 200
        assert response.json() == {"version": version}
        assert client.get("/docs").status_code == 200
        assert Path(config.TOKEN_FILE_PATH).exists()

    assert Path(config.PID_FILE_PATH).read_text(encoding="ascii") == ""
    assert app.state.token_auth.token == ""


def test_local_debug_page_serves_html_without_exposing_credentials(config, tmp_path, monkeypatch):
    page = tmp_path / "index.html"
    page.write_text("<!doctype html><title>本地调试</title>", encoding="utf-8")
    monkeypatch.setattr(server_module, "_DEBUG_PAGE_PATH", page, raising=False)

    with TestClient(server_module.create_app(config)) as client:
        response = client.get("/debug")
        assert response.status_code == 200
        assert response.text == "<!doctype html><title>本地调试</title>"
        assert response.headers["content-type"].startswith("text/html")
        assert response.headers["cache-control"] == "no-store"
        assert client.app.state.token_auth.token not in response.text
        assert client.post("/task", json={"account_id": "account_001", "params": {"task": "读取标题"}}).status_code == 401


def test_missing_local_debug_page_returns_fixed_not_found(config, tmp_path, monkeypatch):
    monkeypatch.setattr(server_module, "_DEBUG_PAGE_PATH", tmp_path / "missing.html", raising=False)

    with TestClient(server_module.create_app(config)) as client:
        response = client.get("/debug")

    assert response.status_code == 404
    assert response.json() == {"detail": "本地调试页面不存在"}


@pytest.mark.parametrize("path", ["/task", "/task/unknown/status", "/task/unknown/resume", "/task/unknown/cancel"])
@pytest.mark.parametrize("credentials", [None, "Basic guessed", "Bearer guessed", "Bearer "])
def test_task_routes_require_valid_bearer_credentials(config, path, credentials):
    app = server_module.create_app(config)
    headers = {"Authorization": credentials} if credentials is not None else {}

    with TestClient(app) as client:
        if path.endswith(("/resume", "/cancel")):
            response = client.post(path, headers=headers)
        elif path == "/task":
            response = client.post(path, headers=headers, json={
                "account_id": "account_001"
            })
        else:
            response = client.get(path, headers=headers)

    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_connected_agent_accepts_tasks_and_unknown_status_is_not_found(config):
    with TestClient(server_module.create_app(config)) as client:
        headers = authorization(config)
        response = client.post("/task", headers=headers, json={
            "account_id": "account_001", "params": {"task": "读取页面标题"}
        })
        assert response.status_code == 202
        assert response.json()["task_id"]
        assert response.json()["status"] == "accepted"
        assert client.get("/task/unknown/status", headers=headers).status_code == 404
        assert "/progress/{task_id}" not in client.get("/openapi.json").json()["paths"]


@pytest.mark.parametrize("body", [
    {},
    {"account_id": "account_001", "params": []},
    {"account_id": "account_001"},
    {"account_id": "account_001", "params": {}},
    {"account_id": "account_001", "params": {"task": "  "}},
    {"account_id": "account_001", "params": {"task": None}},
    {"account_id": "account_001", "params": {"task": 123}},
])
def test_invalid_task_requests_are_rejected(config, body):
    with TestClient(server_module.create_app(config)) as client:
        response = client.post("/task", headers=authorization(config), json=body)

    assert response.status_code == 422


@pytest.mark.parametrize("account_id", ["", "中文账号.01"])
def test_account_id_has_no_format_restriction(config, account_id):
    with TestClient(server_module.create_app(config)) as client:
        response = client.post(
            "/task", headers=authorization(config), json={"account_id": account_id, "params": {"task": "读取标题"}}
        )

    assert response.status_code == 202


def test_second_app_cannot_rotate_the_running_instances_token(config):
    with TestClient(server_module.create_app(config)) as client:
        headers = authorization(config)
        with pytest.raises(RuntimeError, match="实例"):
            with TestClient(server_module.create_app(config)):
                pytest.fail("第二个实例不应启动成功")

        assert authorization(config) == headers
        assert client.post("/task", headers=headers, json={
            "account_id": "account_001", "params": {"task": "读取标题"}
        }).status_code == 202


def test_failed_startup_releases_the_process_lock(config, tmp_path):
    token_directory = tmp_path / "token-directory"
    token_directory.mkdir()
    config.TOKEN_FILE_PATH = str(token_directory)

    with pytest.raises(OSError):
        with TestClient(server_module.create_app(config)):
            pytest.fail("token 写入失败时不应启动服务")

    lock = Lifecycle(config.PID_FILE_PATH)
    try:
        assert lock.acquire()
    finally:
        lock.cleanup()


def test_restart_rotates_credentials(config):
    with TestClient(server_module.create_app(config)):
        previous = authorization(config)

    with TestClient(server_module.create_app(config)) as client:
        assert client.get("/task/unknown/status", headers=previous).status_code == 401
        assert client.get("/task/unknown/status", headers=authorization(config)).status_code == 404


def test_pid_and_token_must_use_different_files(config):
    config.PID_FILE_PATH = config.TOKEN_FILE_PATH

    with pytest.raises(ValueError, match="不同"):
        server_module.create_app(config)
