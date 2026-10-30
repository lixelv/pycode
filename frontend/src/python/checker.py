"""Checks a student's solution against an admin's tests (``name.test.py``).

The tests are ``test_*`` functions with ``assert``. They run from source
(never written to disk) next to the solution, in the admin's browser; only
names, pass/fail and short messages go back to the student.

``pycode_test.run(stdin)`` runs the solution as a program with that input
and returns what it printed (input() prompts are not included).
"""

import builtins
import contextlib
import io
import os
import runpy
import sys
import types

MAX_MESSAGE = 200

_solution = ""


def run(stdin: str = "") -> str:
    """Runs the solution as ``__main__`` with this input; returns its output."""
    lines = io.StringIO(stdin)
    out = io.StringIO()

    def fake_input(prompt=""):
        line = lines.readline()
        if not line:
            raise EOFError("the program asked for more input than the test gave")
        return line.rstrip("\n")

    saved = builtins.input
    builtins.input = fake_input
    try:
        with contextlib.redirect_stdout(out):
            runpy.run_path(_solution, run_name="__main__")
    finally:
        builtins.input = saved
    return out.getvalue()


def _short(text: str) -> str:
    return text if len(text) <= MAX_MESSAGE else text[: MAX_MESSAGE - 1] + "…"


def _failure(err: BaseException) -> str:
    if isinstance(err, AssertionError):
        return _short(str(err) or "assertion failed")
    return _short(f"{type(err).__name__}: {err}")


def run_tests(project: str, solution: str, source: str) -> list:
    """Runs every test_* function of ``source`` against ``project/solution``."""
    global _solution
    _solution = os.path.join(project, solution)
    folder = os.path.dirname(_solution)
    helper = types.ModuleType("pycode_test")
    helper.run = run
    sys.modules["pycode_test"] = helper
    for path in (folder, project):
        if path not in sys.path:
            sys.path.insert(0, path)
    module = types.ModuleType("pycode_check")
    try:
        code = compile(source, "tests", "exec")
        exec(code, module.__dict__)
    except BaseException as err:  # noqa: BLE001 - any error in the test file is reported
        return [{"name": "tests", "ok": False, "message": _failure(err)}]
    results = []
    try:
        for name, fn in list(module.__dict__.items()):
            if not name.startswith("test") or not callable(fn):
                continue
            try:
                fn()
                results.append({"name": name, "ok": True, "message": ""})
            except BaseException as err:  # noqa: BLE001
                results.append({"name": name, "ok": False, "message": _failure(err)})
    finally:
        sys.modules.pop("pycode_test", None)
        module.__dict__.clear()
    return results
