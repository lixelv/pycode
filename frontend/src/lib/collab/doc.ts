import * as Y from "yjs"

import type { Chunk, ChunkKind, ExitInfo, RunStatus } from "@/hooks/use-runner"

/*
 * The project's runtime document (store.runtime):
 *   terminal  Y.Text   console output; each run of text carries {k: ChunkKind}
 *   run       Y.Map    status, exit, executor (uid) and executorClient (Yjs client id)
 */
export const sharedTerminal = (doc: Y.Doc) => doc.getText("terminal")
export const sharedRun = (doc: Y.Doc) => doc.getMap<unknown>("run")

export interface SharedRunState {
  status: RunStatus
  exit: ExitInfo | null
  executor: string | null
  executorClient: number | null
}

export function readRun(doc: Y.Doc): SharedRunState {
  const run = sharedRun(doc)
  return {
    status: (run.get("status") as RunStatus) ?? "idle",
    exit: (run.get("exit") as ExitInfo | null) ?? null,
    executor: (run.get("executor") as string | null) ?? null,
    executorClient: (run.get("executorClient") as number | null) ?? null,
  }
}

export function readTerminal(doc: Y.Doc): Chunk[] {
  const delta = sharedTerminal(doc).toDelta() as { insert: string; attributes?: { k?: ChunkKind } }[]
  return delta.map((d) => ({ kind: d.attributes?.k ?? "stdout", text: d.insert }))
}

export function setDraft(doc: Y.Doc, text: string) {
  sharedRun(doc).set("draft", text)
}

const MAX_TERMINAL_CHARS = 200_000

export function appendTerminal(doc: Y.Doc, kind: ChunkKind, text: string) {
  const term = sharedTerminal(doc)
  doc.transact(() => {
    term.insert(term.length, text, { k: kind })
    // Keep the shared console (and the stored log) bounded.
    if (term.length > MAX_TERMINAL_CHARS) term.delete(0, term.length - MAX_TERMINAL_CHARS)
  })
}

export function resetRun(doc: Y.Doc, executor: string) {
  doc.transact(() => {
    const term = sharedTerminal(doc)
    term.delete(0, term.length)
    const run = sharedRun(doc)
    run.set("status", "connecting")
    run.set("exit", null)
    run.set("executor", executor)
    run.set("executorClient", doc.clientID)
    run.set("draft", "")
  })
}

export function setRunStatus(doc: Y.Doc, status: RunStatus, exit?: ExitInfo | null) {
  doc.transact(() => {
    const run = sharedRun(doc)
    run.set("status", status)
    if (exit !== undefined) run.set("exit", exit)
  })
}
