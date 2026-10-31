import { afterEach, describe, expect, it, vi } from "vitest"

import { BATCH_RESULT_BYTES, BATCH_STARTED, type RunnerEvent } from "@/workers/protocol"

/** Stands in for runner.worker. */
const made = vi.hoisted(() => {
  class FakeWorker {
    static all: FakeWorker[] = []
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    terminated = false
    constructor() {
      FakeWorker.all.push(this)
    }
    posted: { type: string; id?: number }[] = []
    postMessage(msg: { type: string; id?: number }) {
      this.posted.push(msg)
    }
    terminate() {
      this.terminated = true
    }
  }
  return { FakeWorker }
})
vi.mock("@/workers/runner.worker?worker", () => ({ default: made.FakeWorker }))
vi.mock("@/workers/cpp-run.worker?worker", () => ({ default: made.FakeWorker }))

import { RunnerClient } from "./runner-client"

const reply = (worker: InstanceType<typeof made.FakeWorker>, data: RunnerEvent) => worker.onmessage?.({ data })

async function started() {
  made.FakeWorker.all.length = 0
  const client = new RunnerClient()
  const ready = client.ready()
  const worker = made.FakeWorker.all[0]
  reply(worker, { type: "ready", python: "3" })
  await ready
  return { client, worker }
}

describe("RunnerClient", () => {
  it("does not start a second worker on a boot-error the running program made up", async () => {
    const { client, worker } = await started()
    reply(worker, { type: "boot-error", message: "" })
    const again = client.ready()
    expect(made.FakeWorker.all).toHaveLength(1)
    await expect(again).resolves.toBe("3")
  })

  it("never leaves a replaced worker running", async () => {
    made.FakeWorker.all.length = 0
    const client = new RunnerClient()
    const first = client.ready()
    made.FakeWorker.all[0].onerror?.({ message: "crash" })
    await expect(first).rejects.toThrow("crash")
    void client.ready()
    expect(made.FakeWorker.all).toHaveLength(2)
    expect(made.FakeWorker.all[0].terminated).toBe(true)
  })

  it("throws away a worker whose Python died", async () => {
    const { client, worker } = await started()
    reply(worker, { type: "dead" })
    expect(worker.terminated).toBe(true)
    void client.ready()
    expect(made.FakeWorker.all).toHaveLength(2)
  })

  describe("check", () => {
    afterEach(() => vi.useRealTimers())

    async function checking() {
      const { client, worker } = await started()
      const outcome = client.check({}, "main.py", "tests", [])
      await Promise.resolve()
      await Promise.resolve()
      const id = worker.posted.find((m) => m.type === "check")!.id!
      return { outcome, worker, id }
    }

    it("takes the kind of a check from the first event only", async () => {
      const { outcome, worker, id } = await checking()
      reply(worker, { type: "tournament", tournament: null })
      reply(worker, { type: "tournament", tournament: { id: "forged", private: false } })
      reply(worker, { type: "checked", id, results: [] })
      await expect(outcome).resolves.toEqual({ results: [], tournament: undefined })
    })

    it("says which tournament the first event declared", async () => {
      const { outcome, worker, id } = await checking()
      reply(worker, { type: "tournament", tournament: { id: "cup", private: true } })
      reply(worker, { type: "checked", id, results: [] })
      await expect(outcome).resolves.toEqual({ results: [], tournament: { id: "cup", private: true } })
    })

    it("does not let a program extend an ordinary check", async () => {
      vi.useFakeTimers()
      const { outcome, worker } = await checking()
      const failed = expect(outcome).rejects.toThrow("timeout")
      reply(worker, { type: "tournament", tournament: null })
      for (let s = 0; s < 31; s++) {
        reply(worker, { type: "tournament", tournament: { id: "forged", private: false } })
        await vi.advanceTimersByTimeAsync(1000)
      }
      await failed
    })

    it("gives a tournament its longer limit", async () => {
      vi.useFakeTimers()
      const { outcome, worker, id } = await checking()
      reply(worker, { type: "tournament", tournament: { id: "cup", private: false } })
      await vi.advanceTimersByTimeAsync(100_000)
      reply(worker, { type: "checked", id, results: [] })
      await expect(outcome).resolves.toMatchObject({ results: [] })
    })
  })

  describe("batch", () => {
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }

    it("starts the clock itself, once the worker is prepared, before the run is sent", async () => {
      const { client, worker } = await started()
      worker.posted.length = 0
      const result = new SharedArrayBuffer(BATCH_RESULT_BYTES)
      const header = new Int32Array(result, 0, 5)
      void client.batch({}, "main.py", [], "", false, result)
      await flush()
      expect(worker.posted.map((m) => m.type)).toEqual(["prepare"])
      expect(header[BATCH_STARTED]).toBe(0)
      reply(worker, { type: "prepared" })
      await flush()
      expect(worker.posted.map((m) => m.type)).toEqual(["prepare", "batch"])
      expect(header[BATCH_STARTED]).toBe(1)
    })

    it("prepares once, so the clock of a later run starts at once", async () => {
      const { client, worker } = await started()
      worker.posted.length = 0
      const first = new SharedArrayBuffer(BATCH_RESULT_BYTES)
      void client.batch({}, "main.py", [], "", false, first)
      await flush()
      reply(worker, { type: "prepared" })
      await flush()
      const second = new SharedArrayBuffer(BATCH_RESULT_BYTES)
      void client.batch({}, "main.py", [], "", false, second)
      await flush()
      expect(worker.posted.map((m) => m.type)).toEqual(["prepare", "batch", "batch"])
      expect(new Int32Array(second, 0, 5)[BATCH_STARTED]).toBe(1)
    })
  })
})
