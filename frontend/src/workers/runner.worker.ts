/// <reference lib="webworker" />
// Executes the user's program. Runs off the main thread so a busy or blocked
// program (waiting for input(), an endless loop) never freezes the page.
import packagesSrc from "@/python/packages.py?raw"
import runnerSrc from "@/python/runner.py?raw"

import { bootPyodide, installSources, type PyodideInterface } from "./pyodide"
import {
  STDIN_EOF,
  STDIN_INTERRUPT,
  STDIN_WAITING,
  type InstallResult,
  type ProjectFiles,
  type RunnerEvent,
  type RunnerRequest,
} from "./protocol"

const MAX_OUTPUT_BYTES = 1_000_000

// ---- network --------------------------------------------------------------

/*
 * Most sites don't allow requests from a browser page (CORS), so the
 * program's HTTP requests (requests / urllib3 / pyodide.http) go through the
 * backend's proxy. Package downloads and our own origin stay direct.
 */
const DIRECT = new Set([self.location.origin, "https://cdn.jsdelivr.net", "https://pypi.org", "https://files.pythonhosted.org"])

function viaProxy(raw: string | URL): string {
  let url: URL
  try {
    url = new URL(String(raw), self.location.href)
  } catch {
    return String(raw)
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || DIRECT.has(url.origin)) return String(raw)
  return `${self.location.origin}/api/proxy?url=${encodeURIComponent(url.href)}`
}

// urllib3 (used by requests) starts its own nested Worker for streaming
// downloads when Worker exists, and that worker's fetch would bypass the
// proxy. Without Worker it uses XMLHttpRequest, which goes through viaProxy.
delete (self as { Worker?: unknown }).Worker

const directFetch = self.fetch.bind(self)
self.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (input instanceof Request) return directFetch(new Request(viaProxy(input.url), input), init)
  return directFetch(viaProxy(input), init)
}
const directOpen = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...args: unknown[]) => void
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  directOpen.call(this, method, viaProxy(url), ...rest)
} as typeof XMLHttpRequest.prototype.open
const post = (event: RunnerEvent) => postMessage(event)

let py: PyodideInterface | null = null
let buffers: { control: Int32Array; data: Uint8Array; interrupt: Uint8Array } | null = null
const installed = new Set<string>()
let ready: Promise<void> | null = null

// ---- output ---------------------------------------------------------------

/** Coalesces writes: the worker is busy while Python runs, so timers never fire. */
class Stream {
  private decoder = new TextDecoder()
  private pending = ""
  private last = 0
  private kind: "stdout" | "stderr"
  constructor(kind: "stdout" | "stderr") {
    this.kind = kind
  }
  write(bytes: Uint8Array) {
    this.pending += this.decoder.decode(bytes, { stream: true })
    const now = performance.now()
    if (this.pending.length > 4096 || now - this.last > 16) this.flush()
  }
  flush() {
    if (!this.pending) return
    post({ type: this.kind, data: this.pending })
    this.pending = ""
    this.last = performance.now()
  }
}

const stdout = new Stream("stdout")
const stderr = new Stream("stderr")
let outputBytes = 0
let outputLimited = false

function countOutput(n: number) {
  outputBytes += n
  if (outputBytes > MAX_OUTPUT_BYTES && !outputLimited && buffers) {
    outputLimited = true
    buffers.interrupt[0] = 2 // SIGINT: stop the program
  }
}

// ---- boot -----------------------------------------------------------------

async function boot() {
  py = await bootPyodide()
  installSources(py, "pycoder", { "runner.py": runnerSrc, "packages.py": packagesSrc })
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide')")

  py.setStdout({ write: (b: Uint8Array) => (countOutput(b.length), stdout.write(b), b.length), isatty: true })
  py.setStderr({ write: (b: Uint8Array) => (countOutput(b.length), stderr.write(b), b.length), isatty: true })
  py.setStdin({ stdin: readLine, isatty: true })
  if (buffers) py.setInterruptBuffer(buffers.interrupt)

  post({ type: "ready", python: py.runPython("import sys; sys.version.split()[0]") as string })
}

