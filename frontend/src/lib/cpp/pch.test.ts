import { describe, expect, it } from "vitest"

import { sameFiles } from "./pch"

describe("sameFiles", () => {
  it("is true for the same texts and binary files", () => {
    const bytes = new Uint8Array([1])
    expect(sameFiles({ "a.cpp": "x", b: bytes }, { b: bytes, "a.cpp": "x" })).toBe(true)
  })
  it("is false when a text differs", () => {
    expect(sameFiles({ "a.cpp": "x" }, { "a.cpp": "y" })).toBe(false)
  })
  it("is false when a file was added or removed", () => {
    expect(sameFiles({ "a.cpp": "x" }, { "a.cpp": "x", "b.h": "" })).toBe(false)
    expect(sameFiles({ "a.cpp": "x", "b.h": "" }, { "a.cpp": "x" })).toBe(false)
  })
  it("is false for another binary array", () => {
    expect(sameFiles({ b: new Uint8Array([1]) }, { b: new Uint8Array([1]) })).toBe(false)
  })
})
