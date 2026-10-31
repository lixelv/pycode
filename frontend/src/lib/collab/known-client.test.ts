import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { whenClientKnown } from "./known-client"

describe("whenClientKnown", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("goes on at once for a client we know", () => {
    const then = vi.fn()
    whenClientKnown(new Set([7]), 7, then)
    expect(then).toHaveBeenCalledOnce()
  })

  it("waits for the awareness that is still on its way", () => {
    const clients = new Set<number>()
    const then = vi.fn()
    whenClientKnown(clients, 7, then)
    expect(then).not.toHaveBeenCalled()
    clients.add(7)
    vi.advanceTimersByTime(1000)
    expect(then).toHaveBeenCalledOnce()
  })

  it("gives up on a client that never shows up: it was someone else's id", () => {
    const then = vi.fn()
    whenClientKnown(new Set([1]), 7, then)
    vi.advanceTimersByTime(60_000)
    expect(then).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
