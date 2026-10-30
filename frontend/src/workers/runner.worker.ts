/// <reference lib="webworker" />
// Executes the user's program. Runs off the main thread so a busy or blocked
// program (waiting for input(), an endless loop) never freezes the page.
import packagesSrc from "@/python/packages.py?raw"
import checkerSrc from "@/python/checker.py?raw"
import debuggerSrc from "@/python/debugger.py?raw"
import runnerSrc from "@/python/runner.py?raw"

import { bootPyodide, installSources, type PyodideInterface } from "./pyodide"
import {
  DEBUG_COMMANDS,
  DEBUG_WAITING,
  STDIN_EOF,
  STDIN_INTERRUPT,
  STDIN_WAITING,
  type CheckResult,
  type DebugCommand,
  type DebugState,
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
const DIRECT = new Set(["https://cdn.jsdelivr.net", "https://pypi.org", "https://files.pythonhosted.org"])

/*
 * The program may be someone else's (a teacher runs a student's file), and
 * this worker shares the app's origin and cookie. So of our own site it
 * reaches only the Python runtime and the proxy: not the API (codes, roles),
 * not the session socket, not the browser's storage (the project).
 */
function viaProxy(raw: string | URL): string {
  let url: URL
  try {
    url = new URL(String(raw), self.location.href)
  } catch {
    return String(raw)
  }
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/pyodide/") || url.pathname === "/api/proxy") return String(raw)
    throw new TypeError(`Programs cannot request ${url.pathname} of this site.`)
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || DIRECT.has(url.origin)) return String(raw)
  return `${self.location.origin}/api/proxy?url=${encodeURIComponent(url.href)}`
}

/**
 * Replaces a global everywhere it can be found (the worker and its
 * prototypes), so the original is out of reach. (Configurable, so a check
 * can remove it later; deleting it brings nothing back.)
 */
function replaceGlobal(name: string, value: unknown) {
  for (let o: object | null = self; o; o = Object.getPrototypeOf(o)) {
    if (Object.getOwnPropertyDescriptor(o, name)) Object.defineProperty(o, name, { value, configurable: true, writable: false })
  }
}

// urllib3 (used by requests) starts its own nested Worker for streaming
// downloads when Worker exists, and that worker's fetch would bypass the
// proxy. Without Worker it uses XMLHttpRequest, which goes through viaProxy.
delete (self as { Worker?: unknown }).Worker

const directFetch = self.fetch.bind(self)
replaceGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    if (input instanceof Request) return directFetch(new Request(viaProxy(input.url), input), init)
    return directFetch(viaProxy(input), init)
  } catch (err) {
    return Promise.reject(err)
  }
})
for (const name of ["indexedDB", "caches", "WebSocket", "EventSource", "WebTransport"]) replaceGlobal(name, undefined)
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
  installSources(py, "pycoder", { "runner.py": runnerSrc, "packages.py": packagesSrc, "checker.py": checkerSrc, "debugger.py": debuggerSrc })
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

/**
 * Loads the packages Pyodide builds itself (numpy, pandas, matplotlib…) that
 * the project's Python files import, so `import numpy` works without adding
 * it on the Packages tab first.
 */
async function loadImported(files: ProjectFiles) {
  if (!py) return
  const sources = Object.entries(files)
    .filter(([path, content]) => path.endsWith(".py") && typeof content === "string")
    .map(([, content]) => content as string)
    .join("\n")
  try {
    await py.loadPackagesFromImports(sources, {
      messageCallback: (msg: string) => /^Loading /.test(msg) && post({ type: "status", text: msg }),
      errorCallback: () => {},
    })
  } catch {
    // An import that is not a Pyodide package fails later with a clear ModuleNotFoundError.
  }
}

// ---- run ------------------------------------------------------------------

/** The debugger stopped: show where, and block until the page says how to go on. */
function pause(state: string): DebugCommand {
  if (!buffers) return "continue"
  stdout.flush()
  stderr.flush()
  const { control } = buffers
  Atomics.store(control, 0, DEBUG_WAITING)
  post({ type: "paused", state: JSON.parse(state) as DebugState })
  Atomics.wait(control, 0, DEBUG_WAITING)
  post({ type: "paused", state: null })
  if (Atomics.load(control, 0) === STDIN_INTERRUPT) return "stop"
  return DEBUG_COMMANDS[Atomics.load(control, 1)] ?? "continue"
}

async function run(id: number, files: ProjectFiles, entry: string, specs: string[], breakpoints?: Record<string, number[]>) {
  if (!py || !buffers) return
  const missing = specs.filter((s) => !installed.has(s))
  if (missing.length) {
    post({ type: "status", text: `Installing ${missing.join(", ")}…` })
    const failed = (await installPackages(missing)).filter((r) => r.error)
    for (const f of failed) post({ type: "stderr", data: `Could not install ${f.spec}: ${f.error}\n` })
  }

  await loadImported(files)
  const runner = py.pyimport("pycoder.runner")
  writeProject(files)
  outputBytes = 0
  outputLimited = false
  buffers.interrupt[0] = 0
  const started = performance.now()
  let exitCode = 1
  try {
    if (breakpoints) {
      const points = py.toPy(breakpoints)
      exitCode = py.pyimport("pycoder.debugger").run_debug(entry, points, pause) as number
      points.destroy()
    } else exitCode = runner.run_main(entry) as number
  } catch (err) {
    stderr.flush()
    post({ type: "stderr", data: `\n${String(err)}\n` })
  }
  stdout.flush()
  stderr.flush()
  buffers.interrupt[0] = 0
  post({ type: "exit", id, code: exitCode, duration: (performance.now() - started) / 1000, reason: outputLimited ? "output_limit" : null })
}

/** Lays the project out in /home/pyodide/project (texts and binary files). */
function writeProject(files: ProjectFiles) {
  if (!py) return
  const text: Record<string, string> = {}
  for (const [path, content] of Object.entries(files)) if (typeof content === "string") text[path] = content
  const filesPy = py.toPy(text)
  py.pyimport("pycoder.runner").write_project(filesPy)
  filesPy.destroy()
  // Binary files (images, data) go next to the code as they are.
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === "string") continue
    const full = `/home/pyodide/project/${path}`
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")))
    py.FS.writeFile(full, content)
  }
}

// ---- check ------------------------------------------------------------------

/**
 * Runs an admin's tests against a student's solution. This worker is made
 * for one check and thrown away; the student's code gets no network and no
 * browser storage here (it runs in the admin's browser).
 */
async function check(id: number, files: ProjectFiles, solution: string, test: string, specs: string[]) {
  if (!py) return
  const missing = specs.filter((s) => !installed.has(s))
  if (missing.length) await installPackages(missing)
  // The tests may import Pyodide's packages too (before the network goes away).
  await loadImported({ ...files, "tests.py": test })
  for (const name of ["fetch", "XMLHttpRequest", "importScripts"]) replaceGlobal(name, undefined)
  writeProject(files)
  const checker = py.pyimport("pycoder.checker")
  const results = checker.run_tests("/home/pyodide/project", solution, test)
  const list = results.toJs({ dict_converter: Object.fromEntries }) as CheckResult[]
  results.destroy()
  post({ type: "checked", id, results: list })
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
      await run(req.id, req.files, req.entry, req.specs, req.breakpoints)
    } else if (req.type === "check") {
      await check(req.id, req.files, req.solution, req.test, req.specs)
    }
  })
}

