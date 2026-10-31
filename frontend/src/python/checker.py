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

A C++ solution (``kind="cpp"``) is already compiled: its ``run()`` has the same
limits and runs the program through the page (``_run_outside``). Its output
includes prompts, since they are ordinary ``cout``; input past the end of
``stdin`` is EOF. ``run()`` fails the test if the program exits non-zero, crashes,
is cut by the output limit or does not start, whatever it printed.

``polycode_test.module`` holds the solution's declarations (imports, defs,
classes, constants without calls); the program itself is not run.

A file with a top-level ``polycode_test.tournament(id)`` is a tournament: its
tests earn ``points(amount)``, the first failure skips the rest, and the
solution never runs in this interpreter. Its files are not given to it, and
``run()`` goes through the page like a C++ solution's (``_run_isolated``), so
the solution cannot reach the tests or the results.
"""

import ast
import builtins
import contextlib
import io
import math
import os
import runpy
import secrets
import sys
import time
import tracemalloc
import types

MAX_MESSAGE = 200
CHECK_LIMIT = 30  # seconds; the page stops a whole check after this
TOURNAMENT_LIMIT = 120  # the same for a tournament's check
MAX_TOURNAMENT_ID = 64

_solution = ""
_check_started = 0.0
_check_limit = CHECK_LIMIT
_in_tournament = False
_points: dict = {}  # test function -> what it is worth
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


class ExitCodeError(RuntimeError):
    def __init__(self, code: int):
        super().__init__(code)
        self.code = code


class OutputLimitExceeded(RuntimeError):
    pass


class ProgramNotStarted(RuntimeError):
    pass


FILE_ERRORS = {
    "place": "tournament() must be one top-level statement",
    "args": "tournament(id, private=False): id is a string of 1 to 64 characters",
    "points": "points(amount): amount is a positive number",
}


class TestFileError(Exception):
    """The test file misuses tournament() or points(); ``code`` is a key of FILE_ERRORS."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def tournament(id: str, private: bool = False) -> None:
    """The real work is in tournament_of(), before the file runs. Getting here outside
    a tournament means tournament_of() did not see this call (an alias)."""
    if not _in_tournament:
        raise TestFileError("place")


_tournament = tournament  # run_tests has a parameter of this name


def points(amount: float):
    """A decorator: what the test earns in a tournament. Gives back the same function."""
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not 0 < amount < math.inf:
        raise TestFileError("points")

    def worth(fn):
        _points[fn] = amount
        return fn

    return worth


def _tournament_args(call: ast.Call) -> dict:
    invalid = {"error": FILE_ERRORS["args"]}
    if len(call.args) > 2:
        return invalid
    values = dict(zip(("id", "private"), call.args))
    for keyword in call.keywords:
        if keyword.arg not in ("id", "private") or keyword.arg in values:
            return invalid
        values[keyword.arg] = keyword.value
    name = values.get("id")
    private = values.get("private", ast.Constant(False))
    if not isinstance(name, ast.Constant) or not isinstance(private, ast.Constant):
        return invalid
    if not isinstance(name.value, str) or not 1 <= len(name.value) <= MAX_TOURNAMENT_ID or not isinstance(private.value, bool):
        return invalid
    return {"id": name.value, "private": private.value}


