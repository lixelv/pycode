"""Flowchart / syntax-tree views with errors reported as data."""

from .ast_tree import build_tree
from .flow import build_flow


def view(kind: str, code: str, lang: str = "en") -> dict:
    try:
        return {"ok": True, **(build_flow(code, lang) if kind == "flow" else build_tree(code))}
    except SyntaxError as exc:
        return {"ok": False, "error": {"message": exc.msg, "line": exc.lineno}}
    except (RecursionError, MemoryError, ValueError) as exc:
        return {"ok": False, "error": {"message": str(exc) or type(exc).__name__}}
