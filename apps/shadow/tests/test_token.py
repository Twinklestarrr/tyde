import os
import stat

import pytest
from fastapi import HTTPException

from auth import token as token_module


def test_generated_token_is_private_and_can_be_loaded(tmp_path):
    token_file = tmp_path / "data" / "agent_token.txt"
    auth = token_module.TokenAuth(token_file)

    auth.generate_and_save()

    assert len(auth.token) >= 32
    assert token_file.read_text(encoding="utf-8") == auth.token
    if os.name != "nt":
        assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
    loaded = token_module.TokenAuth(token_file)
    loaded.load()
    loaded.verify(f"Bearer {auth.token}")


def test_regeneration_invalidates_the_previous_token(tmp_path):
    auth = token_module.TokenAuth(tmp_path / "token")
    auth.generate_and_save()
    previous = auth.token
    auth.generate_and_save()

    with pytest.raises(HTTPException) as error:
        auth.verify(f"Bearer {previous}")
    assert error.value.status_code == 401
    auth.verify(f"bearer {auth.token}")


@pytest.mark.parametrize("authorization", [None, "Bearer ", "Bearer guessed-token"])
def test_uninitialized_auth_never_accepts_credentials(tmp_path, authorization):
    auth = token_module.TokenAuth(tmp_path / "token")

    with pytest.raises(HTTPException) as error:
        auth.verify(authorization)

    assert error.value.status_code == 401
    assert error.value.headers == {"WWW-Authenticate": "Bearer"}


def test_loading_an_empty_token_fails_closed(tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("\n", encoding="utf-8")
    auth = token_module.TokenAuth(token_file)

    with pytest.raises(ValueError):
        auth.load()

    with pytest.raises(HTTPException):
        auth.verify("Bearer ")


def test_failed_token_replace_preserves_previous_credentials(tmp_path, monkeypatch):
    token_file = tmp_path / "token"
    auth = token_module.TokenAuth(token_file)
    auth.generate_and_save()
    previous = auth.token

    def fail_replace(source, destination):
        raise OSError("模拟磁盘写入失败")

    monkeypatch.setattr(token_module.os, "replace", fail_replace)

    with pytest.raises(OSError):
        auth.generate_and_save()

    assert auth.token == previous
    assert token_file.read_text(encoding="utf-8") == previous
    assert list(tmp_path.iterdir()) == [token_file]
