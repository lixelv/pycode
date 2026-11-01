import _thread
import builtins
import itertools
import os
import re
import sys
import tempfile
import threading
import time
import tracemalloc
import types
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import checker  # noqa: E402

SOLUTION = "print(input())\n"


class RunTestsNames(unittest.TestCase):
    def check(self, source):
        with tempfile.TemporaryDirectory() as project:
            with open(os.path.join(project, "main.py"), "w") as f:
                f.write(SOLUTION)
            return checker.run_tests(project, "main.py", source)

    def test_old_name_works(self):
        res = self.check("import pycode_test\ndef test_a():\n    assert pycode_test.run('x\\n') == 'x\\n'\n")
        self.assertEqual(res, [{"name": "test_a", "ok": True, "message": ""}])

    def test_new_name_works(self):
        res = self.check("import polycode_test\ndef test_a():\n    assert polycode_test.run('x\\n') == 'x\\n'\n")
        self.assertEqual(res, [{"name": "test_a", "ok": True, "message": ""}])

    def test_both_names_are_one_object(self):
        res = self.check("import pycode_test, polycode_test\ndef test_same():\n    assert pycode_test is polycode_test\n")
        self.assertEqual(res, [{"name": "test_same", "ok": True, "message": ""}])

    def test_modules_removed_afterwards(self):
        self.check("import polycode_test\n")
        self.assertNotIn("pycode_test", sys.modules)
        self.assertNotIn("polycode_test", sys.modules)


QUIET = "print(1)\n"  # needs no input
SPIN = "for _ in range(3 * 10**8):\n    pass\n"  # ~4 s of work: a bounded stand-in for `while True: pass`


