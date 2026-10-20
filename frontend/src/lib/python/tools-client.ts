import ToolsWorker from "@/workers/tools.worker?worker"
import type { ToolKind, ToolRequest, ToolResponse } from "@/workers/protocol"

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function getWorker() {
  if (worker) return worker
  worker = new ToolsWorker()
  worker.onmessage = (msg: MessageEvent<ToolResponse>) => {
    const res = msg.data
    const entry = pending.get(res.id)
    pending.delete(res.id)
    if (!entry) return
    if (res.ok) entry.resolve(res.result)
    else entry.reject(new Error(res.error))
  }
  return worker
}

/** Calls the analysis worker (flowchart, syntax tree, Jedi hints). */
export function callTool<T>(kind: ToolKind, args: Omit<ToolRequest, "id" | "kind"> = {}): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage({ id, kind, ...args } satisfies ToolRequest)
  })
}
