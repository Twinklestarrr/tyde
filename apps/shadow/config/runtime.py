"""区分源码目录、发布包目录与用户可写的持久化目录。"""

import os
from pathlib import Path
import sys


PACKAGED = bool(getattr(sys, "frozen", False))
PROJECT_ROOT = (
    Path(os.environ.get("SHADOW_HOME", Path.home() / "Library/Application Support/Shadow")).expanduser().resolve()
    if PACKAGED else Path(__file__).resolve().parents[1]
)


def prepare_runtime() -> None:
    """发布包首次启动复制公开默认配置；已有配置和登录数据始终保留。"""
    if not PACKAGED:
        return
    defaults = Path(sys.executable).resolve().parent / "defaults"
    for relative in (Path(".env"), Path("config/profiles/account_001/browser_profile.json")):
        target = PROJECT_ROOT / relative
        if target.exists():
            continue
        content = (defaults / relative).read_bytes()
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with target.open("xb") as stream:
                stream.write(content)
        except FileExistsError:
            # 同时启动的另一个进程可能已完成初始化，不能覆盖它的配置。
            pass
    # 原库也会通过 Pydantic 读取 cwd/.env，不能让启动位置的其他应用配置混入。
    os.chdir(PROJECT_ROOT)
    os.environ.setdefault("BROWSER_USE_CONFIG_DIR", str(PROJECT_ROOT / "data/browser-use"))
    os.environ.setdefault("PYTHON_DOTENV_DISABLED", "1")
    os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
    os.environ.setdefault("BROWSER_USE_CLOUD_SYNC", "false")
