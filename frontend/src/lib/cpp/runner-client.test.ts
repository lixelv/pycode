import { describe, expect, it } from "vitest"

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
})