class Limits(unittest.TestCase):
    HOOKS = ("_deadline", "_now")

    def setUp(self):
        self.saved = {name: getattr(checker, name, None) for name in self.HOOKS}
        self.timer = None
        checker._deadline = lambda ms: None

    def tearDown(self):
        for name, value in self.saved.items():
            if value is None:
                if hasattr(checker, name):
                    delattr(checker, name)
            else:
                setattr(checker, name, value)
        if self.timer:
            self.timer.cancel()
        if tracemalloc.is_tracing():
            tracemalloc.stop()

    def interrupt_after_ms(self):
        """A page-like deadline: interrupts the main thread after ms; 0 cancels."""

        def deadline(ms):
            if self.timer:
                self.timer.cancel()
                self.timer = None
            if ms:
                self.timer = threading.Timer(ms / 1000, _thread.interrupt_main)
                self.timer.start()

        checker._deadline = deadline

    def check(self, source, solution=SOLUTION):
        with tempfile.TemporaryDirectory() as project:
            with open(os.path.join(project, "main.py"), "w") as f:
                f.write(solution)
            return checker.run_tests(project, "main.py", source)

    def run_direct(self, solution, **limits):
        with tempfile.TemporaryDirectory() as project:
            path = os.path.join(project, "main.py")
            with open(path, "w") as f:
                f.write(solution)
            checker._solution = path
            return checker.run("", **limits)

    def test_time_limit(self):
        self.interrupt_after_ms()
        started = time.perf_counter()
        with self.assertRaises(checker.TimeLimitExceeded) as caught:
            self.run_direct(SPIN, timeout=0.2)
        self.assertLess(time.perf_counter() - started, 2.0)  # interrupted, not run to the end
        self.assertEqual(caught.exception.limit, 0.2)
        self.assertGreaterEqual(caught.exception.used, 0.2)

    def test_time_limit_message(self):
        self.interrupt_after_ms()
        res = self.check("import polycode_test\ndef test_a():\n    polycode_test.run('', timeout=0.2)\n", SPIN)
        self.assertFalse(res[0]["ok"])
        message = res[0]["message"]
        self.assertTrue(message.startswith("time limit 0.2 s exceeded: "), message)
        self.assertTrue(message.endswith(" s"), message)
        self.assertRegex(message, r"^time limit 0\.2 s exceeded: \d+\.\d\d s$")

    def test_time_limit_swallowed(self):
        # The program catches the interrupt and finishes anyway: the elapsed time still counts.
        clock = itertools.chain([0.0], itertools.repeat(5.0))
        checker._now = lambda: next(clock)
        solution = "try:\n    for _ in range(10**6):\n        pass\nexcept BaseException:\n    pass\n"
        with self.assertRaises(checker.TimeLimitExceeded):
            self.run_direct(solution, timeout=1)

    def test_deadline_set_and_cleared(self):
        calls = []
        checker._deadline = calls.append
        self.run_direct("print(1)\n", timeout=2)
        self.assertEqual(calls, [2000, 0])

    def test_memory_limit(self):
        with self.assertRaises(checker.MemoryLimitExceeded) as caught:
            self.run_direct("x = bytearray(30_000_000)\n", ram_usage=10)
        self.assertEqual(caught.exception.limit, 10_000_000)
        self.assertGreaterEqual(caught.exception.used, 30_000_000)
        self.assertFalse(tracemalloc.is_tracing())

    def test_memory_limit_message(self):
        res = self.check(
            "import polycode_test\ndef test_a():\n    polycode_test.run('', ram_usage=10)\n",
            "x = bytearray(30_000_000)\n",
        )
        self.assertFalse(res[0]["ok"])
        message = res[0]["message"]
        self.assertTrue(message.startswith("memory limit 10 MB exceeded: "), message)
        self.assertRegex(message, r"^memory limit 10 MB exceeded: \d+\.\d MB$")

    def test_measures(self):
        res = self.check('import polycode_test\ndef test_a():\n    polycode_test.run("", timeout=5, ram_usage=100)\n', QUIET)
        self.assertTrue(res[0]["ok"], res)
        self.assertIsInstance(res[0]["time"], float)
        self.assertGreaterEqual(res[0]["time"], 0)
        self.assertIsInstance(res[0]["memory"], int)
        self.assertGreater(res[0]["memory"], 0)

    def test_no_limits_no_measures(self):
        res = self.check('import polycode_test\ndef test_a():\n    polycode_test.run("")\n', QUIET)
        self.assertEqual(res, [{"name": "test_a", "ok": True, "message": ""}])
        self.assertNotIn("time", res[0])
        self.assertNotIn("memory", res[0])

    def test_limits_off_with_zero(self):
        res = self.check('import polycode_test\ndef test_a():\n    polycode_test.run("", timeout=0, ram_usage=0)\n', QUIET)
        self.assertTrue(res[0]["ok"], res)
        self.assertNotIn("time", res[0])
        self.assertNotIn("memory", res[0])

    def late_interrupt(self, fired=False):
        """A deadline whose interrupt lands while it is being cancelled."""
        calls = []

        def deadline(ms):
            calls.append(ms)
            if ms == 0 and calls.count(0) == 1:
                raise KeyboardInterrupt
            return fired

        checker._deadline = deadline
        return calls

    def test_interrupt_while_cancelling(self):
        calls = self.late_interrupt()
        saved = builtins.input
        with self.assertRaises(checker.TimeLimitExceeded):
            self.run_direct(QUIET, timeout=5, ram_usage=100)
        self.assertEqual(calls, [5000, 0, 0])  # cancelled again after the interrupt
        self.assertIs(builtins.input, saved)
        self.assertFalse(tracemalloc.is_tracing())

    def test_fired_on_cancel_counts(self):
        checker._deadline = lambda ms: ms == 0
        with self.assertRaises(checker.TimeLimitExceeded):
            self.run_direct(QUIET, timeout=5)

    def test_late_interrupt_does_not_reach_next_test(self):
        self.late_interrupt()
        res = self.check(
            "import polycode_test\n"
            "def test_a():\n    polycode_test.run('x\\n', timeout=5)\n"
            "def test_b():\n    assert polycode_test.run('y\\n', timeout=5) == 'y\\n'\n"
        )
        self.assertFalse(res[0]["ok"])
        self.assertTrue(res[0]["message"].startswith("time limit 5 s exceeded"), res)
        self.assertTrue(res[1]["ok"], res)

    def test_deadline_error_cleans_up(self):
        def deadline(ms):
            if ms:
                raise TypeError("no hook")

        checker._deadline = deadline
        saved = builtins.input
        with self.assertRaises(TypeError):
            self.run_direct(QUIET, timeout=1, ram_usage=10)
        self.assertIs(builtins.input, saved)
        self.assertFalse(tracemalloc.is_tracing())

    def test_used_and_limit_are_floats(self):
        with self.assertRaises(checker.MemoryLimitExceeded) as caught:
            self.run_direct("x = bytearray(30_000_000)\n", ram_usage=10)
        self.assertIsInstance(caught.exception.used, float)
        self.assertIsInstance(caught.exception.limit, float)

    def test_crafted_limit_errors(self):
        tests = "import polycode_test\ndef test_a():\n    polycode_test.run('')\n"
        res = self.check(tests, "import polycode_test\nraise polycode_test.TimeLimitExceeded(1e300, 1)\n")
        self.assertLessEqual(len(res[0]["message"]), checker.MAX_MESSAGE)
        res = self.check(tests, "import polycode_test\nraise polycode_test.MemoryLimitExceeded('leak', 'x')\n")
        self.assertEqual(res[0]["message"], "MemoryLimitExceeded")

    def test_measures_cannot_override_result(self):
        solution = "import sys\nm = sys.modules['checker']._measures\nm['message'] = 'LEAK'\nm['ok'] = False\nm['time'] = 'str'\n"
        res = self.check("import polycode_test\ndef test_a():\n    polycode_test.run('')\n", solution)
        self.assertEqual(res, [{"name": "test_a", "ok": True, "message": ""}])

    def test_measures_reset_between_tests(self):
        res = self.check(
            "import polycode_test\n"
            "def test_a():\n    polycode_test.run('', timeout=5)\n"
            "def test_b():\n    pass\n",
            QUIET,
        )
        self.assertIn("time", res[0])
        self.assertNotIn("time", res[1])


