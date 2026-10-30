import { describe, expect, it } from "vitest"

import { arm, disarm, fire } from "./deadline"

const setup = () => ({ control: new Int32Array(new SharedArrayBuffer(12)), flag: new Uint8Array(new SharedArrayBuffer(1)) })

describe("deadline", () => {
  it("fires an armed timer; disarm reports it and clears the interrupt", () => {
    const { control, flag } = setup()
    arm(control, 1)
    fire(control, 1, () => (flag[0] = 2))
    expect(flag[0]).toBe(2)
    expect(disarm(control, flag)).toBe(true)
    expect(flag[0]).toBe(0)
  })

  it("a timer that fires after disarm does nothing", () => {
    const { control, flag } = setup()
    arm(control, 1)
    expect(disarm(control, flag)).toBe(false)
    fire(control, 1, () => (flag[0] = 2))
    expect(flag[0]).toBe(0)
  })

  it("a stale timer does not hit the next run", () => {
    const { control, flag } = setup()
    arm(control, 1)
    disarm(control, flag)
    arm(control, 2)
    fire(control, 1, () => (flag[0] = 2))
    expect(flag[0]).toBe(0)
    fire(control, 2, () => (flag[0] = 2))
    expect(flag[0]).toBe(2)
  })
})
