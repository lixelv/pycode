import { useCallback, useEffect, useRef, useState } from "react"

import { translate } from "@/lib/i18n"
import { runner, RunnerClient } from "@/lib/python/runner-client"
import type { ProjectFiles } from "@/workers/protocol"

export type ChunkKind = "stdout" | "stderr" | "stdin" | "system"
export interface Chunk {
  kind: ChunkKind
  text: string
}

export type RunStatus = "idle" | "connecting" | "running" | "waiting" | "finished"

export interface ExitInfo {
  code: number | null
  duration: number
  reason: "timeout" | "output_limit" | "killed" | "error" | null
  message?: string
}

export const RUN_TIMEOUT_SEC = 120
const MAX_RUNS_PER_SEC = 8
const MAX_CONSOLE_CHARS = 400_000
/** After an interrupt, how long the program gets to stop before the interpreter is replaced. */
const KILL_GRACE_MS = 2000

/** What the local run did, for mirroring it into a shared session. */
export type RunEvent =
  | { type: "reset" }
  | { type: "output"; kind: ChunkKind; text: string }
  | { type: "status"; status: RunStatus }
  | { type: "exit"; exit: ExitInfo }

export interface RunnerOptions {
  onRateLimited?: (message: string) => void
  onEvent?: (event: RunEvent) => void
}

/** Runs code in the in-browser Python (Pyodide) worker. */
export function useRunner({ onRateLimited, onEvent }: RunnerOptions = {}) {
  const [status, setStatusState] = useState<RunStatus>("idle")
  const emit = useRef(onEvent)
  useEffect(() => {
    emit.current = onEvent
  }, [onEvent])
  const setStatus = useCallback((next: RunStatus | ((s: RunStatus) => RunStatus)) => {
    setStatusState((prev) => {
      const value = typeof next === "function" ? next(prev) : next
      if (value !== prev) queueMicrotask(() => emit.current?.({ type: "status", status: value }))
      return value
    })
  }, [])
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [exit, setExit] = useState<ExitInfo | null>(null)
  const [runCount, setRunCount] = useState(0)
  const [python, setPython] = useState<string | null>(runner.python)
  const [booting, setBooting] = useState(false)
  const current = useRef<number | null>(null)
  const timers = useRef<{ timeout?: number; kill?: number }>({})
  const reason = useRef<ExitInfo["reason"]>(null)
  const startedAt = useRef<number[]>([])
  const rateLimited = useRef(onRateLimited)
  useEffect(() => {
    rateLimited.current = onRateLimited
  }, [onRateLimited])

  const append = useCallback((kind: ChunkKind, text: string) => {
    if (!text) return
    emit.current?.({ type: "output", kind, text })
    setChunks((prev) => {
      const last = prev[prev.length - 1]
      let next = last && last.kind === kind ? [...prev.slice(0, -1), { kind, text: last.text + text }] : [...prev, { kind, text }]
      let total = next.reduce((n, c) => n + c.text.length, 0)
      while (total > MAX_CONSOLE_CHARS && next.length > 1) {
        total -= next[0].text.length
        next = next.slice(1)
      }
      return next
    })
  }, [])

  const clearTimers = () => {
    window.clearTimeout(timers.current.timeout)
    window.clearTimeout(timers.current.kill)
    timers.current = {}
  }

  const finish = useCallback(
    (info: ExitInfo) => {
      clearTimers()
      current.current = null
      setExit(info)
      emit.current?.({ type: "exit", exit: info })
      setStatus("finished")
    },
    [setStatus],
  )

  useEffect(
    () =>
      runner.on((event) => {
        switch (event.type) {
          case "ready":
            setPython(event.python)
            setBooting(false)
            break
          case "status":
            append("system", event.text + "\n")
            break
          case "stdout":
          case "stderr":
            if (current.current !== null) {
              append(event.type, event.data)
              setStatus((s) => (s === "waiting" ? s : "running"))
            }
            break
          case "input_request":
            if (current.current !== null) setStatus("waiting")
            break
          case "exit":
            if (event.id === current.current) {
              finish({
                code: event.code,
                duration: event.duration,
                reason: reason.current ?? event.reason,
              })
            }
            break
        }
      }),
    [append, finish, setStatus],
  )

  // Warm the interpreter up in the background so the first Run is quick.
  useEffect(() => {
    if (!RunnerClient.supported()) return
    setBooting(true)
    runner.ready().catch(() => setBooting(false))
  }, [])

  /** Interrupts the program; replaces the interpreter if it does not stop. */
  const stopWith = useCallback(
    (why: ExitInfo["reason"]) => {
      if (current.current === null) return
      reason.current = why
      runner.interrupt()
      window.clearTimeout(timers.current.kill)
      timers.current.kill = window.setTimeout(() => {
        runner.restart()
        setPython(null)
        finish({ code: null, duration: 0, reason: why })
      }, KILL_GRACE_MS)
    },
    [finish],
  )

  const run = useCallback(
    async (files: ProjectFiles, entry: string, specs: string[] = []) => {
      if (!RunnerClient.supported()) {
        setChunks([{ kind: "stderr", text: "This browser does not allow the in-browser Python here (the page is not cross-origin isolated).\n" }])
        setExit({ code: null, duration: 0, reason: "error", message: "Python unavailable" })
        setStatus("finished")
        return
      }
      const now = performance.now()
      startedAt.current = startedAt.current.filter((t) => now - t < 1000)
      if (startedAt.current.length >= MAX_RUNS_PER_SEC) {
        rateLimited.current?.(translate("toast.slowDown", { n: MAX_RUNS_PER_SEC }))
        return
      }
      startedAt.current.push(now)

      // A run still going is replaced by the new one.
      if (current.current !== null) {
        clearTimers()
        runner.restart()
      }
      reason.current = null
      emit.current?.({ type: "reset" })
      setChunks([])
      setExit(null)
      setRunCount((n) => n + 1)
      setStatus("connecting")
      current.current = -1
      if (!runner.python) setBooting(true)

      try {
        const id = await runner.run(files, entry, specs)
        current.current = id
        setStatus("running")
        timers.current.timeout = window.setTimeout(() => stopWith("timeout"), RUN_TIMEOUT_SEC * 1000)
      } catch (err) {
        finish({ code: null, duration: 0, reason: "error", message: `Python failed to start: ${(err as Error).message}` })
      }
    },
    [finish, stopWith, setStatus],
  )

  const sendInput = useCallback(
    (text: string) => {
      append("stdin", text + "\n")
      setStatus("running")
      runner.sendLine(text)
    },
    [append, setStatus],
  )

  const sendEof = useCallback(() => {
    setStatus("running")
    runner.sendEof()
  }, [setStatus])

  const stop = useCallback(() => stopWith("killed"), [stopWith])
  const clear = useCallback(() => setChunks([]), [])

  useEffect(() => () => clearTimers(), [])

  const active = status === "connecting" || status === "running" || status === "waiting"
  return { status, active, chunks, exit, runCount, python, booting, run, stop, sendInput, sendEof, clear }
}
