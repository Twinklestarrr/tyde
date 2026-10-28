"""验证模型密钥只在已鉴权的当前服务内存中生效。"""

from fastapi.testclient import TestClient
import pytest

from api.server import create_app
from config.settings import Settings


@pytest.fixture
def config(tmp_path):
    return Settings(_env_file=None, LLM_API_KEY="",
        TOKEN_FILE_PATH=str(tmp_path / "token"), PID_FILE_PATH=str(tmp_path / "agent.pid"))


def authorization(client):
    return {"Authorization": f"Bearer {client.app.state.token_auth.token}"}


@pytest.mark.parametrize("credential", [None, "Bearer wrong", "Basic wrong"])
def test_setting_model_key_requires_host_token(config, credential):
    with TestClient(create_app(config)) as client:
        response = client.put("/config/llm", json={"api_key": "synthetic-private-key"},
            headers={"Authorization": credential} if credential else {})

    assert response.status_code == 401
    assert "synthetic-private-key" not in response.text


def test_setting_model_key_does_not_change_source_config_or_write_secret(config, tmp_path, caplog):
    with TestClient(create_app(config)) as client:
        response = client.put("/config/llm", headers=authorization(client),
            json={"api_key": "  synthetic-private-key  "})
        assert response.status_code == 200
        assert response.json() == {"configured": True}
        assert response.headers["cache-control"] == "no-store"
        assert config.LLM_API_KEY == ""

    assert "synthetic-private-key" not in caplog.text
    for file in tmp_path.rglob("*"):
        if file.is_file():
            assert b"synthetic-private-key" not in file.read_bytes()


@pytest.mark.parametrize("body", [
    {}, {"api_key": ""}, {"api_key": "  "}, {"api_key": None},
    {"api_key": {"secret": "synthetic-private-key"}},
    {"api_key": "synthetic-private-key", "unexpected": "synthetic-private-key"},
])
def test_invalid_key_requests_never_echo_submitted_values(config, body):
    with TestClient(create_app(config)) as client:
        response = client.put("/config/llm", headers=authorization(client), json=body)

    assert response.status_code == 422
    assert response.json() == {"detail": "api_key 必须为非空字符串，且不能包含额外字段"}
    assert "synthetic-private-key" not in response.text


def test_invalid_json_never_echoes_raw_secret(config):
    with TestClient(create_app(config)) as client:
        response = client.put("/config/llm",
            headers={**authorization(client), "Content-Type": "application/json"},
            content='{"api_key":"synthetic-private-key"')

    assert response.status_code == 422
    assert "synthetic-private-key" not in response.text


def test_restart_forgets_key_and_rejects_task_before_creating_runtime(config, monkeypatch):
    from api import server

    async def isolated_execution(*args):
        pass

    monkeypatch.setattr(server, "_execute_task", isolated_execution)
    app = create_app(config)
    with TestClient(app) as client:
        assert client.put("/config/llm", headers=authorization(client),
            json={"api_key": "synthetic-private-key"}).status_code == 200

    with TestClient(app) as client:
        assert client.get("/version").status_code == 200
        response = client.post("/task", headers=authorization(client),
            json={"account_id": "account_001", "params": {"task": "读取页面标题"}})
        assert response.status_code == 503
        assert client.app.state.active_task is None
        assert client.app.state.task_results == {}


def test_model_key_request_repr_masks_secret():
    from api import schemas

    request_type = getattr(schemas, "LLMConfigRequest", None)
    assert request_type is not None
    assert "synthetic-private-key" not in repr(request_type(api_key="synthetic-private-key"))
