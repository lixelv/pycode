import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CppClient, COMPILE_DEADLINE_MS, LINT_DEADLINE_MS, type CppRequest } from "./client"

/** Stands in for the clang worker: records requests, replies on demand. */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  posted: CppRequest[] = []
  terminated = false
  postMessage(msg: CppRequest) {
    this.posted.push(msg)
  }
  terminate() {
    this.terminated = true
  }
  reply(data: unknown) {
    this.onmessage?.({ data })
  }
}

const PKGS = { files: {}, includes: [] }

describe("CppClient", () => {
  let workers: FakeWorker[]
  let client: CppClient
  beforeEach(() => {
    vi.useFakeTimers()
    workers = []
    client = new CppClient(() => {
      const w = new FakeWorker()
      workers.push(w)
      return w as unknown as Worker
    })
  })
  afterEach(() => vi.useRealTimers())

  it("kills a lint that runs past its deadline, fails the queue and starts a fresh worker next time", async () => {
    const lint = client.lint({ "main.cpp": "x" }, "main.cpp", PKGS)
    const compile = client.compile({ "main.cpp": "x" }, "main.cpp", PKGS)
    workers[0].reply({ ready: true })
    expect(client.status).toBe("ready")
    vi.advanceTimersByTime(LINT_DEADLINE_MS + 1)
    await expect(lint).rejects.toThrow(/too long/)
    await expect(compile).rejects.toThrow(/too long/)
    expect(workers[0].terminated).toBe(true)
    expect(client.status).toBe("idle")

    const again = client.lint({ "main.cpp": "int x" }, "main.cpp", PKGS)
    expect(workers).toHaveLength(2)
    const sent = workers[1].posted[0]
    workers[1].reply({ ready: true })
    workers[1].reply({ id: sent.id, log: "main.cpp:1:6: error: expected ';'" })
    await expect(again).resolves.toEqual([{ line: 1, col: 6, severity: "error", message: "expected ';'" }])
  })

  it("gives compiles a longer deadline", async () => {
    const compile = client.compile({ "main.cpp": "x" }, "main.cpp", PKGS)
    workers[0].reply({ ready: true })
    vi.advanceTimersByTime(LINT_DEADLINE_MS + 1)
    expect(workers[0].terminated).toBe(false)
    vi.advanceTimersByTime(COMPILE_DEADLINE_MS - LINT_DEADLINE_MS)
    await expect(compile).rejects.toThrow(/too long/)
  })

  it("does not count the compiler download against the deadline", async () => {
    const lint = client.lint({ "main.cpp": "x" }, "main.cpp", PKGS)
    vi.advanceTimersByTime(LINT_DEADLINE_MS * 4)
    expect(workers[0].terminated).toBe(false)
    workers[0].reply({ ready: true })
    workers[0].reply({ id: workers[0].posted[0].id, log: "" })
    await expect(lint).resolves.toEqual([])
  })

  it("reports a failed download and loads again on the next request", async () => {
    const lint = client.lint({ "main.cpp": "x" }, "main.cpp", PKGS)
    expect(client.status).toBe("loading")
    workers[0].reply({ ready: false })
    expect(client.status).toBe("failed")
    workers[0].reply({ id: workers[0].posted[0].id, log: "Failed to fetch\n" })
    await expect(lint).resolves.toEqual([])

    void client.lint({ "main.cpp": "x" }, "main.cpp", PKGS)
    expect(client.status).toBe("loading")
    expect(workers[0].posted).toHaveLength(2)
    workers[0].reply({ ready: true })
    expect(client.status).toBe("ready")
  })
})
