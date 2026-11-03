"""构建 macOS arm64 联调包，只收集程序依赖和公开配置模板。"""

import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tomllib
import zipfile

from dotenv import dotenv_values


def create_archive(project: Path, bundle: Path, archive: Path) -> None:
    """从明确的公开文件生成默认配置，不读取本机 .env、账号或 data。"""
    template = project / ".env.example"
    if dotenv_values(template, interpolate=False).get("LLM_API_KEY"):
        raise ValueError("公开配置模板中的 API Key 必须为空")
    defaults = bundle / "defaults"
    profile = defaults / "config/profiles/account_001/browser_profile.json"
    profile.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(template, defaults / ".env")
    shutil.copyfile(project / "config/profiles/browser_profile.example.json", profile)
    shutil.copyfile(project / "deploy/部署说明.md", bundle / "部署说明.md")
    launcher = bundle / "启动.command"
    launcher.write_text('#!/bin/zsh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec ./shadow-agent\n', encoding="utf-8")
    launcher.chmod(0o755)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for path in sorted(bundle.rglob("*")):
            name = str(path.relative_to(bundle.parent))
            if path.is_symlink():
                # 原生库可能以符号链接引用；普通文件复制会破坏解压后的依赖布局。
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = path.lstat().st_mode << 16
                package.writestr(info, os.readlink(path))
            elif path.is_file():
                package.write(path, name)


def main() -> None:
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("此脚本需要在 macOS Apple 芯片环境构建")
    project = Path(__file__).resolve().parents[1]
    build = project / "build"
    env = {**os.environ, "PYINSTALLER_CONFIG_DIR": str(build / "pyinstaller-cache"),
           "BROWSER_USE_CONFIG_DIR": str(build / "browser-use"),
           "PYTHON_DOTENV_DISABLED": "1", "BROWSER_USE_SETUP_LOGGING": "false",
           "ANONYMIZED_TELEMETRY": "false", "BROWSER_USE_CLOUD_SYNC": "false"}
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
        "--distpath", str(project / "dist"), "--workpath", str(build / "pyinstaller"),
        str(project / "deploy/agent.spec")], cwd=project, env=env, check=True)
    version = tomllib.loads((project / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    archive = project / "dist" / f"shadow-agent-{version}-macos-arm64.zip"
    create_archive(project, project / "dist/shadow-agent", archive)
    print(f"交付包：{archive}")
    with archive.open("rb") as stream:
        print(f"SHA256：{hashlib.file_digest(stream, 'sha256').hexdigest()}")


if __name__ == "__main__":
    main()