/** Blocks the worker until the page sends a line (or EOF / Stop). */
function readLine(): string | null {
  if (!buffers || !py) return null
  stdout.flush()
  stderr.flush()
  const { control, data } = buffers
  Atomics.store(control, 0, STDIN_WAITING)
  post({ type: "input_request" })
  Atomics.wait(control, 0, STDIN_WAITING)
  const state = Atomics.load(control, 0)
  if (state === STDIN_INTERRUPT) {
    py.checkInterrupt() // raises KeyboardInterrupt inside Python
    return null
  }
  if (state === STDIN_EOF) return null
  const length = Atomics.load(control, 1)
  return new TextDecoder().decode(data.slice(0, length))
}

// ---- packages -------------------------------------------------------------

async function installPackages(specs: string[]): Promise<InstallResult[]> {
  const todo = specs.filter((s) => !installed.has(s))
  if (!todo.length) return specs.map((spec) => ({ spec }))
  if (!py) throw new Error("Python is not ready")
  await py.loadPackage(["micropip", "packaging"], { messageCallback: () => {} })
  const install = py.pyimport("pycoder.packages").install
  const proxy = await install(py.toPy(todo))
  const results = proxy.toJs({ dict_converter: Object.fromEntries }) as InstallResult[]
  proxy.destroy()
  for (const r of results) if (!r.error) installed.add(r.spec)
  return results
}

// ---- run ------------------------------------------------------------------

async function run(id: number, files: ProjectFiles, entry: string, specs: string[]) {
  if (!py || !buffers) return
  const missing = specs.filter((s) => !installed.has(s))
  if (missing.length) {
    post({ type: "status", text: `Installing ${missing.join(", ")}…` })
    const failed = (await installPackages(missing)).filter((r) => r.error)
    for (const f of failed) post({ type: "stderr", data: `Could not install ${f.spec}: ${f.error}\n` })
  }

  const runner = py.pyimport("pycoder.runner")
  const text: Record<string, string> = {}
  for (const [path, content] of Object.entries(files)) if (typeof content === "string") text[path] = content
  const filesPy = py.toPy(text)
  runner.write_project(filesPy)
  filesPy.destroy()
  // Binary files (images, data) go next to the code as they are.
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === "string") continue
    const full = `/home/pyodide/project/${path}`
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")))
    py.FS.writeFile(full, content)
  }
  outputBytes = 0
  outputLimited = false
  buffers.interrupt[0] = 0
  const started = performance.now()
  let exitCode = 1
  try {
    exitCode = runner.run_main(entry) as number
  } catch (err) {
    stderr.flush()
    post({ type: "stderr", data: `\n${String(err)}\n` })
  }
  stdout.flush()
  stderr.flush()
  buffers.interrupt[0] = 0
  post({ type: "exit", id, code: exitCode, duration: (performance.now() - started) / 1000, reason: outputLimited ? "output_limit" : null })
}

// ---- messages -------------------------------------------------------------

// Requests are handled one at a time, in order.
let queue: Promise<unknown> = Promise.resolve()

self.onmessage = (msg: MessageEvent<RunnerRequest>) => {
  const req = msg.data
  if (req.type === "init") {
    buffers = {
      control: new Int32Array(req.buffers.control),
      data: new Uint8Array(req.buffers.data),
      interrupt: new Uint8Array(req.buffers.interrupt),
    }
    ready = boot().catch((err) => post({ type: "boot-error", message: String(err) }))
    return
  }
  queue = queue.then(async () => {
    await ready
    if (req.type === "install") {
      try {
        post({ type: "installed", id: req.id, results: await installPackages(req.specs) })
      } catch (err) {
        post({ type: "installed", id: req.id, results: req.specs.map((spec) => ({ spec, error: String(err) })) })
      }
    } else if (req.type === "run") {
      await run(req.id, req.files, req.entry, req.specs)
    }
  })
}

