import { describe, expect, it } from "vitest"

import { ERROR_LINE } from "./console-lines"

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
