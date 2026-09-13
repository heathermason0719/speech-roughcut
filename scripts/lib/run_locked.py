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
    env = dict(os.environ,
               SPEECH_ROUGHCUT_LOCKED_BASE=base,
               SPEECH_ROUGHCUT_LOCK_SUPERVISOR_PID=str(os.getpid()))
    popen_options = {}
    if os.name != 'nt':
        # Retain this open file description in the worker: a killed supervisor
        # must not release the flock while the Node writer is still alive.
        popen_options['pass_fds'] = (lock.fileno(),)
    child = subprocess.Popen([node, script, *args], env=env, **popen_options)
    print(f'LOCK_SUPERVISOR_PID={os.getpid()} LOCK_WORKER_PID={child.pid}', flush=True)
    def stop(_signum, _frame):
        child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    sys.exit(child.wait())