class ModuleDeclarations(unittest.TestCase):
    SOLUTION = (
        "import math\n"
        "EPS = 1e-9\n"
        "N: int = 3\n"
        "X = compute()\n"
        "Y = [f(1)]\n"
        "a = float(input())\n"
        "def triangulate(x, y, z): return x + y > z + EPS\n"
        "class P: pass\n"
        "print('hi')\n"
        "if __name__ == '__main__':\n"
        "    main()\n"
    )

    def check(self, source, solution=None, name="main.py", kind=None):
        with tempfile.TemporaryDirectory() as project:
            with open(os.path.join(project, name), "w") as f:
                f.write(self.SOLUTION if solution is None else solution)
            if kind is None:
                return checker.run_tests(project, name, source)
            return checker.run_tests(project, name, source, kind=kind)

    def ok(self, body, **kw):
        res = self.check("import polycode_test\ndef test_a():\n" + body, **kw)
        self.assertEqual(res, [{"name": "test_a", "ok": True, "message": ""}])

    def test_functions_and_classes_kept(self):
        self.ok("    m = polycode_test.module\n    assert m.triangulate(3, 4, 5)\n    assert m.P\n    assert m.math.sqrt(4) == 2\n")

    def test_program_statements_dropped(self):
        self.ok("    assert not hasattr(polycode_test.module, 'a')\n")

    def test_annassign_kept(self):
        self.ok("    assert polycode_test.module.N == 3\n")

    def test_plain_constant_kept(self):
        self.ok("    assert polycode_test.module.EPS == 1e-9\n")

    def test_call_in_value_dropped(self):
        self.ok("    assert not hasattr(polycode_test.module, 'X')\n")

    def test_nested_call_dropped(self):
        self.ok("    assert not hasattr(polycode_test.module, 'Y')\n")

    def test_main_guard_not_run(self):
        self.ok("    polycode_test.module\n", solution="def main():\n    raise RuntimeError('ran')\n\nif __name__ == '__main__':\n    main()\n")

    def test_cached_within_one_check(self):
        self.ok("    assert polycode_test.module is polycode_test.module\n")

    def test_cached_across_tests_of_one_check(self):
        res = self.check(
            "import polycode_test\nseen = []\n"
            "def test_a():\n    seen.append(polycode_test.module)\n"
            "def test_b():\n    assert polycode_test.module is seen[0]\n"
        )
        self.assertEqual([r["ok"] for r in res], [True, True])

    def test_nothing_printed(self):
        import io

        buf, saved = io.StringIO(), sys.stdout
        sys.stdout = buf
        try:
            self.ok("    polycode_test.module\n")
        finally:
            sys.stdout = saved
        self.assertNotIn("hi", buf.getvalue())

    def test_syntax_error_reported(self):
        res = self.check("import polycode_test\ndef test_a():\n    polycode_test.module\n", solution="def (:\n")
        self.assertEqual(res[0]["message"], "SyntaxError")
        self.assertFalse(res[0]["ok"])

    def test_cpp_solution_is_type_error(self):
        res = self.check(
            "import polycode_test\ndef test_a():\n    polycode_test.module\n",
            solution="#include <iostream>\nint main() {}\n",
            name="main.cpp",
            kind="cpp",
        )
        self.assertEqual(res, [{"name": "test_a", "ok": False, "message": "TypeError"}])


