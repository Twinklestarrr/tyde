"""macOS arm64 单目录构建；配置模板由交付脚本另行收集。"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata


root = Path(SPECPATH).parent
analysis = Analysis(
    [str(root / "main.py")],
    pathex=[str(root)],
    datas=collect_data_files("browser_use") + copy_metadata("browser-use", recursive=True),
    hiddenimports=collect_submodules("browser_use") + [
        "pynput.keyboard._darwin", "pynput.mouse._darwin", "pyautogui._pyautogui_osx",
        "mss.darwin", "AppKit", "Quartz", "ApplicationServices",
        "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on",
    ],
    excludes=["pytest", "IPython"],
)
archive = PYZ(analysis.pure)
executable = EXE(archive, analysis.scripts, [], exclude_binaries=True,
    name="shadow-agent", console=True, target_arch="arm64")
COLLECT(executable, analysis.binaries, analysis.datas, name="shadow-agent")
