"""Runs the user's program inside Pyodide as ``__main__``.

The source is written to ``main.py`` first so tracebacks show its lines.
"""

import builtins
import os
import sys
import traceback


PROJECT = "/home/pyodide/project"


SLEEP_STEP = 0.05
# Beyond this time.sleep has its own answer (OverflowError): 2**63 ns is about 9.2e9 s.
SLEEP_RANGE = 1e10


def sliced_sleep(seconds, sleep, check, step: float = SLEEP_STEP) -> None:
    """Sleeps in slices, checking for an interrupt after each.

    Pyodide looks at the interrupt buffer only every so many eval-breaker
    checks, so a long sleep would notice a Stop seconds late.
    """
    if not isinstance(seconds, (int, float)) or seconds != seconds or abs(seconds) >= SLEEP_RANGE:
        sleep(seconds)  # time.sleep's own answer: TypeError, ValueError, OverflowError
        check()
        return
    if seconds < 0:
        raise ValueError("sleep length must be non-negative")
    remaining = seconds
    while True:
        part = min(remaining, step)
        sleep(part)
        check()
        remaining -= part
        if remaining <= 0:
            return


def install_sleep() -> None:
    """Replaces time.sleep once per interpreter, for runs and checks alike."""
    import functools
    import time

    import pyodide_js

    original = time.sleep

    @functools.wraps(original)
    def sleep(seconds, /):
        sliced_sleep(seconds, original, pyodide_js.checkInterrupt)

    time.sleep = sleep


def write_project(files: dict) -> None:
    """Lays the project out on disk, replacing the previous run's copy."""
    import shutil

    shutil.rmtree(PROJECT, ignore_errors=True)
    for rel, content in files.items():
        path = os.path.join(PROJECT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    os.makedirs(PROJECT, exist_ok=True)
    os.chdir(PROJECT)


def run_batch(path: str, stdin: str, arm=None, trace_memory: bool = False) -> dict:
    """Runs ``path`` with a fixed input for a tournament's check: {exitCode, memory}.

    input() prompts are not printed, reading past ``stdin`` raises EOFError.
    ``memory`` is the tracemalloc peak in bytes, 0 unless ``trace_memory``.
    """
    import io
    import tracemalloc

    lines = io.StringIO(stdin)

    def fake_input(prompt=""):
        line = lines.readline()
        if not line:
            raise EOFError("the program asked for more input than the test gave")
        return line.rstrip("\n")

    saved = builtins.input, sys.stdin
    builtins.input, sys.stdin = fake_input, lines
    memory = 0
    if trace_memory:
        tracemalloc.start()
    try:
        code = run_main(path, arm=arm)
        if trace_memory:
            memory = tracemalloc.get_traced_memory()[1]
    finally:
        if trace_memory and tracemalloc.is_tracing():
            tracemalloc.stop()
        builtins.input, sys.stdin = saved
    return {"exitCode": code, "memory": memory}


def without_internal_frames(tb, folder: str = os.path.dirname(os.path.abspath(__file__))):
    """Ends a traceback before our own wrappers (time.sleep), which mean nothing to a student."""
    head = tb
    while tb and tb.tb_next:
        if tb.tb_next.tb_frame.f_code.co_filename.startswith(folder + os.sep):
            tb.tb_next = None
            break
        tb = tb.tb_next
    return head


def run_main(path: str = "main.py", debugger=None, arm=None) -> int:
    """Runs ``path`` as ``__main__``; with a debugger (a bdb.Bdb), under it.

    ``arm`` turns interrupts on just before the program starts and raises
    KeyboardInterrupt for a Stop that came earlier.
    """
    import bdb

    # Like `python path`: the script's folder (and the project root) are importable,
    # and modules from the previous run are imported fresh.
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None) or ""
        if file.startswith(PROJECT + "/"):
            del sys.modules[name]
    for entry in (PROJECT, os.path.dirname(os.path.join(PROJECT, path))):
        if entry not in sys.path:
            sys.path.insert(0, entry)

    with open(path, encoding="utf-8") as f:
        source = f.read()
    try:
        code = compile(source, path, "exec")
    except SyntaxError as exc:
        traceback.print_exception(type(exc), exc, None)
        return 1

    sys.argv = [path]
    namespace = {"__name__": "__main__", "__file__": path, "__builtins__": builtins}
    try:
        if arm:
            arm()
        if debugger:
            debugger.run(code, namespace)
        else:
            exec(code, namespace)
    except bdb.BdbQuit:
        print("\nStopped", file=sys.stderr)
        return 130
    except SystemExit as exc:
        code = exc.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        print(code, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nKeyboardInterrupt", file=sys.stderr)
        return 130
    except BaseException as exc:
        # Drop this bootstrap's frame so the traceback starts in main.py.
        traceback.print_exception(type(exc), exc, without_internal_frames(exc.__traceback__.tb_next))
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    return 0
