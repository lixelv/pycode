import builtins
import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import runner  # noqa: E402


class SlicedSleep(unittest.TestCase):
    def setUp(self):
        self.slept = []
        self.checks = 0

    def check(self):
        self.checks += 1

    def sleep(self, seconds, **kw):
        runner.sliced_sleep(seconds, sleep=self.slept.append, check=self.check, **kw)

    def test_total_time_is_respected(self):
        self.sleep(1)
        self.assertAlmostEqual(sum(self.slept), 1, places=6)

    def test_no_slice_is_longer_than_the_step(self):
        self.sleep(1, step=0.05)
        self.assertLessEqual(max(self.slept), 0.05 + 1e-9)
        self.assertGreaterEqual(len(self.slept), 20)

    def test_short_sleep_is_one_exact_slice(self):
        self.sleep(0.01, step=0.05)
        self.assertEqual(self.slept, [0.01])

    def test_one_check_per_slice(self):
        self.sleep(0.5, step=0.05)
        self.assertEqual(self.checks, len(self.slept))

    def test_interrupt_from_the_check_stops_the_sleep(self):
        def check():
            if len(self.slept) == 3:
                raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            runner.sliced_sleep(100, sleep=self.slept.append, check=check, step=0.05)
        self.assertEqual(len(self.slept), 3)

    def test_zero_still_yields_and_checks(self):
        self.sleep(0)
        self.assertEqual(self.checks, 1)
        self.assertLessEqual(sum(self.slept), 0)

    def test_negative_is_an_error_like_time_sleep(self):
        with self.assertRaises(ValueError):
            self.sleep(-1)
        self.assertEqual(self.slept, [])


class Arm(unittest.TestCase):
    """run_main arms the interrupt only once the program is about to start."""

    def setUp(self):
        self.events = []
        builtins._pystop_events = self.events
        self.addCleanup(lambda: delattr(builtins, "_pystop_events"))
        self.cwd = os.getcwd()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(os.chdir, self.cwd)
        self.path = list(sys.path)
        self.addCleanup(setattr, sys, "path", self.path)
        self.argv = sys.argv
        self.addCleanup(setattr, sys, "argv", self.argv)
        os.chdir(self.dir.name)

    def run_program(self, source, **kw):
        with open("main.py", "w") as f:
            f.write(source)
        return runner.run_main("main.py", arm=lambda: self.events.append("arm"), **kw)

    def test_armed_before_the_first_statement(self):
        self.assertEqual(self.run_program("_pystop_events.append('program')\n"), 0)
        self.assertEqual(self.events, ["arm", "program"])

    def test_armed_once(self):
        self.run_program("pass\n")
        self.assertEqual(self.events.count("arm"), 1)

    def test_not_armed_for_a_program_that_does_not_compile(self):
        self.assertEqual(self.run_program("def (\n"), 1)
        self.assertEqual(self.events, [])

    def test_interrupt_raised_by_arming_is_a_plain_stop(self):
        # A Stop that waited for the program is delivered as soon as it is armed.
        with open("main.py", "w") as f:
            f.write("_pystop_events.append('program')\n")

        def arm():
            raise KeyboardInterrupt

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(runner.run_main("main.py", arm=arm), 130)
        text = stderr.getvalue()
        self.assertIn("KeyboardInterrupt", text)
        self.assertNotIn("Traceback", text)
        self.assertEqual(self.events, [])

    def test_armed_for_the_debugger_too(self):
        events = self.events

        class Debugger:
            def run(self, code, namespace):
                events.append("debugger")

        self.run_program("pass\n", debugger=Debugger())
        self.assertEqual(self.events, ["arm", "debugger"])

    def test_without_arm_still_runs(self):
        with open("main.py", "w") as f:
            f.write("_pystop_events.append('program')\n")
        self.assertEqual(runner.run_main("main.py"), 0)
        self.assertEqual(self.events, ["program"])


class Batch(unittest.TestCase):
    """run_batch runs a solution on a fixed stdin text, with no console."""

    def setUp(self):
        self.cwd = os.getcwd()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(os.chdir, self.cwd)
        self.path = list(sys.path)
        self.addCleanup(setattr, sys, "path", self.path)
        self.argv = sys.argv
        self.addCleanup(setattr, sys, "argv", self.argv)
        os.chdir(self.dir.name)
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()

    def write(self, source):
        with open("main.py", "w") as f:
            f.write(source)

    def run_batch(self, stdin, **kw):
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()
        with contextlib.redirect_stdout(self.stdout), contextlib.redirect_stderr(self.stderr):
            return runner.run_batch("main.py", stdin, **kw)

    def out(self):
        return self.stdout.getvalue()

    def test_prompt_is_not_printed_and_eof_is_an_error(self):
        self.write('print(input("? "))\ninput()\n')
        self.assertEqual(self.run_batch("x\n")["exitCode"], 1)
        self.assertEqual(self.out(), "x\n")

    def test_stdin_read_gets_the_text(self):
        self.write("import sys\nprint(sys.stdin.read())\n")
        self.run_batch("a\nb\n")
        self.assertEqual(self.out(), "a\nb\n\n")

    def test_exit_codes(self):
        for source, code in (("import sys; sys.exit(3)", 3), ("raise ValueError", 1), ("pass", 0)):
            self.write(source)
            self.assertEqual(self.run_batch("")["exitCode"], code, source)

    def test_traceback_does_not_reach_stdout(self):
        self.write('raise ValueError("secret")\n')
        self.assertEqual(self.run_batch("")["exitCode"], 1)
        self.assertEqual(self.out(), "")

    def test_memory_only_when_traced(self):
        self.write("x = bytearray(10**7)")
        self.assertGreaterEqual(self.run_batch("", trace_memory=True)["memory"], 10**7)
        self.assertEqual(self.run_batch("")["memory"], 0)

    def test_restores_input_and_stdin(self):
        saved = builtins.input, sys.stdin
        self.write("pass\n")
        self.run_batch("")
        self.assertEqual((builtins.input, sys.stdin), saved)

    def test_arm_is_called_before_the_program(self):
        events = []
        self.write("import builtins; builtins.polycode_probe = 1")
        self.addCleanup(lambda: hasattr(builtins, "polycode_probe") and delattr(builtins, "polycode_probe"))
        self.run_batch("", arm=lambda: events.append(hasattr(builtins, "polycode_probe")))
        self.assertEqual(events, [False])


class SleepOutOfRange(unittest.TestCase):
    def test_a_value_beyond_the_range_goes_to_the_real_sleep(self):
        for seconds in (1e300, 10**30, -1e300, -(10**400), float("-inf")):
            slept = []
            runner.sliced_sleep(seconds, sleep=slept.append, check=lambda: None)
            self.assertEqual(slept, [seconds])


class InternalFrames(unittest.TestCase):
    def test_frames_from_the_first_internal_one_are_cut(self):
        with tempfile.TemporaryDirectory() as folder:
            lib = os.path.join(folder, "lib.py")
            with open(lib, "w") as f:
                f.write("def fail():\n    raise ValueError('x')\n")
            scope = {}
            exec(compile(open(lib).read(), lib, "exec"), scope)

            def program():
                scope["fail"]()

            try:
                program()
            except ValueError as exc:
                tb = runner.without_internal_frames(exc.__traceback__, folder)
            names = []
            while tb:
                names.append(tb.tb_frame.f_code.co_name)
                tb = tb.tb_next
            self.assertEqual(names[-1], "program")
            self.assertNotIn("fail", names)


if __name__ == "__main__":
    unittest.main()