class CppChecks(unittest.TestCase):
    def setUp(self):
        self.saved = checker._run_outside if hasattr(checker, "_run_outside") else None
        self.calls = []

    def tearDown(self):
        if self.saved is None:
            if hasattr(checker, "_run_outside"):
                del checker._run_outside
        else:
            checker._run_outside = self.saved

    def check(self, source, wasm):
        def hook(stdin, timeout_ms, trace_memory=False):
            self.calls.append(timeout_ms)
            started = checker._now()
            result = wasm(stdin, timeout_ms)
            result.setdefault("elapsed", checker._now() - started)
            return result

        checker._run_outside = hook
        with tempfile.TemporaryDirectory() as project:
            return checker.run_tests(project, "main.cpp", source, kind="cpp")

    @staticmethod
    def upper(s, t):
        return {"stdout": s.upper(), "memory": 2_000_000, "timedOut": False, "exitCode": 0, "failure": ""}

    def test_run_goes_through_the_hook(self):
        res = self.check("import polycode_test\ndef test_a():\n    assert polycode_test.run('ab') == 'AB'\n", self.upper)
        self.assertEqual([r["ok"] for r in res], [True])

    def test_memory_limit(self):
        res = self.check("import polycode_test\ndef test_a():\n    polycode_test.run('x', ram_usage=1)\n", self.upper)
        self.assertFalse(res[0]["ok"])
        self.assertTrue(res[0]["message"].startswith("memory limit 1 MB exceeded"), res[0]["message"])

    def test_time_limit(self):
        res = self.check(
            "import polycode_test\ndef test_a():\n    polycode_test.run('x', timeout=1)\n",
            lambda s, t: {"stdout": "", "memory": 0, "timedOut": True, "exitCode": 0, "failure": ""},
        )
        self.assertFalse(res[0]["ok"])
        self.assertTrue(res[0]["message"].startswith("time limit 1 s exceeded"), res[0]["message"])

    def test_default_timeout_is_the_check_limit(self):
        self.check("import polycode_test\ndef test_a():\n    polycode_test.run('x')\n", self.upper)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(0 < self.calls[0] <= 30000, self.calls)

    def test_measures(self):
        res = self.check(
            "import polycode_test\ndef test_a():\n    polycode_test.run('x', timeout=5, ram_usage=100)\n", self.upper
        )
        self.assertTrue(res[0]["ok"], res)
        self.assertIn("time", res[0])
        self.assertEqual(res[0]["memory"], 2_000_000)


