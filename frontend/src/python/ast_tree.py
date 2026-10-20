"""Converts Python source into a flat node/edge graph of its syntax tree."""

from __future__ import annotations

import ast
from typing import Any

MAX_NODES = 1500



def _scalar(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= 60 else text[:57] + "..."


def _is_leaf_marker(node: ast.AST) -> bool:
    # Load/Store/Del, Add/Sub, And/Or, ... carry no data: show them inline.
    return not node._fields


def build_tree(source: str) -> dict:
    tree = ast.parse(source, filename="main.py", type_comments=False)
    nodes: list[dict] = []
    edges: list[dict] = []
    truncated = False

    def visit(node: ast.AST) -> str | None:
        nonlocal truncated
        if len(nodes) >= MAX_NODES:
            truncated = True
            return None
        node_id = str(len(nodes))
        entry: dict[str, Any] = {"id": node_id, "type": type(node).__name__, "fields": {}}
        if hasattr(node, "lineno"):
            entry["loc"] = {
                "line": node.lineno,
                "col": node.col_offset,
                "endLine": getattr(node, "end_lineno", None) or node.lineno,
                "endCol": getattr(node, "end_col_offset", None) or node.col_offset,
            }
        nodes.append(entry)

        for name, value in ast.iter_fields(node):
            if isinstance(value, ast.AST):
                if _is_leaf_marker(value):
                    entry["fields"][name] = type(value).__name__
                    continue
                child = visit(value)
                if child is not None:
                    edges.append({"source": node_id, "target": child, "label": name})
            elif isinstance(value, list):
                items = [v for v in value if isinstance(v, ast.AST)]
                if items and all(_is_leaf_marker(v) for v in items):
                    entry["fields"][name] = "[" + ", ".join(type(v).__name__ for v in items) + "]"
                    continue
                if not items and value:
                    entry["fields"][name] = _scalar(value)
                for index, item in enumerate(value):
                    if isinstance(item, ast.AST):
                        child = visit(item)
                        if child is not None:
                            edges.append(
                                {"source": node_id, "target": child, "label": f"{name}[{index}]"}
                            )
            elif value is not None:
                entry["fields"][name] = _scalar(value)
        return node_id

    visit(tree)
    return {"nodes": nodes, "edges": edges, "truncated": truncated}
