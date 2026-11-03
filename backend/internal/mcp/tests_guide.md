# Tests in polycode: `polycode_test`

## Where the tests are
- The solution is `name.py` or `name.cpp`; its tests are `name.test.py`, the nearest one: in the solution's folder first, then each folder up to the root. `run_check(path)` takes the solution's path.
- `create_file` makes `*.test.py` hidden from students (pass `hidden: false` to show it). A hidden test file is still run for students' checks.
- The test file is Python for both languages. It is run in a fresh interpreter; every top-level function named `test_*` is a test, in file order. A test passes if it returns, fails if it raises.

## Who runs a check
- `run_check` runs it in the teacher's tab. A student's Check button sends the request to an admin's browser (the acting owner if an admin, else the earliest admin), which runs the checks one at a time, at most one per student every 3 s. With no admin online, students cannot check.
- A whole check has 30 s (a tournament 120 s). A student needs level `write` to check.
- Results come from code the student controls: they help learning, they are not grades.

## The module
```python
import polycode_test as t   # (the old name pycode_test works too)

def test_sum():
    assert t.run("2 3\n") == "5\n"
```

### `t.run(stdin="", timeout=None, ram_usage=None) -> str`
Runs the whole solution with `stdin` as its input and returns what it printed.
- `timeout` in seconds, `ram_usage` in MB (10**6 bytes); `None` or `0` turns a limit off. A limit that is on is measured and shown at the test's line (`0.12 s · 3.4 MB`).
- Over a limit: `t.TimeLimitExceeded` (a `TimeoutError`) or `t.MemoryLimitExceeded` (a `MemoryError`), with `used` and `limit` (seconds; bytes). Uncaught, the test fails with `time limit 1 s exceeded: 1.43 s` / `memory limit 64 MB exceeded: 81.2 MB`. You can catch them to test that a solution is slow.
- Python: `input()` prompts are left out of the output; `sys.stdin` (`read()`, `.buffer`, iteration) reads `stdin` too; reading past it raises `EOFError` in the solution. `open(0)`/`os.read(0)` get `stdin` only in a tournament; in an ordinary check they wait for the console until the check's limit. Outside a tournament any `sys.exit()`, even `sys.exit(0)`, fails the test (`SystemExit`); in a tournament only a non-zero exit does. Memory is `tracemalloc`'s peak.
- C++: prompts are part of the output (they are ordinary `cout`); reading past `stdin` gets EOF. The test fails, whatever was printed, if the program exits non-zero or crashes (`exit code N`; an uncaught `throw` aborts), prints over 1 000 000 bytes (`output limit exceeded`) or does not start (`the program did not start`). The C++ solution is compiled once per check with the project's C++ packages; a compile error fails the check with the first lines of clang's log. Memory can read low (`-O1` drops unused allocations).
- Without `timeout` an endless loop runs into the whole check's limit (30 s): in an ordinary Python check the whole check ends with a timeout; in C++ and tournaments that run uses the rest of the time and the later tests fail. Pass `timeout`, so it fails one test.

### `t.call(name, *args, timeout=None, ram_usage=None)`
Python solutions only. Calls the solution's top-level function `name` and returns its result; the program itself does not run, and what the function prints is dropped. Arguments and result pass through JSON: numbers, strings, lists, dicts, `None`, booleans (tuples come back as lists). Limits as in `run`. Works in tournaments.

### `t.module`
Python solutions only, not in a tournament. A module of the solution's top-level declarations: imports, `def`, `class`, assignments without a call. The program itself does not run. Use it to test functions with any Python values: `assert t.module.area(2, 3) == 6`. In a C++ solution or a tournament it raises `TypeError`.

### `@t.points(amount)`
What a test is worth (a positive number); without it a test earns 0. Outside a tournament it is only a score: the results show `earned of max`, and every test still runs.

### `t.tournament(id, private=False)`
A top-level statement with literal arguments, once per file: the whole file becomes a tournament.
- `id`: 1 to 64 printable characters, the table's name. `private=True` hides the table from students.
- The first failed test skips the rest; the score is the sum of `points` of passed tests.
- Isolation: the tests run with no project files, and the solution cannot reach them or the results: it runs in one separate interpreter for the whole check, shared by its `run`/`call`s (so state such as imported modules carries over; a timeout starts a new one), with the files an ordinary run sees (public files and its role folders, never hidden ones). `t.module` is unavailable (use `t.call`). In a Python solution a non-zero exit or an uncaught exception also fails the test (`exit code N`).
- Only students' checks are recorded (by their account), keeping each one's best score; standings are by total, then by who reached it first. An admin's own check in a session is not recorded; without a session the teacher's tries go into the same table. For a real contest use a new `id`.
- `tournament_list`, `tournament_standings`, `tournament_set_private` read and manage the tables.

## Messages
Only the test's own failed `assert` carries its text (`assert got == want, f"got {got}"`; up to 200 characters). Any other error raised by the solution shows only a built-in type name (`ValueError`) or `error`, so a solution cannot send text back through the results (a Python solution can raise the limit errors itself, so at most numbers of its choosing come back). A misused `tournament()` or `points()` is an error of the file.

## What `run_check` returns
`results`: one entry per test, `{name, ok, message}`, plus `time`/`memory` when a limit was on, `points` when the file scores, `skipped` after a tournament's first failure. A syntax error or an exception at the test file's top level is a single result named `tests`. Also `testFile`, and `tournament` for a tournament.

## Example
```python
import polycode_test as t

@t.points(1)
def test_example():
    assert t.run("3\n1 2 3\n", timeout=1) == "6\n"

@t.points(2)
def test_big():
    n = 10**5
    data = f"{n}\n" + " ".join(["1"] * n) + "\n"
    out = t.run(data, timeout=1, ram_usage=64)
    assert out.strip() == str(n), "wrong sum on a big input"

def test_function():
    assert t.call("total", [1, 2, 3]) == 6
```
