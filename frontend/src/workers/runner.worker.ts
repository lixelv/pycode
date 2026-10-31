/// <reference lib="webworker" />
// Executes the user's program. Runs off the main thread so a busy or blocked
// program (waiting for input(), an endless loop) never freezes the page.
import { arm, disarm } from "@/lib/python/deadline"
import { signalBuffer } from "@/lib/python/signal-buffer"
import packagesSrc from "@/python/packages.py?raw"
import checkerSrc from "@/python/checker.py?raw"
import debuggerSrc from "@/python/debugger.py?raw"
import runnerSrc from "@/python/runner.py?raw"

import { bootPyodide, installSources, type PyodideInterface } from "./pyodide"
import {
  BATCH_EXITED,
  BATCH_HEADER_BYTES,
  BATCH_OUTPUT_LIMIT,
  BATCH_RESULT_BYTES,
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
let deadlines = 0 // generations of polycode_test.run's timers
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
  installSources(py, "polycode", { "runner.py": runnerSrc, "packages.py": packagesSrc, "checker.py": checkerSrc, "debugger.py": debuggerSrc })
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide')")
  py.pyimport("polycode.runner").install_sleep()

  py.setStdout({ write: (b: Uint8Array) => (countOutput(b.length), stdout.write(b), b.length), isatty: true })
  py.setStderr({ write: (b: Uint8Array) => (countOutput(b.length), stderr.write(b), b.length), isatty: true })
  py.setStdin({ stdin: readLine, isatty: true })

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
  const install = py.pyimport("polycode.packages").install
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

/**
 * Turns interrupts on. Until then a Stop stays in the buffer: raised in
 * Pyodide's own Python (boot, package load, writing the project), it would show
 * a traceback or a false ModuleNotFoundError instead of stopping anything.
 */
function armInterrupts() {
  if (py && buffers) py.setInterruptBuffer(signalBuffer(buffers.interrupt) as unknown as Uint8Array)
}

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
  const runner = py.pyimport("polycode.runner")
  writeProject(files)
  outputBytes = 0
  outputLimited = false
  // Called by run_main just before the program: a Stop that waited is raised here.
  const startProgram = () => {
    armInterrupts()
    py?.checkInterrupt()
  }
  const started = performance.now()
  let exitCode = 1
  try {
    if (breakpoints) {
      const points = py.toPy(breakpoints)
      exitCode = py.pyimport("polycode.debugger").run_debug(entry, points, pause, startProgram) as number
      points.destroy()
    } else exitCode = runner.run_main.callKwargs(entry, { arm: startProgram }) as number
  } catch (err) {
    stderr.flush()
    post({ type: "stderr", data: `\n${String(err)}\n` })
  }
  stdout.flush()
  stderr.flush()
  py.setInterruptBuffer(undefined as unknown as Uint8Array)
  buffers.interrupt[0] = 0
  post({ type: "exit", id, code: exitCode, duration: (performance.now() - started) / 1000, reason: outputLimited ? "output_limit" : null })
}

/** Lays the project out in /home/pyodide/project (texts and binary files). */
function writeProject(files: ProjectFiles) {
  if (!py) return
  const text: Record<string, string> = {}
  for (const [path, content] of Object.entries(files)) if (typeof content === "string") text[path] = content
  const filesPy = py.toPy(text)
  py.pyimport("polycode.runner").write_project(filesPy)
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

/** Runs the C++ solution through the page and blocks until it ends or its time is up. */
function runWasmOnPage(stdin: string, timeoutMs: number) {
  const result = new SharedArrayBuffer(BATCH_RESULT_BYTES)
  const header = new Int32Array(result, 0, 4)
  post({ type: "run_wasm", stdin, timeoutMs, result })
  if (Atomics.wait(header, 0, 0, timeoutMs) === "timed-out") {
    post({ type: "kill_wasm" })
    return { stdout: "", memory: 0, timedOut: true, exitCode: 0, failure: "" }
  }
  // TextDecoder refuses a view of shared memory: slice() copies it out.
  const stdout = new TextDecoder().decode(new Uint8Array(result, BATCH_HEADER_BYTES, header[1]).slice())
  const state = Atomics.load(header, 0)
  const failure = state === BATCH_OUTPUT_LIMIT ? "output_limit" : state === BATCH_EXITED ? "" : "not_started"
  return { stdout, memory: header[2], timedOut: false, exitCode: header[3], failure }
}

/**
 * Runs an admin's tests against a student's solution. This worker is made
 * for one check and thrown away; the student's code gets no network and no
 * browser storage here (it runs in the admin's browser).
 */
async function check(id: number, files: ProjectFiles, solution: string, test: string, specs: string[], cpp = false) {
  if (!py) return
  const missing = specs.filter((s) => !installed.has(s))
  if (missing.length) await installPackages(missing)
  // The tests may import Pyodide's packages too (before the network goes away).
  await loadImported({ ...files, "tests.py": test })
  for (const name of ["fetch", "XMLHttpRequest", "importScripts"]) replaceGlobal(name, undefined)
  writeProject(files)
  // polycode_test.run(timeout=…) asks the page for a timer that interrupts it;
  // ms 0 cancels it at once and says whether it fired.
  ;(self as { polycode_deadline?: (ms: number) => boolean }).polycode_deadline = (ms) => {
    const fired = disarm(buffers!.control, buffers!.interrupt)
    if (ms) {
      arm(buffers!.control, ++deadlines)
      post({ type: "deadline", ms, gen: deadlines })
    }
    return fired
  }
  if (cpp) (self as { polycode_run_wasm?: typeof runWasmOnPage }).polycode_run_wasm = runWasmOnPage
  const checker = py.pyimport("polycode.checker")
  armInterrupts() // a check's time limit is an interrupt
  const results = checker.run_tests("/home/pyodide/project", solution, test, cpp ? "cpp" : "python")
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
      await check(req.id, req.files, req.solution, req.test, req.specs, req.cpp)
    }
  })
}

