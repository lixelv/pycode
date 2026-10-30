import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { STDIN_READY, type CppRunRequest, type RunnerEvent } from "@/workers/protocol"

import { CppRunnerClient } from "./runner-client"

/** Stands in for cpp-run.worker. */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  posted: CppRunRequest[] = []
  terminated = false
  postMessage(msg: CppRunRequest) {
    this.posted.push(msg)
  }
  terminate() {
    this.terminated = true
  }
  reply(data: RunnerEvent) {
    this.onmessage?.({ data })
  }
}

function setup() {
  const workers: FakeWorker[] = []
  const client = new CppRunnerClient(() => {
    const w = new FakeWorker()
    workers.push(w)
    return w as unknown as Worker
  })
  const events: RunnerEvent[] = []
  client.on((e) => events.push(e))
  return { client, workers, events }
}

const WASM = new Uint8Array([0, 97, 115, 109])

describe("CppRunnerClient", () => {
  it("runs in the entry's folder and forwards the worker's events", async () => {
    const { client, workers, events } = setup()
    const id = await client.run(WASM, { "src/main.cpp": "" }, "src/main.cpp")
    const request = workers[0].posted[0]
    expect(request).toMatchObject({ type: "run", id, cwd: "/project/src" })
    workers[0].reply({ type: "stdout", data: "hi\n" })
    workers[0].reply({ type: "exit", id, code: 0, duration: 0, reason: null })
    expect(events.map((e) => e.type)).toEqual(["stdout", "exit"])

    client.sendLine("Ann")
    if (request.type !== "run") throw new Error()
    const control = new Int32Array(request.buffers.control)
    expect(control[0]).toBe(STDIN_READY)
    expect(new TextDecoder().decode(new Uint8Array(request.buffers.data).slice(0, control[1]))).toBe("Ann\n")
  })

  it("interrupt terminates the worker, reports KeyboardInterrupt and exit 130, and the next run works", async () => {
    const { client, workers, events } = setup()
    const id = await client.run(WASM, { "main.cpp": "" }, "main.cpp")
    expect(workers[0].posted[0].cwd).toBe("/project")
    client.interrupt()
    expect(workers[0].terminated).toBe(true)
    expect(events).toEqual([
      { type: "stderr", data: "\nKeyboardInterrupt\n" },
      expect.objectContaining({ type: "exit", id, code: 130, reason: null }),
    ])
    // Late messages of the dead worker are ignored.
    workers[0].reply({ type: "stdout", data: "late" })
    expect(events).toHaveLength(2)

    const next = await client.run(WASM, { "main.cpp": "" }, "main.cpp")
    expect(workers).toHaveLength(2)
    expect(workers[1].posted[0]).toMatchObject({ type: "run", id: next })
  })

  it("interrupt without a running program does nothing", async () => {
    const { client, workers, events } = setup()
    client.interrupt()
    const id = await client.run(WASM, {}, "main.cpp")
    workers[0].reply({ type: "exit", id, code: 0, duration: 0, reason: null })
    client.interrupt()
    expect(workers[0].terminated).toBe(false)
    expect(events.map((e) => e.type)).toEqual(["exit"])
  })

  describe("output batching", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    const exitOf = (id: number): RunnerEvent => ({ type: "exit", id, code: 0, duration: 0, reason: null })

    it("batches stdout within 16 ms into one event", async () => {
      const { client, workers, events } = setup()
      await client.run(WASM, {}, "main.cpp")
      workers[0].reply({ type: "stdout", data: "a" })
      workers[0].reply({ type: "stdout", data: "b" })
      workers[0].reply({ type: "stdout", data: "c" })
      expect(events).toEqual([])
      vi.advanceTimersByTime(16)
      expect(events).toEqual([{ type: "stdout", data: "abc" }])
    })

    it("keeps stdout, stderr, stdout in order as three events", async () => {
      const { client, workers, events } = setup()
      await client.run(WASM, {}, "main.cpp")
      workers[0].reply({ type: "stdout", data: "a" })
      workers[0].reply({ type: "stdout", data: "b" })
      workers[0].reply({ type: "stderr", data: "e" })
      workers[0].reply({ type: "stdout", data: "c" })
      vi.advanceTimersByTime(16)
      expect(events).toEqual([
        { type: "stdout", data: "ab" },
        { type: "stderr", data: "e" },
        { type: "stdout", data: "c" },
      ])
    })

    it("emits pending output before input_request", async () => {
      const { client, workers, events } = setup()
      await client.run(WASM, {}, "main.cpp")
      workers[0].reply({ type: "stdout", data: "Name? " })
      workers[0].reply({ type: "input_request" })
      expect(events).toEqual([{ type: "stdout", data: "Name? " }, { type: "input_request" }])
      vi.advanceTimersByTime(100)
      expect(events).toHaveLength(2)
    })

    it("emits pending output before exit", async () => {
      const { client, workers, events } = setup()
      const id = await client.run(WASM, {}, "main.cpp")
      workers[0].reply({ type: "stdout", data: "bye\n" })
      workers[0].reply(exitOf(id))
      expect(events).toEqual([{ type: "stdout", data: "bye\n" }, exitOf(id)])
      vi.advanceTimersByTime(100)
      expect(events).toHaveLength(2)
    })

    it("interrupt emits pending output, then KeyboardInterrupt, then exit 130", async () => {
      const { client, workers, events } = setup()
      const id = await client.run(WASM, {}, "main.cpp")
      workers[0].reply({ type: "stdout", data: "last line\n" })
      client.interrupt()
      expect(events).toEqual([
        { type: "stdout", data: "last line\n" },
        { type: "stderr", data: "\nKeyboardInterrupt\n" },
        expect.objectContaining({ type: "exit", id, code: 130 }),
      ])
    })

    it("after interrupt, the batch timer and late messages of the dead worker emit nothing", async () => {
      const { client, workers, events } = setup()
      await client.run(WASM, {}, "main.cpp")
      workers[0].reply({ type: "stdout", data: "x" })
      client.interrupt()
      expect(events).toHaveLength(3)
      workers[0].reply({ type: "stdout", data: "late" })
      workers[0].reply({ type: "stderr", data: "later" })
      vi.advanceTimersByTime(100)
      expect(events).toHaveLength(3)
    })

    it("a timer armed before a flush does not emit the next batch early", async () => {
      const { client, workers, events } = setup()
      const id = await client.run(WASM, {}, "main.cpp")
      workers[0].reply({ type: "stdout", data: "a" })
      workers[0].reply({ type: "input_request" }) // flushes "a"
      vi.advanceTimersByTime(10)
      workers[0].reply({ type: "stdout", data: "b" })
      vi.advanceTimersByTime(10) // 20 ms after the first write, 10 ms after the second
      expect(events).toEqual([{ type: "stdout", data: "a" }, { type: "input_request" }])
      vi.advanceTimersByTime(10)
      expect(events.at(-1)).toEqual({ type: "stdout", data: "b" })
      workers[0].reply(exitOf(id))
    })

    /** Write `n` alternating chunks, stdout first or stderr first; returns what was written. */
    const flood = (worker: FakeWorker, n: number, first: "stdout" | "stderr" = "stdout") => {
      const written: { type: "stdout" | "stderr"; data: string }[] = []
      for (let i = 0; i < n; i++) {
        const type = (i % 2 === 0) === (first === "stdout") ? "stdout" : "stderr"
        const event = { type, data: `${type[3]}${i};` } as const
        written.push(event)
        worker.reply(event)
      }
      return written
    }
    const outputs = (events: RunnerEvent[]) =>
      events.filter((e): e is Extract<RunnerEvent, { type: "stdout" | "stderr" }> => e.type === "stdout" || e.type === "stderr")

    it("1000 alternating writes in one batch give at most 64 events", async () => {
      const { client, workers, events } = setup()
      await client.run(WASM, {}, "main.cpp")
      flood(workers[0], 1000)
      vi.advanceTimersByTime(16)
      expect(outputs(events).length).toBeLessThanOrEqual(64)
      expect(outputs(events).length).toBeGreaterThan(0)
    })

    it("a flooded batch loses no text and keeps the written order", async () => {
      const { client, workers, events } = setup()
      await client.run(WASM, {}, "main.cpp")
      const written = flood(workers[0], 1000)
      vi.advanceTimersByTime(16)
      expect(outputs(events).map((e) => e.data).join("")).toBe(written.map((e) => e.data).join(""))
    })

    it("a batch of 64 alternating writes keeps every event's own kind", async () => {
      const { client, workers, events } = setup()
      await client.run(WASM, {}, "main.cpp")
      const written = flood(workers[0], 64)
      vi.advanceTimersByTime(16)
      expect(outputs(events)).toEqual(written)
    })

    it("after a flush the next batch starts with its own kind and its own count", async () => {
      const { client, workers, events } = setup()
      await client.run(WASM, {}, "main.cpp")
      flood(workers[0], 1000)
      vi.advanceTimersByTime(16)
      events.length = 0

      const small = flood(workers[0], 3, "stderr")
      vi.advanceTimersByTime(16)
      expect(outputs(events)).toEqual(small)
      expect(small.map((e) => e.type)).toEqual(["stderr", "stdout", "stderr"])
      events.length = 0

      // The limit counts per batch: a full batch of 64 is split into 64 events again.
      const full = flood(workers[0], 64)
      vi.advanceTimersByTime(16)
      expect(outputs(events)).toEqual(full)
    })
  })
})
