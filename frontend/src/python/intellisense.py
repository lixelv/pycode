"""Static code intelligence (completions, signatures, hover) using Jedi.

Jedi only analyses source code; the user's program is never executed here.
"""

from __future__ import annotations

import jedi
from jedi.api.environment import InterpreterEnvironment

jedi.settings.cache_directory = "/tmp/jedi-cache"
# Pyodide cannot start subprocesses: analyse with this interpreter itself.
_ENV = InterpreterEnvironment()
jedi.settings.case_insensitive_completion = False

MAX_COMPLETIONS = 150
DOCUMENTED_COMPLETIONS = 25
MAX_DOC = 1200


def _doc(text: str) -> str:
    text = text.strip()
    return text if len(text) <= MAX_DOC else text[: MAX_DOC - 1] + "…"


def _script(code: str) -> jedi.Script:
    return jedi.Script(code, path="main.py", environment=_ENV)


def complete(code: str, line: int, column: int) -> list[dict]:
    items = []
    for index, c in enumerate(_script(code).complete(line, column)):
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


def signatures(code: str, line: int, column: int) -> list[dict]:
    out = []
    for sig in _script(code).get_signatures(line, column):
        out.append(
            {
                "label": sig.to_string(),
                "params": [p.to_string() for p in sig.params],
                "index": sig.index,
                "doc": _doc(sig.docstring(raw=True)),
            }
        )
    return out


def hover(code: str, line: int, column: int) -> dict | None:
    for name in _script(code).help(line, column):
        doc = name.docstring(raw=True)
        try:
            sigs = name.get_signatures()
        except Exception:  # noqa: BLE001
            sigs = []
        header = sigs[0].to_string() if sigs else f"{name.type} {name.name}"
        if doc or sigs:
            return {"header": header, "doc": _doc(doc)}
    return None
