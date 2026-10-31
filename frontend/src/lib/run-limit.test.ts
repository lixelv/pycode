import { describe, expect, it } from "vitest"

import { createRunLimit } from "./run-limit"

describe("createRunLimit", () => {
  it("lets 8 runs through within a second and refuses the 9th", () => {
    const limit = createRunLimit(8, 1000)
    for (let i = 0; i < 8; i++) expect(limit.allow(i * 10)).toBe(true)
    expect(limit.allow(100)).toBe(false)
  })

  it("passes again once the window has moved on", () => {
    const limit = createRunLimit(8, 1000)
    for (let i = 0; i < 8; i++) limit.allow(0)
    expect(limit.allow(999)).toBe(false)
    expect(limit.allow(1000)).toBe(true)
  })

  it("a refused run does not use up the window", () => {
    const limit = createRunLimit(2, 1000)
    limit.allow(0)
    limit.allow(500)
    for (let t = 510; t < 1000; t += 33) expect(limit.allow(t)).toBe(false)
    expect(limit.allow(1000)).toBe(true) // only the run at 0 has left
    expect(limit.allow(1001)).toBe(false)
  })

  it("holding the key at 33 ms: about 8 per second, never more", () => {
    const limit = createRunLimit(8, 1000)
    let passed = 0
    for (let t = 0; t < 1000; t += 33) if (limit.allow(t)) passed++
    expect(passed).toBe(8)
  })
})
