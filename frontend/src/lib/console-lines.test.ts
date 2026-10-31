import { describe, expect, it } from "vitest"

import { ERROR_LINE, stderrRuns } from "./console-lines"

describe("ERROR_LINE", () => {
  it.each([
    "main.cpp:1:22: error: x",
    "wasm-ld: error: undefined symbol: f",
    "clang++: error: linker command failed",
    "ZeroDivisionError: division by zero",
    "terminate called after throwing an instance of 'int'",
  ])("matches %s", (line) => {
    expect(ERROR_LINE.test(line)).toBe(true)
  })

  it.each(["error: looks like program output", 'File "main.py", line 1, in <module>'])("does not match %s", (line) => {
    expect(ERROR_LINE.test(line)).toBe(false)
  })
})

describe("stderrRuns", () => {
  it("joins neighbouring lines of the same kind and keeps every character", () => {
    const text = 'Traceback:\n  File "a"\nValueError: x\nKeyError: y\nmore\nend'
    expect(stderrRuns(text)).toEqual([
      { error: false, text: 'Traceback:\n  File "a"\n' },
      { error: true, text: "ValueError: x\nKeyError: y\n" },
      { error: false, text: "more\nend" },
    ])
  })

  it("gives one run for a flood of plain lines", () => {
    expect(stderrRuns("e\n".repeat(1000))).toEqual([{ error: false, text: "e\n".repeat(1000) }])
  })
})
