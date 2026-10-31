import CompleteWorker from "@/workers/cpp-complete.worker?worker"
import type { ProjectFiles } from "@/workers/protocol"

import { cppClient, type CppPackageFiles } from "./client"
import { parseCompletions, splitPreamble, type CppCompletion } from "./completion"

export type CompleteRequest =
  | { type: "complete"; id: number; files: ProjectFiles; entry: string; source: string; line: number; column: number; pkgs: CppPackageFiles; key: string }
  | { type: "header"; key: string; bytes: Uint8Array }
export interface CompleteResponse {
  id: number
  log: string
}

const DEADLINE_MS = 15_000
const textOnly = (files: ProjectFiles) => Object.fromEntries(Object.entries(files).filter(([, content]) => typeof content === "string")) as ProjectFiles
const keyOf = (preamble: string, pkgs: CppPackageFiles, entry: string) => JSON.stringify([preamble, pkgs.includes, entry.slice(0, entry.lastIndexOf("/") + 1)])

interface Job {
  request: Omit<Extract<CompleteRequest, { type: "complete" }>, "id" | "type">
  resolve: (list: CppCompletion[]) => void
}

/**
 * Owns the completion worker: one request at a time, and only the newest of
 * those waiting is answered. While the compiler is still loading there are simply no suggestions.
 */
class CppCompleter {
  private worker: Worker | null = null
  private ready = false
  private busy: (Job & { id: number }) | null = null
  private waiting: Job | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextId = 1
  // The header built or being built, whether or not it succeeded: the same includes are not tried twice.
  private headerKey: string | null = null

  private start() {
    if (this.worker) return this.worker
    const worker = new CompleteWorker()
    this.worker = worker
    worker.onmessage = ({ data }: MessageEvent<CompleteResponse | { ready: boolean }>) => {
      if ("ready" in data) {
        if (data.ready) this.ready = true
        else this.stop()
        return
      }
      if (data.id !== this.busy?.id) return
      clearTimeout(this.timer)
      this.busy.resolve(parseCompletions(data.log))
      this.busy = null
      this.next()
    }
    worker.onerror = (event) => {
      event.preventDefault()
      this.stop()
    }
    return worker
  }

  /** Gone (a failed download, too long a request): the next use starts a new worker and builds the header again. */
  private stop() {
    clearTimeout(this.timer)
    this.worker?.terminate()
    this.worker = null
    this.ready = false
    this.headerKey = null
    this.busy?.resolve([])
    this.waiting?.resolve([])
    this.busy = this.waiting = null
  }

  private next() {
    if (this.busy || !this.waiting || !this.worker) return
    this.busy = { ...this.waiting, id: this.nextId++ }
    this.waiting = null
    this.worker.postMessage({ type: "complete", id: this.busy.id, ...this.busy.request } satisfies CompleteRequest)
    this.timer = setTimeout(() => this.stop(), DEADLINE_MS)
  }

  /** Loads the compiler and, in the background, builds the header for these includes. */
  prepare(files: ProjectFiles, entry: string, source: string, pkgs: CppPackageFiles) {
    this.start()
    const { preamble } = splitPreamble(source)
    const key = keyOf(preamble, pkgs, entry)
    if (!preamble || key === this.headerKey) return
    this.headerKey = key
    void cppClient.precompile(textOnly(files), entry, preamble, pkgs).then(
      (bytes) => {
        if (bytes && this.headerKey === key) this.worker?.postMessage({ type: "header", key, bytes } satisfies CompleteRequest, { transfer: [bytes.buffer as ArrayBuffer] })
      },
      () => {},
    )
  }

  complete(files: ProjectFiles, entry: string, source: string, line: number, column: number, pkgs: CppPackageFiles): Promise<CppCompletion[]> {
    this.start()
    if (!this.ready) return Promise.resolve([])
    const key = keyOf(splitPreamble(source).preamble, pkgs, entry)
    return new Promise((resolve) => {
      this.waiting?.resolve([])
      this.waiting = { request: { files: textOnly(files), entry, source, line, column, pkgs, key }, resolve }
      this.next()
    })
  }
}

export const cppCompleter = new CppCompleter()
