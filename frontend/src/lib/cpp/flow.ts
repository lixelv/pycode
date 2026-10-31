/**
 * Builds the execution-order flowchart of C++ code: the same structure and
 * format as `python/flow.py` (steps, yes/no branches, repeat edges, a frame per
 * function, class and method, call links resolved after building).
 */
import type { AstLoc } from "@/lib/ast"
import type { FlowEdgeKind, FlowGroup, FlowKind, FlowResponse, FlowStep } from "@/lib/flow"

import { locOf, parseCpp, syntaxError, type Node } from "./parse"

const MAX_NODES = 1500
const MAX_LABEL = 60
// Deeper nesting (e.g. thousands of `{{{…}}}`) is cut off like too many nodes.
const MAX_DEPTH = 200

// A pending connection: (node id, edge label, edge kind).
type Pred = [string, string | null, FlowEdgeKind]
type Edge = { source: string; target: string; label: string | null; kind: FlowEdgeKind }

type Ctx = {
  group: string
  funcEnd: string
  cls: string | null // class whose method is being built (resolves m() and this->m())
  main: boolean
  loops: string[] // continue targets
  breaks: Pred[][] // where `break` leaves to: loops and switches
}

// Russian versions of every caption and label (keys are the English templates).
const RU: Record<string, string> = {
  "Program start": "Начало программы",
  "Program end": "Конец программы",
  "The program begins here: main() runs top to bottom.": "Программа начинается здесь: main() выполняется сверху вниз.",
  "main() is over: the program finishes.": "main() закончилась: программа завершается.",
  "Check the condition: if it is true go to “yes”, otherwise to “no”.": "Проверить условие: если оно истинно — идём по «да», иначе по «нет».",
  "Repeat while {cond} is true.": "Повторять, пока {cond} истинно.",
  "Repeat forever (until break or return).": "Повторять бесконечно (до break или return).",
  "Run the steps, then repeat while {cond} is true.": "Выполнить шаги, затем повторять, пока {cond} истинно.",
  "Take each item of {it} one by one and put it in {var}.": "Брать по очереди каждый элемент из {it} и класть его в {var}.",
  "Compare {subject} with {value}: if they are equal go to “yes”, otherwise to “no”.": "Сравнить {subject} с {value}: если они равны — идём по «да», иначе по «нет».",
  "No case matched: run the default steps.": "Ни один случай не подошёл: выполнить шаги default.",
  yes: "да",
  no: "нет",
  "next item": "следующий",
  done: "готово",
  repeat: "повторить",
  "exit loop": "выйти из цикла",
  "on error": "при ошибке",
  "any error": "любая ошибка",
  "Give the result back and leave the function.": "Вернуть результат и выйти из функции.",
  "Stop the loop right now and continue after it.": "Сразу прервать цикл и продолжить после него.",
  "Skip the rest of this round and go to the next one.": "Пропустить остаток этого шага цикла и перейти к следующему.",
  "Try the steps below; if an error happens, jump to the matching catch.": "Попробовать выполнить шаги ниже; если случится ошибка — перейти к подходящему catch.",
  "Runs only if {kind} happened.": "Выполняется, только если произошла {kind}.",
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
  "Read what the user types.": "Прочитать то, что ввёл пользователь.",
  "Show text in the console.": "Вывести текст в консоль.",
  "Create {names} and give it a value.": "Создать {names} и задать значение.",
  "Create {names}.": "Создать {names}.",
  "Call {name}(…) and save the result in {names}.": "Вызвать {name}(…) и сохранить результат в {names}.",
  "Save the value in {names}.": "Сохранить значение в {names}.",
  "Increase {var} by {value}.": "Увеличить {var} на {value}.",
  "Decrease {var} by {value}.": "Уменьшить {var} на {value}.",
  "Multiply {var} by {value}.": "Умножить {var} на {value}.",
  "Divide {var} by {value}.": "Разделить {var} на {value}.",
  "Update {var} by {value}.": "Изменить {var} на {value}.",
  "Call {name}(…).": "Вызвать {name}(…).",
  "Stop with an error.": "Остановиться с ошибкой.",
  "Run this line.": "Выполнить эту строку.",
  calls: "вызывает",
  uses: "использует",
  "inherits from": "наследует от",
}

