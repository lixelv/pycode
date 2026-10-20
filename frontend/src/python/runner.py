"""Runs the user's program inside Pyodide as ``__main__``.

The source is written to ``main.py`` first so tracebacks show its lines.
"""

import builtins
import sys
import traceback


PROJECT = "/home/pyodide/project"


def write_project(files: dict) -> None:
    """Lays the project out on disk, replacing the previous run's copy."""
    import os
    import shutil

    shutil.rmtree(PROJECT, ignore_errors=True)
    for rel, content in files.items():
        path = os.path.join(PROJECT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    os.makedirs(PROJECT, exist_ok=True)
    os.chdir(PROJECT)


def run_main(path: str = "main.py") -> int:
    import os

    # Like `python path`: the script's folder (and the project root) are importable,
    # and modules from the previous run are imported fresh.
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None) or ""
        if file.startswith(PROJECT + "/"):
            del sys.modules[name]
    for entry in (PROJECT, os.path.dirname(os.path.join(PROJECT, path))):
        if entry not in sys.path:
            sys.path.insert(0, entry)

    with open(path, encoding="utf-8") as f:
        source = f.read()
    try:
        code = compile(source, path, "exec")
    except SyntaxError as exc:
        traceback.print_exception(type(exc), exc, None)
        return 1

    sys.argv = [path]
    namespace = {"__name__": "__main__", "__file__": path, "__builtins__": builtins}
    try:
        exec(code, namespace)
    except SystemExit as exc:
        code = exc.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        print(code, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nKeyboardInterrupt", file=sys.stderr)
        return 130
    except BaseException as exc:
        # Drop this bootstrap's frame so the traceback starts in main.py.
        traceback.print_exception(type(exc), exc, exc.__traceback__.tb_next)
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    return 0
