"""保存原生感知截图，并在任务结束时按需合成 GIF。"""

import base64
from io import BytesIO
from pathlib import Path

from PIL import Image

from config.settings import PROJECT_ROOT, Settings, settings


class ScreenshotRecorder:
    """按任务隔离截图；构造时不创建目录，SAVE_HISTORY 控制全部存档。"""

    def __init__(self, task_id: str, *, config: Settings | None = None):
        self.config = config if config is not None else settings
        root = Path(self.config.HISTORY_SAVE_PATH).expanduser()
        if not root.is_absolute():
            root = PROJECT_ROOT / root
        root = root.resolve()
        self.directory = (root / task_id).resolve()
        if self.directory == root or not self.directory.is_relative_to(root):
            raise ValueError("任务目录必须位于历史存档目录内，且不能使用根目录")

    def save_screenshot(self, step: int, screenshot: str | None) -> Path | None:
        """将 base64 截图保存为 PNG；无截图或关闭历史时不写文件。"""
        if not self.config.SAVE_HISTORY or not screenshot:
            return None
        if step < 0:
            raise ValueError("步数不能为负数")
        data = base64.b64decode(screenshot, validate=True)
        with Image.open(BytesIO(data)) as image:
            image.load()
            self.directory.mkdir(parents=True, exist_ok=True)
            path = self.directory / f"step_{step:06d}.png"
            image.save(path, format="PNG")
        return path

    def finish(self) -> Path | None:
        """按步数排序磁盘帧生成 GIF；关闭开关或没有截图时不生成。"""
        if not self.config.SAVE_HISTORY or not self.config.SAVE_GIF:
            return None
        paths = sorted(
            self.directory.glob("step_*.png"),
            key=lambda path: int(path.stem.removeprefix("step_")),
        )
        if not paths:
            return None

        frames = []
        try:
            for path in paths:
                with Image.open(path) as image:
                    frames.append(image.convert("RGB"))
            size = (max(frame.width for frame in frames), max(frame.height for frame in frames))
            # 视口变化时补白到最大画布，避免后续帧被首帧尺寸裁切。
            for index, frame in enumerate(frames):
                if frame.size != size:
                    canvas = Image.new("RGB", size, "white")
                    canvas.paste(frame, (0, 0))
                    frame.close()
                    frames[index] = canvas
            path = self.directory / "recording.gif"
            frames[0].save(
                path, format="GIF", save_all=True, append_images=frames[1:],
                duration=500, loop=0, optimize=False,
            )
            return path
        finally:
            for frame in frames:
                frame.close()
