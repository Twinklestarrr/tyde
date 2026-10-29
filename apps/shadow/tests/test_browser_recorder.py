"""验证截图落盘、任务目录边界和可选 GIF 的实际图像内容。"""

import base64
from io import BytesIO

from PIL import Image, UnidentifiedImageError
import pytest

from browser import recorder as recorder_module
from config.settings import Settings


@pytest.fixture
def config(tmp_path):
    return Settings(_env_file=None, HISTORY_SAVE_PATH=str(tmp_path / "sessions"))


def screenshot(color="red", size=(4, 3), format="PNG"):
    output = BytesIO()
    with Image.new("RGB", size, color) as image:
        image.save(output, format=format)
    return base64.b64encode(output.getvalue()).decode("ascii")


@pytest.mark.parametrize("format", ["PNG", "JPEG"])
def test_screenshot_is_saved_as_a_real_png(config, format):
    recorder = recorder_module.ScreenshotRecorder("task_001", config=config)

    path = recorder.save_screenshot(1, screenshot(format=format))

    assert path == recorder.directory / "step_000001.png"
    with Image.open(path) as image:
        assert image.format == "PNG"
        assert image.size == (4, 3)


def test_disabled_history_never_writes_images_or_gif(config):
    config.SAVE_HISTORY = False
    config.SAVE_GIF = True
    recorder = recorder_module.ScreenshotRecorder("task_001", config=config)

    assert recorder.save_screenshot(1, "无效截图也不会处理") is None
    assert recorder.finish() is None
    assert not recorder.directory.exists()


@pytest.mark.parametrize("value", [None, ""])
def test_missing_screenshot_does_not_create_a_directory(config, value):
    recorder = recorder_module.ScreenshotRecorder("task_001", config=config)

    assert recorder.save_screenshot(1, value) is None
    assert not recorder.directory.exists()


@pytest.mark.parametrize("task_id", ["", "..", "../outside"])
def test_task_archive_cannot_escape_or_reuse_the_archive_root(config, task_id):
    with pytest.raises(ValueError, match="任务目录"):
        recorder_module.ScreenshotRecorder(task_id, config=config)


def test_absolute_task_directory_outside_the_archive_root_is_rejected(config, tmp_path):
    with pytest.raises(ValueError, match="任务目录"):
        recorder_module.ScreenshotRecorder(str(tmp_path / "outside"), config=config)


def test_relative_archive_root_is_anchored_to_the_project(config, tmp_path, monkeypatch):
    monkeypatch.setattr(recorder_module, "PROJECT_ROOT", tmp_path, raising=False)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    config.HISTORY_SAVE_PATH = "records"

    recorder = recorder_module.ScreenshotRecorder("task_001", config=config)
    path = recorder.save_screenshot(1, screenshot())

    assert path == tmp_path / "records/task_001/step_000001.png"


@pytest.mark.parametrize("value", ["无效 base64", base64.b64encode(b"not an image").decode()])
def test_invalid_image_is_reported_without_leaving_an_archive(config, value):
    recorder = recorder_module.ScreenshotRecorder("task_001", config=config)

    with pytest.raises((ValueError, UnidentifiedImageError)):
        recorder.save_screenshot(1, value)

    assert not recorder.directory.exists()


def test_negative_step_is_rejected_without_writing(config):
    recorder = recorder_module.ScreenshotRecorder("task_001", config=config)

    with pytest.raises(ValueError, match="步数"):
        recorder.save_screenshot(-1, screenshot())

    assert not recorder.directory.exists()


def test_gif_is_disabled_by_default_but_png_is_still_saved(config):
    recorder = recorder_module.ScreenshotRecorder("task_001", config=config)

    path = recorder.save_screenshot(1, screenshot())

    assert path.is_file()
    assert recorder.finish() is None
    assert not list(recorder.directory.glob("*.gif"))


def test_empty_recording_does_not_create_a_gif(config):
    config.SAVE_GIF = True
    recorder = recorder_module.ScreenshotRecorder("task_001", config=config)

    assert recorder.finish() is None
    assert not recorder.directory.exists()


def test_gif_uses_numeric_step_order_and_preserves_frames_of_different_sizes(config):
    config.SAVE_GIF = True
    recorder = recorder_module.ScreenshotRecorder("task_001", config=config)
    recorder.save_screenshot(10, screenshot("blue", (3, 5)))
    recorder.save_screenshot(2, screenshot("lime", (4, 2)))
    recorder.save_screenshot(1, screenshot("red", (2, 3)))

    path = recorder.finish()

    with Image.open(path) as image:
        assert image.format == "GIF"
        assert image.n_frames == 3
        assert image.size == (4, 5)
        assert image.info["duration"] == 500
        for index, color in enumerate([(255, 0, 0), (0, 255, 0), (0, 0, 255)]):
            image.seek(index)
            assert image.convert("RGB").getpixel((0, 0)) == color
        assert image.convert("RGB").getpixel((3, 4)) == (255, 255, 255)
