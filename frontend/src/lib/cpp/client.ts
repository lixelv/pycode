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

export type CppStatus = "idle" | "loading" | "ready"

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
class CppClient {
  status: CppStatus = "idle"
  private worker: Worker | null = null
  private queue: Job[] = []
  private busy: (Job & { id: number }) | null = null
  private nextId = 1
  private listeners = new Set<() => void>()

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
    this.busy = { ...this.queue.shift()!, id: this.nextId++ }
    worker.postMessage({ id: this.busy.id, ...this.busy.request } satisfies CppRequest)
  }

  private start(): Worker {
    if (this.worker) return this.worker
    const worker = new CppWorker()
    this.worker = worker
    this.setStatus("loading")
    worker.onmessage = ({ data }: MessageEvent<CppResponse | { ready: true }>) => {
      if ("ready" in data) return this.setStatus("ready")
      if (data.id !== this.busy?.id) return
      const job = this.busy
      this.busy = null
      job.resolve(data)
      this.next()
    }
    // A crashed worker fails what it had; the next request starts a new one.
    worker.onerror = (event) => {
      event.preventDefault()
      worker.terminate()
      this.worker = null
      const failed = [...(this.busy ? [this.busy] : []), ...this.queue.splice(0)]
      this.busy = null
      this.setStatus("idle")
      for (const job of failed) job.reject(new Error(event.message || "C++ compiler failed"))
    }
    return worker
  }
}

export const cppClient = new CppClient()

/** The compiler's state for the status bar. */
export const useCppStatus = () => useSyncExternalStore(cppClient.subscribe, () => cppClient.status)
