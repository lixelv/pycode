import { fire } from "@/lib/python/deadline"
import { SOLUTION_BOOT_MS } from "@/lib/python/limits"
import { cwdOf } from "@/lib/cpp/wasi"
import CppRunWorker from "@/workers/cpp-run.worker?worker"
import RunnerWorker from "@/workers/runner.worker?worker"
import {
  BATCH_NOT_STARTED,
  BATCH_STARTED,
  DEBUG_COMMANDS,
  DEBUG_GO,
  STDIN_EOF,
  STDIN_INTERRUPT,
  STDIN_MAX_BYTES,
  STDIN_READY,
  type CheckOutcome,
  type CheckTournament,
  type DebugCommand,
  type InstallResult,
  type ProgramRunner,
  type ProjectFiles,
  type RunnerEvent,
} from "@/workers/protocol"

type Listener = (event: RunnerEvent) => void

/** How long a tournament's whole check may take (python/checker.py, TOURNAMENT_LIMIT). */
export const TOURNAMENT_TIMEOUT_MS = 120_000
/** When run() itself keeps the limit (python/checker.py), the page's timer is only a backstop: the checker must get to say which test ran out. */
const BACKSTOP_MS = 5_000

/** A batch run that cannot happen: whoever waits on `result` learns it did not start. A result already given stays. */
function failBatch(result: SharedArrayBuffer) {
  const header = new Int32Array(result, 0, 5)
  Atomics.compareExchange(header, 0, 0, BATCH_NOT_STARTED)
  Atomics.store(header, BATCH_STARTED, 1)
  Atomics.notify(header, BATCH_STARTED)
  Atomics.notify(header, 0)
}

/**
 * Owns the Python runner worker: starting it, feeding input(), interrupting,
 * and replacing it when a program cannot be stopped any other way.
 */
export class RunnerClient implements ProgramRunner {
  private worker: Worker | null = null
  private control!: Int32Array
  private data!: Uint8Array
  private interruptFlag!: Uint8Array
  private listeners = new Set<Listener>()
  private nextId = 1
  private pendingInstalls = new Map<number, (r: InstallResult[]) => void>()
  private readyPromise: Promise<string> | null = null
  private deadline: ReturnType<typeof setTimeout> | undefined
  private wasmWorker: Worker | null = null
  private solution: RunnerClient | null = null // a tournament's solution, apart from the tests
  private prepared: Promise<void> | null = null
  python: string | null = null

  static supported() {
    return typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated
  }

