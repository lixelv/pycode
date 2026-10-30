"""Checks a student's solution against an admin's tests (``name.test.py``).

The tests are ``test_*`` functions with ``assert``. They run from source
(never written to disk) next to the solution, in the admin's browser; only
names, pass/fail and the tests' own assert messages go back to the student
(errors from the solution are reported by built-in type name only). The
solution shares the interpreter with the tests, so results are a learning
aid, not a grade: deliberate code can still fake them.

``polycode_test.run(stdin, timeout, ram_usage)`` runs the solution as a
program with that input and returns what it printed (input() prompts are not
included). ``timeout`` (seconds) and ``ram_usage`` (MB, 10**6 bytes) are
limits; ``None`` or ``0`` turns one off. A limit that is on is also measured
and shown with the test's result.
"""

import builtins
import contextlib
import io
import os
import runpy
import secrets
import sys
import time
import tracemalloc
import types

MAX_MESSAGE = 200

_solution = ""
# What the current test's run() calls measured: "time" (sum), "memory" (peak).
_measures: dict = {}


class TimeLimitExceeded(TimeoutError):
    def __init__(self, used: float, limit: float):
        super().__init__(used, limit)
        self.used = used
        self.limit = limit


class MemoryLimitExceeded(MemoryError):
    def __init__(self, used: float, limit: float):
        super().__init__(used, limit)
        self.used = used
        self.limit = limit


def _deadline(ms: int) -> None:
    """Asks the page to interrupt us after ms (0 cancels)."""
    import js  # Pyodide only; the unit tests replace this hook

    js.polycode_deadline(ms)


_now = time.perf_counter


def run(stdin: str = "", timeout: float | None = None, ram_usage: float | None = None) -> str:
    """Runs the solution as ``__main__`` with this input; returns its output.
    Raises TimeLimitExceeded / MemoryLimitExceeded when a limit is exceeded."""
    lines = io.StringIO(stdin)
    out = io.StringIO()

    def fake_input(prompt=""):
        line = lines.readline()
        if not line:
            raise EOFError("the program asked for more input than the test gave")
        return line.rstrip("\n")

    saved = builtins.input
    builtins.input = fake_input
    if ram_usage:
        tracemalloc.start()
    if timeout:
        _deadline(max(1, round(timeout * 1000)))
    started = _now()
    interrupted = False
    try:
        with contextlib.redirect_stdout(out):
            runpy.run_path(_solution, run_name="__main__")
    except KeyboardInterrupt:
        if not timeout:
            raise
        interrupted = True
    finally:
        used = _now() - started
        if timeout:
            _deadline(0)
        builtins.input = saved
        if ram_usage:
            peak = tracemalloc.get_traced_memory()[1]
            tracemalloc.stop()
            _measures["memory"] = max(_measures.get("memory", 0), peak)
        if timeout:
            _measures["time"] = _measures.get("time", 0.0) + used
    if timeout and (interrupted or used > timeout):
        raise TimeLimitExceeded(max(used, timeout), timeout)
    if ram_usage and peak > ram_usage * 1e6:
        raise MemoryLimitExceeded(peak, ram_usage * 1e6)
    return out.getvalue()


def _short(text: str) -> str:
    return text if len(text) <= MAX_MESSAGE else text[: MAX_MESSAGE - 1] + "…"


def _failure(err: BaseException, tests: str) -> str:
    """What the student is told. Only the tests' own asserts carry text: the
    solution must not be able to send anything back through messages."""
    if isinstance(err, AssertionError):
        tb = err.__traceback__
        while tb and tb.tb_next:
            tb = tb.tb_next
        if tb and tb.tb_frame.f_code.co_filename == tests:
            return _short(str(err) or "assertion failed")
        return "AssertionError"
    if isinstance(err, (TimeLimitExceeded, MemoryLimitExceeded)):
        # Built only from numbers: the solution cannot pass text through these.
        try:
            used, limit = float(err.used), float(err.limit)
        except BaseException:  # noqa: BLE001
            return type(err).__name__
        if isinstance(err, TimeLimitExceeded):
            return f"time limit {limit:g} s exceeded: {used:.2f} s"
        return f"memory limit {limit / 1e6:g} MB exceeded: {used / 1e6:.1f} MB"
    kind = type(err)
    return kind.__name__ if kind.__module__ == "builtins" else "error"


def run_tests(project: str, solution: str, source: str) -> list:
    """Runs every test_* function of ``source`` against ``project/solution``."""
    global _solution
    _solution = os.path.join(project, solution)
    folder = os.path.dirname(_solution)
    helper = types.ModuleType("polycode_test")
    helper.run = run
    helper.TimeLimitExceeded = TimeLimitExceeded
    helper.MemoryLimitExceeded = MemoryLimitExceeded
    # The old name keeps working for existing tests.
    sys.modules["polycode_test"] = sys.modules["pycode_test"] = helper
    for path in (folder, project):
        if path not in sys.path:
            sys.path.insert(0, path)
    module = types.ModuleType("polycode_check")
    # A name the solution cannot know, to tell the tests' frames from its own.
    tests = f"<tests-{secrets.token_hex(8)}>"
    try:
        code = compile(source, tests, "exec")
        del source
        exec(code, module.__dict__)
    except SyntaxError as err:
        return [{"name": "tests", "ok": False, "message": _short(f"SyntaxError: {err.msg} (line {err.lineno})")}]
    except BaseException as err:  # noqa: BLE001 - any error in the test file is reported
        return [{"name": "tests", "ok": False, "message": _failure(err, tests)}]
    results = []
    try:
        for name, fn in list(module.__dict__.items()):
            # def test_…(): functions named so (not lambdas or helpers bound to such names).
            if not name.startswith("test_") or not isinstance(fn, types.FunctionType) or fn.__name__ != name:
                continue
            _measures.clear()
            try:
                fn()
                result = {"name": name, "ok": True, "message": ""}
            except BaseException as err:  # noqa: BLE001
                result = {"name": name, "ok": False, "message": _failure(err, tests)}
            results.append({**result, **_measures})
    finally:
        sys.modules.pop("polycode_test", None)
        sys.modules.pop("pycode_test", None)
        module.__dict__.clear()
    return results
