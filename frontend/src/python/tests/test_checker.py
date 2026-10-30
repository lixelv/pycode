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
import unittest

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
        self.saved = checker._run_wasm if hasattr(checker, "_run_wasm") else None
        self.calls = []

    def tearDown(self):
        if self.saved is None:
            if hasattr(checker, "_run_wasm"):
                del checker._run_wasm
        else:
            checker._run_wasm = self.saved

    def check(self, source, wasm):
        def hook(stdin, timeout_ms):
            self.calls.append(timeout_ms)
            return wasm(stdin, timeout_ms)

        checker._run_wasm = hook
        with tempfile.TemporaryDirectory() as project:
            return checker.run_tests(project, "main.cpp", source, kind="cpp")

    @staticmethod
    def upper(s, t):
        return {"stdout": s.upper(), "memory": 2_000_000, "timedOut": False}

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
            lambda s, t: {"stdout": "", "memory": 0, "timedOut": True},
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


if __name__ == "__main__":
    unittest.main()
