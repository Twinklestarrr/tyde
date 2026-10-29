"""本地宿主通信的随机 token 生成、保存与校验。"""

import os
import secrets
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Annotated

from fastapi import Header, HTTPException


class TokenAuth:
    def __init__(self, token_file: str | Path):
        self.token_file = Path(token_file)
        self.token = ""

    def generate_and_save(self) -> None:
        """安全创建临时文件并原子替换，写入成功后才启用新 token。"""
        token = secrets.token_urlsafe(32)
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = None
        try:
            with NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.token_file.parent,
                prefix=".agent-token-",
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(token)
            os.replace(temporary_path, self.token_file)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
        self.token = token

    def load(self) -> None:
        """读取已有 token；缺失或空文件不能作为有效凭据。"""
        self.token = ""
        token = self.token_file.read_text(encoding="utf-8").strip()
        if not token:
            raise ValueError("token 文件为空")
        self.token = token

    def verify(
        self, authorization: Annotated[str | None, Header()] = None
    ) -> None:
        scheme, _, supplied = (authorization or "").partition(" ")
        if (
            not self.token
            or scheme.lower() != "bearer"
            or not secrets.compare_digest(
                supplied.encode("utf-8"), self.token.encode("utf-8")
            )
        ):
            raise HTTPException(
                status_code=401,
                detail="缺少或无效的访问凭据",
                headers={"WWW-Authenticate": "Bearer"},
            )