const INPUT = new Set(["cin", "scanf", "getline", "getchar", "fgets"])
const OUTPUT = new Set(["cout", "cerr", "clog", "printf", "puts", "putchar"])
const CLASSES = new Set(["class_specifier", "struct_specifier"])

const short = (text: string) => {
  text = text.split(/\s+/).filter(Boolean).join(" ")
  return text.length <= MAX_LABEL ? text : text.slice(0, MAX_LABEL - 1) + "…"
}

/** A condition without its brackets: `(x > 0)` → `x > 0`. */
const bare = (n: Node | null | undefined) => short(n?.text.replace(/^\(([\s\S]*)\)$/, "$1") ?? "")

const named = (n: Node | null | undefined): Node[] =>
  (n?.namedChildren ?? []).filter((c): c is Node => !!c && c.type !== "comment")

/** All named descendants, the node itself included (iterative: code may nest deeply). */
function* walk(n: Node): Generator<Node> {
  const stack = [n]
  for (let next = stack.pop(); next; next = stack.pop()) {
    yield next
    for (const c of [...next.namedChildren].reverse()) if (c) stack.push(c)
  }
}

class Truncated extends Error {}

class FlowBuilder {
  nodes: FlowStep[] = []
  edges: Edge[] = []
  groups: FlowGroup[] = []
  functions = new Map<string, string>() // free function name -> start node
  classes = new Map<string, { node: string; bases: string[]; methods: Map<string, string> }>()
  // (node, part of the code to scan for calls, class, group, inside main)
  sites: [string, Node, string | null, string, boolean][] = []
  groupStart = new Map<string, string>()
  linked = new Set<string>()
  depth = 0
  private code: string
  private lang: "en" | "ru"
  private lines: string[]

  constructor(code: string, lang: "en" | "ru") {
    this.code = code
    this.lang = lang
    this.lines = code.split("\n")
  }

