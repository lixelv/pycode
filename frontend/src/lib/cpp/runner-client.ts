import { cwdOf } from "@/lib/cpp/wasi"
import CppRunWorker from "@/workers/cpp-run.worker?worker"
import {
  STDIN_EOF,
  STDIN_MAX_BYTES,
  STDIN_READY,
  type CppRunRequest,
  type ProgramRunner,
  type ProjectFiles,
  type RunnerBuffers,
  type RunnerEvent,
} from "@/workers/protocol"

type Listener = (event: RunnerEvent) => void

/**
 * Runs compiled C++ programs in cpp-run.worker, with input() on the same
 * shared buffers as Python. A wasm program cannot be interrupted, so Stop
 * terminates the worker and starts a new one.
 */
export class CppRunnerClient implements ProgramRunner {
  private worker: Worker | null = null
  private buffers: RunnerBuffers | null = null
  private control!: Int32Array
  private data!: Uint8Array
  private listeners = new Set<Listener>()
  private running: { id: number; started: number } | null = null
  private nextId = 1
  private createWorker: () => Worker

  /** `createWorker` is replaced in tests. */
  constructor(createWorker: () => Worker = () => new CppRunWorker()) {
    this.createWorker = createWorker
  }

  on(listener: Listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: RunnerEvent) {
    this.listeners.forEach((l) => l(event))
  }

  private spawn() {
    const worker = this.createWorker()
    worker.onmessage = (msg: MessageEvent<RunnerEvent>) => {
      if (worker !== this.worker) return
      const event = msg.data
      if (event.type === "exit" && event.id === this.running?.id) this.running = null
      this.emit(event)
    }
    worker.onerror = (e) => {
      if (worker !== this.worker || !this.running) return
      const { id, started } = this.running
      this.restart()
      this.emit({ type: "stderr", data: `\n${e.message || "The C++ runner crashed."}\n` })
      this.emit({ type: "exit", id, code: 1, duration: (performance.now() - started) / 1000, reason: null })
    }
    this.worker = worker
    return worker
  }

  /** Runs a program compiled from `entry` (its folder is the working folder); resolves with the run's id. */
  async run(wasm: Uint8Array, files: ProjectFiles, entry: string): Promise<number> {
    if (this.running) this.restart()
    if (!this.buffers) {
      this.buffers = { control: new SharedArrayBuffer(12), data: new SharedArrayBuffer(STDIN_MAX_BYTES), interrupt: new SharedArrayBuffer(1) }
      this.control = new Int32Array(this.buffers.control)
      this.data = new Uint8Array(this.buffers.data)
    }
    const worker = this.worker ?? this.spawn()
    const id = this.nextId++
    this.running = { id, started: performance.now() }
    const request: CppRunRequest = { type: "run", id, wasm, files, cwd: cwdOf(entry), buffers: this.buffers }
    worker.postMessage(request)
    return id
  }

  sendLine(text: string) {
    if (!this.buffers) return
    const bytes = new TextEncoder().encode(text + "\n").slice(0, STDIN_MAX_BYTES)
    this.data.set(bytes)
    Atomics.store(this.control, 1, bytes.length)
    Atomics.store(this.control, 0, STDIN_READY)
    Atomics.notify(this.control, 0)
  }

  sendEof() {
    if (!this.buffers) return
    Atomics.store(this.control, 0, STDIN_EOF)
    Atomics.notify(this.control, 0)
  }

  /** Stops the program at once, like Ctrl+C: `KeyboardInterrupt` and exit code 130. */
  interrupt() {
    if (!this.running) return
    const { id, started } = this.running
    this.restart()
    this.spawn() // ready for the next run
    this.emit({ type: "stderr", data: "\nKeyboardInterrupt\n" })
    this.emit({ type: "exit", id, code: 130, duration: (performance.now() - started) / 1000, reason: null })
  }

  restart() {
    this.worker?.terminate()
    this.worker = null
    this.running = null
  }
}

export const cppRunner = new CppRunnerClient()
