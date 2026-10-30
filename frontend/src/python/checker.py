"""Checks a student's solution against an admin's tests (``name.test.py``).

The tests are ``test_*`` functions with ``assert``. They run from source
(never written to disk) next to the solution, in the admin's browser; only
names, pass/fail and the tests' own assert messages go back to the student
(errors from the solution are reported by built-in type name only). The
solution shares the interpreter with the tests, so results are a learning
aid, not a grade: deliberate code can still fake them.

``pycode_test.run(stdin)`` runs the solution as a program with that input
and returns what it printed (input() prompts are not included).
"""

import builtins
import contextlib
import io
import os
import runpy
import secrets
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
    kind = type(err)
    return kind.__name__ if kind.__module__ == "builtins" else "error"


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
            if not name.startswith("test") or not callable(fn):
                continue
            try:
                fn()
                results.append({"name": name, "ok": True, "message": ""})
            except BaseException as err:  # noqa: BLE001
                results.append({"name": name, "ok": False, "message": _failure(err, tests)})
    finally:
        sys.modules.pop("pycode_test", None)
        module.__dict__.clear()
    return results
