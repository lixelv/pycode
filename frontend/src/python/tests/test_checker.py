import _thread
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


if __name__ == "__main__":
    unittest.main()
