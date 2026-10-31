import ast
import os
import unittest

PYTHON = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse(*path):
    with open(os.path.join(PYTHON, *path), encoding="utf-8") as f:
        return ast.parse(f.read())


def functions(tree):
    return {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}


def classes(tree):
    return {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}


class StubMatchesChecker(unittest.TestCase):
    """The hints' polycode_test must say what the checker's really does."""

    def setUp(self):
        self.stub = parse("stubs", "polycode_test.py")
        self.checker = parse("checker.py")

    def test_run_has_the_same_parameters(self):
        run = ast.dump(functions(self.stub)["run"].args)
        self.assertEqual(run, ast.dump(functions(self.checker)["run"].args))
        self.assertEqual(run, ast.dump(functions(self.checker)["_run_cpp"].args))

    def test_public_names_are_those_of_the_helper(self):
        helper = {
            target.attr
            for node in ast.walk(self.checker)
            if isinstance(node, ast.Assign)
            for target in node.targets
            if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "helper"
        }
        helper.discard("__getattr__")
        helper.add("module")  # built on first use through __getattr__
        public = set(functions(self.stub)) | set(classes(self.stub))
        public |= {node.target.id for node in self.stub.body if isinstance(node, ast.AnnAssign)}
        self.assertEqual({name for name in public if not name.startswith("_")}, helper)

    def test_errors_have_the_same_bases(self):
        for name in ("TimeLimitExceeded", "MemoryLimitExceeded"):
            ours = [ast.dump(base) for base in classes(self.stub)[name].bases]
            self.assertEqual(ours, [ast.dump(base) for base in classes(self.checker)[name].bases])


if __name__ == "__main__":
    unittest.main()