  tr(template: string, values: Record<string, string> = {}) {
    const text = this.lang === "ru" ? (RU[template] ?? template) : template
    return text.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "")
  }

  /** The statement's text up to its body: `for (int i = 0; i < n; i++)`. */
  header(s: Node, body: Node | null) {
    return short(this.code.slice(s.startIndex, body ? body.startIndex : s.endIndex))
  }

  node(kind: FlowKind, label: string, caption: string, ctx: Ctx | null, s?: Node, scope: Node[] = []): string {
    if (this.nodes.length >= MAX_NODES) throw new Truncated()
    const id = String(this.nodes.length)
    const loc: AstLoc | undefined = s ? locOf(s, this.lines) : undefined
    this.nodes.push({ id, kind, label, caption, group: ctx?.group ?? null, ...(loc ? { loc } : {}) })
    if (ctx) for (const part of scope) this.sites.push([id, part, ctx.cls, ctx.group, ctx.main])
    return id
  }

  edge(source: string, target: string, label: string | null = null, kind: FlowEdgeKind = "next") {
    this.edges.push({ source, target, label, kind })
  }

  link(preds: Pred[], target: string) {
    for (const [source, label, kind] of preds) this.edge(source, target, label, kind)
  }

  uniqueGroup(id: string) {
    let unique = id
    for (let i = 2; this.groups.some((g) => g.id === unique); i++) unique = `${id} #${i}`
    return unique
  }

  // -- building ---------------------------------------------------------

  build(root: Node): FlowResponse {
    let truncated = false
    try {
      this.declarations(root, null)
    } catch (e) {
      if (!(e instanceof Truncated)) throw e
      truncated = true
    }
    this.resolveLinks()
    return { ok: true, nodes: this.nodes, edges: this.edges, groups: this.groups, truncated }
  }

  /** Runs a step of the recursive descent, cut off past MAX_DEPTH. */
  nested<T>(fn: () => T): T {
    if (this.depth >= MAX_DEPTH) throw new Truncated()
    this.depth++
    try {
      return fn()
    } finally {
      this.depth--
    }
  }

  /** Top-level code: functions and classes, also inside namespaces and templates. */
  declarations(n: Node, cls: string | null) {
    this.nested(() => this.declarationsIn(n, cls))
  }

  declarationsIn(n: Node, cls: string | null) {
    for (const d of named(n)) {
      if (d.type === "function_definition") this.function(d, cls)
      else if (CLASSES.has(d.type)) this.klass(d, cls)
      else if (["namespace_definition", "linkage_specification", "template_declaration", "declaration_list", "field_declaration_list"].includes(d.type))
        this.declarations(d.childForFieldName("body") ?? d, cls)
      else if (d.type === "declaration" || d.type === "field_declaration") {
        // `struct P {...} p;` declares a class and a variable at once.
        const type = d.childForFieldName("type")
        if (type && CLASSES.has(type.type)) this.klass(type, cls)
      }
    }
  }

  function(fn: Node, cls: string | null) {
    let decl = fn.childForFieldName("declarator")
    while (decl && decl.type !== "function_declarator") decl = decl.childForFieldName("declarator")
    const nameNode = decl?.childForFieldName("declarator")
    const body = fn.childForFieldName("body")
    if (!decl || !nameNode || !body) return
    let name = nameNode.text
    // `void P::m() {}` defined outside its class is still P's method.
    if (!cls && nameNode.type === "qualified_identifier") {
      const scope = nameNode.childForFieldName("scope")?.text
      if (scope && this.classes.has(scope)) {
        cls = scope
        name = nameNode.childForFieldName("name")?.text ?? name
      }
    }
    const isMain = !cls && name === "main"
    const id = this.uniqueGroup(cls ? `${cls}::${name}` : name)
    this.groups.push({
      id,
      title: this.tr(cls ? "method {name}" : "function {name}", { name }),
      kind: cls ? "method" : "function",
      parent: cls,
    })
    const ctx: Ctx = { group: id, funcEnd: "", cls, main: isMain, loops: [], breaks: [] }
    const start = isMain
      ? this.node("start", this.tr("Program start"), this.tr("The program begins here: main() runs top to bottom."), ctx, decl)
      : this.node(
          "start",
          short(decl.text),
          this.tr(cls ? "The method {name} starts here when it is called." : "The function {name} starts here when it is called.", { name }),
          ctx,
          decl,
        )
    if (cls) this.classes.get(cls)!.methods.set(name, start)
    else if (!this.functions.has(name)) this.functions.set(name, start)
    this.groupStart.set(id, start)
    ctx.funcEnd = isMain
      ? this.node("end", this.tr("Program end"), this.tr("main() is over: the program finishes."), ctx)
      : this.node("end", this.tr("end of {name}", { name }), this.tr("Go back to the line that called it."), ctx)
    this.link(this.seq(named(body), [[start, null, "next"]], ctx), ctx.funcEnd)
  }

  klass(c: Node, parent: string | null) {
    const name = c.childForFieldName("name")?.text
    const body = c.childForFieldName("body")
    if (!name || !body) return
    const id = this.uniqueGroup(name)
    const bases = named(named(c).find((n) => n.type === "base_class_clause"))
      .filter((n) => n.type !== "access_specifier")
      .map((n) => n.text)
    const methods = named(body)
      .map((m) => (m.type === "template_declaration" ? named(m).find((x) => x.type === "function_definition") : m))
      .filter((m) => m?.type === "function_definition")
      .map((m) => {
        let d = m!.childForFieldName("declarator")
        while (d && d.type !== "function_declarator") d = d.childForFieldName("declarator")
        return d?.childForFieldName("declarator")?.text ?? ""
      })
    this.groups.push({ id, title: this.tr("class {name}", { name }), kind: "class", parent })
    const what = methods.length ? this.tr("methods: {list}", { list: methods.join(", ") }) : this.tr("no methods")
    const inherits = bases.length ? this.tr(" It inherits from {list}.", { list: bases.join(", ") }) : ""
    const ctx = { group: id } as Ctx
    const node = this.node("class", this.header(c, body), this.tr("Blueprint for {name} objects with {what}.", { name, what }) + inherits, ctx, c)
    this.classes.set(id, { node, bases, methods: new Map() })
    this.declarations(body, id)
  }

  seq(stmts: Node[], preds: Pred[], ctx: Ctx): Pred[] {
    for (const s of stmts) {
      if (!preds.length) break // unreachable (after return / break / continue)
      preds = this.stmt(s, preds, ctx)
    }
    return preds
  }

  /** Runs a loop body with `break` and `continue` bound to this loop. */
  loopBody(body: Node | null, preds: Pred[], head: string, ctx: Ctx): { exits: Pred[]; breaks: Pred[] } {
    const breaks: Pred[] = []
    ctx.loops.push(head)
    ctx.breaks.push(breaks)
    const exits = this.seq(body ? [body] : [], preds, ctx)
    ctx.loops.pop()
    ctx.breaks.pop()
    return { exits, breaks }
  }

  stmt(s: Node, preds: Pred[], ctx: Ctx): Pred[] {
    return this.nested(() => this.step(s, preds, ctx))
  }

  step(s: Node, preds: Pred[], ctx: Ctx): Pred[] {
    const f = (name: string) => s.childForFieldName(name)
    const tr = this.tr.bind(this)

    switch (s.type) {
      case "compound_statement":
        return this.seq(named(s), preds, ctx)

      case "if_statement": {
        const cond = f("condition")
        const d = this.node("decision", this.header(s, f("consequence")), tr("Check the condition: if it is true go to “yes”, otherwise to “no”."), ctx, s, cond ? [cond] : [])
        this.link(preds, d)
        const yes = this.seq([f("consequence")!].filter(Boolean), [[d, tr("yes"), "yes"]], ctx)
        const alt = named(f("alternative"))
        const no = alt.length ? this.seq(alt, [[d, tr("no"), "no"]], ctx) : [[d, tr("no"), "no"] as Pred]
        return [...yes, ...no]
      }

      case "while_statement":
      case "for_statement":
      case "for_range_loop": {
        const body = f("body")
        let caption: string
        let go = tr("yes")
        let stop = tr("no")
        let scope: Node[]
        if (s.type === "for_range_loop") {
          caption = tr("Take each item of {it} one by one and put it in {var}.", { it: short(f("right")?.text ?? ""), var: short(f("declarator")?.text ?? "") })
          go = tr("next item")
          stop = tr("done")
          scope = [f("right")].filter((n): n is Node => !!n)
        } else {
          const cond = f("condition")
          caption = cond ? tr("Repeat while {cond} is true.", { cond: bare(cond) }) : tr("Repeat forever (until break or return).")
          scope = [f("initializer"), cond, f("update")].filter((n): n is Node => !!n)
        }
        const head = this.node("loop", this.header(s, body), caption, ctx, s, scope)
        this.link(preds, head)
        const { exits, breaks } = this.loopBody(body, [[head, go, "yes"]], head, ctx)
        for (const [source] of exits) this.edge(source, head, tr("repeat"), "repeat")
        return [[head, stop, "no"], ...breaks]
      }

      case "do_statement": {
        // The steps run first, the condition comes after them.
        const cond = f("condition")
        const body = f("body")
        const head = this.node("loop", short(`while ${cond?.text ?? ""}`), tr("Run the steps, then repeat while {cond} is true.", { cond: bare(cond) }), ctx, cond ?? s, cond ? [cond] : [])
        const entry = `entry:${head}`
        const { exits, breaks } = this.loopBody(body, [[entry, null, "next"]], head, ctx)
        // The body's first steps are what the loop repeats.
        const firsts = this.edges.filter((e) => e.source === entry).map((e) => e.target)
        this.edges = this.edges.filter((e) => e.source !== entry)
        for (const target of firsts) {
          this.link(preds, target)
          this.edge(head, target, tr("repeat"), "repeat")
        }
        if (exits.some(([source]) => source === entry)) this.link(preds, head) // empty body
        this.link(exits.filter(([source]) => source !== entry), head)
        return [[head, tr("no"), "no"], ...breaks]
      }

      case "switch_statement": {
        // A chain of conditions, one per case; steps fall through to the next case until break.
        const subject = bare(f("condition"))
        const breaks: Pred[] = []
        ctx.breaks.push(breaks)
        let pending = preds
        let fall: Pred[] = []
        let fallback: Node | null = null
        const cases = named(f("body")).filter((c) => c.type === "case_statement")
        for (const c of cases) {
          const value = c.childForFieldName("value")
          if (!value) {
            fallback = c
            continue
          }
          const d = this.node(
            "decision",
            short(`case ${value.text}`),
            tr("Compare {subject} with {value}: if they are equal go to “yes”, otherwise to “no”.", { subject, value: short(value.text) }),
            ctx,
            c,
            c === cases[0] && f("condition") ? [f("condition")!] : [],
          )
          this.link(pending, d)
          fall = this.seq(named(c).filter((n) => n.id !== value.id), [[d, tr("yes"), "yes"], ...fall], ctx)
          pending = [[d, tr("no"), "no"]]
        }
        if (fallback) {
          const into = fallback === cases[cases.length - 1] ? [...pending, ...fall] : pending
          fall = fallback === cases[cases.length - 1] ? [] : fall
          pending = []
          fall = [...fall, ...this.seq(named(fallback), into, ctx)]
        }
        ctx.breaks.pop()
        return [...pending, ...fall, ...breaks]
      }

      case "return_statement": {
        const n = this.node("return", short(s.text), tr("Give the result back and leave the function."), ctx, s, [s])
        this.link(preds, n)
        this.edge(n, ctx.funcEnd)
        return []
      }

      case "break_statement":
        if (ctx.breaks.length) {
          const n = this.node("jump", "break", tr("Stop the loop right now and continue after it."), ctx, s)
          this.link(preds, n)
          ctx.breaks[ctx.breaks.length - 1].push([n, tr("exit loop"), "no"])
          return []
        }
        break

      case "continue_statement":
        if (ctx.loops.length) {
          const n = this.node("jump", "continue", tr("Skip the rest of this round and go to the next one."), ctx, s)
          this.link(preds, n)
          this.edge(n, ctx.loops[ctx.loops.length - 1], tr("repeat"), "repeat")
          return []
        }
        break

      case "try_statement": {
        const t = this.node("try", "try", tr("Try the steps below; if an error happens, jump to the matching catch."), ctx, s)
        this.link(preds, t)
        let exits = this.seq([f("body")!].filter(Boolean), [[t, null, "next"]], ctx)
        for (const h of named(s).filter((n) => n.type === "catch_clause")) {
          const params = h.childForFieldName("parameters")
          const kind = params && params.text !== "(...)" ? short(params.text.slice(1, -1)) : tr("any error")
          const hn = this.node("except", this.header(h, h.childForFieldName("body")), tr("Runs only if {kind} happened.", { kind }), ctx, h)
          this.edge(t, hn, tr("on error"), "no")
          exits = [...exits, ...this.seq([h.childForFieldName("body")!].filter(Boolean), [[hn, null, "next"]], ctx)]
        }
        return exits
      }
    }

    const [kind, caption] = this.explain(s)
    const n = this.node(kind, short(s.text), caption, ctx, s, [s])
    this.link(preds, n)
    return [[n, null, "next"]]
  }

  explain(s: Node): [FlowKind, string] {
    const tr = this.tr.bind(this)
    const words = [...walk(s)].filter((n) => n.type === "identifier").map((n) => n.text)
    if (words.some((w) => INPUT.has(w))) return ["io", tr("Read what the user types.")]
    if (words.some((w) => OUTPUT.has(w))) return ["io", tr("Show text in the console.")]
    if (s.type === "throw_statement") return ["jump", tr("Stop with an error.")]

    const callName = (n: Node | null | undefined) => {
      const fn = n?.type === "call_expression" ? n.childForFieldName("function") : null
      return fn ? (fn.childForFieldName("field") ?? fn.childForFieldName("name") ?? fn).text : ""
    }

    if (s.type === "declaration") {
      const declarators = s.childrenForFieldName("declarator").filter((d): d is Node => !!d)
      const names = declarators.map((d) => short((d.childForFieldName("declarator") ?? d).text)).join(", ")
      const value = declarators.map((d) => d.childForFieldName("value")).find(Boolean)
      const call = callName(value)
      if (call) return ["statement", tr("Call {name}(…) and save the result in {names}.", { name: call, names })]
      return ["statement", tr(value ? "Create {names} and give it a value." : "Create {names}.", { names })]
    }

    const e = s.type === "expression_statement" ? named(s)[0] : null
    if (e?.type === "assignment_expression") {
      const left = short(e.childForFieldName("left")?.text ?? "")
      const right = e.childForFieldName("right")
      const op = e.childForFieldName("operator")?.text ?? "="
      if (op === "=") {
        const call = callName(right)
        if (call) return ["statement", tr("Call {name}(…) and save the result in {names}.", { name: call, names: left })]
        return ["statement", tr("Save the value in {names}.", { names: left })]
      }
      const verb = { "+=": "Increase", "-=": "Decrease", "*=": "Multiply", "/=": "Divide" }[op] ?? "Update"
      return ["statement", tr(`${verb} {var} by {value}.`, { var: left, value: short(right?.text ?? "") })]
    }
    if (e?.type === "update_expression") {
      const verb = e.text.includes("++") ? "Increase" : "Decrease"
      return ["statement", tr(`${verb} {var} by {value}.`, { var: short(e.childForFieldName("argument")?.text ?? ""), value: "1" })]
    }
    const call = callName(e)
    if (call) return ["statement", tr("Call {name}(…).", { name: call })]
    return ["statement", tr("Run this line.")]
  }

  // -- call links -------------------------------------------------------

  addLink(source: string, target: string, label: string, kind: FlowEdgeKind) {
    const key = `${source} ${target} ${kind}`
    if (this.linked.has(key)) return
    this.linked.add(key)
    this.edge(source, target, label, kind)
  }

  /** A method on a class or its bases. */
  method(cls: string | null, name: string, seen = new Set<string>()): string | undefined {
    const info = cls ? this.classes.get(cls) : undefined
    if (!info || seen.has(cls!)) return undefined
    seen.add(cls!)
    return info.methods.get(name) ?? info.bases.map((b) => this.method(b, name, seen)).find(Boolean)
  }

  uniqueMethod(name: string) {
    const found = [...this.classes.values()].map((c) => c.methods.get(name)).filter(Boolean)
    return found.length === 1 ? found[0] : undefined
  }

  resolveLinks() {
    for (const [node, part, cls, group, main] of this.sites) {
      // Outside main, show "this function uses X" once, from its start,
      // instead of from every line that calls X.
      const source = main ? node : (this.groupStart.get(group) ?? node)
      const label = this.tr(main ? "calls" : "uses")
      for (const sub of walk(part)) {
        if (sub.type !== "call_expression") continue
        const fn = sub.childForFieldName("function")
        let target: string | undefined
        if (fn?.type === "identifier") target = this.method(cls, fn.text) ?? this.functions.get(fn.text)
        else if (fn?.type === "qualified_identifier") {
          const scope = fn.childForFieldName("scope")?.text ?? ""
          const name = fn.childForFieldName("name")?.text ?? ""
          target = this.method(scope, name) ?? this.functions.get(fn.text) ?? this.functions.get(name)
        } else if (fn?.type === "field_expression") {
          const name = fn.childForFieldName("field")?.text ?? ""
          target = fn.childForFieldName("argument")?.type === "this" ? this.method(cls, name) : this.uniqueMethod(name)
        }
        if (target) this.addLink(source, target, label, "call")
      }
    }
    for (const info of this.classes.values())
      for (const base of info.bases) {
        const parent = this.classes.get(base)
        if (parent) this.addLink(info.node, parent.node, this.tr("inherits from"), "inherit")
      }
  }
}

/** The C++ flowchart in the format `flow.py` returns for Python. */
export async function cppFlow(code: string, lang: "en" | "ru"): Promise<FlowResponse> {
  const tree = await parseCpp(code)
  try {
    const error = syntaxError(tree.rootNode)
    if (error) return { ok: false, error }
    return new FlowBuilder(code, lang).build(tree.rootNode)
  } finally {
    tree.delete()
  }
}