def tournament_of(source: str) -> dict | None:
    """Whether a test file is a tournament, from its text alone: None, {id, private}
    or {error}. A syntax error is None: run_tests reports it."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return None

    def named(func) -> bool:
        return (isinstance(func, ast.Name) and func.id == "tournament") or (isinstance(func, ast.Attribute) and func.attr == "tournament" and isinstance(func.value, ast.Name))

    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and named(node.func)]
    if not calls:
        return None
    statements = [node.value for node in tree.body if isinstance(node, ast.Expr)]
    if len(calls) > 1 or not any(calls[0] is value for value in statements):
        return {"error": FILE_ERRORS["place"]}
    return _tournament_args(calls[0])


def _deadline(ms: int) -> bool:
    """Asks the page to interrupt us after ms. 0 cancels at once (no interrupt
    can arrive after it returns) and says whether the timer fired."""
    import js  # Pyodide only; the unit tests replace this hook

    return js.polycode_deadline(ms)


_now = time.perf_counter


def _cancel_deadline() -> bool:
    """Cancels the timer; True if it fired. An interrupt that lands while
    cancelling counts as fired."""
    fired = False
    while True:
        try:
            return bool(_deadline(0)) or fired
        except KeyboardInterrupt:
            fired = True


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
    started = None
    interrupted = False
    peak = 0
    try:
        try:
            builtins.input = fake_input
            if ram_usage:
                tracemalloc.start()
            if timeout:
                _deadline(max(1, round(timeout * 1000)))
            started = _now()
            with contextlib.redirect_stdout(out):
                runpy.run_path(_solution, run_name="__main__")
        finally:
            # Once cancelled, no interrupt can come: the handler and cleanup below are safe.
            if timeout and _cancel_deadline():
                interrupted = True
    except KeyboardInterrupt:
        if not timeout:
            raise
        interrupted = True
    finally:
        used = 0.0 if started is None else _now() - started
        builtins.input = saved
        if ram_usage and tracemalloc.is_tracing():
            peak = tracemalloc.get_traced_memory()[1]
            tracemalloc.stop()
            _measures["memory"] = max(_measures.get("memory", 0), peak)
        if timeout:
            _measures["time"] = _measures.get("time", 0.0) + used
    if timeout and (interrupted or used > timeout):
        raise TimeLimitExceeded(float(max(used, timeout)), float(timeout))
    if ram_usage and peak > ram_usage * 1e6:
        raise MemoryLimitExceeded(float(peak), float(ram_usage * 1e6))
    return out.getvalue()


def _short(text: str) -> str:
    return text if len(text) <= MAX_MESSAGE else text[: MAX_MESSAGE - 1] + "…"


def _failure(err: BaseException, tests: str, isolated: bool = False) -> str:
    """What the student is told. Only the tests' own asserts carry text: the
    solution must not be able to send anything back through messages."""
    if isinstance(err, TestFileError):
        return (type(err.code) is str and FILE_ERRORS.get(err.code)) or "error"
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
            return _short(f"time limit {limit:g} s exceeded: {used:.2f} s")
        return _short(f"memory limit {limit / 1e6:g} MB exceeded: {used / 1e6:.1f} MB")
    # Fixed text or an integer: the program's output never gets here. A solution sharing
    # this interpreter never gets these from run(), but can reach the classes through sys.modules.
    if isolated:
        if isinstance(err, OutputLimitExceeded):
            return "output limit exceeded"
        if isinstance(err, ProgramNotStarted):
            return "the program did not start"
        if isinstance(err, ExitCodeError):
            try:
                return _short(f"exit code {int(err.code)}")
            except BaseException:  # noqa: BLE001
                return type(err).__name__
    kind = type(err)
    return kind.__name__ if kind.__module__ == "builtins" else "error"


def _measured() -> dict:
    """The test's measures as plain numbers (the solution can reach _measures)."""
    measured = {}
    for key, kind in (("time", float), ("memory", int)):
        try:
            value = kind(_measures[key])
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if math.isfinite(value) and value >= 0:
            measured[key] = value
    return measured


def _run_outside(stdin: str, timeout_ms: int, trace_memory: bool = False) -> dict:
    """Runs the solution outside this interpreter, through the page, blocking:
    {stdout, memory, timedOut, exitCode, failure, elapsed}. ``failure`` is "",
    "output_limit" or "not_started"; exitCode alone cannot tell them apart (a program
    may return 130 or 1 itself). ``elapsed`` is in seconds, from the program's start."""
    import js  # Pyodide only; the unit tests replace this hook

    result = js.polycode_run_outside(stdin, timeout_ms, trace_memory)
    return {
        "stdout": result.stdout,
        "memory": result.memory,
        "timedOut": result.timedOut,
        "exitCode": result.exitCode,
        "failure": result.failure,
        "elapsed": result.elapsed,
    }


