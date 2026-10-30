import os
import sys
import tempfile
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


if __name__ == "__main__":
    unittest.main()
