import { useEffect, useState } from "react"
import type { Awareness } from "y-protocols/awareness"
import type * as Y from "yjs"

import { readRun, readTerminal, sharedRun, sharedTerminal, type SharedRunState } from "@/lib/collab/doc"
import type { Chunk } from "@/hooks/use-runner"
import type { DebugState } from "@/workers/protocol"

export interface SharedConsole extends SharedRunState {
  chunks: Chunk[]
  /** The line being typed for input(), visible to everyone. */
  draft: string
  /** The person running the program left without finishing. */
  executorGone: boolean
  /** The run is under the debugger; where it stopped (null while it runs). */
  debugging: boolean
  debug: DebugState | null
}

/**
 * The project's console, read from its doc: alone it mirrors your own runs,
 * in a session it shows what the person running the code prints.
 */
export function useSharedConsole(doc: Y.Doc, awareness: Awareness | null): SharedConsole {
  const read = (): SharedConsole => {
    const run = readRun(doc)
    const active = run.status === "running" || run.status === "waiting" || run.status === "connecting"
    const executorGone =
      !!awareness && active && run.executorClient !== null && run.executorClient !== doc.clientID && !awareness.getStates().has(run.executorClient)
    const shared = sharedRun(doc)
    return {
      ...run,
      chunks: readTerminal(doc),
      draft: (shared.get("draft") as string) ?? "",
      executorGone,
      debugging: !!shared.get("debugging"),
      debug: (shared.get("debug") as DebugState | null) ?? null,
    }
  }
  const [state, setState] = useState<SharedConsole>(read)

  useEffect(() => {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setState(read()))
    }
    update()
    const term = sharedTerminal(doc)
    const run = sharedRun(doc)
    term.observe(update)
    run.observe(update)
    awareness?.on("change", update)
    return () => {
      cancelAnimationFrame(frame)
      term.unobserve(update)
      run.unobserve(update)
      awareness?.off("change", update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, awareness])

  return state
}
