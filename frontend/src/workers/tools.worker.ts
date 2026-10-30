/// <reference lib="webworker" />
// Static analysis in its own interpreter, so hints and the flowchart keep
// working while the user's program runs or waits for input().
import astTreeSrc from "@/python/ast_tree.py?raw"
import flowSrc from "@/python/flow.py?raw"
import intellisenseSrc from "@/python/intellisense.py?raw"
import packagesSrc from "@/python/packages.py?raw"
import viewsSrc from "@/python/views.py?raw"

import { bootPyodide, installSources, type PyodideInterface } from "./pyodide"
import type { ToolRequest, ToolResponse } from "./protocol"

let pyReady: Promise<PyodideInterface> | null = null
let jediReady: Promise<void> | null = null
const installed = new Set<string>()

function python() {
  pyReady ??= bootPyodide().then((py) => {
    installSources(py, "polycode", {
      "ast_tree.py": astTreeSrc,
      "flow.py": flowSrc,
      "intellisense.py": intellisenseSrc,
      "packages.py": packagesSrc,
      "views.py": viewsSrc,
    })
    py.runPython("import sys; sys.path.insert(0, '/home/pyodide')")
    return py
  })
  return pyReady
}

const toJs = (value: unknown) => {
  if (value && typeof value === "object" && "toJs" in value) {
    const proxy = value as { toJs: (o: object) => unknown; destroy: () => void }
    const out = proxy.toJs({ dict_converter: Object.fromEntries })
    proxy.destroy()
    return out
  }
  return value
}

async function handle(req: ToolRequest): Promise<unknown> {
  const py = await python()
  const code = req.code ?? ""
  switch (req.kind) {
    case "flow":
    case "ast":
      return toJs(py.pyimport("polycode.views").view(req.kind, code, req.lang ?? "en"))
    case "install": {
      await py.loadPackage(["micropip", "packaging"], { messageCallback: () => {} })
      const todo = (req.specs ?? []).filter((s) => !installed.has(s))
      if (todo.length) {
        await py.pyimport("polycode.packages").install(py.toPy(todo))
        todo.forEach((s) => installed.add(s))
      }
      return true
    }
    default: {
      jediReady ??= py.loadPackage("jedi", { messageCallback: () => {} }).then(() => undefined)
      await jediReady
      const mod = py.pyimport("polycode.intellisense")
      const fn = req.kind === "complete" ? mod.complete : req.kind === "signature" ? mod.signatures : mod.hover
      return toJs(fn(code, req.line, req.column)) ?? null
    }
  }
}

self.onmessage = async (msg: MessageEvent<ToolRequest>) => {
  const req = msg.data
  let response: ToolResponse
  try {
    response = { id: req.id, ok: true, result: await handle(req) }
  } catch (err) {
    response = { id: req.id, ok: false, error: String(err) }
  }
  postMessage(response)
}
