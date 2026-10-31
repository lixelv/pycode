import { fire } from "@/lib/python/deadline"
import { cwdOf } from "@/lib/cpp/wasi"
import CppRunWorker from "@/workers/cpp-run.worker?worker"
import RunnerWorker from "@/workers/runner.worker?worker"
import {
  BATCH_NOT_STARTED,
  DEBUG_COMMANDS,
  DEBUG_GO,
  STDIN_EOF,
  STDIN_INTERRUPT,
  STDIN_MAX_BYTES,
  STDIN_READY,
  type CheckResult,
  type DebugCommand,
  type InstallResult,
  type ProgramRunner,
  type ProjectFiles,
  type RunnerEvent,
} from "@/workers/protocol"

type Listener = (event: RunnerEvent) => void

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
    const worker = new RunnerWorker()
    this.worker = worker
    this.readyPromise = new Promise((resolve, reject) => {
      worker.onmessage = (msg: MessageEvent<RunnerEvent>) => {
        const event = msg.data
        if (event.type === "ready") {
          this.python = event.python
          resolve(event.python)
        } else if (event.type === "boot-error") {
          this.readyPromise = null
          reject(new Error(event.message))
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
    await this.ready()
    const id = this.nextId++
    this.interruptFlag[0] = 0
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
    worker.onerror = () => {
      // The worker failed to load: the test fails. A result it has already given stays.
      const header = new Int32Array(result, 0, 4)
      if (Atomics.compareExchange(header, 0, 0, BATCH_NOT_STARTED) !== 0) return
      Atomics.notify(header, 0)
    }
    worker.postMessage({ type: "batch", wasm, files, cwd, stdin, result })
  }

  private killWasm() {
    this.wasmWorker?.terminate()
    this.wasmWorker = null
  }

  /**
   * Runs tests against a solution, then throws this interpreter away (see
   * check() in the worker). With `wasm` the solution is that C++ program.
   */
  async check(files: ProjectFiles, solution: string, test: string, specs: string[], wasm?: Uint8Array, timeoutMs = 30_000): Promise<CheckResult[]> {
    await this.ready()
    const id = this.nextId++
    try {
      return await new Promise<CheckResult[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
        const off = this.on((event) => {
          if (event.type === "run_wasm" && wasm) this.runWasm(wasm, files, cwdOf(solution), event.stdin, event.result)
          if (event.type === "kill_wasm") this.killWasm()
          if (event.type !== "checked" || event.id !== id) return
          clearTimeout(timer)
          off()
          resolve(event.results)
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
    this.worker?.terminate()
    this.worker = null
    this.readyPromise = null
    this.python = null
    this.pendingInstalls.forEach((resolve) => resolve([]))
    this.pendingInstalls.clear()
  }
}

export const runner = new RunnerClient()