class CppExitStatus(CppChecks):
    """run() of a C++ solution fails on a bad exit, even if the output is right."""

    SECRET = "SECRET-from-the-program"
    RIGHT = "import polycode_test\ndef test_a():\n    assert polycode_test.run('x') == 'SECRET-from-the-program'\n"

    def result(self, code=0, failure="", timed_out=False, memory=2_000_000):
        return lambda s, t: {
            "stdout": self.SECRET,
            "memory": memory,
            "timedOut": timed_out,
            "exitCode": code,
            "failure": failure,
        }

    def failed(self, source, wasm, message):
        res = self.check(source, wasm)
        self.assertFalse(res[0]["ok"], res)
        self.assertEqual(res[0]["message"], message)
        self.assertNotIn("SECRET", res[0]["message"])

    def test_exit_zero_passes(self):
        res = self.check(self.RIGHT, self.result())
        self.assertTrue(res[0]["ok"], res)

    def test_return_1_fails_though_the_output_is_right(self):
        self.failed(self.RIGHT, self.result(code=1), "exit code 1")

    def test_abort_or_trap_fails(self):
        self.failed(self.RIGHT, self.result(code=134), "exit code 134")

    def test_negative_exit_code_is_reported_as_a_number(self):
        self.failed(self.RIGHT, self.result(code=-1), "exit code -1")

    def test_a_program_returning_130_is_not_called_output_limit(self):
        self.failed(self.RIGHT, self.result(code=130), "exit code 130")

    def test_output_limit_has_a_fixed_text(self):
        self.failed(self.RIGHT, self.result(code=130, failure="output_limit"), "output limit exceeded")

    def test_program_that_did_not_start_fails(self):
        self.failed(
            "import polycode_test\ndef test_a():\n    polycode_test.run('x')\n",
            lambda s, t: {"stdout": "", "memory": 0, "timedOut": False, "exitCode": 1, "failure": "not_started"},
            "the program did not start",
        )

    def test_a_test_expecting_empty_output_does_not_pass_when_not_started(self):
        res = self.check(
            "import polycode_test\ndef test_a():\n    assert polycode_test.run('x') == ''\n",
            lambda s, t: {"stdout": "", "memory": 0, "timedOut": False, "exitCode": 1, "failure": "not_started"},
        )
        self.assertFalse(res[0]["ok"], res)

    def test_time_limit_wins_over_exit_code(self):
        res = self.check(
            "import polycode_test\ndef test_a():\n    polycode_test.run('x', timeout=1)\n",
            self.result(code=134, timed_out=True),
        )
        self.assertFalse(res[0]["ok"])
        self.assertTrue(res[0]["message"].startswith("time limit 1 s exceeded"), res[0]["message"])

    def test_memory_limit_wins_over_exit_code(self):
        res = self.check(
            "import polycode_test\ndef test_a():\n    polycode_test.run('x', ram_usage=1)\n",
            self.result(code=134),
        )
        self.assertFalse(res[0]["ok"])
        self.assertTrue(res[0]["message"].startswith("memory limit 1 MB exceeded"), res[0]["message"])

    def test_memory_limit_wins_over_output_limit(self):
        res = self.check(
            "import polycode_test\ndef test_a():\n    polycode_test.run('x', ram_usage=1)\n",
            self.result(code=130, failure="output_limit"),
        )
        self.assertTrue(res[0]["message"].startswith("memory limit 1 MB exceeded"), res[0]["message"])

    def test_measures_are_kept_on_a_bad_exit(self):
        res = self.check(
            "import polycode_test\ndef test_a():\n    polycode_test.run('x', timeout=5, ram_usage=100)\n",
            self.result(code=1),
        )
        self.assertEqual(res[0]["message"], "exit code 1")
        self.assertIn("time", res[0])
        self.assertEqual(res[0]["memory"], 2_000_000)

    def test_a_later_run_failing_fails_the_test(self):
        codes = iter([0, 3])
        self.failed(
            "import polycode_test\ndef test_a():\n    polycode_test.run('x')\n    polycode_test.run('y')\n",
            lambda s, t: self.result(code=next(codes))(s, t),
            "exit code 3",
        )

    def test_no_opt_in_for_a_non_zero_exit(self):
        for arg in ("check=False", "exit_code=1", "expect_exit=1"):
            res = self.check(
                f"import polycode_test\ndef test_a():\n    polycode_test.run('x', {arg})\n",
                self.result(code=1),
            )
            self.assertEqual(res[0]["message"], "TypeError", arg)

    def test_real_hook_passes_exit_status_from_the_worker(self):
        fake = types.ModuleType("js")
        fake.polycode_run_outside = lambda stdin, ms, trace: types.SimpleNamespace(
            stdout="out", memory=7, timedOut=False, exitCode=134, failure="", elapsed=0.5
        )
        real = self.saved
        with unittest.mock.patch.dict(sys.modules, {"js": fake}):
            result = real("x", 100)
        self.assertEqual(result, {"stdout": "out", "memory": 7, "timedOut": False, "exitCode": 134, "failure": "", "elapsed": 0.5})