def _run_isolated(stdin: str = "", timeout: float | None = None, ram_usage: float | None = None) -> str:
    """run() for a solution outside this interpreter (C++, a tournament's). Without
    ``timeout`` it may use what is left of the check."""
    ms = round(timeout * 1000) if timeout else round((_check_limit - (_now() - _check_started)) * 1000)
    ms = max(1, ms)
    result = _run_outside(stdin, ms, bool(ram_usage))
    used = result["elapsed"]
    memory = result["memory"]
    if timeout:
        _measures["time"] = _measures.get("time", 0.0) + used
    if ram_usage:
        _measures["memory"] = max(_measures.get("memory", 0), memory)
    if result["timedOut"] or (timeout and used > timeout):
        limit = timeout or ms / 1000
        raise TimeLimitExceeded(float(max(used, limit)), float(limit))
    if ram_usage and memory > ram_usage * 1e6:
        raise MemoryLimitExceeded(float(memory), float(ram_usage * 1e6))
    if result["failure"] == "output_limit":
        raise OutputLimitExceeded()
    if result["failure"]:
        raise ProgramNotStarted()
    if result["exitCode"] != 0:
        raise ExitCodeError(result["exitCode"])
    return result["stdout"]


def _missing(name: str):
    raise AttributeError(f"module 'polycode_test' has no attribute {name!r}")


def declarations(source: str, filename: str) -> types.ModuleType:
    """A module with only the top-level declarations of ``source``: imports,
    defs, classes and assignments whose value contains no call."""
    kept = []
    for node in ast.parse(source, filename).body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kept.append(node)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            if node.value is None or not any(isinstance(n, ast.Call) for n in ast.walk(node.value)):
                kept.append(node)
    code = compile(ast.Module(body=kept, type_ignores=[]), filename, "exec")
    module = types.ModuleType(os.path.splitext(os.path.basename(filename))[0])
    exec(code, module.__dict__)
    return module


def run_tests(project: str, solution: str, source: str, kind: str = "python", tournament: bool = False) -> list:
    """Runs every test_* function of ``source`` against ``project/solution``.
    ``kind`` is the solution's language: "python" or "cpp". In a ``tournament`` (see
    tournament_of) the first failure skips the rest and the project stays away from us."""
    global _solution, _check_started, _check_limit, _in_tournament
    _check_started = _now()
    _check_limit = TOURNAMENT_LIMIT if tournament else CHECK_LIMIT
    _in_tournament = tournament
    _points.clear()
    isolated = kind == "cpp" or tournament
    _solution = os.path.join(project, solution)
    folder = os.path.dirname(_solution)
    helper = types.ModuleType("polycode_test")
    helper.run = _run_isolated if isolated else run
    helper.tournament = _tournament
    helper.points = points
    helper.TimeLimitExceeded = TimeLimitExceeded
    helper.MemoryLimitExceeded = MemoryLimitExceeded
    cached = []

    def module_of_solution():
        if isolated:
            raise TypeError("module is only for Python solutions outside a tournament")
        if not cached:
            with open(_solution, encoding="utf-8") as f:
                cached.append(declarations(f.read(), _solution))
        return cached[0]

    # Built on first use (PEP 562), once per check.
    helper.__getattr__ = lambda name: module_of_solution() if name == "module" else _missing(name)
    # The old name keeps working for existing tests.
    sys.modules["polycode_test"] = sys.modules["pycode_test"] = helper
    for path in () if tournament else (folder, project):
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
        return [{"name": "tests", "ok": False, "message": _failure(err, tests, isolated)}]
    results = []
    failed = False
    try:
        for name, fn in list(module.__dict__.items()):
            # def test_…(): functions named so (not lambdas or helpers bound to such names).
            if not name.startswith("test_") or not isinstance(fn, types.FunctionType) or fn.__name__ != name:
                continue
            worth = {"points": _points.get(fn, 0)} if tournament else {}
            if tournament and failed:
                results.append({"name": name, "ok": False, "message": "", "skipped": True, **worth})
                continue
            _measures.clear()
            try:
                fn()
                result = {"name": name, "ok": True, "message": ""}
            except BaseException as err:  # noqa: BLE001
                result = {"name": name, "ok": False, "message": _failure(err, tests, isolated)}
                failed = True
            results.append({**result, **_measured(), **worth})
    finally:
        sys.modules.pop("polycode_test", None)
        sys.modules.pop("pycode_test", None)
        module.__dict__.clear()
    return results
