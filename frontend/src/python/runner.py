"""Runs the user's program inside Pyodide as ``__main__``.

The source is written to ``main.py`` first so tracebacks show its lines.
"""

import ast
import builtins
import contextlib
import io
import json
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


def run_batch(path: str, stdin: str, arm=None, trace_memory: bool = False, call: str = "") -> dict:
    """Runs ``path`` with a fixed input for a tournament's check: {exitCode, memory}.

    input() prompts are not printed, reading past ``stdin`` raises EOFError.
    ``memory`` is the tracemalloc peak in bytes, 0 unless ``trace_memory``.
    With ``call`` (JSON ``{"name", "args"}``) the file is not run: its declarations are
    loaded and that function is called; stdout is then the result as one line of JSON.
    Each run has streams of its own: a program may replace or close them
    (``io.TextIOWrapper(sys.stdout.buffer)``), and the next run must not notice.
    """
    import io
    import tracemalloc

    lines = io.TextIOWrapper(io.BytesIO(stdin.encode("utf-8", "replace")), encoding="utf-8")
    out = open(1, "w", encoding="utf-8", closefd=False)
    err = open(2, "w", encoding="utf-8", errors="backslashreplace", closefd=False)

    def fake_input(prompt=""):
        line = lines.readline()
        if not line:
            raise EOFError("the program asked for more input than the test gave")
        return line.rstrip("\n")

    saved = builtins.input, sys.stdin, sys.stdout, sys.stderr
    builtins.input, sys.stdin, sys.stdout, sys.stderr = fake_input, lines, out, err
    memory = 0
    if trace_memory:
        tracemalloc.start()
    try:
        code = run_main(path, arm=arm, call=json.loads(call) if call else None)
        if trace_memory:
            memory = tracemalloc.get_traced_memory()[1]
    finally:
        if trace_memory and tracemalloc.is_tracing():
            tracemalloc.stop()
        _flush(out)
        _flush(err)
        builtins.input, sys.stdin, sys.stdout, sys.stderr = saved
    return {"exitCode": code, "memory": memory}


def _flush(stream) -> None:
    """A program may have closed its streams; that does not change how it ended."""
    try:
        stream.flush()
    except (ValueError, OSError):
        pass


def without_internal_frames(tb, folder: str = os.path.dirname(os.path.abspath(__file__))):
    """Ends a traceback before our own wrappers (time.sleep), which mean nothing to a student."""
    head = tb
    while tb and tb.tb_next:
        if tb.tb_next.tb_frame.f_code.co_filename.startswith(folder + os.sep):
            tb.tb_next = None
            break
        tb = tb.tb_next
    return head


def declaration_code(source: str, filename: str):
    """Compiles only the top-level declarations of ``source``: imports, defs,
    classes and assignments whose value contains no call."""
    kept = []
    for node in ast.parse(source, filename).body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kept.append(node)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            if node.value is None or not any(isinstance(n, ast.Call) for n in ast.walk(node.value)):
                kept.append(node)
    return compile(ast.Module(body=kept, type_ignores=[]), filename, "exec")


def run_main(path: str = "main.py", debugger=None, arm=None, call=None) -> int:
    """Runs ``path`` as ``__main__``; with a debugger (a bdb.Bdb), under it.

    ``arm`` turns interrupts on just before the program starts and raises
    KeyboardInterrupt for a Stop that came earlier. With ``call`` ({"name", "args"}) only
    the declarations run, then the function is called and its result printed as JSON
    (what the function prints itself is dropped).
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
        code = declaration_code(source, path) if call else compile(source, path, "exec")
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
            if call:
                function = namespace.get(call["name"])
                if not callable(function):
                    raise NameError(f"the solution has no function {call['name']!r}")
                with contextlib.redirect_stdout(io.StringIO()):
                    value = function(*call["args"])
                print(json.dumps(value))
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
        _flush(sys.stdout)
        _flush(sys.stderr)
    return 0
