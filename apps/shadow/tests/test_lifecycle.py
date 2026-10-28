import os
from pathlib import Path
import subprocess
import sys

from api import lifecycle as lifecycle_module


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def acquire_in_subprocess(pid_file, cleanup=True):
    code = """
import sys
from api.lifecycle import Lifecycle
lock = Lifecycle(sys.argv[1])
acquired = lock.acquire()
print(acquired)
if sys.argv[2] == 'True':
    lock.cleanup()
"""
    result = subprocess.run(
        [sys.executable, "-c", code, str(pid_file), str(cleanup)],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    return result.stdout.strip() == "True"


def test_only_one_process_can_hold_the_lock(tmp_path):
    pid_file = tmp_path / "data" / "agent.pid"
    owner = lifecycle_module.Lifecycle(pid_file)
    other = lifecycle_module.Lifecycle(pid_file)

    assert owner.acquire()
    try:
        assert pid_file.read_text(encoding="ascii") == str(os.getpid())
        assert not acquire_in_subprocess(pid_file)
        assert not other.acquire()
        other.cleanup()
        assert not acquire_in_subprocess(pid_file)
        assert pid_file.read_text(encoding="ascii") == str(os.getpid())
    finally:
        owner.cleanup()

    assert pid_file.exists()
    assert pid_file.read_text(encoding="ascii") == ""
    assert acquire_in_subprocess(pid_file)


def test_stale_pid_does_not_prevent_startup_and_cleanup_is_idempotent(tmp_path):
    pid_file = tmp_path / "agent.pid"
    pid_file.write_text("99999999", encoding="ascii")
    lock = lifecycle_module.Lifecycle(pid_file)

    try:
        assert lock.acquire()
        assert lock.acquire()
        assert pid_file.read_text(encoding="ascii") == str(os.getpid())
    finally:
        lock.cleanup()
        lock.cleanup()

    assert acquire_in_subprocess(pid_file)


def test_process_exit_releases_lock_without_explicit_cleanup(tmp_path):
    pid_file = tmp_path / "agent.pid"
    assert acquire_in_subprocess(pid_file, cleanup=False)
    assert pid_file.read_text(encoding="ascii")

    lock = lifecycle_module.Lifecycle(pid_file)
    try:
        assert lock.acquire()
        assert pid_file.read_text(encoding="ascii") == str(os.getpid())
    finally:
        lock.cleanup()
