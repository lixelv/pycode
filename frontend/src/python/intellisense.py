"""Static code intelligence (completions, signatures, hover) using Jedi.

Jedi only analyses source code; the user's program is never executed here.
"""

from __future__ import annotations

import sys

import jedi
from jedi.api.environment import InterpreterEnvironment

jedi.settings.cache_directory = "/tmp/jedi-cache"
# Pyodide cannot start subprocesses: analyse with this interpreter itself.
_ENV = InterpreterEnvironment()
jedi.settings.case_insensitive_completion = False

MAX_COMPLETIONS = 150
DOCUMENTED_COMPLETIONS = 25
MAX_DOC = 1200
# Where our package lives, not for the user's eyes, and the hints for test files.
_HOME = "/home/pyodide"
_STUBS = f"{_HOME}/polycode_stubs"
_PROJECT = "/tmp/jedi-project"  # an empty folder: Jedi also imports from the file's own


def _doc(text: str) -> str:
    text = text.strip()
    return text if len(text) <= MAX_DOC else text[: MAX_DOC - 1] + "…"


def _script(code: str, path: str) -> jedi.Script:
    sys_path = [entry for entry in sys.path if entry and entry != _HOME]
    if path.endswith(".test.py"):
        sys_path.insert(0, _STUBS)
    project = jedi.Project(_PROJECT, sys_path=sys_path, smart_sys_path=False)
    return jedi.Script(code, path=f"{_PROJECT}/main.py", environment=_ENV, project=project)


def complete(code: str, line: int, column: int, path: str = "") -> list[dict]:
    items = []
    for index, c in enumerate(_script(code, path).complete(line, column)):
        if index >= MAX_COMPLETIONS:
            break
        # Skip private/dunder names unless the user started typing them.
        typed = c.name[: len(c.name) - len(c.complete or "")]
        if c.name.startswith("_") and not typed.startswith("_"):
            continue
        item = {"name": c.name, "type": c.type, "complete": c.complete, "description": c.description}
        if index < DOCUMENTED_COMPLETIONS:
            try:
                sigs = c.get_signatures()
                if sigs:
                    item["signature"] = sigs[0].to_string()
                item["doc"] = _doc(c.docstring(raw=True))
            except Exception:  # noqa: BLE001 - docs are best effort
                pass
        items.append(item)
    return items


def signatures(code: str, line: int, column: int, path: str = "") -> list[dict]:
    out = []
    for sig in _script(code, path).get_signatures(line, column):
        out.append(
            {
                "label": sig.to_string(),
                "params": [p.to_string() for p in sig.params],
                "index": sig.index,
                "doc": _doc(sig.docstring(raw=True)),
            }
        )
    return out


def hover(code: str, line: int, column: int, path: str = "") -> dict | None:
    for name in _script(code, path).help(line, column):
        doc = name.docstring(raw=True)
        try:
            sigs = name.get_signatures()
        except Exception:  # noqa: BLE001
            sigs = []
        header = sigs[0].to_string() if sigs else f"{name.type} {name.name}"
        if doc or sigs:
            return {"header": header, "doc": _doc(doc)}
    return None
