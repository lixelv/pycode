import { useSyncExternalStore } from "react"

import CppWorker from "@/workers/cpp.worker?worker"
import type { ProjectFiles } from "@/workers/protocol"

import { parseClangDiagnostics, type ClangDiagnostic } from "./diagnostics"

/** Headers of C++ packages: files by absolute path (`/packages/<repo>/…`) and their `-I` folders. */
export type CppPackageFiles = { files: Record<string, string>; includes: string[] }

export interface CppRequest {
  id: number
  kind: "lint" | "compile"
  files: ProjectFiles
  entry: string
  pkgs: CppPackageFiles
}
/** The clang log (paths relative to the project) and, for a successful compile, the program. */
export interface CppResponse {
  id: number
  log: string
  wasm?: Uint8Array
}

/** `failed`: the compiler could not be downloaded; the next request tries again. */
export type CppStatus = "idle" | "loading" | "ready" | "failed"

// How long one request may run once the compiler is loaded (the download is not counted).
// Past it the worker is killed: a pathological file must not block every later lint and compile.
export const LINT_DEADLINE_MS = 15_000
export const COMPILE_DEADLINE_MS = 30_000

interface Job {
  request: Omit<CppRequest, "id">
  resolve: (response: CppResponse) => void
  reject: (error: Error) => void
}

/**
 * Owns the clang worker. It starts on the first lint or compile (the
 * compiler is a 27 MB download), never for a project without C++. Requests
 * go one at a time; a lint still waiting is replaced by a newer one.
 */
export class CppClient {
  status: CppStatus = "idle"
  private worker: Worker | null = null
  private queue: Job[] = []
  private busy: (Job & { id: number }) | null = null
  private deadline: ReturnType<typeof setTimeout> | undefined
  private nextId = 1
  private listeners = new Set<() => void>()

  private createWorker: () => Worker

  /** `createWorker` is replaced in tests. */
  constructor(createWorker: () => Worker = () => new CppWorker()) {
    this.createWorker = createWorker
  }

  /** Problems of `entry` (`clang++ -fsyntax-only`). */
  async lint(files: ProjectFiles, entry: string, pkgs: CppPackageFiles): Promise<ClangDiagnostic[]> {
    const { log } = await this.request({ kind: "lint", files, entry, pkgs })
    return parseClangDiagnostics(log, entry)
  }

  /** Compiles `entry` to a WASI program; `wasm` is null when it did not compile. */
  async compile(files: ProjectFiles, entry: string, pkgs: CppPackageFiles): Promise<{ wasm: Uint8Array | null; log: string }> {
    const { log, wasm } = await this.request({ kind: "compile", files, entry, pkgs })
    return { wasm: wasm ?? null, log }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setStatus(status: CppStatus) {
    this.status = status
    for (const listener of this.listeners) listener()
  }

  private request(request: Omit<CppRequest, "id">): Promise<CppResponse> {
    return new Promise((resolve, reject) => {
      if (request.kind === "lint") {
        const stale = this.queue.findIndex((job) => job.request.kind === "lint")
        // Its caller has newer text by now: it gets an empty log.
        if (stale >= 0) this.queue.splice(stale, 1)[0].resolve({ id: 0, log: "" })
      }
      this.queue.push({ request, resolve, reject })
      this.next()
    })
  }

  private next() {
    if (this.busy || !this.queue.length) return
    const worker = this.start()
    // After a failed download the worker tries again with this request.
    if (this.status === "failed") this.setStatus("loading")
    this.busy = { ...this.queue.shift()!, id: this.nextId++ }
    worker.postMessage({ id: this.busy.id, ...this.busy.request } satisfies CppRequest)
    if (this.status === "ready") this.arm()
  }

  /** Starts the clock for the request in flight. */
  private arm() {
    clearTimeout(this.deadline)
    if (!this.busy) return
    const ms = this.busy.request.kind === "compile" ? COMPILE_DEADLINE_MS : LINT_DEADLINE_MS
    this.deadline = setTimeout(() => this.kill("The C++ compiler took too long"), ms)
  }

  /** Stops the worker and fails what it had; the next request starts a new one. */
  private kill(message: string) {
    clearTimeout(this.deadline)
    this.worker?.terminate()
    this.worker = null
    const failed = [...(this.busy ? [this.busy] : []), ...this.queue.splice(0)]
    this.busy = null
    this.setStatus("idle")
    for (const job of failed) job.reject(new Error(message))
  }

  private start(): Worker {
    if (this.worker) return this.worker
    const worker = this.createWorker()
    this.worker = worker
    this.setStatus("loading")
    worker.onmessage = ({ data }: MessageEvent<CppResponse | { ready: boolean }>) => {
      if ("ready" in data) {
        this.setStatus(data.ready ? "ready" : "failed")
        if (data.ready) this.arm()
        return
      }
      if (data.id !== this.busy?.id) return
      clearTimeout(this.deadline)
      const job = this.busy
      this.busy = null
      job.resolve(data)
      this.next()
    }
    worker.onerror = (event) => {
      event.preventDefault()
      this.kill(event.message || "C++ compiler failed")
    }
    return worker
  }
}

export const cppClient = new CppClient()

/** The compiler's state for the status bar. */
export const useCppStatus = () => useSyncExternalStore(cppClient.subscribe, () => cppClient.status)
