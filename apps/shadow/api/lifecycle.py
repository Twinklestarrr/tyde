"""用操作系统文件锁保证本地 Agent 同时仅运行一个实例。"""

import errno
import os
from pathlib import Path
from typing import TextIO

from config.settings import settings


class Lifecycle:
    def __init__(self, pid_file: str | Path | None = None):
        self.pid_file = Path(pid_file if pid_file is not None else settings.PID_FILE_PATH)
        self._file: TextIO | None = None

    def acquire(self) -> bool:
        """非阻塞加锁；只有持锁实例能够写入 PID。"""
        if self._file is not None:
            return True
        self.pid_file.parent.mkdir(parents=True, exist_ok=True)
        handle = self.pid_file.open("a+", encoding="ascii")
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            handle.close()
            if error.errno in (errno.EACCES, errno.EAGAIN):
                return False
            raise

        try:
            handle.seek(0)
            handle.truncate()
            handle.write(str(os.getpid()))
            handle.flush()
        except BaseException:
            handle.close()
            raise
        self._file = handle
        return True

    def cleanup(self) -> None:
        """清空 PID 并关闭句柄释放锁；保留文件以避免删除重建的竞争。"""
        handle, self._file = self._file, None
        if handle is None:
            return
        try:
            handle.seek(0)
            handle.truncate()
            handle.flush()
        finally:
            handle.close()
