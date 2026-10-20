"""Builds an execution-order flowchart (control-flow graph) from Python code.

Made for teaching: every node is one step the program takes, edges show what
runs next, conditions branch into "yes" / "no", loops point back with
"repeat", and user-defined functions get their own flow that call sites link to.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field

MAX_NODES = 1500


MAX_LABEL = 52

# A pending connection: (node id, edge label, edge kind).
Pred = tuple[str, "str | None", str]


@dataclass
class _Loop:
    head: str
    breaks: list[Pred] = field(default_factory=list)


@dataclass
class _Ctx:
    group: str | None = None  # innermost frame (function / method / class); None = main program
    func_end: str | None = None
    cls: str | None = None  # class whose method is being built (resolves self.x())
    loops: list[_Loop] = field(default_factory=list)


_lang = "en"

# Russian versions of every caption and label (keys are the English templates).
_RU = {
    "Program start": "Начало программы",
    "Program end": "Конец программы",
    "The program begins here and runs top to bottom.": "Программа начинается здесь и выполняется сверху вниз.",
    "Nothing is left to run: the program finishes.": "Больше нечего выполнять: программа завершается.",
    "creates {name}": "создаёт {name}",
    "Check the condition: if it is true go to “yes”, otherwise to “no”.": "Проверить условие: если оно истинно — идём по «да», иначе по «нет».",
    "Repeat while {cond} is true.": "Повторять, пока {cond} истинно.",
    "Take each item of {it} one by one and put it in {var}.": "Брать по очереди каждый элемент из {it} и класть его в {var}.",
    "yes": "да",
    "no": "нет",
    "next item": "следующий",
    "done": "готово",
    "repeat": "повторить",
    "exit loop": "выйти из цикла",
    "on error": "при ошибке",
    "no match": "нет совпадений",
    "case {p}": "случай {p}",
    "any error": "любая ошибка",
    "Define the function {name}. Its steps run only when it is called.": "Определить функцию {name}. Её шаги выполнятся, только когда её вызовут.",
    "Define the class {name}: a blueprint for creating objects.": "Определить класс {name}: шаблон для создания объектов.",
    "Give the result back and leave the function.": "Вернуть результат и выйти из функции.",
    "Stop the loop right now and continue after it.": "Сразу прервать цикл и продолжить после него.",
    "Skip the rest of this round and go to the next one.": "Пропустить остаток этого шага цикла и перейти к следующему.",
    "Try the steps below; if an error happens, jump to the matching except.": "Попробовать выполнить шаги ниже; если случится ошибка — перейти к подходящему except.",
    "Runs only if {kind} happened.": "Выполняется, только если произошла {kind}.",
    "Open a resource, run the steps inside, then close it.": "Открыть ресурс, выполнить шаги внутри, затем закрыть его.",
    "Compare the value with each case, top to bottom.": "Сравнить значение с каждым случаем сверху вниз.",
    "method {name}": "метод {name}",
    "function {name}": "функция {name}",
    "class {name}": "класс {name}",
    "The method {name} starts here when it is called.": "Метод {name} начинается здесь, когда его вызывают.",
    "The function {name} starts here when it is called.": "Функция {name} начинается здесь, когда её вызывают.",
    "end of {name}": "конец {name}",
    "Go back to the line that called it.": "Вернуться к строке, которая её вызвала.",
    "methods: {list}": "методами: {list}",
    "no methods": "без методов",
    " It inherits from {list}.": " Наследует от {list}.",
    "Blueprint for {name} objects with {what}.": "Шаблон для объектов {name} с {what}.",
    "Ask the user to type something and save it in {names}.": "Попросить пользователя что-то ввести и сохранить в {names}.",
    "Create a new {name} object (runs __init__) and save it in {names}.": "Создать новый объект {name} (выполняется __init__) и сохранить в {names}.",
    "Call {name}(…) and save the result in {names}.": "Вызвать {name}(…) и сохранить результат в {names}.",
    "Save the value in {names}.": "Сохранить значение в {names}.",
    "Increase {var} by {value}.": "Увеличить {var} на {value}.",
    "Decrease {var} by {value}.": "Уменьшить {var} на {value}.",
    "Multiply {var} by {value}.": "Умножить {var} на {value}.",
    "Divide {var} by {value}.": "Разделить {var} на {value}.",
    "Update {var} by {value}.": "Изменить {var} на {value}.",
    "Show text in the console.": "Вывести текст в консоль.",
    "Wait until the user types something.": "Подождать, пока пользователь что-нибудь введёт.",
    "Call {name}(…).": "Вызвать {name}(…).",
    "Load code from another module so it can be used here.": "Подключить код из другого модуля, чтобы использовать его здесь.",
    "Do nothing (a placeholder).": "Ничего не делать (заглушка).",
    "Stop with an error.": "Остановиться с ошибкой.",
    "Make sure the condition is true, otherwise stop with an error.": "Убедиться, что условие истинно, иначе остановиться с ошибкой.",
    "Delete the variable or item.": "Удалить переменную или элемент.",
    "Run this line.": "Выполнить эту строку.",
    "calls": "вызывает",
    "uses": "использует",
    "calls parent": "вызывает родителя",
    "uses __str__": "использует __str__",
    "inherits from": "наследует от",
}


def tr(template: str, **values: str) -> str:
    text = _RU.get(template, template) if _lang == "ru" else template
    return text.format(**values) if values else text


class _Truncated(Exception):
    pass


def _call_scope(stmt: ast.AST) -> list[ast.AST]:
    """The parts of a statement whose calls belong to this step.

    A compound statement's body is made of its own steps, so only its header
    counts: `if t.exists():` calls exists(), not what runs inside the branch.
    """
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Try)):
        return []
    if isinstance(stmt, (ast.If, ast.While)):
        return [stmt.test]
    if isinstance(stmt, (ast.For, ast.AsyncFor)):
        return [stmt.iter]
    if isinstance(stmt, (ast.With, ast.AsyncWith)):
        return [item.context_expr for item in stmt.items]
    if isinstance(stmt, ast.Match):
        return [stmt.subject]
    if isinstance(stmt, ast.ExceptHandler):
        return [stmt.type] if stmt.type else []
    return [stmt]


def _short(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= MAX_LABEL else text[: MAX_LABEL - 1] + "…"


class FlowBuilder:
    def __init__(self, source: str) -> None:
        self.src = source
        self.lines = source.splitlines()
        self.nodes: list[dict] = []
        self.edges: list[dict] = []
        self.functions: dict[str, str] = {}  # qualified name -> start node
        self.classes: dict[str, dict] = {}  # name -> {"node", "bases", "methods": {name: start}}
        self.groups: list[dict] = []  # frames: {"id", "title", "kind", "parent"}
        # (node, expression to scan for calls, class for self, function group)
        self.sites: list[tuple[str, ast.AST, str | None, str | None]] = []
        self.group_start: dict[str, str] = {}  # function / method -> its start node
        self.var_types: dict[str, str] = {}
        self.class_names: set[str] = set()
        self._linked: set[tuple[str, str, str]] = set()

    # -- helpers -----------------------------------------------------------

    def seg(self, node: ast.AST) -> str:
        return ast.get_source_segment(self.src, node) or ""

    def header(self, stmt: ast.stmt) -> str:
        line = self.lines[stmt.lineno - 1].strip() if stmt.lineno <= len(self.lines) else ""
        return _short(line.rstrip(":").rstrip())

    def node(self, kind: str, label: str, caption: str, ctx: _Ctx, stmt: ast.AST | None = None) -> str:
        if len(self.nodes) >= MAX_NODES:
            raise _Truncated
        node_id = str(len(self.nodes))
        entry: dict = {"id": node_id, "kind": kind, "label": label, "caption": caption, "group": ctx.group}
        if stmt is not None and hasattr(stmt, "lineno"):
            entry["loc"] = {
                "line": stmt.lineno,
                "col": stmt.col_offset,
                "endLine": stmt.end_lineno or stmt.lineno,
                "endCol": stmt.end_col_offset or stmt.col_offset,
            }
            for part in _call_scope(stmt):
                self.sites.append((node_id, part, ctx.cls, ctx.group))
        self.nodes.append(entry)
        return node_id

    def edge(self, source: str, target: str, label: str | None = None, kind: str = "next") -> None:
        self.edges.append({"source": source, "target": target, "label": label, "kind": kind})

    def link(self, preds: list[Pred], target: str) -> None:
        for source, label, kind in preds:
            self.edge(source, target, label, kind)

    # -- building ----------------------------------------------------------

    def build(self) -> dict:
        truncated = False
        main = _Ctx()
        module = ast.parse(self.src)
        self.prepass(module)
        start = self.node("start", tr("Program start"), tr("The program begins here and runs top to bottom."), main)
        try:
            exits = self.seq(module.body, [(start, None, "next")], main)
            end = self.node("end", tr("Program end"), tr("Nothing is left to run: the program finishes."), main)
            self.link(exits, end)
        except _Truncated:
            truncated = True
        self.resolve_links()
        return {"nodes": self.nodes, "edges": self.edges, "groups": self.groups, "truncated": truncated}

    # -- classes, types and call links ------------------------------------

    def prepass(self, module: ast.Module) -> None:
        """Class names and `x = SomeClass(...)` variables, for linking calls."""
        names = {n.name for n in ast.walk(module) if isinstance(n, ast.ClassDef)}
        self.class_names = names
        for n in ast.walk(module):
            if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call):
                f = n.value.func
                if isinstance(f, ast.Name) and f.id in names:
                    for t in n.targets:
                        if isinstance(t, ast.Name):
                            self.var_types[t.id] = f.id

    def method(self, cls: str | None, name: str, seen: set | None = None) -> str | None:
        """Finds a method on a class or its bases (simple MRO)."""
        if cls is None or cls not in self.classes:
            return None
        seen = seen or set()
        if cls in seen:
            return None
        seen.add(cls)
        info = self.classes[cls]
        if name in info["methods"]:
            return info["methods"][name]
        for base in info["bases"]:
            found = self.method(base, name, seen)
            if found:
                return found
        return None

    def type_of(self, expr: ast.AST, cls: str | None) -> str | None:
        if isinstance(expr, ast.Name):
            if expr.id == "self":
                return cls
            return self.var_types.get(expr.id)
        if isinstance(expr, ast.Call) and isinstance(expr.func, ast.Name) and expr.func.id in self.classes:
            return expr.func.id
        return None

    def add_link(self, source: str, target: str, label: str, kind: str) -> None:
        key = (source, target, kind)
        if key not in self._linked:
            self._linked.add(key)
            self.edge(source, target, label, kind)

    def link_str(self, source: str, expr: ast.AST, cls: str | None) -> None:
        t = self.type_of(expr, cls)
        target = self.method(t, "__str__") or self.method(t, "__repr__")
        if target:
            self.add_link(source, target, tr("uses __str__"), "call")

    def resolve_links(self) -> None:
        for node, stmt, cls, group in self.sites:
            # Inside a function, show "this function uses X" once, from its
            # definition, instead of from every line that calls X.
            source = self.group_start.get(group, node) if group else node
            for sub in ast.walk(stmt):
                if isinstance(sub, ast.FormattedValue):
                    self.link_str(source, sub.value, cls)
                if not isinstance(sub, ast.Call):
                    continue
                f = sub.func
                if isinstance(f, ast.Name):
                    if f.id in self.functions:
                        self.add_link(source, self.functions[f.id], tr("uses") if group else tr("calls"), "call")
                    elif f.id in self.classes:
                        target = self.method(f.id, "__init__") or self.classes[f.id]["node"]
                        self.add_link(source, target, tr("creates {name}", name=f.id), "create")
                    elif f.id in ("print", "str"):
                        for arg in sub.args:
                            self.link_str(source, arg, cls)
                elif isinstance(f, ast.Attribute):
                    if isinstance(f.value, ast.Call) and isinstance(f.value.func, ast.Name) and f.value.func.id == "super" and cls in self.classes:
                        target = next((m for b in self.classes[cls]["bases"] if (m := self.method(b, f.attr))), None)
                        if target:
                            self.add_link(source, target, tr("calls parent"), "call")
                        continue
                    t = self.type_of(f.value, cls)
                    target = self.method(t, f.attr) if t else self.unique_method(f.attr)
                    if target:
                        self.add_link(source, target, tr("uses") if group else tr("calls"), "call")
        for name, info in self.classes.items():
            for base in info["bases"]:
                if base in self.classes:
                    self.add_link(info["node"], self.classes[base]["node"], tr("inherits from"), "inherit")

    def unique_method(self, name: str) -> str | None:
        found = [info["methods"][name] for info in self.classes.values() if name in info["methods"]]
        return found[0] if len(found) == 1 else None

    def seq(self, stmts: list[ast.stmt], preds: list[Pred], ctx: _Ctx) -> list[Pred]:
        for stmt in stmts:
            if not preds:  # unreachable (after return / break / continue)
                break
            preds = self.stmt(stmt, preds, ctx)
        return preds

    def stmt(self, s: ast.stmt, preds: list[Pred], ctx: _Ctx) -> list[Pred]:
        if isinstance(s, ast.If):
            d = self.node("decision", self.header(s), tr("Check the condition: if it is true go to “yes”, otherwise to “no”."), ctx, s)
            self.link(preds, d)
            yes = self.seq(s.body, [(d, tr("yes"), "yes")], ctx)
            no = self.seq(s.orelse, [(d, tr("no"), "no")], ctx) if s.orelse else [(d, tr("no"), "no")]
            return yes + no

        if isinstance(s, (ast.While, ast.For, ast.AsyncFor)):
            if isinstance(s, ast.While):
                caption = tr("Repeat while {cond} is true.", cond=_short(self.seg(s.test)))
                go, stop = tr("yes"), tr("no")
            else:
                caption = tr("Take each item of {it} one by one and put it in {var}.", it=_short(self.seg(s.iter)), var=_short(self.seg(s.target)))
                go, stop = tr("next item"), tr("done")
            head = self.node("loop", self.header(s), caption, ctx, s)
            self.link(preds, head)
            loop = _Loop(head)
            ctx.loops.append(loop)
            body = self.seq(s.body, [(head, go, "yes")], ctx)
            ctx.loops.pop()
            for source, _label, _kind in body:
                self.edge(source, head, tr("repeat"), "repeat")
            exits: list[Pred] = [(head, stop, "no")]
            if s.orelse:
                exits = self.seq(s.orelse, exits, ctx)
            return exits + loop.breaks

        if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.function(s, s.name, ctx)
            n = self.node("define", self.header(s), tr("Define the function {name}. Its steps run only when it is called.", name=s.name), ctx, s)
            self.link(preds, n)
            return [(n, None, "next")]

        if isinstance(s, ast.ClassDef):
            self.klass(s, ctx)
            n = self.node("define", self.header(s), tr("Define the class {name}: a blueprint for creating objects.", name=s.name), ctx, s)
            self.link(preds, n)
            return [(n, None, "next")]

        if isinstance(s, ast.Return):
            n = self.node("return", _short(self.seg(s)), tr("Give the result back and leave the function."), ctx, s)
            self.link(preds, n)
            if ctx.func_end:
                self.edge(n, ctx.func_end)
                return []
            return [(n, None, "next")]

        if isinstance(s, ast.Break) and ctx.loops:
            n = self.node("jump", "break", tr("Stop the loop right now and continue after it."), ctx, s)
            self.link(preds, n)
            ctx.loops[-1].breaks.append((n, tr("exit loop"), "no"))
            return []

        if isinstance(s, ast.Continue) and ctx.loops:
            n = self.node("jump", "continue", tr("Skip the rest of this round and go to the next one."), ctx, s)
            self.link(preds, n)
            self.edge(n, ctx.loops[-1].head, tr("repeat"), "repeat")
            return []

        if isinstance(s, (ast.Try, getattr(ast, "TryStar", ast.Try))):
            t = self.node("try", "try", tr("Try the steps below; if an error happens, jump to the matching except."), ctx, s)
            self.link(preds, t)
            exits = self.seq(s.body, [(t, None, "next")], ctx)
            if s.orelse:
                exits = self.seq(s.orelse, exits, ctx)
            for h in s.handlers:
                kind = _short(self.seg(h.type)) if h.type else tr("any error")
                hn = self.node("except", _short(self.lines[h.lineno - 1].strip().rstrip(":")), tr("Runs only if {kind} happened.", kind=kind), ctx, h)
                self.edge(t, hn, tr("on error"), "no")
                exits += self.seq(h.body, [(hn, None, "next")], ctx)
            if s.finalbody:
                exits = self.seq(s.finalbody, exits, ctx)
            return exits

        if isinstance(s, (ast.With, ast.AsyncWith)):
            w = self.node("statement", self.header(s), tr("Open a resource, run the steps inside, then close it."), ctx, s)
            self.link(preds, w)
            return self.seq(s.body, [(w, None, "next")], ctx)

        if isinstance(s, ast.Match):
            d = self.node("decision", self.header(s), tr("Compare the value with each case, top to bottom."), ctx, s)
            self.link(preds, d)
            exits: list[Pred] = []
            has_default = False
            for case in s.cases:
                pattern = _short(self.seg(case.pattern))
                has_default |= pattern == "_"
                exits += self.seq(case.body, [(d, tr("case {p}", p=pattern), "yes")], ctx)
            if not has_default:
                exits.append((d, tr("no match"), "no"))
            return exits

        kind, caption = self.explain(s)
        n = self.node(kind, _short(self.seg(s)), caption, ctx, s)
        self.link(preds, n)
        return [(n, None, "next")]

    def function(self, fn: ast.FunctionDef | ast.AsyncFunctionDef, name: str, outer: _Ctx, cls: str | None = None) -> str:
        self.groups.append(
            {"id": name, "title": tr("method {name}", name=fn.name) if cls else tr("function {name}", name=name), "kind": "method" if cls else "function", "parent": outer.group}
        )
        ctx = _Ctx(group=name, cls=cls)
        args = ", ".join(a.arg for a in fn.args.args)
        start = self.node("start", f"{fn.name}({args})", tr("The method {name} starts here when it is called." if cls else "The function {name} starts here when it is called.", name=fn.name), ctx, fn)
        self.functions.setdefault(name, start)
        self.group_start[name] = start
        end = self.node("end", tr("end of {name}", name=fn.name), tr("Go back to the line that called it."), ctx)
        ctx.func_end = end
        exits = self.seq(fn.body, [(start, None, "next")], ctx)
        self.link(exits, end)
        return start

    def klass(self, c: ast.ClassDef, outer: _Ctx) -> None:
        bases = [b.id for b in c.bases if isinstance(b, ast.Name)]
        methods = [m for m in c.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))]
        self.groups.append({"id": c.name, "title": tr("class {name}", name=c.name), "kind": "class", "parent": None})
        ctx = _Ctx(group=c.name)
        what = tr("methods: {list}", list=", ".join(m.name for m in methods)) if methods else tr("no methods")
        inherits = tr(" It inherits from {list}.", list=", ".join(bases)) if bases else ""
        node = self.node("class", self.header(c), tr("Blueprint for {name} objects with {what}.", name=c.name, what=what) + inherits, ctx, c)
        info = {"node": node, "bases": bases, "methods": {}}
        self.classes[c.name] = info
        for m in methods:
            # Methods are only linked from calls; they are not top-level functions.
            start = self.function(m, f"{c.name}.{m.name}", ctx, cls=c.name)
            self.functions.pop(f"{c.name}.{m.name}", None)
            info["methods"][m.name] = start

    def explain(self, s: ast.stmt) -> tuple[str, str]:
        call = s.value if isinstance(s, (ast.Expr, ast.Assign, ast.AnnAssign, ast.AugAssign)) else None
        call_name = ""
        if isinstance(call, ast.Call):
            f = call.func
            call_name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else ""

        if isinstance(s, (ast.Assign, ast.AnnAssign)):
            targets = s.targets if isinstance(s, ast.Assign) else [s.target]
            names = ", ".join(_short(self.seg(t)) for t in targets)
            if call_name == "input" or (isinstance(call, ast.Call) and "input(" in self.seg(call)):
                return "io", tr("Ask the user to type something and save it in {names}.", names=names)
            if call_name in self.class_names:
                return "statement", tr("Create a new {name} object (runs __init__) and save it in {names}.", name=call_name, names=names)
            if call_name:
                return "statement", tr("Call {name}(…) and save the result in {names}.", name=call_name, names=names)
            return "statement", tr("Save the value in {names}.", names=names)
        if isinstance(s, ast.AugAssign):
            op = {ast.Add: "Increase", ast.Sub: "Decrease", ast.Mult: "Multiply", ast.Div: "Divide"}.get(type(s.op), "Update")
            return "statement", tr(op + " {var} by {value}.", var=_short(self.seg(s.target)), value=_short(self.seg(s.value)))
        if isinstance(s, ast.Expr) and call_name:
            if call_name == "print":
                return "io", tr("Show text in the console.")
            if call_name == "input":
                return "io", tr("Wait until the user types something.")
            return "statement", tr("Call {name}(…).", name=call_name)
        if isinstance(s, (ast.Import, ast.ImportFrom)):
            return "statement", tr("Load code from another module so it can be used here.")
        if isinstance(s, ast.Pass):
            return "statement", tr("Do nothing (a placeholder).")
        if isinstance(s, ast.Raise):
            return "jump", tr("Stop with an error.")
        if isinstance(s, ast.Assert):
            return "statement", tr("Make sure the condition is true, otherwise stop with an error.")
        if isinstance(s, ast.Delete):
            return "statement", tr("Delete the variable or item.")
        return "statement", tr("Run this line.")


def build_flow(source: str, lang: str = "en") -> dict:
    global _lang
    _lang = lang
    return FlowBuilder(source).build()
