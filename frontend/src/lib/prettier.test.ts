import { describe, expect, it } from "vitest"

import { formatWith } from "./prettier"
import { htmlProblems } from "./web-lint"

describe("formatWith", () => {
  it("formats CSS", async () => {
    expect(await formatWith("css", "a{color:red}")).toBe("a {\n  color: red;\n}\n")
  })
  it("formats JavaScript", async () => {
    expect(await formatWith("javascript", "let x=1")).toBe("let x = 1;\n")
  })
})

describe("htmlProblems", () => {
  it("reports an unclosed tag", () => {
    const problems = htmlProblems("<div>\n<p>hi</p>\n")
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0].message).toMatch(/div/)
  })
  it("accepts valid HTML", () => {
    expect(htmlProblems("<!DOCTYPE html>\n<html><body><p>hi</p></body></html>\n")).toEqual([])
  })
})
