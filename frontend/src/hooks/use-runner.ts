import { useCallback, useEffect, useRef, useState } from "react"

import { cppRunner } from "@/lib/cpp/runner-client"
import { translate } from "@/lib/i18n"
import { runner, RunnerClient } from "@/lib/python/runner-client"
import type { DebugCommand, DebugState, ProgramRunner, ProjectFiles } from "@/workers/protocol"

export type ChunkKind = "stdout" | "stderr" | "stdin" | "system"
export interface Chunk {
  kind: ChunkKind
  text: string
}

export type RunStatus = "idle" | "compiling" | "connecting" | "running" | "waiting" | "finished"
/** A program is starting, running or waiting for input. */
export const isBusy = (status: RunStatus) => status === "compiling" || status === "connecting" || status === "running" || status === "waiting"

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
  /** The debugger stopped here (or goes on: null). */
  | { type: "debug"; state: DebugState | null }

export interface RunnerOptions {
  onRateLimited?: (message: string) => void
  onEvent?: (event: RunEvent) => void
  /** Start the interpreter in the background (the project has Python). */
  warm?: boolean
}

/** What a C++ compile gave: the program, or null and clang's log. */
export type CppBuild = { wasm: Uint8Array | null; log: string }

/** Runs programs in the browser: Python (Pyodide worker) or compiled C++ (cpp-run worker). */
export function useRunner({ onRateLimited, onEvent, warm = true }: RunnerOptions = {}) {
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
  const [debugState, setDebugState] = useState<DebugState | null>(null)
  const [runCount, setRunCount] = useState(0)
  const [python, setPython] = useState<string | null>(runner.python)
  const [booting, setBooting] = useState(false)
  const current = useRef<number | null>(null)
  // The runner of the current (or last) run: only its events count, input goes to it.
  const client = useRef<ProgramRunner>(runner)
  const generation = useRef(0)
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
      setDebugState(null)
      emit.current?.({ type: "debug", state: null })
      setExit(info)
      emit.current?.({ type: "exit", exit: info })
      setStatus("finished")
    },
    [setStatus],
  )

  useEffect(() => {
    const listen = (source: ProgramRunner) =>
      source.on((event) => {
        if (event.type === "ready") {
          setPython(event.python)
          setBooting(false)
          return
        }
        if (source !== client.current) return
        switch (event.type) {
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
          case "paused":
            if (current.current === null) break
            setDebugState(event.state)
            emit.current?.({ type: "debug", state: event.state })
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
      })
    const offs = [listen(runner), listen(cppRunner)]
    return () => offs.forEach((off) => off())
  }, [append, finish, setStatus])

  // Warm the interpreter up in the background so the first Run is quick.
  useEffect(() => {
    if (!warm || !RunnerClient.supported() || runner.python) return
    setBooting(true)
    runner.ready().then(
      () => setBooting(false),
      () => setBooting(false),
    )
  }, [warm])

  /** Interrupts the program; replaces the interpreter if it does not stop. */
  const stopWith = useCallback(
    (why: ExitInfo["reason"]) => {
      if (current.current === null) return
      reason.current = why
      const target = client.current
      if (target === cppRunner && current.current === -1) {
        finish({ code: null, duration: 0, reason: why }) // still compiling: its result is dropped
        return
      }
      window.clearTimeout(timers.current.kill)
      timers.current.kill = window.setTimeout(() => {
        target.restart()
        if (target === runner) setPython(null)
        finish({ code: null, duration: 0, reason: why })
      }, KILL_GRACE_MS)
      // C++ stops at once: its exit comes now and clears the timer above.
      target.interrupt()
    },
    [finish],
  )

  /** Starts a run on `next`: the new generation, or null when the browser cannot run it or runs come too fast. */
  const begin = useCallback(
    (next: ProgramRunner, what: string): number | null => {
      if (!RunnerClient.supported()) {
        setChunks([{ kind: "stderr", text: translate("run.unsupported", { what }) + "\n" }])
        setExit({ code: null, duration: 0, reason: "error", message: translate("run.unavailable", { what }) })
        setStatus("finished")
        return null
      }
      const now = performance.now()
      startedAt.current = startedAt.current.filter((t) => now - t < 1000)
      if (startedAt.current.length >= MAX_RUNS_PER_SEC) {
        rateLimited.current?.(translate("toast.slowDown", { n: MAX_RUNS_PER_SEC }))
        return null
      }
      startedAt.current.push(now)

      // A run still going is replaced by the new one.
      if (current.current !== null) {
        clearTimers()
        client.current.restart()
      }
      client.current = next
      reason.current = null
      emit.current?.({ type: "reset" })
      setChunks([])
      setExit(null)
      setRunCount((n) => n + 1)
      current.current = -1
      return ++generation.current
    },
    [setStatus],
  )

  const run = useCallback(
    async (files: ProjectFiles, entry: string, specs: string[] = [], breakpoints?: Record<string, number[]>, fresh = false) => {
      if (begin(runner, "Python") === null) return
      // `fresh` asks for a new interpreter (nothing a previous program changed survives into this one).
      if (fresh) runner.restart()
      setStatus("connecting")
      if (!runner.python) setBooting(true)

      try {
        const id = await runner.run(files, entry, specs, breakpoints)
        current.current = id
        setStatus("running")
        // A program being debugged waits for the person, so it has no time limit.
        if (!breakpoints) timers.current.timeout = window.setTimeout(() => stopWith("timeout"), RUN_TIMEOUT_SEC * 1000)
      } catch (err) {
        finish({ code: null, duration: 0, reason: "error", message: `Python failed to start: ${(err as Error).message}` })
      }
    },
    [begin, finish, stopWith, setStatus],
  )

  /** Compiles (`compile`, in the clang worker) and runs a C++ program; a failed compile shows clang's log. */
  const runCpp = useCallback(
    async (files: ProjectFiles, entry: string, compile: () => Promise<CppBuild>) => {
      const gen = begin(cppRunner, "C++")
      if (gen === null) return
      // Always emitted: a Run during a compile leaves the local status as it is, but the doc was reset.
      setStatusState("compiling")
      emit.current?.({ type: "status", status: "compiling" })
      let build: CppBuild
      try {
        build = await compile()
      } catch (err) {
        if (gen === generation.current && current.current === -1) {
          finish({ code: null, duration: 0, reason: "error", message: (err as Error).message })
        }
        return
      }
      if (gen !== generation.current || current.current !== -1) return // stopped or replaced meanwhile
      if (!build.wasm) {
        append("stderr", build.log)
        finish({ code: 1, duration: 0, reason: null })
        return
      }
      current.current = await cppRunner.run(build.wasm, files, entry)
      setStatus("running")
      timers.current.timeout = window.setTimeout(() => stopWith("timeout"), RUN_TIMEOUT_SEC * 1000)
    },
    [append, begin, finish, stopWith, setStatus],
  )

  const sendInput = useCallback(
    (text: string) => {
      append("stdin", text + "\n")
      setStatus("running")
      client.current.sendLine(text)
    },
    [append, setStatus],
  )

  const sendEof = useCallback(() => {
    setStatus("running")
    client.current.sendEof()
  }, [setStatus])

  const stop = useCallback(() => stopWith("killed"), [stopWith])
  const clear = useCallback(() => setChunks([]), [])

  useEffect(() => () => clearTimers(), [])

  const active = isBusy(status)
  const debug = useCallback((command: DebugCommand) => runner.debug(command), [])

  return { status, active, chunks, exit, runCount, python, booting, run, runCpp, stop, sendInput, sendEof, clear, debugState, debug }
}