class ForgedProgramErrors(unittest.TestCase):
    SOURCE = "import sys\ndef test_a():\n    raise sys.modules['checker'].ExitCodeError(123)\n"

    def run_kind(self, kind):
        with tempfile.TemporaryDirectory() as project:
            with open(os.path.join(project, "main.py"), "w") as f:
                f.write("")
            return checker.run_tests(project, "main.py", self.SOURCE, kind=kind)[0]["message"]

    def test_only_a_cpp_solution_reports_them(self):
        self.assertEqual(self.run_kind("python"), "error")
        self.assertEqual(self.run_kind("cpp"), "exit code 123")


HEAD = "import polycode_test as t\nt.tournament('x')\n"


def checker_run_plain(source):
    with tempfile.TemporaryDirectory() as project:
        with open(os.path.join(project, "main.py"), "w") as f:
            f.write(SOLUTION)
        return checker.run_tests(project, "main.py", source, tournament=False)


class Tournament(unittest.TestCase):
    def setUp(self):
        self.saved = getattr(checker, "_run_outside", None)
        self.calls = []
        self.answer = None

    def tearDown(self):
        if self.saved is None:
            if hasattr(checker, "_run_outside"):
                del checker._run_outside
        else:
            checker._run_outside = self.saved

    def check(self, source, project=None):
        def hook(stdin, timeout_ms, trace_memory):
            self.calls.append(timeout_ms)
            if self.answer is not None:
                return dict(self.answer)
            return {"stdout": stdin, "memory": 0, "timedOut": False, "exitCode": 0, "failure": "", "elapsed": 0.0}

        checker._run_outside = hook
        if project is not None:
            return checker.run_tests(project, "main.py", source, tournament=True)
        with tempfile.TemporaryDirectory() as folder:
            with open(os.path.join(folder, "main.py"), "w") as f:
                f.write(SOLUTION)
            return checker.run_tests(folder, "main.py", source, tournament=True)

    def test_tournament_of(self):
        self.assertIsNone(checker.tournament_of("x = 1\n"))
        self.assertIsNone(checker.tournament_of("def (\n"))
        self.assertEqual(
            checker.tournament_of("import polycode_test as t\nt.tournament('a')\n"), {"id": "a", "private": False}
        )
        self.assertEqual(
            checker.tournament_of("from polycode_test import tournament\ntournament('a', private=True)\n"),
            {"id": "a", "private": True},
        )

    def test_tournament_of_rejects(self):
        for source in (
            "tournament('a')\ntournament('b')\n",
            "def f():\n    tournament('a')\n",
            "tournament('')\n",
            f"tournament('{'x' * 65}')\n",
            "tournament(1)\n",
            "name = 'a'\ntournament(name)\n",
            "tournament('a', private=1)\n",
        ):
            self.assertIn("error", checker.tournament_of(source), source)

    def test_stops_after_the_first_failure(self):
        res = self.check(
            HEAD
            + "@t.points(10)\ndef test_a(): pass\n"
            + "@t.points(30)\ndef test_b(): assert False, 'no'\n"
            + "@t.points(5)\ndef test_c(): raise SystemExit\n"
        )
        self.assertEqual(
            [(r["name"], r["ok"], r.get("skipped", False), r["points"]) for r in res],
            [("test_a", True, False, 10), ("test_b", False, False, 30), ("test_c", False, True, 5)],
        )
        self.assertEqual(res[1]["message"], "no")

    def test_test_without_points_costs_nothing_and_still_stops(self):
        res = self.check(HEAD + "def test_a(): assert False\n@t.points(5)\ndef test_b(): pass\n")
        self.assertEqual(res[0]["points"], 0)
        self.assertTrue(res[1]["skipped"])

    def test_tests_above_the_call_count(self):
        res = self.check("import polycode_test as t\n@t.points(2)\ndef test_a(): pass\nt.tournament('x')\n")
        self.assertEqual(res[0]["points"], 2)

    def test_ordinary_mode_runs_everything_and_scores_without_skipping(self):
        res = checker_run_plain(
            "import polycode_test as t\n@t.points(2)\ndef test_a(): assert False\ndef test_b(): pass\n"
        )
        self.assertEqual([r["name"] for r in res], ["test_a", "test_b"])
        self.assertEqual([r["points"] for r in res], [2, 0])
        self.assertFalse(any(r.get("skipped") for r in res))

    def test_bad_points_is_an_error_of_the_file(self):
        for amount in ("0", "-1", "True", "'5'", "float('inf')", "float('nan')"):
            res = self.check(HEAD + f"@t.points({amount})\ndef test_a(): pass\n")
            self.assertEqual([r["name"] for r in res], ["tests"], amount)

    def test_alias_of_tournament_is_an_error_of_the_file(self):
        res = checker_run_plain("from polycode_test import tournament as x\nx('a')\n")
        self.assertEqual([r["name"] for r in res], ["tests"])
        self.assertIn("tournament", res[0]["message"])

    def test_project_stays_out_of_sys_path(self):
        before = list(sys.path)
        self.check(HEAD + "def test_a(): pass\n", project="/nonexistent/project")
        self.assertEqual(sys.path, before)

    def test_module_is_a_type_error(self):
        res = self.check(HEAD + "def test_a():\n    t.module\n")
        self.assertEqual(res[0]["message"], "TypeError")

    def test_run_goes_through_the_hook(self):
        res = self.check(HEAD + "def test_a():\n    assert t.run('x\\n') == 'x\\n'\n")
        self.assertTrue(res[0]["ok"])
        self.assertEqual(len(self.calls), 1)

    def test_endless_solution_without_timeout_fails_and_skips_the_rest(self):
        self.answer = {"stdout": "", "memory": 0, "timedOut": True, "exitCode": 0, "failure": "", "elapsed": 120.0}
        res = self.check(HEAD + "def test_a():\n    t.run()\ndef test_b(): pass\n")
        self.assertIn("time limit", res[0]["message"])
        self.assertTrue(res[1]["skipped"])
        self.assertLessEqual(self.calls[0], 120_000)

    def test_the_limit_of_a_whole_check_is_120_seconds(self):
        self.check(HEAD + "def test_a():\n    t.run()\n")
        self.assertGreater(self.calls[0], 30_000)
        self.assertLessEqual(self.calls[0], 120_000)

    def test_ordinary_check_keeps_its_30_seconds(self):
        checker._run_outside = lambda stdin, ms, trace: self.calls.append(ms) or {"stdout": "", "memory": 0, "timedOut": False, "exitCode": 0, "failure": "", "elapsed": 0.0}
        with tempfile.TemporaryDirectory() as project:
            checker.run_tests(project, "main.cpp", "import polycode_test as t\ndef test_a():\n    t.run()\n", kind="cpp")
        self.assertLessEqual(self.calls[0], 30_000)

    def test_time_is_what_the_page_measured(self):
        self.answer = {"stdout": "", "memory": 0, "timedOut": False, "exitCode": 0, "failure": "", "elapsed": 2.0}
        res = self.check(HEAD + "def test_a():\n    t.run(timeout=1)\n")
        self.assertEqual(res[0]["message"], "time limit 1 s exceeded: 2.00 s")
        self.assertEqual(res[0]["time"], 2.0)

    def test_memory_is_traced_only_when_limited(self):
        traces = []

        def hook(stdin, ms, trace):
            traces.append(trace)
            return {"stdout": "", "memory": 0, "timedOut": False, "exitCode": 0, "failure": "", "elapsed": 0.0}

        with tempfile.TemporaryDirectory() as project:
            checker._run_outside = hook
            checker.run_tests(project, "main.py", HEAD + "def test_a():\n    t.run()\n    t.run(ram_usage=64)\n", tournament=True)
        self.assertEqual(traces, [False, True])

    def test_id_with_a_control_character_is_rejected(self):
        for source in ("tournament('a\\nb')\n", "tournament('a\\tb')\n", "tournament('\\x00')\n"):
            self.assertIn("error", checker.tournament_of(source), source)

    def test_id_of_64_characters_is_accepted(self):
        self.assertEqual(checker.tournament_of(f"tournament('{'x' * 64}')\n")["id"], "x" * 64)

    def test_a_function_of_the_solution_is_not_a_tournament(self):
        source = "import polycode_test as t\ndef test_a():\n    assert t.module.tournament(8) == 8\n"
        self.assertIsNone(checker.tournament_of(source))

    def test_a_str_subclass_cannot_break_the_error_text(self):
        class Evil(str):
            def __hash__(self):
                raise ValueError("no")

        self.assertEqual(checker._failure(checker.TestFileError(Evil("place")), "<tests>"), "error")

    def test_exit_code_of_a_python_solution_reaches_the_student(self):
        self.answer = {"stdout": "", "memory": 0, "timedOut": False, "exitCode": 1, "failure": "", "elapsed": 0.0}
        res = self.check(HEAD + "def test_a():\n    t.run()\n")
        self.assertEqual(res[0]["message"], "exit code 1")


