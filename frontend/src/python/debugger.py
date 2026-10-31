"""Step-by-step running of the user's program (bdb).

On every stop the page gets where the program is and its variables
(``pause(state_json)``) and answers with a command: continue, next (step
over), step (into), return (out of the function) or stop.
"""

import bdb
import json
import os

from polycode.runner import PROJECT, run_main

MAX_REPR = 200
MAX_VARS = 50


def _ours(filename: str) -> bool:
    # The main file is compiled with a relative name; imported ones are absolute.
    # "<frozen …>", "<string>" and the like are Python's own.
    if filename.startswith("<"):
        return False
    return not os.path.isabs(filename) or filename.startswith(PROJECT + "/")


def _rel(filename: str) -> str:
    return os.path.relpath(filename, PROJECT) if os.path.isabs(filename) else filename


def _show(value) -> str:
    try:
        text = repr(value)
    except Exception as err:  # noqa: BLE001 - a broken __repr__ must not stop debugging
        text = f"<{type(value).__name__}: {err}>"
    return text if len(text) <= MAX_REPR else text[: MAX_REPR - 1] + "…"


def _variables(names: dict) -> dict:
    out = {}
    for name, value in names.items():
        if name.startswith("__") or type(value).__name__ in ("module", "function", "type", "builtin_function_or_method"):
            continue
        out[name] = _show(value)
        if len(out) >= MAX_VARS:
            break
    return out


class Debugger(bdb.Bdb):
    def __init__(self, pause, breakpoints: dict):
        # bdb keeps breakpoints globally (and a new Bdb loads them): forget the previous run's first.
        bdb.Breakpoint.clearBreakpoints()
        super().__init__()
        self.pause = pause
        self.first = True
        for path, lines in breakpoints.items():
            for line in lines:
                self.set_break(os.path.join(PROJECT, path), int(line))

    def state(self, frame) -> dict:
        stack = [
            {"name": f.f_code.co_name, "file": _rel(f.f_code.co_filename), "line": lineno}
            for f, lineno in self.get_stack(frame, None)[0]
            if _ours(f.f_code.co_filename) and f.f_code.co_name != "<string>"
        ]
        variables = _variables(frame.f_locals)
        if frame.f_globals is not frame.f_locals:
            # The function's own variables first, then globals, MAX_VARS in all.
            for name, value in _variables(frame.f_globals).items():
                if len(variables) >= MAX_VARS:
                    break
                variables.setdefault(name, value)
        return {"file": _rel(frame.f_code.co_filename), "line": frame.f_lineno, "stack": stack, "vars": variables}

    def user_line(self, frame):
        if not _ours(frame.f_code.co_filename):
            return  # library code: keep going until we are back in the project
        if self.first:
            self.first = False
            # With breakpoints, run to the first one; without, stop on line 1.
            if self.breaks and not self.break_here(frame):
                self.set_continue()
                return
        command = self.pause(json.dumps(self.state(frame)))
        if command == "next":
            self.set_next(frame)
        elif command == "step":
            self.set_step()
        elif command == "return":
            self.set_return(frame)
        elif command == "stop":
            self.set_quit()
        else:
            self.set_continue()


def run_debug(path: str, breakpoints, pause, arm=None) -> int:
    """Runs the project's ``path`` like ``run_main``, stopping as the page asks."""
    if hasattr(breakpoints, "to_py"):
        breakpoints = breakpoints.to_py()
    return run_main(path, Debugger(pause, dict(breakpoints)), arm)
