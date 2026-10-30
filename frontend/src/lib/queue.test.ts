import { describe, expect, it } from "vitest"

import { serial } from "./queue"

describe("serial", () => {
  it("runs tasks one at a time, in order, even when one fails", async () => {
    const run = serial()
    const log: string[] = []
    const task = (name: string, fail = false) => async () => {
      log.push(`start ${name}`)
      await new Promise((r) => setTimeout(r, 5))
      log.push(`end ${name}`)
      if (fail) throw new Error(name)
      return name
    }
    const results = await Promise.allSettled([run(task("a", true)), run(task("b")), run(task("c"))])
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"])
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"])
  })
})