  on(listener: Listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Starts the worker (once) and resolves with the Python version. */
  ready(): Promise<string> {
    if (this.readyPromise) return this.readyPromise
    const control = new SharedArrayBuffer(12)
    const data = new SharedArrayBuffer(STDIN_MAX_BYTES)
    const interrupt = new SharedArrayBuffer(1)
    this.control = new Int32Array(control)
    this.data = new Uint8Array(data)
    this.interruptFlag = new Uint8Array(interrupt)
    this.worker?.terminate() // one that crashed; a program may also still be running in it
    const worker = new RunnerWorker()
    this.worker = worker
    this.readyPromise = new Promise((resolve, reject) => {
      worker.onmessage = (msg: MessageEvent<RunnerEvent>) => {
        const event = msg.data
        if (event.type === "ready") {
          this.python = event.python
          resolve(event.python)
        } else if (event.type === "boot-error") {
          // Once started, this can only be a program posting it.
          if (this.python !== null) return
          this.readyPromise = null
          reject(new Error(event.message))
        } else if (event.type === "dead") {
          this.restart()
        } else if (event.type === "deadline") {
          clearTimeout(this.deadline)
          const control = this.control
          this.deadline = setTimeout(() => fire(control, event.gen, () => this.interrupt()), event.ms)
        } else if (event.type === "installed") {
          this.pendingInstalls.get(event.id)?.(event.results)
          this.pendingInstalls.delete(event.id)
        }
        this.listeners.forEach((l) => l(event))
      }
      worker.onerror = (e) => {
        this.readyPromise = null
        reject(new Error(e.message || "The Python worker crashed."))
      }
    })
    worker.postMessage({ type: "init", buffers: { control, data, interrupt } })
    return this.readyPromise
  }

  /** Runs `entry`; with `breakpoints` (path -> lines), under the debugger. */
  async run(files: ProjectFiles, entry: string, specs: string[], breakpoints?: Record<string, number[]>): Promise<number> {
    const ready = this.ready()
    // Before the wait, so a Stop during boot stays pending for this run.
    this.interruptFlag[0] = 0
    await ready
    const id = this.nextId++
    this.worker!.postMessage({ type: "run", id, files, entry, specs, breakpoints })
    return id
  }

  /** Tells the paused debugger how to go on. */
  debug(command: DebugCommand) {
    Atomics.store(this.control, 1, DEBUG_COMMANDS.indexOf(command))
    Atomics.store(this.control, 0, DEBUG_GO)
    Atomics.notify(this.control, 0)
  }

  async install(specs: string[]): Promise<InstallResult[]> {
    await this.ready()
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pendingInstalls.set(id, resolve)
      this.worker!.postMessage({ type: "install", id, specs })
    })
  }

  sendLine(text: string) {
    const bytes = new TextEncoder().encode(text + "\n").slice(0, STDIN_MAX_BYTES)
    this.data.set(bytes)
    Atomics.store(this.control, 1, bytes.length)
    Atomics.store(this.control, 0, STDIN_READY)
    Atomics.notify(this.control, 0)
  }

  sendEof() {
    Atomics.store(this.control, 0, STDIN_EOF)
    Atomics.notify(this.control, 0)
  }

  /** Raises KeyboardInterrupt in the program, also while it waits for input. */
  interrupt() {
    if (!this.worker) return
    this.interruptFlag[0] = 2
    Atomics.store(this.control, 0, STDIN_INTERRUPT)
    Atomics.notify(this.control, 0)
  }

  /** A check's C++ run: batch mode in its own worker, the answer goes straight into `result`. */
  private runWasm(wasm: Uint8Array, files: ProjectFiles, cwd: string, stdin: string, result: SharedArrayBuffer) {
    this.killWasm()
    const worker = new CppRunWorker()
    this.wasmWorker = worker
    worker.onerror = () => failBatch(result) // the worker failed to load: the test fails
    // A wasm program starts at once: its time counts from here.
    const header = new Int32Array(result, 0, 5)
    Atomics.store(header, BATCH_STARTED, 1)
    Atomics.notify(header, BATCH_STARTED)
    worker.postMessage({ type: "batch", wasm, files, cwd, stdin, result })
  }

  /**
   * A tournament's solution, one run in this interpreter; the answer goes straight into `result`.
   * Its time starts here, not in the worker: from its second run on, a program can have replaced anything there.
   */
  async batch(files: ProjectFiles, entry: string, specs: string[], stdin: string, traceMemory: boolean, result: SharedArrayBuffer) {
    try {
      await this.ready()
      await (this.prepared ??= new Promise<void>((resolve) => {
        const off = this.on((event) => {
          if (event.type !== "prepared") return
          off()
          resolve()
        })
        this.worker!.postMessage({ type: "prepare", files, specs })
      }))
      const header = new Int32Array(result, 0, 5)
      Atomics.store(header, BATCH_STARTED, 1)
      Atomics.notify(header, BATCH_STARTED)
      this.worker!.postMessage({ type: "batch", files, entry, stdin, traceMemory, result })
    } catch {
      failBatch(result)
    }
  }

  private killWasm() {
    this.wasmWorker?.terminate()
    this.wasmWorker = null
  }

  /**
   * Runs tests against a solution, then throws this interpreter away (see
   * check() in the worker). With `wasm` the solution is that C++ program; a
   * tournament's Python solution runs in another client of ours.
   */
  async check(files: ProjectFiles, solution: string, test: string, specs: string[], wasm?: Uint8Array, timeoutMs = 30_000): Promise<CheckOutcome> {
    await this.ready()
    const id = this.nextId++
    try {
      return await new Promise<CheckOutcome>((resolve, reject) => {
        const timeout = () => reject(new Error("timeout"))
        let timer = setTimeout(timeout, wasm ? timeoutMs + BACKSTOP_MS : timeoutMs)
        let kind: CheckTournament | null | undefined // the first event's: nothing else can set it
        const off = this.on((event) => {
          if (event.type === "tournament" && kind === undefined) {
            kind = event.tournament
            if (kind) {
              clearTimeout(timer)
              timer = setTimeout(timeout, TOURNAMENT_TIMEOUT_MS + SOLUTION_BOOT_MS + BACKSTOP_MS)
            }
          }
          if (event.type === "run_outside") {
            if (wasm) this.runWasm(wasm, files, cwdOf(solution), event.stdin, event.result)
            else void (this.solution ??= new RunnerClient()).batch(files, solution, specs, event.stdin, event.traceMemory, event.result)
          }
          if (event.type === "kill_outside") {
            this.killWasm()
            this.solution?.restart()
          }
          if (event.type !== "checked" || event.id !== id) return
          clearTimeout(timer)
          off()
          resolve({ results: event.results, tournament: kind ?? undefined })
        })
        this.worker!.postMessage({ type: "check", id, files, solution, test, specs, cpp: !!wasm })
      })
    } finally {
      this.restart()
    }
  }

  /** Throws the interpreter away (endless C-level loop, removed packages). */
  restart() {
    clearTimeout(this.deadline)
    this.killWasm()
    this.solution?.restart()
    this.solution = null
    this.worker?.terminate()
    this.worker = null
    this.readyPromise = null
    this.prepared = null
    this.python = null
    this.pendingInstalls.forEach((resolve) => resolve([]))
    this.pendingInstalls.clear()
  }
}

export const runner = new RunnerClient()
