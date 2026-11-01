"""Tools for a check (``name.test.py``). Exists only while the check runs.

Only for the editor's hints: the real module is built by ``checker.py``.
"""

from types import ModuleType as _ModuleType

module: _ModuleType
"""The solution's top-level declarations (imports, defs, classes, assignments
without a call); the program itself does not run. Python solutions only."""


class TimeLimitExceeded(TimeoutError):
    """run() went over ``timeout``."""

    used: float
    """Seconds the program took."""
    limit: float
    """The limit, in seconds."""


class MemoryLimitExceeded(MemoryError):
    """run() went over ``ram_usage``."""

    used: float
    """Peak bytes the program used."""
    limit: float
    """The limit, in bytes."""


def run(stdin: str = "", timeout: float | None = None, ram_usage: float | None = None) -> str:
    """Runs the solution with this input and returns what it printed.

    ``timeout`` is in seconds, ``ram_usage`` in MB (10**6 bytes); None or 0
    turns a limit off. A limit that is on is measured and shown with the test.
    Python: input() prompts are not in the output, and reading past ``stdin``
    raises EOFError. C++: prompts are in the output, reading past ``stdin``
    gets EOF, and a non-zero exit fails the test. In a tournament a Python
    solution also fails the test on a non-zero exit or an uncaught exception.
    """
    ...


def call(name: str, *args, timeout: float | None = None, ram_usage: float | None = None):
    """Calls the solution's function ``name`` with these arguments and returns its result.

    Only the solution's top-level declarations are loaded (see ``module``), the program
    itself does not run, and what the function prints is dropped. Arguments and the
    result pass through JSON (numbers, strings, lists, dicts, None): tuples come back
    as lists. Works in a tournament too, where ``module`` does not. ``timeout`` and
    ``ram_usage`` are as in ``run``. Python solutions only.
    """
    ...


def tournament(id: str, private: bool = False) -> None:
    """Makes this whole file a tournament: tests earn points(), the first failure
    skips the rest, and each participant's best run goes into the table ``id``.

    One top-level statement, with literal arguments. ``id`` has 1 to 64 characters;
    ``private=True`` hides the table from students.
    """
    ...


def points(amount: float):
    """A decorator: what this test earns. Without it, a test earns 0. Outside a tournament
    the points are only a score shown with the results."""
    ...