class PlainChecks(unittest.TestCase):
    def check(self, source, solution):
        with tempfile.TemporaryDirectory() as project:
            with open(os.path.join(project, "main.py"), "w") as f:
                f.write(solution)
            return checker.run_tests(project, "main.py", source)

    def test_solution_may_read_sys_stdin(self):
        res = self.check(
            "import polycode_test as t\ndef test_a(): assert t.run('2\\n3 4\\n').split() == ['7']\n",
            "import sys\nk, a, b = sys.stdin.read().split()\nprint(int(a) + int(b))\n",
        )
        self.assertEqual([(r["name"], r["ok"]) for r in res], [("test_a", True)])

    def test_open_zero_and_stdin_buffer_work_too(self):
        res = self.check(
            "import polycode_test as t\ndef test_a(): assert t.run('x y').split() == ['y', 'x']\n",
            "import sys\nprint(*reversed(sys.stdin.buffer.read().decode().split()))\n",
        )
        self.assertTrue(res[0]["ok"], res)

    def test_points_outside_a_tournament_are_a_score_and_never_skip(self):
        res = self.check(
            "import polycode_test as t\n@t.points(10)\ndef test_a(): assert False, 'no'\n@t.points(5)\ndef test_b(): pass\n",
            SOLUTION,
        )
        self.assertEqual(
            [(r["name"], r["ok"], r["points"], r.get("skipped", False)) for r in res],
            [("test_a", False, 10, False), ("test_b", True, 5, False)],
        )

    def test_no_points_without_any_points_call(self):
        res = self.check("def test_a(): pass\n", SOLUTION)
        self.assertNotIn("points", res[0])


if __name__ == "__main__":
    unittest.main()
