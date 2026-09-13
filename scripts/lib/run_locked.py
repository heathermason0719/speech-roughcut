#!/usr/bin/env python3
"""Hold an OS-owned lock while the Node invocation owner runs; death releases it."""
import os
import signal
import subprocess
import sys

base, node, script, *args = sys.argv[1:]
os.makedirs(base, exist_ok=True)
with open(os.path.join(base, '.run.lock'), 'a+b') as lock:
    try:
        if os.name == 'nt':
            import msvcrt
            if os.path.getsize(lock.name) == 0:
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print('❌ invocation 已有活动写入所有者，不能并发执行或恢复', file=sys.stderr)
        sys.exit(1)
    env = dict(os.environ, SPEECH_ROUGHCUT_LOCKED_BASE=base)
    child = subprocess.Popen([node, script, *args], env=env)
    def stop(_signum, _frame):
        child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    sys.exit(child.wait())
